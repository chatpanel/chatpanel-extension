// The waveform drew as a flat line twice, and both times the bug was arithmetic
// that looks perfectly reasonable in a diff. So the shape is a pure function and
// these assert the things you would otherwise have to squint at a screen to see:
// that the band has real thickness, and that it moves.
import assert from 'node:assert/strict';
import { waveShape, smoothLevels, POINTS } from '../extension/js/voice-wave.js';

const H = 56; // the bar's actual height

function stats(curve) {
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (const v of curve) { mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; }
  return { min: mn, max: mx, mean: sum / curve.length };
}

// ── idle must be VISIBLE ───────────────────────────────────────────────────────
// The version this replaced had a mean half-height of 0.85px inside 56 — a band
// under 2px thick, which is a line. Anything at that scale is indistinguishable
// from broken, so the floor is asserted rather than trusted.
{
  let worstMean = Infinity;
  for (let t = 0; t < 400; t += 3) worstMean = Math.min(worstMean, stats(waveShape({ t, height: H })).mean);
  assert.ok(worstMean * 2 >= 5,
    `idle band is only ${(worstMean * 2).toFixed(1)}px thick at its thinnest — that reads as a flat line`);
}

// ── and it must MOVE ───────────────────────────────────────────────────────────
{
  const a = waveShape({ t: 0, height: H });
  const b = waveShape({ t: 20, height: H });
  let biggest = 0;
  for (let i = 0; i < a.length; i++) biggest = Math.max(biggest, Math.abs(a[i] - b[i]));
  assert.ok(biggest >= 2, `the idle wave only moves ${biggest.toFixed(2)}px — it will look frozen`);

  // Travelling, not pulsing in unison: neighbouring points must differ, or the
  // whole band just breathes as one block.
  const c = waveShape({ t: 7, height: H });
  let neighbourSpread = 0;
  for (let i = 1; i < c.length; i++) neighbourSpread = Math.max(neighbourSpread, Math.abs(c[i] - c[i - 1]));
  assert.ok(neighbourSpread > 0.2, 'the wave must travel along the band, not pulse as one block');
}

// ── real signal dominates the idle motion ──────────────────────────────────────
{
  const loud = new Float32Array(POINTS).fill(1);
  const quiet = waveShape({ t: 0, height: H });
  const speaking = waveShape({ t: 0, height: H, level: loud });
  assert.ok(stats(speaking).mean > stats(quiet).mean * 2,
    'speech must clearly rise above the resting wave, or talking looks the same as silence');
  // …and stays inside the canvas.
  assert.ok(stats(speaking).max <= H / 2, 'the band must not overflow the canvas');
}

// ── the ends taper, so it reads as a voice and not a rectangle ────────────────
{
  const c = waveShape({ t: 0, height: H, level: new Float32Array(POINTS).fill(1) });
  const mid = c[Math.floor(POINTS / 2)];
  assert.ok(c[0] < mid * 0.35 && c[POINTS - 1] < mid * 0.35, 'the ends must taper');
}

// ── smoothing: fast up, slow down ─────────────────────────────────────────────
// A band that falls as fast as it rises flickers between words.
{
  const level = new Float32Array(POINTS);
  const loudBins = new Uint8Array(256).fill(255);
  smoothLevels(level, loudBins);
  const afterOneLoudFrame = level[Math.floor(POINTS / 2)];
  assert.ok(afterOneLoudFrame > 0.3, 'a loud frame must register immediately, or syllables are missed');

  const before = level[Math.floor(POINTS / 2)];
  smoothLevels(level, new Uint8Array(256)); // silence
  const after = level[Math.floor(POINTS / 2)];
  assert.ok(after < before, 'it must decay');
  assert.ok(after > before * 0.5, 'but not collapse in one frame — that is what flickers between words');
}

// ── degenerate inputs must not throw or produce NaN ───────────────────────────
{
  for (const c of [waveShape({ height: 0 }), waveShape({ height: 1 }), waveShape({ height: H, level: new Float32Array(POINTS) })]) {
    assert.ok(c.every((v) => Number.isFinite(v) && v >= 0), 'every point must be a finite, non-negative height');
  }
  assert.doesNotThrow(() => smoothLevels(new Float32Array(POINTS), null));
  assert.doesNotThrow(() => smoothLevels(new Float32Array(POINTS), new Uint8Array(0)));
}

console.log('✓ voice-wave: idle band is thick enough to see, travels rather than pulses, speech rises clearly above it, ends taper, levels rise fast and fall slow, degenerate input is finite');
