// Barge-in by voice. Interruption has to trigger on the fact that you STARTED
// talking — a transcript arrives only after you pause, by which time you have
// finished your sentence into a still-talking assistant. These pin the two ways an
// energy detector goes wrong: firing on nothing, and not firing on speech.
import assert from 'node:assert/strict';
import { createVad, lowBandEnergy, VAD_DEFAULTS } from '../extension/js/voice-vad.js';

const feedN = (vad, e, n) => { let fired = false; for (let i = 0; i < n; i++) fired = vad.feed(e) || fired; return fired; };

// ── a quiet room never fires ───────────────────────────────────────────────────
{
  const vad = createVad();
  assert.equal(feedN(vad, 0.01, 300), false, 'room tone must never interrupt the assistant');
  assert.equal(feedN(vad, 0, 300), false, 'and neither must total silence');
}

// ── speech fires, and quickly ──────────────────────────────────────────────────
{
  const vad = createVad();
  feedN(vad, 0.01, 60);                   // learn the room
  let at = -1;
  for (let i = 0; i < 60; i++) if (vad.feed(0.4)) { at = i; break; }
  assert.ok(at >= 0, 'sustained speech must fire');
  assert.ok(at <= VAD_DEFAULTS.minFrames, `it fired after ${at} frames; must not need more than ${VAD_DEFAULTS.minFrames}`);
  assert.ok(VAD_DEFAULTS.minFrames <= 18, 'the confirmation window must stay under ~300ms at 60fps or the interruption feels laggy');
}

// ── one loud frame is a door, not a person ─────────────────────────────────────
{
  const vad = createVad();
  feedN(vad, 0.01, 60);
  const fired = vad.feed(0.95) || feedN(vad, 0.01, 10);
  assert.equal(fired, false, 'a single loud frame must not interrupt — that is a door slam or a cough');
}

// ── echo leaking past cancellation is a low, steady hum — it raises nothing ─────
// Whatever survives AEC is far below a voice at the microphone. It must not fire,
// and it must not be learned as "the floor" in a way that then hides real speech.
{
  const vad = createVad();
  feedN(vad, 0.03, 300);                  // constant faint leak, well under minEnergy
  assert.equal(vad.feed(0.03), false, 'a faint steady leak must not fire');
  let fired = false;
  for (let i = 0; i < 40; i++) fired = vad.feed(0.45) || fired;
  assert.ok(fired, 'and a real voice over that leak must still fire');
}

// ── a loud room raises the bar rather than firing constantly ───────────────────
{
  const vad = createVad();
  // A loud frame does NOT teach the floor (only quiet frames do), so a continuous
  // loud environment is a different problem — but a ROOM that is merely lively
  // (below minEnergy) should be absorbed as floor and then need a bigger jump.
  feedN(vad, 0.05, 400);
  assert.equal(feedN(vad, 0.05, 60), false, 'a lively-but-quiet room must not fire on its own level');
  const before = vad.floor;
  assert.ok(before > 0.03, 'the floor should have risen toward the room level');
}

// ── after firing, one interruption is one ─────────────────────────────────────
{
  const vad = createVad();
  feedN(vad, 0.01, 60);
  let count = 0;
  for (let i = 0; i < 60; i++) if (vad.feed(0.5)) count++;
  assert.equal(count, 1, `continuous speech for a second must fire once, not ${count} times — the cooldown exists for this`);
}

// ── reset clears the confirmation run and the cooldown ────────────────────────
{
  const vad = createVad();
  feedN(vad, 0.5, VAD_DEFAULTS.minFrames - 1);   // one frame short
  vad.reset();
  assert.equal(vad.feed(0.5), false, 'a reset must discard a partial run');
}

// ── the energy read is the LOW band, where speech lives ───────────────────────
{
  const bins = new Uint8Array(256);
  bins.fill(200, 0, 64);                   // low band loud
  assert.ok(lowBandEnergy(bins) > 0.7, 'low-band energy must reflect the low bins');
  const hiss = new Uint8Array(256);
  hiss.fill(200, 200, 256);                // only hiss up top
  assert.ok(lowBandEnergy(hiss) < 0.05, 'high-frequency hiss must barely register');
  assert.equal(lowBandEnergy(null), 0);
  assert.equal(lowBandEnergy(new Uint8Array(0)), 0);
}

console.log('✓ voice-vad: quiet room never fires, speech fires within ~200ms, a slam does not, echo leak does not but voice over it does, one interruption is one, low band is what is measured');
