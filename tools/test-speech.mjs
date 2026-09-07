// Voice out. The failure modes here are all about TIMING and CANCELLATION, not audio:
// a "Stop" that leaves one more chunk queued keeps talking over the user, and a
// reply spoken from raw markdown reads backticks and pipes out loud.
import assert from 'node:assert/strict';

// ── minimal DOM/audio fakes ─────────────────────────────────────────────────────
const played = [];
let audioInstances = [];
globalThis.Audio = class {
  constructor(url) { this.url = url; this.paused = false; audioInstances.push(this); }
  play() { played.push(this.url); setTimeout(() => this.onended?.(), 1); return Promise.resolve(); }
  pause() { this.paused = true; }
};
globalThis.URL.createObjectURL = (b) => `blob:${b.__id}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = { speechSynthesis: { speak() {}, cancel() {}, getVoices: () => [] } };

const { stripForSpeech, splitForSpeech, resolveSpeechProvider, createSpeech, probeGatewayTTS } =
  await import('../extension/js/speech.js');

// ── markdown is written to be read, not heard ───────────────────────────────────
{
  assert.equal(stripForSpeech('# Title\n\nSome **bold** text.'), 'Title\n\nSome bold text.');
  assert.match(stripForSpeech('Run ```js\nconst x=1;\n``` now'), /code block/,
    'a code block must be announced, not read line by line');
  assert.equal(stripForSpeech('See [the docs](https://x.com/y) here'), 'See the docs here',
    'a link should read as its text, not its URL');
  assert.equal(stripForSpeech('`inline` and *em*'), 'inline and em');
  assert.equal(stripForSpeech('| a | b |'), 'a   b'.replace(/\s+/g, ' ').trim() || 'a b');
  assert.equal(stripForSpeech(''), '');
  assert.equal(stripForSpeech(null), '');
}

// ── chunking exists for LATENCY: the first chunk must be short ──────────────────
{
  const long = 'First short one. ' + 'Then a much longer sentence that goes on. '.repeat(20);
  const parts = splitForSpeech(long);
  assert.ok(parts.length > 1, 'long text must be chunked so audio can start early');
  assert.ok(parts[0].length <= 90, `first chunk ${parts[0].length} chars — must stay small for time-to-first-sound`);
  // and the later ones are allowed to be bigger: once audio is playing, size is free
  assert.ok(parts.slice(1).some((p) => p.length > 90), 'later chunks should batch up, not stay tiny');
  // nothing is dropped
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  assert.ok(words(parts.join(' ')) >= words(stripForSpeech(long)) * 0.95, 'chunking lost text');
  assert.deepEqual(splitForSpeech(''), []);
  assert.deepEqual(splitForSpeech('   \n  '), []);
}

// ── provider resolution: gateway when it advertises tts, else browser ───────────
{
  const withFetch = async (impl, fn) => { const old = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = old; } };

  let r = await withFetch(async () => ({ ok: true, json: async () => ({ tts: { enabled: true, ready: false } }) }),
    () => resolveSpeechProvider({ gatewayUrl: 'http://127.0.0.1:4320' }));
  assert.equal(r.provider, 'gateway');
  assert.equal(r.private, true, 'local synthesis must be reported as private');

  // An OLDER gateway with no tts block must fall back, not throw — the Tesla rule.
  r = await withFetch(async () => ({ ok: true, json: async () => ({ ok: true, version: '0.6.1' }) }),
    () => resolveSpeechProvider({}));
  assert.equal(r.provider, 'browser');

  // tts present but disabled in config → fallback
  r = await withFetch(async () => ({ ok: true, json: async () => ({ tts: { enabled: false } }) }),
    () => resolveSpeechProvider({}));
  assert.equal(r.provider, 'browser');

  // No gateway at all → fallback, silently
  r = await withFetch(async () => { throw new Error('ECONNREFUSED'); }, () => resolveSpeechProvider({}));
  assert.equal(r.provider, 'browser');
  assert.equal(await withFetch(async () => { throw new Error('nope'); }, () => probeGatewayTTS()), null);
}

// ── gateway playback: chunks play IN ORDER, and one is prefetched ahead ─────────
{
  played.length = 0; audioInstances = [];
  const requested = [];
  let inFlight = 0, maxInFlight = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requested.push(body.text);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { ok: true, blob: async () => ({ __id: requested.length }) };
  };
  const seen = [];
  const s = createSpeech({ provider: 'gateway', gatewayUrl: 'http://127.0.0.1:4320', voice: 'af_heart', onChunk: (i, n) => seen.push([i, n]) });
  // Sentences long enough to actually cross the chunk caps.
  const A = `Alpha ${'a'.repeat(90)}.`, B = `Beta ${'b'.repeat(300)}.`, C = `Gamma ${'c'.repeat(300)}.`;
  await s.speak(`${A} ${B} ${C}`);
  assert.deepEqual(requested, [A, B, C], 'chunks must be requested in order');
  assert.equal(played.length, 3, 'every chunk must play');
  assert.ok(maxInFlight <= 2, `prefetch should stay one ahead, saw ${maxInFlight} concurrent`);
  assert.deepEqual(seen.map((x) => x[0]), [0, 1, 2]);
  assert.equal(s.isSpeaking(), false, 'speaking must clear when done');
}

// Short text must NOT be chunked — three round trips for one sentence is waste.
{
  const requested = [];
  globalThis.fetch = async (url, init) => { requested.push(JSON.parse(init.body).text); return { ok: true, blob: async () => ({ __id: 1 }) }; };
  const s = createSpeech({ provider: 'gateway' });
  await s.speak('One. Two. Three.');
  assert.deepEqual(requested, ['One. Two. Three.'], 'a short answer is one request');
}

// ── stop() is the one that matters: nothing may play after it ──────────────────
{
  played.length = 0; audioInstances = [];
  let resolveFetch;
  globalThis.fetch = async () => {
    await new Promise((r) => { resolveFetch = () => r(); });
    return { ok: true, blob: async () => ({ __id: 'late' }) };
  };
  const s = createSpeech({ provider: 'gateway' });
  const p = s.speak('Alpha. Beta. Gamma.');
  s.stop();                       // cancelled while the first fetch is still open
  resolveFetch?.();               // the request now lands — too late
  await p;
  assert.equal(played.length, 0, 'a chunk fetched after stop() must NOT play');
  assert.equal(s.isSpeaking(), false);
}

// ── a gateway error surfaces as a message, and never leaves us "speaking" ───────
{
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'tts model not ready' } }) });
  let err = null, ended = false;
  const s = createSpeech({ provider: 'gateway', onError: (m) => { err = m; }, onEnd: () => { ended = true; } });
  await s.speak('Hello there.');
  assert.equal(err, 'tts model not ready', 'the gateway\'s reason should reach the user');
  assert.equal(ended, true, 'onEnd must fire even on failure, or the UI stays stuck mid-speak');
  assert.equal(s.isSpeaking(), false);
}

// ── browser fallback speaks, and cancels previous speech first ─────────────────
{
  const calls = [];
  globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  globalThis.window.speechSynthesis = {
    speak(u) { calls.push(['speak', u.text]); setTimeout(() => u.onend?.(), 1); },
    cancel() { calls.push(['cancel']); },
    getVoices: () => [],
  };
  const s = createSpeech({ provider: 'browser' });
  await s.speak('# Heading\n\nHello **world**.');
  assert.deepEqual(calls[0], ['cancel'], 'a new utterance must cancel the old one first');
  assert.equal(calls[1][0], 'speak');
  assert.equal(calls[1][1], 'Heading\n\nHello world.', 'browser voice gets stripped text too');
}

console.log('✓ speech: markdown stripping, latency chunking, provider ladder, ordered playback, prefetch bound, stop-after-fetch, error surfacing, browser fallback');
