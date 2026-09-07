// Getting to the offscreen document — the one place that knows how to open it.
//
// An MV3 service worker has no DOM and no audio: `new Audio()` and `AudioContext` simply do
// not exist there. So a timer that fires while no window is open — which is every timer worth
// having — cannot make a sound by itself. An offscreen document can.
//
// ONE DOCUMENT, TWO USES. Chrome allows a single offscreen document per extension, so the
// in-browser model and the alert sound share it, and its `reasons` have to cover both at
// CREATION time — whichever feature opens it first. Asking for AUDIO_PLAYBACK when the model
// opened it, or WORKERS when a timer did, is not something we can retrofit later.
//
// Tiny and dependency-free on purpose: the service worker imports this, and a worker cannot
// `import()` lazily — anything reachable from here is parsed on every cold start.

const PAGE = 'offscreen.html';
const REASONS = ['WORKERS', 'AUDIO_PLAYBACK'];
const JUSTIFICATION = 'Run the on-device AI model off the UI thread, and sound timer alerts '
  + 'when no window is open.';

let _ready = null;

/** True where an offscreen document is even a thing (Chromium; not Firefox). */
export const hasOffscreen = () => typeof chrome !== 'undefined' && !!chrome.offscreen;

/**
 * Make sure the offscreen document exists. Safe to call concurrently and repeatedly.
 *
 * Throws only when the platform has no offscreen API at all, so callers can fall back —
 * the panel to its in-page engine, a timer to the notification alone.
 */
export async function ensureOffscreenDoc() {
  if (!hasOffscreen()) throw new Error('offscreen API unavailable');
  if (_ready) return _ready;
  _ready = (async () => {
    if (await chrome.offscreen.hasDocument?.()) return;
    try {
      await chrome.offscreen.createDocument({ url: PAGE, reasons: REASONS, justification: JUSTIFICATION });
    } catch (e) {
      // Two callers can race past hasDocument() and both try to create it; the loser gets
      // "Only a single offscreen document may be created", which means the document we
      // wanted now exists. That is success, not failure.
      if (!/single offscreen document/i.test(String(e?.message || e))) throw e;
    }
  })();
  try { return await _ready; } catch (e) { _ready = null; throw e; }
}

/**
 * Is the document open RIGHT NOW?
 *
 * For callers that want to talk to it only if it already exists — telling the model engine to
 * drop a deleted model, say, which is pointless work if nothing is holding one. Never opens
 * it, and answers false where offscreen documents do not exist.
 */
export async function offscreenDocOpen() {
  if (!hasOffscreen()) return false;
  try { return !!(await chrome.offscreen.hasDocument?.()); } catch { return false; }
}

/**
 * Ask the offscreen document to sound the timer alert.
 *
 * FOR CALLERS WITH NO AUDIO OF THEIR OWN — which means the service worker, and only it. A
 * page (the side panel, the settings page) has AudioContext already and should import
 * js/alert-sound.js directly rather than opening a document to do it.
 *
 * Deliberately contains no `import()`: this module is on the SERVICE WORKER's static graph,
 * and a dynamic import there throws at runtime — so a lazily-loaded chime would be a chime
 * that never plays. test-service-worker-imports enforces exactly that.
 *
 * Returns whether the request was sent, which callers use to decide nothing: the notification
 * goes out either way, and a machine with no audio output must still get its reminder.
 */
export async function playAlertViaOffscreen(opts = {}) {
  try {
    await ensureOffscreenDoc();
    chrome.runtime.sendMessage({ target: 'offscreen-audio', type: 'alert', ...opts });
    return true;
  } catch {
    return false; // no offscreen API (Firefox) — the notification still goes out
  }
}
