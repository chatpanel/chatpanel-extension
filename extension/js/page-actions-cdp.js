// High-reliability page control via chrome.debugger + the Chrome DevTools
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
// on chrome.scripting — it's reliable and cheap. CDP is used only for the ACT
// (trusted clicks + typed text). We locate an element's viewport centre via
// scripting, then dispatch trusted mouse/keyboard at those coordinates.

import { flashHighlight } from './page-actions.js';

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
  if (!chrome.debugger) {
    const err = new Error('Debugger API unavailable in this build.');
    err.code = 'no-debugger-perm';
    throw err;
  }
  ensureDetachHook();
  if (!sessions.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
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

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* tab closed / already gone */
  }
}

// Chrome detaches us on its own (navigation, tab close, user clicks "cancel" on
// the banner). Keep our map in sync so we re-attach cleanly next time. Registered
// lazily because the `chrome.debugger` namespace can be absent until the optional
// permission is granted, and this module loads at startup.
let detachHooked = false;
function ensureDetachHook() {
  if (detachHooked || !chrome.debugger?.onDetach) return;
  detachHooked = true;
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId == null) return;
    const s = sessions.get(src.tabId);
    if (s) {
      clearTimeout(s.timer);
      sessions.delete(src.tabId);
    }
  });
}

const send = (tabId, method, params) =>
  chrome.debugger.sendCommand({ tabId }, method, params || {});

async function script(tabId, func, args = []) {
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return inj?.result;
}

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
// Injected readers (self-contained — run via chrome.scripting)
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
