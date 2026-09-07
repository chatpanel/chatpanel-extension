// Voice activity detection for barge-in — pure maths, no audio API.
//
// Waiting for a TRANSCRIPT to interrupt the assistant is too slow: the speech
// engine commits a final only after the speaker pauses, so you finish your whole
// sentence into a still-talking assistant. Interruption has to trigger on the
// fact that you STARTED talking, and the transcript then arrives as the next
// question on its own.
//
// It also removes the word-count filter's cost: "stop" is one word, and by the
// time it was rejected as possible echo the moment had passed. Energy is a
// different signal from text — our own audio is removed by echo cancellation, and
// whatever leaks past it is far below a voice at the microphone.
//
//   const vad = createVad();
//   vad.feed(energy)   -> true on the frame the person is judged to have started
//   vad.reset()
//
// `energy` is 0..1: the mean of an analyser's low bins over 255. Two safeguards
// against a false trigger: the level must exceed a noise FLOOR learned while the
// room is quiet by a wide ratio, and must stay there for several consecutive
// frames — a door slam is loud for one frame, speech for many.

export const VAD_DEFAULTS = Object.freeze({
  minFrames: 12,     // ~200ms at 60fps before we call it speech
  ratio: 3.0,        // must exceed the learned floor by this factor…
  minEnergy: 0.06,   // …and this absolute level, so a silent room's floor of ~0 does not trigger on nothing
  floorAlpha: 0.02,  // how fast the floor follows quiet frames
  cooldownFrames: 45, // after firing, ignore ~750ms so one interruption is one
});

export function createVad(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  let floor = 0.02;
  let run = 0;
  let cooldown = 0;

  return {
    get floor() { return floor; },
    feed(energy) {
      const e = Math.max(0, Math.min(1, Number(energy) || 0));
      if (cooldown > 0) { cooldown--; return false; }
      const threshold = Math.max(o.minEnergy, floor * o.ratio);
      if (e >= threshold) {
        run++;
        if (run >= o.minFrames) { run = 0; cooldown = o.cooldownFrames; return true; }
        return false;
      }
      run = 0;
      // Only quiet frames teach the floor — a loud one would raise it and make the
      // next real interruption harder to hear.
      floor += (e - floor) * o.floorAlpha;
      return false;
    },
    reset() { run = 0; cooldown = 0; },
  };
}

/** Mean low-band energy of an analyser frame, 0..1. Speech lives in the low bins. */
export function lowBandEnergy(bins, fraction = 0.25) {
  if (!bins || !bins.length) return 0;
  const n = Math.max(1, Math.floor(bins.length * fraction));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += bins[i];
  return sum / n / 255;
}
