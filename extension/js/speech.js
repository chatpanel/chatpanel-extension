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
//     opts: { gatewayUrl?, provider='browser', voice?, speed?,
//             onStart, onChunk, onEnd, onError }
//       onChunk(i, total) — a chunk began playing; drives progress UI.
//   controller: { speak(text), stop(), isSpeaking() }
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
        onChunk?.(0, 1);
        window.speechSynthesis.speak(u);
      } catch (e) {
        speaking = false;
        onError?.(e.message); onEnd?.();
      }
    },
  };
}

// ── gateway (Kokoro over loopback) ─────────────────────────────────────────────
function createGatewaySpeech({ gatewayUrl, voice, speed = 1, onStart, onChunk, onEnd, onError } = {}) {
  const base = String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  let speaking = false;
  let audio = null;
  let abort = null;
  let token = 0; // bumped by stop(), so a late fetch from a cancelled run is dropped

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

  function play(url) {
    return new Promise((resolve, reject) => {
      audio = new Audio(url);
      audio.onended = resolve;
      audio.onerror = () => reject(new Error('playback failed'));
      audio.play().catch(reject);
    });
  }

  const api = {
    provider: 'gateway',
    isSpeaking: () => speaking,
    stop() {
      token++;
      speaking = false;
      try { abort?.abort(); } catch { /* no request in flight */ }
      abort = null;
      if (audio) { try { audio.pause(); } catch { /* already stopped */ } audio = null; }
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
          onChunk?.(i, chunks.length);
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
