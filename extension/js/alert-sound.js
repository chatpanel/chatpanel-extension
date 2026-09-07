// The sound a timer makes when it goes off.
//
// A timer that finishes silently is a timer that did not go off. Jobs and widget timers both
// delivered a chrome notification and nothing else — and a notification is a thing you SEE,
// which is no use at all for the one feature whose entire point is telling you about
// something while you are looking elsewhere. On Windows in particular, Chrome's own
// notifications frequently arrive silent (Focus Assist, per-app notification settings), so
// "the OS will chime" was never a plan.
//
// SYNTHESIZED, not a file. A two-note chime is a dozen lines of Web Audio and costs nothing
// to ship, while an audio asset is bytes in every package, a decode on every play, and one
// more thing the Firefox build has to carry. It also means the sound works offline and
// cannot 404.
//
// Pure Web Audio and nothing else — no chrome.*, no DOM — so the same module plays in the
// side panel (where a widget timer lives) and in the offscreen document (where the service
// worker's timers land, since a worker has no audio API at all).

// A rising perfect fifth: two short sine tones, the second a fifth above the first. Chosen to
// be audible over a call without being an alarm — a timer is information, not an emergency.
const CHIME = Object.freeze([
  { freq: 660, at: 0, dur: 0.16 },   // E5
  { freq: 990, at: 0.17, dur: 0.30 }, // B5
]);

// Loud enough to hear across a room, quiet enough not to startle someone wearing headphones.
export const DEFAULT_GAIN = 0.18;

let _ctx = null;
function context() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  // Reused: constructing an AudioContext per beep leaks hardware audio streams, and browsers
  // cap how many a page may hold.
  if (!_ctx || _ctx.state === 'closed') _ctx = new Ctx();
  return _ctx;
}

/**
 * Play the alert. Resolves when the sound has finished, or immediately if it cannot play.
 *
 * NEVER THROWS. Audio can be refused for reasons that have nothing to do with the timer —
 * no output device, an autoplay policy, a suspended context — and a timer whose notification
 * failed to make a noise must still deliver its notification.
 *
 * @param repeat how many times to sound it (a reminder you asked to be sticky gets two)
 * @returns true if it actually played
 */
export async function playAlert({ gain = DEFAULT_GAIN, repeat = 1 } = {}) {
  const ctx = context();
  if (!ctx) return false;
  try {
    // A context created before any user gesture starts suspended; in an offscreen document
    // there IS no gesture, and resume() is what makes it audible anyway.
    if (ctx.state === 'suspended') await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = Math.max(0, Math.min(1, gain));
    master.connect(ctx.destination);
    const startedAt = ctx.currentTime;
    const cycle = 0.55;
    const times = Math.max(1, Math.min(3, Math.floor(repeat) || 1));
    for (let r = 0; r < times; r++) {
      for (const note of CHIME) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = note.freq;
        const t0 = startedAt + r * cycle + note.at;
        // A hard start/stop on a sine is a click. Ramp both ends.
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(1, t0 + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
        osc.connect(env);
        env.connect(master);
        osc.start(t0);
        osc.stop(t0 + note.dur + 0.02);
      }
    }
    const total = (times - 1) * cycle + CHIME[CHIME.length - 1].at + CHIME[CHIME.length - 1].dur;
    await new Promise((r) => { setTimeout(r, Math.ceil(total * 1000) + 60); });
    try { master.disconnect(); } catch { /* already torn down */ }
    return true;
  } catch {
    return false; // a silent timer is bad; a timer that throws instead of firing is worse
  }
}

/** Testing seam / teardown: drop the shared context. */
export function closeAlertAudio() {
  try { _ctx?.close?.(); } catch { /* ignore */ }
  _ctx = null;
}
