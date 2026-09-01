// THE BUG THIS PREVENTS: an extension that installs on a phone and cannot be opened.
//
// Chromium on Android (Kiwi, Edge, and the other forks that load Web Store extensions)
// gives an extension exactly one entry point — a row in the ⋮ menu that opens the
// action's `default_popup`. It does not dispatch action.onClicked for a popup-less
// action, and it does not necessarily wake the service worker to ask. ChatPanel shipped
// with a tab fallback but no popup, so on those browsers the row did nothing at all,
// while Quetta — whose extension UI does dispatch the click — worked fine. That is a
// silent, whole-product failure on a platform where nothing else can report it.
//
// Every assertion here is one way that could come back.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readChromeManifest, toFirefoxManifest } from './firefox-manifest.mjs';

const extDir = path.join(ROOT, 'extension');
const read = (rel) => readFileSync(path.join(extDir, rel), 'utf8');
const manifest = readChromeManifest();

// ── 1. The popup exists and is wired ──────────────────────────────────────
const popup = manifest.action?.default_popup;
assert.equal(popup, 'panel-launcher.html',
  'action.default_popup is the ONLY entry point Chromium-on-Android offers; without it the ⋮ menu row is inert');
assert.ok(existsSync(path.join(extDir, popup)), `action.default_popup points at ${popup}, which does not exist`);

// ── 2. The popup page can actually run under the extension CSP ────────────
// script-src 'self' — an inline <script> would be blocked and the popup would render a
// dead "Opening ChatPanel…" forever, which is indistinguishable from the original bug.
const page = read(popup);
assert.match(page, /<script type="module" src="js\/panel-launcher\.js"><\/script>/,
  'the launcher must load its logic from an external module file');
assert.ok(!/<script(?![^>]*\bsrc=)/.test(page),
  'inline <script> is blocked by the extension CSP (script-src \'self\') — the popup would never run');
for (const src of [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
  if (/^(https?:|data:)/.test(src)) continue;
  assert.ok(existsSync(path.join(extDir, src)), `panel-launcher.html references "${src}", which does not exist`);
}

// ── 3. The popup opens the panel through the ONE opener ───────────────────
// Branching on the engine here would fork the "where does the panel live" decision into
// a second place, and the two would drift.
const launcher = read('js/panel-launcher.js');
assert.match(launcher, /import \{ openSidePanel \} from '\.\/side-panel\.js'/,
  'the launcher must route through js/side-panel.js, not decide the surface itself');
assert.ok(!/chrome\.(sidePanel|sidebarAction|tabs)\./.test(launcher),
  'the launcher must not touch an engine API directly — js/side-panel.js owns that');
assert.match(launcher, /window\.close\(\)/, 'the popup must close itself once the panel is open elsewhere');
assert.match(launcher, /needs-tap/,
  'auto-open can be refused for want of a user gesture; the launcher must fall back to a tappable button, never fail silently');

// ── 4. …and every engine WITH a real panel takes the popup back off ───────
// A declared popup suppresses both openPanelOnActionClick and onClicked. Left in place on
// desktop it would trade the phone bug for a desktop one.
const panelSrc = read('js/side-panel.js');
assert.match(panelSrc, /export function releaseActionPopup\(\)/,
  'js/side-panel.js must own releasing the popup — it is the only file that knows the surface');
assert.match(panelSrc, /setPopup\(\{ popup: '' \}\)/,
  "setPopup must be given '' (disable). null means \"reset to the manifest default\" on Firefox — the opposite");
assert.match(panelSrc, /panelSurface === 'tab'\) return false/,
  'on mobile the popup IS the entry point and must never be released');
const wireBody = panelSrc.slice(panelSrc.indexOf('export function wireActionToPanel'));
assert.ok(wireBody.indexOf('releaseActionPopup()') < wireBody.indexOf('if (hasSidePanelApi'),
  'releaseActionPopup() must run BEFORE the Chromium-desktop early return, or desktop keeps the popup forever');

// wireActionToPanel is what re-applies it after a browser restart drops runtime action
// state, so it has to run on every service-worker wake — i.e. at top level.
const bg = read('background.js');
const bgTop = bg.split('\n').filter((l) => /^wireActionToPanel\(\);/.test(l));
assert.equal(bgTop.length, 1, 'background.js must call wireActionToPanel() at TOP level (an SW only wakes for what it registers on load)');

// ── 5. Firefox for Android needs the same entry point ─────────────────────
// It has no sidebar_action either, so the popup is its only surface too.
const ff = toFirefoxManifest(manifest);
assert.equal(ff.action?.default_popup, popup,
  'the Firefox build must carry the popup — Firefox for Android has no sidebar and would be unopenable without it');

// ── 6. The tab surface has to be usable once it opens ─────────────────────
const html = read('sidepanel.html');
assert.match(html, /name="viewport"[^>]*viewport-fit=cover/, 'the panel must draw into the safe area it then pads back out of');
assert.match(html, /name="viewport"[^>]*interactive-widget=resizes-content/,
  'without this the on-screen keyboard covers the composer the user is typing into');
const css = read('sidepanel.css');
assert.match(css, /html\.surface-tab body \{[^}]*height: 100dvh/s,
  '100vh is the LARGEST a phone viewport gets — it puts the composer below the fold with no way to scroll to it');
assert.match(css, /env\(safe-area-inset-bottom\)/, 'the gesture bar sits on top of the composer without a safe-area pad');

// ── 7. Back closes the overlay, not the app ───────────────────────────────
// A phone user's Back while a drawer is open must mean "close the drawer". Getting the
// history bookkeeping wrong is invisible on desktop and infuriating on a phone: one
// stale entry and Back silently does nothing for a tap.
const { armBackButton } = await import('../extension/js/mobile-back.js');

const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, {
    id, classes: new Set(['hidden']), listeners: [],
    classList: {
      contains: (c) => els.get(id).classes.has(c),
      add: (c) => { els.get(id).classes.add(c); observers.forEach((f) => f()); },
      remove: (c) => { els.get(id).classes.delete(c); observers.forEach((f) => f()); },
    },
    click: () => els.get(id).listeners.forEach((f) => f()),
  });
  return els.get(id);
};
const observers = [];
// Close buttons behave like the real ones: they hide their drawer.
const wireClose = (btn, drawer) => { el(btn).listeners.push(() => el(drawer).classList.add('hidden')); };
wireClose('history-close', 'history');
wireClose('meetings-close', 'meetings-drawer');
wireClose('live-notes-close', 'live-notes-drawer');
wireClose('widgets-close', 'widgets-drawer');
wireClose('meeting-vclose', 'meeting-view');

// A history stack just faithful enough: entries, a pointer, and popstate on the way back.
const stack = [{}];
let at = 0;
let popstate = () => {};
globalThis.document = { getElementById: (id) => (els.has(id) ? els.get(id) : null) };
globalThis.history = {
  pushState: (st) => { stack.length = at + 1; stack.push(st); at++; },
  go: (n) => { for (let i = 0; i < -n; i++) { if (at > 0) { at--; popstate(); } } },
};
globalThis.window = { addEventListener: (type, fn) => { if (type === 'popstate') popstate = fn; } };
globalThis.MutationObserver = class { constructor(fn) { observers.push(fn); } observe() {} };
const back = () => { if (at > 0) { at--; popstate(); } };
const isOpen = (id) => !el(id).classList.contains('hidden');

// Touch every id the module watches so the fake DOM can answer for them.
for (const id of ['history', 'widgets-drawer', 'meetings-drawer', 'meeting-view', 'live-notes-drawer', 'watch-menu']) el(id);
armBackButton();

el('history').classList.remove('hidden');            // open a drawer
assert.equal(at, 1, 'opening an overlay must push exactly one history entry');
back();
assert.ok(!isOpen('history'), 'Back must close the open drawer');
assert.equal(at, 0, 'and spend exactly the entry it pushed');

// Two deep: the nested meeting view closes back to its list before the drawer closes.
el('meetings-drawer').classList.remove('hidden');
el('meeting-view').classList.remove('hidden');
back();
assert.ok(!isOpen('meeting-view') && isOpen('meetings-drawer'), 'Back inside a meeting returns to the list, it does not close the drawer');
back();
assert.ok(!isOpen('meetings-drawer'), 'the next Back closes the drawer');
assert.equal(at, 0, 'the panel is back at its top level with no leftover entries');

// Closed by its own X: the entry must be handed back, or the next Back does nothing.
el('live-notes-drawer').classList.remove('hidden');
assert.equal(at, 1);
el('live-notes-close').click();
assert.equal(at, 0, 'closing a drawer by hand must return its history entry — otherwise Back silently does nothing once');

// Nothing open: Back belongs to the browser, and leaves the panel.
back();
assert.equal(at, 0, 'with nothing open the module must not intercept Back');

console.log('mobile entry-point tests passed');
