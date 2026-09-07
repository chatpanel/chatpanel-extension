// Voice out — speak text, the mirror of dictation.js.
//
// Two providers, same ladder as dictation:
//   'gateway' — PRIVATE default when detected: text goes to the local ChatPanel
//               gateway over loopback, Kokoro synthesizes IN-PROCESS, and the
//               audio comes back as a WAV. Nothing leaves the machine.
//   'browser' — speechSynthesis. Also on-device (unlike browser STT, which ships
//               audio to a vendor), so it is a genuine zero-install fallback, just
//               with the OS voices instead of Kokoro's.
//
// Contract:
//   resolveSpeechProvider({gatewayUrl}) -> { provider, private, label, tts? }
//   createSpeech(opts)                  -> controller
//     opts: { gatewayUrl?, provider='browser', voice?, speed?, analyse?,
//             onStart, onChunk, onEnd, onError }
//       onChunk(i, total, text) — a chunk began playing, and the words it is
//                 saying. The caption follows the AUDIO rather than the whole
//                 reply, so what is on screen is what you are hearing.
//   controller: { speak(text), stop(), isSpeaking(), analyser() }
//
// `analyse: true` taps the playing audio with a Web Audio AnalyserNode and exposes
// it via analyser(), so a caller can draw a waveform driven by the ACTUAL signal.
// A shape that merely animates on a timer drifts out of sync with the voice within
// a sentence, which reads as lag in the audio rather than in the animation.
//
// Why the text is chunked HERE and not only in the gateway: the gateway returns a
// complete WAV, so a 60-second answer would sit silent for ~30 s before the first
// sound. Splitting client-side lets chunk 1 play while chunk 2 is still being
// synthesized — the first word arrives in about a second, and the rest streams in
// behind it. When the gateway route learns to stream, this becomes the fallback
// path rather than the only one.

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4320';

export function isSpeechSupported() {
  return typeof window !== 'undefined' && ('speechSynthesis' in window || typeof fetch === 'function');
}

// Probe the gateway's additive `tts` health block. Fast + silent: no gateway (or an
// older one without TTS) just means the browser fallback, never an error.
export async function probeGatewayTTS(gatewayUrl = DEFAULT_GATEWAY_URL) {
  const base = String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1200);
    const res = await fetch(`${base}/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.tts && j.tts.enabled ? j.tts : null;
  } catch { return null; }
}

export async function resolveSpeechProvider({ gatewayUrl } = {}) {
  const tts = await probeGatewayTTS(gatewayUrl);
  if (tts) return { provider: 'gateway', private: true, label: 'Local (gateway)', tts };
  const ok = typeof window !== 'undefined' && 'speechSynthesis' in window;
  return { provider: ok ? 'browser' : 'none', private: ok, label: ok ? 'Browser voice' : 'Unavailable' };
}

// Split for playback latency, not for a model limit — the gateway does its own
// bounding. Sentence boundaries are where a listener expects a pause anyway.
//
// The FIRST chunk is deliberately much smaller than the rest: synthesis runs at
// roughly 2x realtime, so a 90-character opener is ~6 s of audio costing ~3 s to
// make, while a 350-character one would make the user wait ~10 s in silence. Once
// audio is playing the remaining chunks are synthesized behind it and the size no
// longer costs anything, so they are larger — fewer requests, and fewer seams.
export function splitForSpeech(text, { first = 90, rest = 350 } = {}) {
  const clean = stripForSpeech(text);
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const s of sentences) {
    const cap = out.length === 0 ? first : rest;
    const cand = buf ? `${buf} ${s}` : s;
    if (cand.length > cap && buf) { out.push(buf); buf = s; }
    else buf = cand;
  }
  if (buf) out.push(buf);
  return out;
}

// Markdown is written to be READ, not heard: backticks, hashes and pipes become
// noise or get spelled out. Strip the syntax, keep the words.
export function stripForSpeech(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')   // don't read code aloud
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')           // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // links → their text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/^\s*[-=]{3,}\s*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A speaking QUEUE fed while the reply is still being generated.
 *
 * Waiting for a complete answer before making any sound costs the whole
 * generation in silence — on a long reply that is most of the interaction. Text
 * arrives as a growing string, so this holds a cursor into it, hands over every
 * COMPLETE sentence as it appears, and speaks them back to back.
 *
 *   const q = speakStream(speaker);
 *   q.push(partialText);   // called repeatedly with the growing reply
 *   q.end();               // generation finished
 *   await q.done;          // resolves when the last sentence has been spoken
 *
 * Only complete sentences are released: synthesizing a half-clause produces a
 * voice that trails off mid-thought and then restarts, which is worse than a
 * slightly later start.
 */
export function speakStream(speaker, { onSpeaking } = {}) {
  let spoken = 0;        // how much of the text has been queued
  let text = '';
  let ended = false;
  let chain = Promise.resolve();
  let stopped = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const enqueue = (chunk) => {
    if (!chunk || stopped) return;
    chain = chain.then(async () => {
      if (stopped) return;
      onSpeaking?.(chunk);
      try { await speaker.speak(chunk); } catch { /* one bad chunk must not stall the rest */ }
    });
  };

  const drain = () => {
    const pending = text.slice(spoken);
    if (!pending) return;
    // A sentence is only finished when a terminator is followed by whitespace or
    // the end of the generation — "e.g." mid-sentence must not trigger a chunk.
    const re = /[^.!?]*[.!?]+(?=\s|$)/g;
    let m, last = 0;
    while ((m = re.exec(pending)) !== null) last = m.index + m[0].length;
    if (!last) return;
    const ready = pending.slice(0, last).trim();
    spoken += last;
    if (ready) enqueue(ready);
  };

  return {
    push(next) {
      if (stopped) return;
      text = String(next || '');
      drain();
    },
    end() {
      if (ended || stopped) return;
      ended = true;
      // Whatever is left has no terminator — say it anyway; the generation is over.
      const tail = text.slice(spoken).trim();
      if (tail) { spoken = text.length; enqueue(tail); }
      chain.then(() => resolveDone());
    },
    stop() {
      stopped = true;
      try { speaker.stop(); } catch { /* nothing playing */ }
      resolveDone();
    },
    done,
  };
}

export function createSpeech(opts = {}) {
  const provider = opts.provider || 'browser';
  return provider === 'gateway' ? createGatewaySpeech(opts) : createBrowserSpeech(opts);
}

// ── browser (speechSynthesis) ──────────────────────────────────────────────────
function createBrowserSpeech({ voice = null, speed = 1, onStart, onChunk, onEnd, onError } = {}) {
  let speaking = false;
  return {
    provider: 'browser',
    isSpeaking: () => speaking,
    // speechSynthesis gives no audio node to tap, so a caller must fall back to
    // something that is not signal-driven. Saying so is better than a fake.
    analyser: () => null,
    stop() {
      speaking = false;
      try { window.speechSynthesis.cancel(); } catch { /* nothing playing */ }
    },
    async speak(text) {
      const clean = stripForSpeech(text);
      if (!clean) return;
      this.stop();
      speaking = true;
      onStart?.();
      try {
        const u = new SpeechSynthesisUtterance(clean);
        u.rate = speed;
        if (voice) {
          const v = window.speechSynthesis.getVoices().find((x) => x.name === voice || x.voiceURI === voice);
          if (v) u.voice = v;
        }
        u.onend = () => { speaking = false; onEnd?.(); };
        u.onerror = (e) => { speaking = false; onError?.(e?.error || 'speech failed'); onEnd?.(); };
        onChunk?.(0, 1, clean);
        window.speechSynthesis.speak(u);
      } catch (e) {
        speaking = false;
        onError?.(e.message); onEnd?.();
      }
    },
  };
}

// ── gateway (Kokoro over loopback) ─────────────────────────────────────────────
function createGatewaySpeech({ gatewayUrl, voice, speed = 1, analyse = false, onStart, onChunk, onEnd, onError } = {}) {
  const base = String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  let speaking = false;
  let audio = null;
  let abort = null;
  let token = 0; // bumped by stop(), so a late fetch from a cancelled run is dropped

  // One AudioContext for the whole controller, created lazily on first play so it
  // is born inside the user gesture that started the conversation — a context
  // constructed earlier starts 'suspended' and the waveform never moves.
  let actx = null;
  let analyserNode = null;
  function ensureAnalyser() {
    if (!analyse || analyserNode) return analyserNode;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      analyserNode = actx.createAnalyser();
      analyserNode.fftSize = 1024;
      analyserNode.smoothingTimeConstant = 0.75;
      analyserNode.connect(actx.destination);
    } catch { analyserNode = null; } // no Web Audio: the caller falls back to CSS
    return analyserNode;
  }

  async function fetchChunk(text, signal) {
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
      signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json())?.error?.message || msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    return URL.createObjectURL(await res.blob());
  }

  let resolvePlay = null; // settles the in-flight play() when stop() pauses it
  function play(url) {
    return new Promise((resolve, reject) => {
      // pause() fires neither onended nor onerror, so without this a stopped chunk
      // leaves its promise pending forever and the speak queue behind it hangs.
      resolvePlay = resolve;
      audio = new Audio(url);
      const an = ensureAnalyser();
      if (an && actx) {
        try {
          // A media element can be tapped ONCE, which is fine — every chunk is a
          // fresh element. Routing through the analyser replaces the element's own
          // output, so the node must reach the destination or playback goes silent.
          actx.createMediaElementSource(audio).connect(an);
          if (actx.state === 'suspended') actx.resume().catch(() => {});
        } catch { /* already tapped, or no Web Audio — play it plainly */ }
      }
      audio.onended = () => { resolvePlay = null; resolve(); };
      audio.onerror = () => reject(new Error('playback failed'));
      audio.play().catch(reject);
    });
  }

  const api = {
    provider: 'gateway',
    isSpeaking: () => speaking,
    analyser: () => analyserNode,
    stop() {
      token++;
      speaking = false;
      try { abort?.abort(); } catch { /* no request in flight */ }
      abort = null;
      if (audio) { try { audio.pause(); } catch { /* already stopped */ } audio = null; }
      if (resolvePlay) { const r = resolvePlay; resolvePlay = null; r(); }
    },
    async speak(text) {
      const chunks = splitForSpeech(text);
      if (!chunks.length) return;
      api.stop();
      const mine = ++token;
      speaking = true;
      abort = new AbortController();
      onStart?.();
      const urls = [];
      try {
        // Fetch chunk 1, then keep exactly one chunk in flight ahead of playback:
        // audio starts after the first short chunk instead of after the whole answer.
        let next = fetchChunk(chunks[0], abort.signal);
        for (let i = 0; i < chunks.length; i++) {
          const url = await next;
          if (token !== mine) return;            // stopped while we were fetching
          urls.push(url);
          next = i + 1 < chunks.length ? fetchChunk(chunks[i + 1], abort.signal) : null;
          onChunk?.(i, chunks.length, chunks[i]);
          await play(url);
          if (token !== mine) return;
        }
      } catch (e) {
        if (token === mine && e?.name !== 'AbortError') onError?.(e.message);
      } finally {
        for (const u of urls) { try { URL.revokeObjectURL(u); } catch { /* already gone */ } }
        if (token === mine) { speaking = false; audio = null; abort = null; onEnd?.(); }
      }
    },
  };
  return api;
}
