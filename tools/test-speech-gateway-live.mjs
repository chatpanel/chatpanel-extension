// The extension's speech.js driven against a REAL running gateway.
//
// Both sides' unit tests can pass while the wire between them disagrees — the
// extension mocks fetch, the gateway is tested without a client, and nothing in
// either suite ever sees /health's `tts` block and POST /tts in the same process.
// This is the one check that does.
//
// SKIPS when no gateway is listening, so CI and anyone without one is unaffected;
// it runs for free on a developer machine that has it up. Start one with:
//   chatpanel-gateway     (or: node bin/chatpanel-gateway.js in chatpanel-gateway)
import assert from 'node:assert/strict';

const GW = process.env.CHATPANEL_GATEWAY_URL || 'http://127.0.0.1:4320';

async function gatewayHasTts() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const res = await fetch(`${GW}/health`, { signal: c.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j?.tts?.enabled);
  } catch { return false; }
}

if (!(await gatewayHasTts())) {
  console.log(`○ speech↔gateway: skipped — no gateway with TTS at ${GW}`);
  process.exit(0);
}

// Minimal audio fakes: we care that BYTES arrive and play in order, not that this
// process makes a sound.
const played = [];
const blobs = [];
globalThis.Audio = class {
  constructor(url) { this.url = url; }
  play() { played.push(this.url); setTimeout(() => this.onended?.(), 1); return Promise.resolve(); }
  pause() {}
};
globalThis.URL.createObjectURL = (b) => { blobs.push(b); return `blob:${blobs.length}`; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = { speechSynthesis: undefined };

const { resolveSpeechProvider, createSpeech } = await import('../extension/js/speech.js');

// 1. The extension must RECOGNISE this gateway from the additive health block.
const eng = await resolveSpeechProvider({ gatewayUrl: GW });
assert.equal(eng.provider, 'gateway', 'a running gateway with TTS must resolve to the local provider');
assert.equal(eng.private, true, 'and local synthesis must be reported as private');

// 2. A multi-chunk answer must come back as real audio, in order.
const chunks = [];
const s = createSpeech({ provider: 'gateway', gatewayUrl: GW, onChunk: (i, n) => chunks.push([i, n]) });
await s.speak('The panel speaks. `code` and [a link](http://example.com) are read as words.\n\n'
  + 'This second paragraph exists to force a second chunk, so the prefetch path runs as well as the first request.');
assert.ok(played.length >= 2, `expected at least 2 chunks, played ${played.length}`);
assert.deepEqual(played, blobs.map((_, i) => `blob:${i + 1}`), 'chunks must play in the order they were requested');
for (const b of blobs) {
  const size = b.size ?? b.length ?? 0;
  assert.ok(size > 1000, `a chunk came back with only ${size} bytes — that is not audio`);
}
assert.equal(s.isSpeaking(), false, 'speaking must clear when the last chunk ends');

// 3. stop() has to actually stop — the bug that talks over the user.
const before = played.length;
const s2 = createSpeech({ provider: 'gateway', gatewayUrl: GW });
const p = s2.speak('One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve. Thirteen.');
setTimeout(() => s2.stop(), 120);
await p;
assert.ok(played.length - before <= 1, `stop() let ${played.length - before} chunks through`);
assert.equal(s2.isSpeaking(), false);

console.log(`✓ speech↔gateway (live at ${GW}): detected, ${blobs.length} chunks of real audio in order, stop() cancels`);
