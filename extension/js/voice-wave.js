// The shape of the voice waveform — pure maths, no canvas, no DOM.
//
// Separated out because the first two attempts were wrong in a way that is
// invisible from reading the code and obvious from measuring it: the idle
// amplitude worked out to a mean of 1.7px inside a 56px canvas, so the band drew
// as a flat line. That is a numeric bug in a pure function, and it belongs
// somewhere it can be asserted rather than eyeballed.
//
// Returns HALF-heights in pixels, one per point, to be mirrored about the centre.

export const POINTS = 72;

// Idle is not decoration. A bar that looks blank cannot be told apart from one
// that is broken, so when there is no signal the band still travels — clearly,
// not at the threshold of visibility.
const IDLE_BASE = 0.26;   // fraction of the available half-height
const IDLE_SWING = 0.16;

/**
 * @param {{ points?: number, t?: number, level?: Float32Array|null, height: number,
 *           amplitude?: number, motion?: boolean }} opts
 *   level     0..1 per point, from an analyser; null/absent means idle
 *   t         frame counter, drives the travelling wave
 *   amplitude fraction of the canvas height the band may use, half above and half below
 *   motion    false under prefers-reduced-motion: the idle wave stops TRAVELLING,
 *             but the band still follows the analyser. Reduced motion means drop
 *             the decoration, not the information — freezing a display of the
 *             user's own voice makes the feature look broken, which is exactly
 *             what happened when this drew a single static frame and stopped.
 */
export function waveShape({ points = POINTS, t = 0, level = null, height, amplitude = 0.44, motion = true } = {}) {
  const maxAmp = Math.max(1, height * amplitude);
  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    // A single travelling sine. An earlier version multiplied two of them, which
    // spends most of its time near zero — the product is why this looked dead.
    // With motion off the phase is fixed, so the resting band has a shape but does
    // not animate.
    const idle = motion
      ? IDLE_BASE + IDLE_SWING * Math.sin(i * 0.38 - t * 0.09)
      : IDLE_BASE * 0.6;
    const signal = level ? Math.max(0, level[i] || 0) : 0;
    // Taper the ends so it reads as a voice rather than a rectangle.
    const taper = Math.sin((Math.PI * (i + 0.5)) / points) ** 0.7;
    out[i] = Math.max(idle, signal) * taper * maxAmp;
  }
  return out;
}

/**
 * Smooth a raw analyser frame into per-point levels, in place.
 *
 * Fast to rise so a syllable lands crisply, slow to fall so the band does not
 * flicker between words. Bins are sampled with a squared index because speech
 * energy sits low — a linear sweep spends most of the width on hiss that never
 * moves.
 */
export function smoothLevels(level, bins, points = POINTS) {
  for (let i = 0; i < points; i++) {
    let v = 0;
    if (bins && bins.length) {
      const from = Math.floor((i / points) ** 2 * bins.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / points) ** 2 * bins.length));
      let sum = 0;
      for (let j = from; j < to; j++) sum += bins[j];
      v = (sum / (to - from)) / 255;
    }
    level[i] += (v - level[i]) * (v > level[i] ? 0.5 : 0.12);
  }
  return level;
}
