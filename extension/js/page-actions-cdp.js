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

import { flashHighlight } from './page-actions.js';
import { api } from './browser-api.js';

const CDP_VERSION = '1.3';
const IDLE_DETACH_MS = 8000; // drop the debugger (and its banner) after a lull

const truthy = (v) =>
  v === true || v === 'true' || v === 'on' || v === 1 || v === '1' || v === 'yes';

// --------------------------------------------------------------------------
// Debugger session: attach lazily, hold briefly, auto-detach when idle
// --------------------------------------------------------------------------
const sessions = new Map(); // tabId → { timer }

function bump(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => detach(tabId), IDLE_DETACH_MS);
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
        throw new Error('Close DevTools on this tab to use high-reliability mode.');
      }
      throw e;
    }
    sessions.set(tabId, {});
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
    const s = sessions.get(src.tabId);
    if (s) {
      clearTimeout(s.timer);
      sessions.delete(src.tabId);
    }
  });
}

const send = (tabId, method, params) =>
  api.debugger.sendCommand({ tabId }, method, params || {});

async function script(tabId, func, args = []) {
  const [inj] = await api.scripting.executeScript({ target: { tabId }, func, args });
  return inj?.result;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function trustedClick(tabId, x, y) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
}

// --------------------------------------------------------------------------
// Reusable trusted KEYBOARD primitives. Real per-character key events (not
// Input.insertText) — this is what makes typeahead/autocomplete dropdowns fire,
// because sites listen on keydown/keyup/input, not a bulk text insert.
// --------------------------------------------------------------------------

// Type `text` as individual keystrokes. `perCharMs` paces it like a human so
// debounced autocompletes keep up.
async function trustedType(tabId, text, perCharMs = 30) {
  for (const ch of String(text)) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp' });
    if (perCharMs) await delay(perCharMs);
  }
}

// Named non-printable keys (Enter, ArrowDown, Backspace…) for nav/selection.
const KEY_DEFS = {
  Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' },
  Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
  ArrowDown: { windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  ArrowUp: { windowsVirtualKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  ArrowLeft: { windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' },
  Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' },
  Delete: { windowsVirtualKeyCode: 46, key: 'Delete', code: 'Delete' },
  Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
  Home: { windowsVirtualKeyCode: 36, key: 'Home', code: 'Home' },
  End: { windowsVirtualKeyCode: 35, key: 'End', code: 'End' },
  Space: { windowsVirtualKeyCode: 32, key: ' ', code: 'Space', text: ' ' },
};
async function trustedKey(tabId, name) {
  const k = KEY_DEFS[name];
  if (!k) return;
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

// --------------------------------------------------------------------------
// Coordinate-based "computer use" — the model reads a screenshot and drives the
// page by COORDINATES, so it works on canvas apps (Google Sheets/Docs, Figma)
// and anything not exposed as DOM. Coordinates are in CSS-viewport space
// (0..innerWidth × 0..innerHeight) — the same space the screenshot tool reports.
// CDP-only (needs trusted events).
// --------------------------------------------------------------------------
export async function cdpClickAt(tabId, x, y) {
  await ensureAttached(tabId);
  try {
    await trustedClick(tabId, Math.round(x), Math.round(y));
    return { ok: true, clickedAt: { x: Math.round(x), y: Math.round(y) } };
  } finally {
    bump(tabId);
  }
}
// Type at the CURRENT focus (after a click_at). Real keystrokes.
export async function cdpTypeText(tabId, text) {
  await ensureAttached(tabId);
  try {
    await trustedType(tabId, String(text));
    return { ok: true, typed: String(text).slice(0, 80) };
  } finally {
    bump(tabId);
  }
}
export async function cdpPressKey(tabId, key) {
  await ensureAttached(tabId);
  try {
    if (!KEY_DEFS[key]) return { ok: false, error: `unknown key "${key}"` };
    await trustedKey(tabId, key);
    return { ok: true, key };
  } finally {
    bump(tabId);
  }
}
export async function cdpScroll(tabId, x, y, dy) {
  await ensureAttached(tabId);
  try {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x ?? 100),
      y: Math.round(y ?? 100),
      deltaX: 0,
      deltaY: Math.round(dy ?? 400),
    });
    return { ok: true, scrolledBy: Math.round(dy ?? 400) };
  } finally {
    bump(tabId);
  }
}

// Drag the mouse through a path with the button held — i.e. a freehand stroke.
// This is how you DRAW (Excalidraw pencil) or drag-and-drop. `points` is an
// ordered [{x,y}, …] in CSS-viewport space; we press at the first, move through
// each, and release at the last.
export async function cdpDrag(tabId, points) {
  await ensureAttached(tabId);
  try {
    const pts = (points || [])
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    if (pts.length < 2) return { ok: false, error: 'drag needs at least 2 points' };
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts[0].x, y: pts[0].y });
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: pts[0].x, y: pts[0].y, button: 'left', buttons: 1, clickCount: 1,
    });
    for (let i = 1; i < pts.length; i++) {
      await send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pts[i].x, y: pts[i].y, button: 'left', buttons: 1,
      });
      await delay(8); // small pace so the app samples the path like a real stroke
    }
    const last = pts[pts.length - 1];
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 1, clickCount: 1,
    });
    return { ok: true, strokePoints: pts.length };
  } finally {
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
