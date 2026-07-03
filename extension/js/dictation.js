// Real-time dictation (speech → text) as a reusable capability.
//
// Providers (one contract, callers never change when the engine does):
//   'gateway' — PRIVATE default when detected: mic PCM streams over loopback to
//               the local ChatPanel gateway, whisper transcribes IN-PROCESS
//               there (language auto-detected by the multilingual model), and
//               only text comes back. Audio never leaves the machine.
//   'browser' — zero-install fallback: the browser's Web Speech API. Caveat:
//               Chrome ships the audio to Google's speech service — callers
//               must LABEL this tier when it's active.
//
// Contract:
//   isDictationSupported()            -> boolean (browser engine present)
//   micPermissionState()              -> 'granted' | 'prompt' | 'denied'
//   resolveDictationProvider({gatewayUrl}) -> { provider, private, label, stt? }
//   createDictation(opts)             -> controller
//     opts: { lang?, provider='browser', gatewayUrl?, redact?,
//             onStart, onInterim, onFinal, onEnd, onError, onStatus }
//       onInterim(text) — best guess of the phrase being spoken right now (mutable)
//       onFinal(text)   — a finalized chunk; append it to the committed transcript
//       onEnd()         — recognition fully stopped (user, or a fatal error)
//       onError({ code, message, fatal })
//       onStatus({ state, pct? }) — gateway engine state (model download progress)
//   controller: { start(), stop(), toggle(), get recording }
//
// The caller keeps the running transcript (base draft + committed finals) and
// only overlays the live `interim` on top — this module stays stateless about
// the composer's text so it's reusable anywhere a live transcript is wanted.

function SpeechRecognitionCtor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

export function isDictationSupported() {
  return !!SpeechRecognitionCtor();
}

// Whether the extension origin already holds mic permission: 'granted' |
// 'prompt' | 'denied'. Extension surfaces (side panel especially) can NOT show
// Chrome's mic prompt themselves — SpeechRecognition just fails `not-allowed` —
// so anything other than 'granted' means: send the user through the one-time
// grant page (mic-permission.html) first.
export async function micPermissionState() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; }
  catch { return 'prompt'; }
}

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4320';

// Probe the local gateway for the additive `stt` health block. Fast + silent:
// no gateway (or an old one without STT) just means the browser fallback.
export async function probeGatewaySTT(gatewayUrl = DEFAULT_GATEWAY_URL) {
  const base = String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
    const h = await r.json();
    if (h?.ok && h.stt && h.stt.enabled !== false) return { available: true, base, ...h.stt };
  } catch { /* not running */ }
  return { available: false, base };
}

// Pick the best engine: local gateway when available (private), else the
// labeled browser fallback. Returns enough for callers to show WHICH engine is
// live — the privacy indicator is part of the contract, not decoration.
export async function resolveDictationProvider({ gatewayUrl } = {}) {
  const stt = await probeGatewaySTT(gatewayUrl);
  if (stt.available) {
    return { provider: 'gateway', private: true, label: 'Local (gateway)', stt };
  }
  if (isDictationSupported()) {
    return { provider: 'browser', private: false, label: 'Browser — audio processed by Google' };
  }
  return { provider: null, private: false, label: 'unavailable' };
}

// Errors that mean "don't bother retrying this session".
const FATAL = new Set([
  'not-allowed', 'service-not-allowed', 'audio-capture',
  'language-not-supported', 'bad-grammar',
]);

export function createDictation(opts = {}) {
  const { provider = 'browser' } = opts;
  if (provider === 'gateway') return createGatewayDictation(opts);
  if (provider !== 'browser') throw new Error(`Unknown dictation provider: ${provider}`);
  return createBrowserDictation(opts);
}

function createBrowserDictation({
  lang,
  onStart, onInterim, onFinal, onEnd, onError,
} = {}) {
  const Rec = SpeechRecognitionCtor();
  if (!Rec) throw new Error('Speech recognition is not supported in this browser.');

  let rec = null;
  let recording = false; // user intent — stays true across the engine's silent auto-restarts

  function build() {
    const r = new Rec();
    r.lang = lang || navigator.language || 'en-US';
    r.continuous = true;      // keep listening across pauses
    r.interimResults = true;  // stream partial words as they're recognized

    r.onstart = () => onStart?.();

    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0]?.transcript || '';
        if (res.isFinal) { if (txt.trim()) onFinal?.(txt); }
        else interim += txt;
      }
      if (interim) onInterim?.(interim);
    };

    r.onerror = (e) => {
      // 'no-speech' / 'aborted' are benign — the engine just stopped; onend handles it.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      const fatal = FATAL.has(e.error);
      if (fatal) recording = false;
      onError?.({ code: e.error, message: e.message || e.error, fatal });
    };

    r.onend = () => {
      // Chrome stops recognition on its own after a pause. While the user still
      // intends to dictate, restart so it behaves like "record until I hit Stop".
      if (recording) {
        try { r.start(); }
        catch { recording = false; onEnd?.(); }
      } else {
        onEnd?.();
      }
    };

    return r;
  }

  return {
    get recording() { return recording; },
    start() {
      if (recording) return;
      recording = true;
      rec = build();
      try { rec.start(); }
      catch (e) { recording = false; onError?.({ code: 'start-failed', message: e.message, fatal: true }); }
    },
    stop() {
      if (!recording) return;
      recording = false; // set first so onend doesn't auto-restart
      try { rec?.stop(); } catch { /* already stopped */ }
    },
    toggle() { if (this.recording) this.stop(); else this.start(); },
  };
}

// ── Gateway provider — local whisper over loopback ─────────────────────────────
// Capture: getUserMedia → 16 kHz AudioContext → PCM chunks POSTed to the local
// gateway's STT session; interim/final text streams back over SSE. The audio
// crosses 127.0.0.1 only. `redact: true` asks the gateway to run finals through
// its shared redaction guard (the optional STT→NER hop).

const CHUNK_MS = 400; // post cadence — small enough to feel live, big enough to be cheap

function createGatewayDictation({
  lang, gatewayUrl, redact = false,
  onStart, onInterim, onFinal, onEnd, onError, onStatus,
} = {}) {
  const base = String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  let recording = false;
  let sid = null;
  let media = null;    // MediaStream
  let ctx = null;      // AudioContext
  let finished = false;

  function stopCapture() {
    try { media?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { ctx?.close(); } catch { /* gone */ }
    media = null; ctx = null;
  }
  // DELETE flushes the buffered tail as a last `final` before the server emits
  // `end` — so teardown goes: stop capture → DELETE → SSE delivers final+end →
  // finish() notifies the caller exactly once.
  function endSessionReq() {
    if (sid) fetch(`${base}/stt/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  }
  function finish() {
    if (finished) return;
    finished = true;
    recording = false;
    stopCapture();
    onEnd?.();
  }

  const fail = (code, message, fatal = true) => {
    onError?.({ code, message, fatal });
    if (fatal) { endSessionReq(); finish(); }
  };

  // Read the session's SSE event stream and fan events out to the callbacks.
  async function pumpEvents() {
    let res;
    try { res = await fetch(`${base}/stt/sessions/${sid}/events`); } catch (e) { return fail('gateway-unreachable', e.message); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!line.startsWith('data: ')) continue;
          let ev = null;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'interim') onInterim?.(ev.text);
          else if (ev.type === 'final') onFinal?.(ev.text);
          else if (ev.type === 'progress' || ev.type === 'state') onStatus?.({ state: ev.state, pct: ev.pct });
          else if (ev.type === 'language') onStatus?.({ state: 'language', lang: ev.lang }); // auto-detected spoken language
          else if (ev.type === 'error') { onError?.({ code: ev.code, message: ev.message, fatal: !!ev.fatal }); if (ev.fatal) { endSessionReq(); return finish(); } }
          else if (ev.type === 'end') return finish();
        }
      }
    } catch { /* stream dropped — treated as end below */ }
    finish();
  }

  // Mic → mono Float32 PCM at 16 kHz, shipped every CHUNK_MS.
  async function pumpAudio() {
    media = await navigator.mediaDevices.getUserMedia({ audio: true });
    ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(media);
    // ScriptProcessor keeps this CSP-simple (no separate worklet file); its
    // latency is irrelevant at dictation timescales.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let pending = [];
    let pendingLen = 0;
    let lastPost = Date.now();
    const flush = async () => {
      if (!pendingLen || !sid) return;
      const out = new Float32Array(pendingLen);
      let o = 0;
      for (const c of pending) { out.set(c, o); o += c.length; }
      pending = []; pendingLen = 0;
      try {
        await fetch(`${base}/stt/sessions/${sid}/audio`, { method: 'POST', body: out.buffer });
      } catch { if (recording) fail('gateway-unreachable', 'gateway stopped answering'); }
    };
    proc.onaudioprocess = (e) => {
      if (!recording) return;
      pending.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      pendingLen += e.inputBuffer.length;
      if (Date.now() - lastPost >= CHUNK_MS) { lastPost = Date.now(); flush(); }
    };
    src.connect(proc);
    proc.connect(ctx.destination); // required for onaudioprocess to fire; proc outputs silence
  }

  return {
    get recording() { return recording; },
    async start() {
      if (recording || finished) return;
      recording = true;
      try {
        const r = await fetch(`${base}/stt/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang: lang || undefined, redact: !!redact }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message || `HTTP ${r.status}`);
        sid = (await r.json()).id;
      } catch (e) { return fail('gateway-unreachable', e.message); }
      pumpEvents(); // long-lived; resolves when the session ends
      try {
        await pumpAudio();
      } catch (e) {
        return fail(e?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture', e.message);
      }
      onStart?.();
    },
    stop() {
      if (!recording) return;
      recording = false;
      stopCapture();
      endSessionReq(); // SSE delivers the flushed final + 'end' → finish() → onEnd
    },
    toggle() { if (this.recording) this.stop(); else this.start(); },
  };
}
