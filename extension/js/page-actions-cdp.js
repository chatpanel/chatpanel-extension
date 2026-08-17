// High-reliability page control via api.debugger + the Chrome DevTools
// Protocol (CDP) Input domain — the same mechanism Puppeteer/Playwright use.
//
// Why this exists: the default path in page-actions.js sets values and dispatches
// SYNTHETIC events (isTrusted:false). Native inputs accept those, but many custom
// widgets, strict React handlers, and validation gates reject anything that isn't
// a real user event. CDP Input.* produces TRUSTED events at the browser level —
// indistinguishable from a human — so it works where synthetic events silently
// fail. The cost is the `debugger` permission and Chrome's persistent
// "ChatPanel is debugging this browser" banner, so this is opt-in only.
//
// Division of labour: READING the page (locate elements, read back state) stays
// on api.scripting — it's reliable and cheap. CDP is used only for the ACT
// (trusted clicks + typed text). We locate an element's viewport centre via
// scripting, then dispatch trusted mouse/keyboard at those coordinates.

import { flashHighlight, showCursor } from './page-actions.js';
import { api } from './browser-api.js';

const CDP_VERSION = '1.3';
const IDLE_DETACH_MS = 8000; // drop the debugger (and its banner) after a lull

const truthy = (v) =>
  v === true || v === 'true' || v === 'on' || v === 1 || v === '1' || v === 'yes';

// --------------------------------------------------------------------------
// Debugger session: attach lazily, hold briefly, auto-detach when idle
// --------------------------------------------------------------------------
const sessions = new Map(); // tabId → { timer }

// Tabs whose pointer we captured. Detaching drops the focus emulation that keeps
// the lock alive, and a page that loses focus loses the pointer — so a captured
// tab gets a much longer idle window, and re-applies focus emulation if Chrome
// detaches us anyway (navigation, banner dismissed) and we re-attach.
const capturedTabs = new Set();
const CAPTURED_IDLE_DETACH_MS = 30000;

function bump(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  const idle = capturedTabs.has(tabId) ? CAPTURED_IDLE_DETACH_MS : IDLE_DETACH_MS;
  s.timer = setTimeout(() => detach(tabId), idle);
}

async function ensureAttached(tabId) {
  // `debugger` is a required permission, so the namespace is always present —
  // but guard anyway so a stripped build degrades to the scripting fallback.
  if (!api.debugger) {
    const err = new Error('Debugger API unavailable in this build.');
    err.code = 'no-debugger-perm';
    throw err;
  }
  ensureDetachHook();
  if (!sessions.has(tabId)) {
    try {
      await api.debugger.attach({ tabId }, CDP_VERSION);
    } catch (e) {
      // Already attached by another client (DevTools open on this tab) → unusable.
      if (/already attached/i.test(e.message)) {
        // Now that high-reliability is the default, this is the failure a
        // developer with DevTools open will actually meet — so name both ways out.
        throw new Error(
          'Chrome DevTools is open on this tab, and only one debugger can attach at a time. ' +
          'Close DevTools on this tab, or turn off "High-reliability page control" in ChatPanel ' +
          'settings to fall back to synthetic events.',
        );
      }
      throw e;
    }
    sessions.set(tabId, {});
    // Re-arm focus emulation on a fresh session for a tab we had captured —
    // otherwise the page silently loses focus, and with it the pointer.
    if (capturedTabs.has(tabId)) {
      try {
        await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch {
        /* best effort — capture_pointer reports the real state anyway */
      }
    }
  }
  bump(tabId);
}

// Screenshot the attached tab's viewport via CDP — works even when the tab isn't
// focused (unlike tabs.captureVisibleTab). Returns a JPEG data URL.
export async function cdpScreenshot(tabId) {
  await ensureAttached(tabId);
  try {
    const r = await send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    bump(tabId);
    return r?.data ? `data:image/jpeg;base64,${r.data}` : null;
  } catch {
    return null;
  }
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(tabId);
  pointerPos.delete(tabId); // the virtual position is only meaningful within a session
  try {
    await api.debugger.detach({ tabId });
  } catch {
    /* tab closed / already gone */
  }
}

// Chrome detaches us on its own (navigation, tab close, user clicks "cancel" on
// the banner). Keep our map in sync so we re-attach cleanly next time. Registered
// lazily because the `api.debugger` namespace can be absent until the optional
// permission is granted, and this module loads at startup.
let detachHooked = false;
function ensureDetachHook() {
  if (detachHooked || !api.debugger?.onDetach) return;
  detachHooked = true;
  api.debugger.onDetach.addListener((src) => {
    if (src.tabId == null) return;
    pointerPos.delete(src.tabId);
    capturedTabs.delete(src.tabId); // tab closed / navigated / user cancelled the banner
    const s = sessions.get(src.tabId);
    if (s) {
      clearTimeout(s.timer);
      sessions.delete(src.tabId);
    }
  });
}

const send = (tabId, method, params) =>
  api.debugger.sendCommand({ tabId }, method, params || {});

/**
 * The page as Chrome's ACCESSIBILITY TREE — roles and names, not coordinates.
 *
 * Everything else here synthesizes input at pixel positions, and a small model is bad at
 * pixels: it guessed 500,630 and then 500,550, drew nothing, and reported success. That is
 * not a prompting problem. Asking a model to estimate where a button is, when the browser
 * already knows its name and role, is asking the wrong question.
 *
 * Chrome computes this tree for screen readers, so it is maintained by someone else, works
 * on apps we have never seen, and needs no per-site rules — the thing the hostname table
 * was rejected for. "Click the button named 'Rectangle'" is a request a 2B model can get
 * right; "click at 500,630" is not.
 *
 * A canvas exposes nothing here, so pixels remain the answer for drawing apps. This is an
 * addition to that path, not a replacement for it.
 */
export async function readAxTree(tabId, { max = 200 } = {}) {
  await ensureAttached(tabId);
  await send(tabId, 'Accessibility.enable');
  const res = await send(tabId, 'Accessibility.getFullAXTree', { depth: -1 });
  const nodes = res?.nodes || [];
  const val = (p) => (p && typeof p === 'object' ? p.value : p);
  const out = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = String(val(n.role) || '');
    const name = String(val(n.name) || '').replace(/\s+/g, ' ').trim();
    // A node with no name cannot be asked for by name, so it is noise here — the DOM
    // inspector still covers selector-based work.
    if (!name || !INTERESTING_ROLES.has(role)) continue;
    const props = {};
    for (const p of n.properties || []) {
      const v = val(p.value);
      // Only states that change what a model should DO with the node.
      if (['disabled', 'checked', 'expanded', 'focused', 'required', 'selected'].includes(p.name) && v !== false && v != null) {
        props[p.name] = v;
      }
    }
    out.push({ role, name: name.length > 120 ? `${name.slice(0, 117)}…` : name, ...(Object.keys(props).length ? { state: props } : {}) });
    if (out.length >= max) break;
  }
  return { nodes: out, truncated: out.length >= max };
}

// Roles worth offering a model: things it can act on or read as structure. Everything else
// (generic containers, presentational wrappers) is tree noise that would crowd out the rest.
const INTERESTING_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox',
  'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'heading', 'img', 'dialog', 'alert', 'status', 'progressbar',
]);

/**
 * What is at a point, and what has focus after clicking it.
 *
 * Deliberately shallow — a tag, a role, a short label — because the question a caller has
 * is "did I hit the thing I meant", not "describe the DOM". `focused` is the half that
 * matters for typing: text goes to whatever holds focus, so a click that focused nothing
 * means the next type_text will land nowhere, which is exactly the failure this is for.
 */
async function probeClick(tabId, x, y) {
  return script(tabId, (px, py) => {
    const label = (el) => {
      if (!el) return null;
      const name = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '';
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const bits = [el.tagName?.toLowerCase(), el.getAttribute?.('role'), name || text].filter(Boolean);
      return bits.join(' · ') || null;
    };
    const el = document.elementFromPoint(px, py);
    const active = document.activeElement;
    const editable = !!active && (
      active.isContentEditable
      || ['input', 'textarea', 'select'].includes(active.tagName?.toLowerCase())
      || active.getAttribute?.('role') === 'textbox'
    );
    return {
      hit: label(el),
      focused: label(active),
      // The one fact that decides whether typing will go anywhere.
      typingGoesTo: editable ? label(active) : null,
    };
  }, [x, y]);
}

async function script(tabId, func, args = []) {
  const [inj] = await api.scripting.executeScript({ target: { tabId }, func, args });
  return inj?.result;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// POINTER LOCK — the mode that breaks coordinate-based control
//
// When a page calls requestPointerLock() (3D games, first-person views, some map
// and CAD tools), the OS cursor is hidden and the page STOPS receiving positions.
// It reads only `movementX/movementY` deltas, and whatever the app acts on sits at
// a fixed reticle — usually the viewport centre. Two consequences:
//
//   • a click's x/y is IGNORED — you cannot click a thing by aiming at its pixels;
//     you must first turn the view until the target is under the reticle;
//   • a mouse move is a TURN, not a jump — so moving "to" a coordinate before
//     clicking silently rotates the view away from the target.
//
// Chrome derives the movement delta from the difference between CONSECUTIVE
// dispatched positions, so relative motion is expressed by dispatching a position
// offset from the last one. While locked the page never reads the absolute value,
// so we let that virtual position drift outside the viewport instead of clamping —
// clamping at an edge would silently swallow every further turn in that direction.
// --------------------------------------------------------------------------
const pointerPos = new Map(); // tabId → { x, y } virtual position we last dispatched

// Also report the biggest <canvas>. A page dominated by one is almost certainly a
// canvas app, and "big canvas + NOT locked" is the exact state in which relative
// aiming silently does nothing — so the caller can say so instead of letting an
// agent turn an uncaptured pointer in circles.
function pointerStateInPage() {
  let best = null;
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (!best || area > best.area) best = { area, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dominant = !!best && best.area >= vw * vh * 0.5;
  return {
    locked: !!document.pointerLockElement,
    w: vw,
    h: vh,
    hasFocus: document.hasFocus(),
    canvas: best ? { w: best.w, h: best.h, cx: Math.round(best.x + best.w / 2), cy: Math.round(best.y + best.h / 2) } : null,
    canvasApp: dominant,
  };
}
// Aiming is a BURST — many small turns in a row — and probing the page before each
// one would put a scripting round-trip on the hot path. Cache it briefly. Lock
// state changes on a click (canvases grab the pointer on click) or a key (Escape
// releases it), so those invalidate the cache explicitly; the TTL is just a
// backstop for a page that locks on its own.
const POINTER_STATE_TTL_MS = 500;
const pointerState = new Map(); // tabId → { at, val }
const invalidatePointerState = (tabId) => pointerState.delete(tabId);

async function readPointerState(tabId) {
  const hit = pointerState.get(tabId);
  if (hit && Date.now() - hit.at < POINTER_STATE_TTL_MS) return hit.val;
  try {
    const val = await script(tabId, pointerStateInPage);
    pointerState.set(tabId, { at: Date.now(), val });
    // Self-correcting: the moment the page is seen WITHOUT the lock it stops
    // earning the long idle window, so a tab that navigated away from a game (or
    // where the user pressed Escape) goes back to the normal short session.
    if (!val?.locked) capturedTabs.delete(tabId);
    return val;
  } catch {
    return null;
  }
}
// Where the virtual pointer is now — defaults to the viewport centre, which is
// also where a locked app's reticle sits.
function pointerAt(tabId, st) {
  const cur = pointerPos.get(tabId);
  if (cur) return cur;
  const c = { x: Math.round((st?.w || 800) / 2), y: Math.round((st?.h || 600) / 2) };
  pointerPos.set(tabId, c);
  return c;
}

// CDP's `buttons` is a bitmask of what's held DOWN; `button` names the one that
// changed. Keep them consistent or apps that read either field misbehave.
const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const normButton = (b) => {
  const s = String(b || 'left').toLowerCase();
  return BUTTON_MASK[s] ? s : 'left';
};

// One trusted click. `button` reaches right/middle (context menus, and the
// secondary action in most canvas apps and games); `clickCount` 2 makes a real
// double-click — dispatched as two press/release pairs with an incrementing
// count, which is what Chrome turns into a `dblclick`.
//
// `move:false` suppresses the leading mouseMoved. That matters under POINTER LOCK,
// where a move is not "go to this spot" but "turn the camera by this delta" — so
// moving before a click would swing the aim off target and the click lands
// somewhere else entirely.
async function trustedClick(tabId, x, y, button = 'left', clickCount = 1, { move = true } = {}) {
  const b = normButton(button);
  const buttons = BUTTON_MASK[b];
  if (move) await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let n = 1; n <= Math.max(1, Math.min(3, clickCount)); n++) {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: b, buttons, clickCount: n,
    });
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: b, buttons, clickCount: n,
    });
  }
}

// --------------------------------------------------------------------------
// Reusable trusted KEYBOARD primitives. Real per-character key events (not
// Input.insertText) — this is what makes typeahead/autocomplete dropdowns fire,
// because sites listen on keydown/keyup/input, not a bulk text insert.
// --------------------------------------------------------------------------

// Type `text` as individual keystrokes. `perCharMs` paces it like a human so
// debounced autocompletes keep up.
async function trustedType(tabId, text, perCharMs = 30) {
  for (const ch of String(text).replace(/\r\n/g, '\n')) {
    // A newline must be a real Enter, not the character '\n'. Dispatched as text it is
    // silently swallowed by most web apps — which is how "Score\n55\n62\n…" ended up
    // concatenated into a single Google Sheets cell, and then cost thirty actions to
    // undo. Treating \n as Enter matches what anyone writing the call expects, and a
    // tool that quietly does nothing is worse than one that errors.
    if (ch === '\n') {
      for (const ev of keyEventsFor(KEY_DEFS.Enter)) await send(tabId, 'Input.dispatchKeyEvent', ev);
      if (perCharMs) await delay(perCharMs);
      continue;
    }
    // A tab is Tab, for the same reason: in a grid it means "next column", and sent as a
    // character it does nothing at all. Together with \n this makes a whole block of cells
    // one type_text call — which is how a person would paste it.
    if (ch === '\t') {
      for (const ev of keyEventsFor(KEY_DEFS.Tab)) await send(tabId, 'Input.dispatchKeyEvent', ev);
      if (perCharMs) await delay(perCharMs);
      continue;
    }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp' });
    if (perCharMs) await delay(perCharMs);
  }
}

/**
 * Accept the step shapes a model actually writes.
 *
 * The dispatcher teaches one convention at the top level — {action, args} — and this tool
 * then demanded a different one inside its steps: {type, …}. A model that had just learned
 * the first naturally reused it, got `unknown step type "undefined"`, and retried the same
 * call. That is our inconsistency showing up as the model's failure, and it cost a real run
 * three identical retries before it gave up and emitted malformed tool syntax.
 *
 * So both shapes are accepted, and the familiar page actions are expanded into the
 * primitives they are made of. A model that can only express itself in click_at and
 * drag_at can now still build a combination, which is the whole point of this tool.
 */
/**
 * A drag, as a canvas app will actually recognise it.
 *
 * Press, one jump, release is not a drag to most canvas apps — Excalidraw, Figma, tldraw,
 * draw.io all track pointermove to size a shape, and a single move from origin to
 * destination reads as a click that happened to end elsewhere. So the pointer is walked
 * across in steps. It costs nothing (these are synthesized events, not real time) and it is
 * the difference between a drag that works and one that reports ok having drawn nothing —
 * which is exactly what a user saw: {"ok":true,"steps":7} and an empty canvas.
 */
function dragSteps(x, y, toX, toY, button, hops = 6) {
  const steps = [{ type: 'move', x, y }, { type: 'mouse_down', button }];
  if (Number.isFinite(toX) && Number.isFinite(toY) && Number.isFinite(x) && Number.isFinite(y)) {
    for (let i = 1; i <= hops; i++) {
      steps.push({
        type: 'move', button,
        x: Math.round(x + ((toX - x) * i) / hops),
        y: Math.round(y + ((toY - y) * i) / hops),
      });
    }
  }
  steps.push({ type: 'mouse_up', button });
  return steps;
}

export function normalizeSteps(steps) {
  const out = [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  for (const raw of steps || []) {
    const step = raw || {};
    // {action, args} — the dispatcher's convention, used one level down.
    const name = String(step.type || step.action || '').toLowerCase().replace(/[^a-z_]/g, '');
    const a = { ...step, ...(step.args && typeof step.args === 'object' ? step.args : {}) };
    const to = { x: num(a.toX ?? a.tox ?? a.toX), y: num(a.toY ?? a.toy) };
    switch (name) {
      // Already a primitive (with underscore-free spellings tolerated — small models drop
      // them, and rejecting "keydown" teaches nothing).
      case 'key_down': case 'keydown': out.push({ ...a, type: 'key_down' }); break;
      case 'key_up': case 'keyup': out.push({ ...a, type: 'key_up' }); break;
      case 'mouse_down': case 'mousedown': out.push({ ...a, type: 'mouse_down' }); break;
      case 'mouse_up': case 'mouseup': out.push({ ...a, type: 'mouse_up' }); break;
      // Every spelling a model has actually produced. `mouse_move` was missing and cost a
      // real run its whole sequence at step 6 — the vocabulary is cheap, the failure is not.
      case 'move': case 'move_mouse': case 'movemouse': case 'mouse_move': case 'mousemove':
      case 'moveto': case 'move_to': case 'pointer_move': case 'pointermove':
        out.push({ ...a, type: 'move' }); break;
      case 'type': case 'type_text': case 'typetext': out.push({ type: 'type', text: a.text ?? '' }); break;
      case 'wait': case 'sleep': out.push({ type: 'wait', ms: num(a.ms) ?? 0 }); break;

      // Page actions, expanded into the primitives they are made of.
      case 'click_at': case 'clickat': case 'click':
        out.push({ type: 'move', x: num(a.x), y: num(a.y) });
        out.push({ type: 'mouse_down', button: a.button });
        out.push({ type: 'mouse_up', button: a.button });
        break;
      case 'drag_at': case 'dragat': case 'drag':
        out.push(...dragSteps(num(a.x), num(a.y), to.x, to.y, a.button));
        break;
      case 'press_key': case 'presskey':
        out.push({ type: 'key_down', key: a.key });
        out.push({ type: 'key_up', key: a.key });
        break;

      // Unknown: passed through unchanged so the executor produces its own, now
      // correctable, error rather than this function inventing a guess.
      default: out.push(step); break;
    }
  }
  return out;
}

// Named non-printable keys (Enter, ArrowDown, Backspace…) for nav/selection.
//
// ALIASES ARE NOT CLUTTER. A model that asks for "Return" or "Esc" means the key everyone
// else calls Enter and Escape; rejecting it burns a round trip and teaches nothing. The
// vocabulary should be as wide as the intent is unambiguous.
const KEY_DEFS = {
  // `text` is what makes a key COMMIT. A rawKeyDown fires keydown and nothing else, so
  // an editor listening for the character event — Google Sheets' cell editor, a rich
  // text field, a code editor — sees the key and never acts on it. Enter and Tab produce
  // characters; arrows, Escape, Backspace and Delete genuinely do not, so they stay raw.
  Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
  Return: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
  Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', text: '\t' },
  ArrowDown: { windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  ArrowUp: { windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  ArrowLeft: { windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' },
  Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' },
  Delete: { windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' },
  Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
  Esc: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
  Del: { windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' },
  Home: { windowsVirtualKeyCode: 36, key: 'Home', code: 'Home' },
  End: { windowsVirtualKeyCode: 35, key: 'End', code: 'End' },
  // Paging keys. Their absence produced `error: unknown key "PageDown"` in a real run —
  // the model reached for the obvious way to page through a long thread and was told the
  // key does not exist, then fell back to screenshots.
  PageDown: { windowsVirtualKeyCode: 34, key: 'PageDown', code: 'PageDown' },
  PageUp: { windowsVirtualKeyCode: 33, key: 'PageUp', code: 'PageUp' },
  PgDn: { windowsVirtualKeyCode: 34, key: 'PageDown', code: 'PageDown' },
  PgUp: { windowsVirtualKeyCode: 33, key: 'PageUp', code: 'PageUp' },
  Space: { windowsVirtualKeyCode: 32, key: ' ', code: 'Space', text: ' ' },
};
async function trustedKey(tabId, name) {
  const k = KEY_DEFS[name];
  if (!k) return;
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

// CDP modifier bitmask, for key CHORDS (Shift+1, Cmd+A, Ctrl+Enter…).
const MODS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, super: 4, shift: 8 };

// The modifier keys as keys in their OWN right — needed by input_sequence, where
// Shift is held across other events rather than folded into one chord.
const MOD_KEY_DEFS = {
  shift: { bit: 8, def: { windowsVirtualKeyCode: 16, key: 'Shift', code: 'ShiftLeft' } },
  control: { bit: 2, def: { windowsVirtualKeyCode: 17, key: 'Control', code: 'ControlLeft' } },
  alt: { bit: 1, def: { windowsVirtualKeyCode: 18, key: 'Alt', code: 'AltLeft' } },
  meta: { bit: 4, def: { windowsVirtualKeyCode: 91, key: 'Meta', code: 'MetaLeft' } },
};
const MOD_ALIAS = {
  shift: 'shift', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt',
  meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta',
};
const namedKey = (name) => Object.keys(KEY_DEFS).find((k) => k.toLowerCase() === String(name).toLowerCase());
// A CDP key descriptor for a single letter/digit/named key (no modifiers here).
function keyDefFor(name) {
  const named = namedKey(name);
  if (named) return KEY_DEFS[named];
  const s = String(name);
  if (/^[a-z]$/i.test(s)) return { key: s.toLowerCase(), code: 'Key' + s.toUpperCase(), windowsVirtualKeyCode: s.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(s)) return { key: s, code: 'Digit' + s, windowsVirtualKeyCode: 48 + Number(s) };
  return null;
}
// Parse "Shift+1" / "Cmd+A" / "Enter" into { def, modifiers }.
function parseChord(spec) {
  const parts = String(spec).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const keyName = parts.pop();
  const modifiers = parts.reduce((m, p) => m | (MODS[p.toLowerCase()] || 0), 0);
  const def = keyDefFor(keyName);
  return def ? { def, modifiers, plainNamed: modifiers === 0 ? namedKey(keyName) : null } : null;
}

// Press one key WITH modifiers held — a trusted chord. Used for app shortcuts
// like Excalidraw's Shift+1 (zoom to fit) and the system paste (Cmd/Ctrl+V).
/**
 * The two events for one key press.
 *
 * A key that produces a character must go out as `keyDown` WITH its `text`; anything else
 * is a `rawKeyDown`. Getting this wrong is invisible in a screenshot — the key registers,
 * the field just never commits — which is exactly how thirty-five values ended up
 * concatenated in one spreadsheet cell.
 *
 * With a modifier held, the text is dropped: Cmd+Enter is a shortcut, not a character.
 */
export function keyEventsFor(def, modifiers = 0) {
  const producesText = typeof def.text === 'string' && def.text.length > 0 && modifiers === 0;
  const { text, ...rest } = def;
  return producesText
    ? [
      { type: 'keyDown', modifiers, ...rest, text, unmodifiedText: text },
      { type: 'keyUp', modifiers, ...rest },
    ]
    : [
      { type: 'rawKeyDown', modifiers, ...rest },
      { type: 'keyUp', modifiers, ...rest },
    ];
}

export async function cdpKeyChord(tabId, def, modifiers = 0) {
  await ensureAttached(tabId);
  try {
    for (const ev of keyEventsFor(def, modifiers)) {
      await sendResilient(tabId, 'Input.dispatchKeyEvent', ev);
    }
    return { ok: true };
  } finally {
    bump(tabId);
  }
}

// HOLD a key down for a while, then release — how you walk in a game (hold W),
// sprint (hold Shift), or drive any "while pressed" control. Deliberately
// self-releasing rather than exposing raw down/up: an unmatched keyDown would
// leave the page with a stuck key after the turn ends or we idle-detach.
//
// The hold is capped, the idle timer is bumped THROUGH it so the debugger can't
// detach mid-hold, and the keyUp goes out in a `finally` via sendResilient — so
// even a detach-and-reattach still releases the key.
const MAX_HOLD_MS = 5000;
export async function cdpKeyHold(tabId, def, modifiers = 0, holdMs = 300) {
  await ensureAttached(tabId);
  const ms = Math.max(0, Math.min(MAX_HOLD_MS, Math.round(holdMs) || 0));
  const keepAlive = setInterval(() => bump(tabId), Math.floor(IDLE_DETACH_MS / 2));
  try {
    // Through the same helper as every other press, so a held Enter commits like a
    // tapped one and the two paths cannot drift apart again.
    await sendResilient(tabId, 'Input.dispatchKeyEvent', keyEventsFor(def, modifiers)[0]);
    await delay(ms);
    return { ok: true, heldMs: ms };
  } finally {
    clearInterval(keepAlive);
    // Always release, even if the hold above threw — a stuck key breaks the page.
    await sendResilient(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def })
      .catch(() => {});
    bump(tabId);
  }
}

// --------------------------------------------------------------------------
// Coordinate-based "computer use" — the model reads a screenshot and drives the
// page by COORDINATES, so it works on canvas apps (Google Sheets/Docs, Figma)
// and anything not exposed as DOM. Coordinates are in CSS-viewport space
// (0..innerWidth × 0..innerHeight) — the same space the screenshot tool reports.
// CDP-only (needs trusted events).
// --------------------------------------------------------------------------
export async function cdpClickAt(tabId, x, y, button = 'left', clicks = 1) {
  await ensureAttached(tabId);
  try {
    const st = await readPointerState(tabId);
    const b = normButton(button);
    const n = Math.max(1, Math.min(3, Math.round(clicks) || 1));
    if (st?.locked) {
      // Locked: coordinates mean nothing and moving would turn the view. Click
      // exactly where we already are, and TELL the caller its x/y was ignored so
      // it re-aims with move_mouse deltas instead of retrying the same click.
      const at = pointerAt(tabId, st);
      await trustedClick(tabId, at.x, at.y, b, n, { move: false });
      return {
        ok: true,
        button: b,
        clicks: n,
        pointerLock: true,
        note:
          'This page holds POINTER LOCK, so the x/y you passed was ignored — the click went to the ' +
          'app\'s reticle (centre of the viewport). To act on something else, AIM first with ' +
          'move_mouse {dx, dy} until the target sits under the reticle, then click again.',
      };
    }
    await showCursor(tabId, x, y); // glide the agent cursor to the click point
    await trustedClick(tabId, Math.round(x), Math.round(y), b, n);
    pointerPos.set(tabId, { x: Math.round(x), y: Math.round(y) });
    // SAY WHAT IT HIT.
    //
    // "ok" only ever meant the event dispatched. A model clicked (10,10) on Google Sheets
    // — the menu bar, not a cell — typed a whole times table into nothing, got ok for every
    // step, and told the user the sheet was filled. It had no way to know it had missed.
    //
    // The page can answer this exactly: what element is at that point, and what has focus
    // afterwards. A click that lands on a menu bar when the model wanted a cell is then
    // visible in the result instead of being indistinguishable from success.
    const hit = await probeClick(tabId, Math.round(x), Math.round(y)).catch(() => null);
    return { ok: true, clickedAt: { x: Math.round(x), y: Math.round(y) }, button: b, clicks: n, ...(hit || {}) };
  } finally {
    // A click on a canvas is the usual way a page GRABS the pointer, so never
    // trust the cached lock state across one.
    invalidatePointerState(tabId);
    bump(tabId);
  }
}

// --------------------------------------------------------------------------
// CAPTURE THE POINTER — the step that makes a first-person app controllable
//
// A canvas app takes the pointer by calling requestPointerLock() from a click
// handler. Chrome grants that only if the click is a real user gesture AND the
// page's document is FOCUSED. Driving from the side panel, neither is guaranteed:
// focus usually sits on the panel, so the page's request is rejected and the app
// stays in its uncaptured state — clicks land, movement keys work, but the view
// never turns, which reads as "the controls are accepted and nothing happens".
//
// So focus the window and tab first, then click, then VERIFY against
// document.pointerLockElement rather than assuming the click worked.
// --------------------------------------------------------------------------
// What is actually AT the click point, so a failure can say "you hit the splash
// overlay", not just "it didn't work".
function topElementInPage(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}

export async function cdpCapturePointer(tabId, { x, y } = {}) {
  await ensureAttached(tabId);
  try {
    invalidatePointerState(tabId);
    let st = await readPointerState(tabId);
    if (st?.locked) return { ok: true, alreadyCaptured: true, pointerLock: true };

    // Getting the page's DOCUMENT focused is the whole game. Activating the tab is
    // NOT enough on its own: within the window, focus can still sit on the side
    // panel, and a document that isn't focused has its lock request rejected. So
    // do all three, cheapest last:
    //   Emulation.setFocusEmulationEnabled — makes the renderer treat the page as
    //     focused regardless of where OS/browser focus actually is. This is the one
    //     that fixes the side-panel case;
    //   Page.bringToFront — activates the CDP target itself;
    //   tabs/windows.update — moves real browser focus.
    const focusErrors = [];
    let focusEmulated = false;
    try {
      await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      focusEmulated = true;
    } catch (e) {
      focusErrors.push(`focusEmulation: ${e?.message || e}`);
    }
    try {
      await send(tabId, 'Page.bringToFront');
    } catch (e) {
      focusErrors.push(`bringToFront: ${e?.message || e}`);
    }
    try {
      const tab = await api.tabs.get(tabId);
      await api.tabs.update(tabId, { active: true });
      if (tab?.windowId != null) await api.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      focusErrors.push(`tabFocus: ${e?.message || e}`);
    }

    // Click the canvas centre by default — that is what the app's handler listens on.
    const cx = Number.isFinite(x) ? Math.round(x) : st?.canvas?.cx ?? Math.round((st?.w || 800) / 2);
    const cy = Number.isFinite(y) ? Math.round(y) : st?.canvas?.cy ?? Math.round((st?.h || 600) / 2);
    await trustedClick(tabId, cx, cy, 'left', 1);
    pointerPos.set(tabId, { x: cx, y: cy });

    // The lock is granted asynchronously — poll briefly rather than reading once.
    for (let i = 0; i < 10; i++) {
      await delay(100);
      invalidatePointerState(tabId);
      st = await readPointerState(tabId);
      if (st?.locked) {
        capturedTabs.add(tabId); // hold the session open so the lock survives
        bump(tabId);
        return { ok: true, pointerLock: true, capturedAt: { x: cx, y: cy }, focusEmulated };
      }
    }

    // Still not captured — report WHAT WE HIT and whether the page thinks it is
    // focused, so the next move is a diagnosis rather than another blind retry.
    const hit = await script(tabId, topElementInPage, [cx, cy]).catch(() => null);
    const hitCanvas = hit?.tag === 'canvas';
    return {
      ok: false,
      pointerLock: false,
      clickedAt: { x: cx, y: cy },
      pageFocused: st?.hasFocus ?? null,
      focusEmulated,
      elementAtPoint: hit || undefined,
      ...(focusErrors.length ? { focusErrors } : {}),
      error:
        (hitCanvas
          ? 'Clicked the canvas itself, but the app did not take the pointer. '
          : `The click landed on <${hit?.tag || 'unknown'}>${hit?.text ? ` ("${hit.text}")` : ''}, NOT the canvas — something is covering it. Dismiss that splash / menu / "click to play" overlay first (click it, or press Escape), then call capture_pointer again. `) +
        'If the canvas was hit and it still will not capture, this app may simply not use pointer lock ' +
        '(then drive it with ordinary click_at / move_mouse {x, y}), or Chrome is refusing the request ' +
        'because the page is not really focused. Do NOT keep aiming — mouse-look cannot work until it ' +
        'captures. Ask the user to click once inside the app and then say continue.',
    };
  } finally {
    bump(tabId);
  }
}

// Move the pointer WITHOUT pressing. Two modes:
//   {x, y}   absolute — hover menus, tooltips, canvas previews under the cursor;
//   {dx, dy} relative — a TURN. The only mode a pointer-locked app understands,
//            and also handy for nudging a hover target.
// Relative is resolved against the virtual position (see the pointer-lock note
// above), which is why it keeps working across a long series of small turns.
export async function cdpMoveMouse(tabId, { x, y, dx, dy } = {}) {
  await ensureAttached(tabId);
  try {
    const st = await readPointerState(tabId);
    const rel = Number.isFinite(dx) || Number.isFinite(dy);
    let nx;
    let ny;
    if (rel) {
      const at = pointerAt(tabId, st);
      nx = Math.round(at.x + (Number(dx) || 0));
      ny = Math.round(at.y + (Number(dy) || 0));
      // Unlocked, the position is real and must stay on screen; locked, it is a
      // pure delta carrier and is allowed to drift off-viewport.
      if (!st?.locked && st) {
        nx = Math.max(0, Math.min(st.w - 1, nx));
        ny = Math.max(0, Math.min(st.h - 1, ny));
      }
    } else {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: 'move_mouse needs either {x, y} or {dx, dy}' };
      }
      if (st?.locked) {
        return {
          ok: false,
          pointerLock: true,
          error:
            'This page holds POINTER LOCK, so it cannot be pointed at absolute coordinates. ' +
            'Turn the view with move_mouse {dx, dy} instead — positive dx looks right, positive dy looks down.',
        };
      }
      nx = Math.round(x);
      ny = Math.round(y);
    }
    if (!st?.locked) await showCursor(tabId, nx, ny);
    await sendResilient(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx, y: ny });
    pointerPos.set(tabId, { x: nx, y: ny });
    if (st?.locked) {
      return { ok: true, pointerLock: true, turnedBy: { dx: Number(dx) || 0, dy: Number(dy) || 0 } };
    }
    // A relative move on an UNCAPTURED page is not a camera turn — it just slides
    // the cursor, clamped to the viewport. Reporting a bare "ok" here is what lets
    // an agent believe it is looking around while the view never moves, so say
    // plainly what happened and what to do about it.
    if (rel) {
      return {
        ok: true,
        movedTo: { x: nx, y: ny },
        pointerLock: false,
        warning:
          'This page does NOT hold pointer lock, so this was a cursor move, not a view turn — ' +
          (st?.canvasApp
            ? 'and the page is dominated by a <canvas>, so if it is a first-person / 3D app you must ' +
              'capture the pointer FIRST with capture_pointer, then aim with {dx, dy}. Repeating turns ' +
              'before capturing will keep doing nothing.'
            : 'if you meant to hover a spot, pass absolute {x, y} instead.'),
      };
    }
    return { ok: true, movedTo: { x: nx, y: ny } };
  } finally {
    bump(tabId);
  }
}
// Type at the CURRENT focus (after a click_at). Real keystrokes.
export async function cdpTypeText(tabId, text) {
  await ensureAttached(tabId);
  try {
    // Where will this text GO? Text is delivered to whatever holds focus, so typing with
    // nothing focused types into nothing — which is what happened when a model clicked a
    // menu bar and then sent a whole times table. Checked BEFORE typing, so the answer is
    // actionable rather than a post-mortem.
    const target = await script(tabId, () => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const editable = a.isContentEditable
        || ['input', 'textarea', 'select'].includes(a.tagName?.toLowerCase())
        || a.getAttribute?.('role') === 'textbox';
      const name = a.getAttribute?.('aria-label') || a.getAttribute?.('title') || '';
      return { editable, label: [a.tagName?.toLowerCase(), name].filter(Boolean).join(' · ') };
    }).catch(() => null);

    if (target && target.editable === false) {
      // A refusal beats a silent no-op: the model can click the right thing and retry,
      // where "ok" left it believing the text had landed.
      return {
        ok: false,
        error: `nothing editable has focus — the focused element is "${target.label}", which does not accept text. `
          + 'Click the field or cell first (click_at returns what it hit and where typing will go), then type.',
      };
    }
    await trustedType(tabId, String(text));
    return { ok: true, typed: String(text).slice(0, 80), into: target?.label || null };
  } finally {
    bump(tabId);
  }
}
export async function cdpPressKey(tabId, key, holdMs = 0) {
  await ensureAttached(tabId);
  const chord = parseChord(key);
  if (!chord) return { ok: false, error: `unknown key "${key}"` };
  // Refuse clipboard chords (Cmd/Ctrl + V/X/C). The model can't see the clipboard,
  // so pasting it into a page — or copying page data out — is an exfiltration path
  // with no legitimate autonomous use. App shortcuts (Shift+1, Ctrl+Enter, arrows,
  // Cmd/Ctrl+A select-all used by form-fill) are unaffected.
  const hasCmdCtrl = (chord.modifiers & (MODS.ctrl | MODS.meta)) !== 0;
  if (hasCmdCtrl && ['v', 'x', 'c'].includes(String(chord.def?.key || '').toLowerCase())) {
    return { ok: false, error: 'clipboard shortcuts (paste/cut/copy) are disabled for safety' };
  }
  try {
    // A requested HOLD always goes through the hold path — that's the only way to
    // drive "while pressed" controls (walking in a game, sprint, press-and-hold).
    const hold = Math.round(Number(holdMs)) || 0;
    if (hold > 0) {
      const r = await cdpKeyHold(tabId, chord.def, chord.modifiers, hold);
      return { ...r, key };
    }
    // Plain named key (Enter/Space/…) keeps the text-producing keyDown path;
    // anything with a modifier (or a letter/digit) goes through the chord helper.
    if (chord.plainNamed) await trustedKey(tabId, chord.plainNamed);
    else await cdpKeyChord(tabId, chord.def, chord.modifiers);
    return { ok: true, key };
  } finally {
    invalidatePointerState(tabId); // Escape releases pointer lock — re-probe next time
    bump(tabId);
  }
}
// Best-effort scroll position, so the caller (and the model) can tell when the
// page has actually reached the bottom — and stop, instead of scrolling forever.
async function readScrollState(tabId) {
  try {
    return await script(tabId, () => {
      const el = document.scrollingElement || document.documentElement;
      const y = Math.round(window.scrollY || el.scrollTop || 0);
      const maxY = Math.max(0, Math.round((el.scrollHeight || 0) - window.innerHeight));
      return { y, maxY, atBottom: y >= maxY - 2 };
    });
  } catch {
    return null;
  }
}

// chrome.debugger can detach mid-command on navigation-heavy / scroll-jacked
// pages ("Detached while handling command."). Drop the dead session, re-attach,
// and retry the command once before giving up.
const DETACHED_RE = /detached|target closed|tab with given id|cannot access/i;
async function sendResilient(tabId, method, params) {
  try {
    return await send(tabId, method, params);
  } catch (e) {
    if (!DETACHED_RE.test(e?.message || '')) throw e;
    await detach(tabId);
    await ensureAttached(tabId);
    return await send(tabId, method, params);
  }
}

export async function cdpScroll(tabId, x, y, dy) {
  await ensureAttached(tabId);
  const requested = Math.round(dy ?? 400);
  const before = await readScrollState(tabId);
  try {
    await sendResilient(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x ?? 100),
      y: Math.round(y ?? 100),
      deltaX: 0,
      deltaY: requested,
    });
  } catch {
    // CDP wheel still failing after a re-attach — fall back to a plain DOM scroll.
    // It doesn't need the debugger and is the more reliable way to reach a bottom.
    await script(tabId, (d) => window.scrollBy(0, d), [requested]).catch(() => {});
  }
  const after = await readScrollState(tabId);
  bump(tabId);
  const movedBy = before && after ? after.y - before.y : undefined;
  return {
    ok: true,
    requested,
    ...(movedBy !== undefined ? { movedBy } : {}),
    ...(after ? { atBottom: after.atBottom } : {}),
  };
}

// --------------------------------------------------------------------------
// COMPOSITE INPUT — several keys and/or buttons held AT THE SAME TIME
//
// The single-shot tools each model one input in isolation, which cannot express
// what real apps constantly ask for: Shift held while dragging (constrain), Space
// held while dragging (pan), two direction keys at once (diagonal movement), a
// modifier held across a click (multi-select), a button held while the view turns.
//
// So this runs an ordered STEP LIST and tracks what is currently held, because CDP
// events are stateless: every event must carry the modifier bitmask and the button
// bitmask that are down AT THAT MOMENT, or the page sees a plain click instead of a
// Shift-click. Anything still held when the list ends — or when a step throws — is
// released in the `finally`, so a sequence can never strand the page with a stuck
// key or a button down.
// --------------------------------------------------------------------------
const MAX_SEQUENCE_STEPS = 40;
const MAX_SEQUENCE_WAIT_MS = 8000;

// Resolve a step's `key` to a CDP descriptor + the modifier bit it contributes.
function resolveStepKey(name) {
  const raw = String(name || '').trim();
  const mod = MOD_ALIAS[raw.toLowerCase()];
  if (mod) return { def: MOD_KEY_DEFS[mod].def, bit: MOD_KEY_DEFS[mod].bit, name: mod };
  const named = namedKey(raw);
  if (named) return { def: KEY_DEFS[named], bit: 0, name: named };
  const def = keyDefFor(raw);
  return def ? { def, bit: 0, name: raw.toLowerCase() } : null;
}

export async function cdpInputSequence(tabId, steps) {
  await ensureAttached(tabId);
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return { ok: false, error: 'input_sequence needs at least one step' };
  if (list.length > MAX_SEQUENCE_STEPS) {
    return { ok: false, error: `too many steps (${list.length}); max is ${MAX_SEQUENCE_STEPS} — split it across calls` };
  }

  const heldKeys = new Map(); // name → { def, bit }
  let modifiers = 0;
  let heldButtons = 0;
  let waited = 0;
  const done = [];
  // What the sequence actually DID, so the result can say more than "ok".
  let clickCount = 0;
  let dragCount = 0;
  let draggedPx = 0;
  let downAt = null;
  // Keep the debugger alive across the whole sequence — a long one can outlast the
  // idle window, and detaching mid-sequence is what strands a held input.
  const keepAlive = setInterval(() => bump(tabId), Math.floor(IDLE_DETACH_MS / 2));

  const st = await readPointerState(tabId);
  let pos = pointerAt(tabId, st);

  try {
    for (const [i, raw] of normalizeSteps(list).entries()) {
      const step = raw || {};
      const type = String(step.type || '').toLowerCase();
      switch (type) {
        case 'key_down':
        case 'key_up': {
          const k = resolveStepKey(step.key);
          if (!k) return { ok: false, error: `step ${i + 1}: unknown key "${step.key}"`, completed: done };
          if (type === 'key_down') {
            // Same clipboard rule as press_key — holding the modifier separately
            // must not become a back door to Cmd/Ctrl+V.
            const withMods = modifiers | k.bit;
            if ((withMods & (MODS.ctrl | MODS.meta)) && ['v', 'x', 'c'].includes(String(k.def.key || '').toLowerCase())) {
              return { ok: false, error: 'clipboard shortcuts (paste/cut/copy) are disabled for safety', completed: done };
            }
            if (k.bit) modifiers |= k.bit;
            heldKeys.set(k.name, k);
            await sendResilient(tabId, 'Input.dispatchKeyEvent', keyEventsFor(k.def, modifiers)[0]);
          } else {
            heldKeys.delete(k.name);
            if (k.bit) modifiers &= ~k.bit;
            await sendResilient(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k.def });
          }
          break;
        }
        case 'type': {
          // A model wrote {action:"type_text",args:{key:"Enter"}} — no text at all — and the
          // step typed nothing while the sequence still reported ok. An argument that is
          // missing is an error the model can fix; silence is not.
          if (typeof step.text !== 'string' || !step.text.length) {
            return {
              ok: false, completed: done,
              error: `step ${i + 1}: type needs {text:"…"}. To press a named key use `
                + '{action:"press_key",args:{key:"Enter"}} instead.',
            };
          }
          // Text typed WITH whatever is currently held (e.g. Shift for capitals is
          // implicit in the text itself; a held Ctrl makes these shortcuts).
          for (const ch of String(step.text ?? '')) {
            await sendResilient(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown', modifiers, text: ch, unmodifiedText: ch,
            });
            await sendResilient(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers });
          }
          break;
        }
        case 'mouse_down':
        case 'mouse_up': {
          const b = normButton(step.button);
          const mask = BUTTON_MASK[b];
          if (type === 'mouse_down') {
            heldButtons |= mask;
            downAt = { x: pos.x, y: pos.y, moved: 0 };
          } else {
            heldButtons &= ~mask;
            // A press-and-release that travelled is a drag; one that did not is a click.
            // That distinction is the whole difference between drawing and doing nothing.
            if (downAt) {
              if (downAt.moved > 3) { dragCount += 1; draggedPx += downAt.moved; } else clickCount += 1;
              downAt = null;
            }
          }
          await sendResilient(tabId, 'Input.dispatchMouseEvent', {
            type: type === 'mouse_down' ? 'mousePressed' : 'mouseReleased',
            x: pos.x, y: pos.y, button: b, buttons: heldButtons, clickCount: 1, modifiers,
          });
          break;
        }
        case 'move': {
          const rel = Number.isFinite(step.dx) || Number.isFinite(step.dy);
          let nx;
          let ny;
          if (rel) {
            nx = Math.round(pos.x + (Number(step.dx) || 0));
            ny = Math.round(pos.y + (Number(step.dy) || 0));
            if (!st?.locked && st) {
              nx = Math.max(0, Math.min(st.w - 1, nx));
              ny = Math.max(0, Math.min(st.h - 1, ny));
            }
          } else if (Number.isFinite(step.x) && Number.isFinite(step.y)) {
            if (st?.locked) {
              return { ok: false, error: `step ${i + 1}: page holds pointer lock — use {dx, dy}, not {x, y}`, completed: done };
            }
            nx = Math.round(step.x);
            ny = Math.round(step.y);
          } else {
            return { ok: false, error: `step ${i + 1}: move needs {x, y} or {dx, dy}`, completed: done };
          }
          if (downAt && heldButtons) downAt.moved += Math.hypot(nx - pos.x, ny - pos.y);
          pos = { x: nx, y: ny };
          pointerPos.set(tabId, pos);
          await sendResilient(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: nx, y: ny, buttons: heldButtons, modifiers,
            ...(heldButtons ? { button: normButton(step.button) } : {}),
          });
          break;
        }
        case 'wait': {
          const ms = Math.max(0, Math.min(MAX_SEQUENCE_WAIT_MS - waited, Math.round(Number(step.ms)) || 0));
          waited += ms;
          await delay(ms);
          break;
        }
        default:
          // A correctable error, not a dead end. The old message named the bad value and
          // nothing else, so a model that had guessed the shape wrong had no way back —
          // and small models guessed it wrong repeatedly, retrying the identical call.
          return {
            ok: false,
            completed: done,
            error: `step ${i + 1}: unknown step type "${step.type}". `
              + 'Steps are {type:"key_down"|"key_up"|"mouse_down"|"mouse_up"|"move"|"type"|"wait", …}. '
              + 'Page actions also work as steps: {action:"click_at",args:{x,y}}, '
              + '{action:"drag_at",args:{x,y,toX,toY}}, {action:"press_key",args:{key}}, '
              + '{action:"type_text",args:{text}}.',
          };
      }
      done.push(type);
    }
    // SAY WHAT HAPPENED, NOT JUST THAT IT HAPPENED.
    //
    // "ok" meant "the events dispatched", and a model reasonably read it as "the thing I
    // wanted worked". A real run selected the ellipse tool, sent a single click, got "ok",
    // and told the user it had drawn a circle. Nothing was drawn: a canvas app needs the
    // button HELD across movement, and one click is not that.
    //
    // We cannot know intent, so we report shape instead — how many clicks, how many drags,
    // how far the pointer travelled while held. A model that meant to draw sees drags:0 and
    // has something to correct. Naming what is missing beats a cheerful "ok" that is
    // technically true and practically a lie.
    const summary = {
      ok: true,
      steps: done.length,
      clicks: clickCount,
      drags: dragCount,
      draggedPx: Math.round(draggedPx),
      keys: done.filter((t) => t === 'key_down').length,
      typed: done.filter((t) => t === 'type').length,
      ...(st?.locked ? { pointerLock: true } : {}),
    };
    if (!dragCount && (clickCount || done.length)) {
      summary.note = 'No drag occurred — the mouse button was never held across a movement. '
        + 'Drawing, resizing and selecting a region on a canvas all require a drag: use '
        + '{action:"drag_at",args:{x,y,toX,toY}} or mouse_down, several moves, mouse_up. '
        + 'A single click only places the cursor or selects.';
    }
    return summary;
  } finally {
    clearInterval(keepAlive);
    // Release EVERYTHING, in the reverse order it went down. Best-effort: a page
    // that navigated mid-sequence is already rid of the state anyway.
    for (const mask of [1, 2, 4]) {
      if (heldButtons & mask) {
        const b = Object.keys(BUTTON_MASK).find((k) => BUTTON_MASK[k] === mask);
        heldButtons &= ~mask;
        await sendResilient(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: pos.x, y: pos.y, button: b, buttons: heldButtons, clickCount: 1, modifiers,
        }).catch(() => {});
      }
    }
    for (const k of [...heldKeys.values()].reverse()) {
      if (k.bit) modifiers &= ~k.bit;
      await sendResilient(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k.def })
        .catch(() => {});
    }
    invalidatePointerState(tabId);
    bump(tabId);
  }
}

// --------------------------------------------------------------------------
// EVALUATE JAVASCRIPT IN THE PAGE — the sharpest tool here, and the most dangerous
//
// This is a universal capability: page JS can read anything the logged-in user can
// see, call any same-origin API as them, and change the page at will. It therefore
// sits behind a developer setting that is OFF by default, and — unlike every other
// page action — its confirmation can never be waived by "allow for this site" (see
// ALWAYS_CONFIRM_TOOLS in sidepanel.js). Nothing here may weaken either gate.
//
// Runs via CDP rather than an injected `new Function`, because injection into the
// MAIN world is subject to the page's own CSP and would fail on exactly the strict
// sites where this is most useful. Results come back by value, size-capped, with
// secret-looking keys stripped by the caller.
// --------------------------------------------------------------------------
const MAX_EVAL_RESULT = 20000;

export async function cdpEvaluate(tabId, expression, { timeoutMs = 5000 } = {}) {
  await ensureAttached(tabId);
  const code = String(expression ?? '');
  if (!code.trim()) return { ok: false, error: 'no code given' };
  try {
    const r = await Promise.race([
      sendResilient(tabId, 'Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false, // never launder this into a user gesture
        allowUnsafeEvalBlockedByCSP: true,
      }),
      delay(timeoutMs).then(() => ({ __timeout: true })),
    ]);
    if (r?.__timeout) {
      return { ok: false, error: `evaluation did not finish within ${timeoutMs}ms` };
    }
    if (r?.exceptionDetails) {
      const ex = r.exceptionDetails;
      return {
        ok: false,
        error: `page threw: ${ex.exception?.description || ex.text || 'unknown error'}`.slice(0, 1000),
      };
    }
    const value = r?.result?.value;
    let out = value;
    if (typeof value === 'string' && value.length > MAX_EVAL_RESULT) {
      out = `${value.slice(0, MAX_EVAL_RESULT)}… [truncated]`;
    } else if (value && typeof value === 'object') {
      const json = JSON.stringify(value);
      if (json && json.length > MAX_EVAL_RESULT) {
        out = `${json.slice(0, MAX_EVAL_RESULT)}… [truncated]`;
      }
    }
    return { ok: true, type: r?.result?.type, value: out === undefined ? null : out };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    invalidatePointerState(tabId); // arbitrary code can lock/unlock or navigate
    bump(tabId);
  }
}

// Drag the mouse through a path with the button held — i.e. a freehand stroke.
// This is how you DRAW (Excalidraw pencil) or drag-and-drop. `points` is an
// ordered [{x,y}, …] in CSS-viewport space; we press at the first, move through
// each, and release at the last.
export async function cdpDrag(tabId, points, button = 'left') {
  await ensureAttached(tabId);
  const b = normButton(button);
  const buttons = BUTTON_MASK[b];
  let pressed = false;
  let last = null;
  try {
    const pts = (points || [])
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    if (pts.length < 2) return { ok: false, error: 'drag needs at least 2 points' };
    last = pts[0];
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts[0].x, y: pts[0].y });
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: pts[0].x, y: pts[0].y, button: b, buttons, clickCount: 1,
    });
    pressed = true;
    for (let i = 1; i < pts.length; i++) {
      await send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pts[i].x, y: pts[i].y, button: b, buttons,
      });
      last = pts[i];
      await delay(8); // small pace so the app samples the path like a real stroke
    }
    return { ok: true, strokePoints: pts.length, button: b };
  } finally {
    // Release in `finally` for the same reason a held key does: a button left
    // down mid-stroke leaves the app dragging forever.
    if (pressed) {
      await sendResilient(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: last.x, y: last.y, button: b, buttons, clickCount: 1,
      }).catch(() => {});
    }
    bump(tabId);
  }
}

// --------------------------------------------------------------------------
// Injected readers (self-contained — run via api.scripting)
// --------------------------------------------------------------------------
function locateInPage(selector) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    return null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { hidden: true };
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    tag: el.tagName.toLowerCase(),
    type: (el.type || '').toLowerCase(),
    role: (el.getAttribute('role') || '').toLowerCase(),
    editable: el.isContentEditable,
    checked:
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      !!el.checked,
  };
}

function selectAllFocused() {
  const el = document.activeElement;
  if (!el) return;
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
}

function selectOptionInPage(selector, v) {
  const el = document.querySelector(selector);
  if (!el || el.tagName !== 'SELECT') return false;
  const opt =
    [...el.options].find((o) => o.value === v) ||
    [...el.options].find((o) => o.text.trim() === v.trim());
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function readStateInPage(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  if (el.getAttribute('aria-checked') != null) return el.getAttribute('aria-checked') === 'true';
  if (el.getAttribute('aria-selected') != null) return el.getAttribute('aria-selected') === 'true';
  const t = (el.type || '').toLowerCase();
  if (t === 'checkbox' || t === 'radio') return !!el.checked;
  if (el.isContentEditable) return (el.innerText || '').trim();
  return String(el.value ?? '').trim();
}

// Injected: find the best visible autocomplete-dropdown option to click. Covers
// the common typeahead patterns (ARIA listbox/option, and a few data-attr ones).
// Returns the option's centre coords + text, preferring one matching `want`.
function findComboOptionInPage(want) {
  const sel = [
    '[role="listbox"] [role="option"]',
    '[role="option"]',
    '[role="listbox"] li',
    'ul[role="listbox"] li',
    '[data-stid*="result"]',
    '.results-list li',
    '[class*="typeahead"] li',
    '[class*="autocomplete"] li',
  ].join(',');
  const needle = String(want || '').trim().toLowerCase();
  const opts = [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && (el.innerText || '').trim();
  });
  if (!opts.length) return null;
  const best =
    (needle && opts.find((el) => (el.innerText || '').toLowerCase().includes(needle))) || opts[0];
  best.scrollIntoView({ block: 'center', inline: 'center' });
  const r = best.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    text: (best.innerText || '').trim().slice(0, 100),
  };
}

// --------------------------------------------------------------------------
// Public: fill + click via trusted events
// --------------------------------------------------------------------------
export async function cdpFillForm(tabId, fields) {
  await ensureAttached(tabId);
  const results = [];
  try {
    for (const { selector, value } of fields || []) {
      const loc = await script(tabId, locateInPage, [selector]);
      if (!loc) {
        results.push({ selector, ok: false, error: 'not found' });
        continue;
      }
      if (loc.hidden) {
        results.push({ selector, ok: false, error: 'not visible' });
        continue;
      }
      try {
        const isOption =
          loc.type === 'radio' || ['radio', 'option', 'menuitemradio'].includes(loc.role);
        const isToggle =
          loc.type === 'checkbox' || ['checkbox', 'switch', 'menuitemcheckbox'].includes(loc.role);
        if (loc.tag === 'select') {
          // A native <select> opens an OS-drawn dropdown that CDP can't reach —
          // set it through scripting (reliable for real <select>s).
          const ok = await script(tabId, selectOptionInPage, [selector, String(value)]);
          if (!ok) {
            results.push({ selector, ok: false, error: 'no matching option' });
            continue;
          }
        } else if (isOption) {
          if (!loc.checked) await trustedClick(tabId, loc.x, loc.y);
        } else if (isToggle) {
          if (loc.checked !== truthy(value)) await trustedClick(tabId, loc.x, loc.y);
        } else {
          // Text-like: trusted click to focus, select any existing content, type.
          await trustedClick(tabId, loc.x, loc.y);
          await script(tabId, selectAllFocused, []);
          await send(tabId, 'Input.insertText', { text: String(value) });
        }
        const now = await script(tabId, readStateInPage, [selector]);
        await flashHighlight(tabId, [selector]); // show which field was acted on
        results.push({ selector, ok: true, value: now });
      } catch (e) {
        results.push({ selector, ok: false, error: e.message });
      }
      bump(tabId);
    }
    return results;
  } finally {
    bump(tabId);
  }
}

export async function cdpClickElement(tabId, selector) {
  await ensureAttached(tabId);
  try {
    const loc = await script(tabId, locateInPage, [selector]);
    if (!loc) throw new Error('not found');
    if (loc.hidden) throw new Error('not visible');
    await trustedClick(tabId, loc.x, loc.y);
    await flashHighlight(tabId, [selector]); // show what was clicked
    return { ok: true };
  } finally {
    bump(tabId);
  }
}

// Typeahead / autocomplete combobox (e.g. Expedia "Where to?"). The hard case:
// typing text isn't enough — you must SELECT a suggestion from the dropdown the
// site renders. We focus, clear, type with REAL keystrokes (so the dropdown
// actually appears), wait for it, then click the matching option (falling back
// to ↓+Enter). Requires trusted events, so this is CDP-only.
export async function cdpFillCombobox(tabId, selector, value) {
  await ensureAttached(tabId);
  try {
    const loc = await script(tabId, locateInPage, [selector]);
    if (!loc) throw new Error('not found');
    if (loc.hidden) throw new Error('not visible');
    await trustedClick(tabId, loc.x, loc.y); // focus
    await script(tabId, selectAllFocused, []); // clear any existing text
    await trustedKey(tabId, 'Backspace');
    await trustedType(tabId, String(value)); // real keystrokes → dropdown appears
    // Poll for the dropdown to populate (network-backed suggestions take a moment).
    let opt = null;
    for (let i = 0; i < 12 && !opt; i++) {
      await delay(200);
      opt = await script(tabId, findComboOptionInPage, [String(value)]);
    }
    await flashHighlight(tabId, [selector]);
    if (opt) {
      await trustedClick(tabId, opt.x, opt.y);
      return { ok: true, selected: opt.text };
    }
    // No visible option found — try keyboard selection as a fallback.
    await trustedKey(tabId, 'ArrowDown');
    await trustedKey(tabId, 'Enter');
    return { ok: true, selected: '(keyboard ↓+Enter)', note: 'no dropdown option detected; used keyboard' };
  } finally {
    bump(tabId);
  }
}

// Injected (self-contained): find a clickable by text and return its centre
// coordinates, so CDP can dispatch a trusted click there. Mirrors the matcher in
// page-actions.js clickByTextInPage.
function locateByTextInPage(text, role) {
  const want = String(text || '').trim().toLowerCase();
  if (!want) return null;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  let sel =
    'button, a[href], input[type=submit], input[type=button], [role=button], [role=link], [role=menuitem], [role=tab], [role=option]';
  if (role === 'button') sel = 'button, input[type=submit], input[type=button], [role=button]';
  else if (role === 'link') sel = 'a[href], [role=link]';
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '').trim().toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!isVisible(el)) continue;
    const n = nameOf(el);
    if (!n) continue;
    const score = n === want ? 3 : n.startsWith(want) ? 2 : n.includes(want) ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return null;
  best.scrollIntoView({ block: 'center', inline: 'center' });
  const r = best.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { hidden: true };
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    matched: (best.innerText || best.value || best.getAttribute('aria-label') || '').trim().slice(0, 80),
  };
}

export async function cdpClickByText(tabId, text, role = 'any') {
  await ensureAttached(tabId);
  try {
    const loc = await script(tabId, locateByTextInPage, [text, role]);
    if (!loc) throw new Error(`no ${role === 'any' ? 'element' : role} matching "${text}"`);
    if (loc.hidden) throw new Error('match not visible');
    await trustedClick(tabId, loc.x, loc.y);
    return { ok: true, matched: loc.matched };
  } finally {
    bump(tabId);
  }
}
