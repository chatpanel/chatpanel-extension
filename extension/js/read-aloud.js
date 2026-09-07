// One voice at a time, panel-wide.
//
// speech.js is the capability (providers, chunking, playback). This is the thin
// piece of state a UI needs on top of it: WHICH message is currently speaking, so
// a second Speak stops the first instead of talking over it, and every button can
// render itself correctly without each one holding its own controller.
//
// Deliberately tiny and DOM-free — the side panel, notes and the meetings viewer
// all want "read this aloud" and none of them should own the audio.

let ctl = null;             // the live speech controller from speech.js
let current = null;         // id of whatever is speaking, or null
let engine = null;          // cached provider resolution
let engineAt = 0;
const listeners = new Set();

// The gateway can start (or stop) while the panel is open, so the provider probe is
// cached only briefly — long enough that a burst of buttons doesn't re-probe, short
// enough that starting the gateway is noticed without a reload.
const ENGINE_TTL_MS = 30_000;

export function onSpeakChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) { try { fn(current); } catch { /* a bad listener must not stop the others */ } }
}

export function speakingId() { return current; }
export function speechEngine() { return engine; }

export function stopSpeak() {
  try { ctl?.stop(); } catch { /* nothing playing */ }
  ctl = null;
  if (current !== null) { current = null; emit(); }
}

export async function resolveEngine({ gatewayUrl } = {}) {
  const fresh = engine && Date.now() - engineAt < ENGINE_TTL_MS;
  if (fresh) return engine;
  const { resolveSpeechProvider } = await import('./speech.js');
  engine = await resolveSpeechProvider({ gatewayUrl });
  engineAt = Date.now();
  return engine;
}

/**
 * Speak `text` for `id`, or stop if `id` is already speaking (so one button is both
 * Speak and Stop). Resolves when playback finishes or is cancelled.
 */
export async function toggleSpeak(id, text, { gatewayUrl, voice, speed, onError } = {}) {
  if (current === id) { stopSpeak(); return; }
  stopSpeak(); // a different message was speaking — it yields immediately

  const eng = await resolveEngine({ gatewayUrl });
  if (!eng || eng.provider === 'none') { onError?.('Speech isn’t available in this browser'); return; }

  const { createSpeech } = await import('./speech.js');
  current = id;
  emit();
  ctl = createSpeech({
    provider: eng.provider,
    gatewayUrl,
    voice,
    speed,
    onError: (m) => onError?.(m),
    onEnd: () => {
      // Only clear if WE are still the current speaker: a fast Speak→Speak hands
      // over to the next message, and the old controller's onEnd must not wipe it.
      if (current === id) { current = null; ctl = null; emit(); }
    },
  });
  await ctl.speak(text);
}

// ── the button ────────────────────────────────────────────────────────────────
// Kept here rather than in sidepanel.js so none of it lands on first paint, and so
// the "which button is speaking" refresh has exactly one implementation for every
// surface that grows a Speak button (panel today, notes and meetings next).
let wired = false;
let toldEngine = false;
const ICONS = {};

export function registerSpeakIcons(icons) { Object.assign(ICONS, icons); }

function refreshButtons(id) {
  for (const el of document.querySelectorAll('[data-speak-for]')) {
    const on = el.dataset.speakFor === String(id ?? '');
    el.innerHTML = ICONS[on ? 'stop' : 'speak'] || '';
    el.title = on ? 'Stop' : 'Read aloud';
    el.classList.toggle('speaking', on);
  }
}

/** Speak (or stop) one message and keep every Speak button in the DOM in step. */
export async function speakMessage(id, text, { gatewayUrl, voice, speed, toast } = {}) {
  if (!wired) { wired = true; onSpeakChange(refreshButtons); }
  const starting = speakingId() !== id;
  await toggleSpeak(id, text, {
    gatewayUrl, voice, speed,
    onError: (m) => toast?.(`\u2715 ${m}`, 3000),
  });
  // Say WHERE the voice came from the first time: local synthesis is a privacy
  // property, and a silent fallback to the OS voice would hide that the gateway
  // is not running.
  if (starting && !toldEngine) {
    toldEngine = true;
    if (engine?.provider === 'browser') toast?.('Speaking with the browser voice — start the gateway for local Kokoro', 3400);
  }
}
