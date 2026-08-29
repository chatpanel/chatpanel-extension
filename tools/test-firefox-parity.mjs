import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, CHROMIUM_ONLY_FILES } from './firefox-manifest.mjs';

// THE BUG THIS PREVENTS. "Feature parity" is a claim that rots the moment someone writes
// a Chromium-only call into shared code. Every check here is a way the two builds could
// silently stop being the same product: a dead button on Firefox, a lost user gesture, a
// feature that ships to one store and not the other.

const extDir = path.join(ROOT, 'extension');
const read = (rel) => readFileSync(path.join(extDir, rel), 'utf8');

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) jsFiles(full, out); }
    else if (e.name.endsWith('.js')) out.push(path.relative(extDir, full).split(path.sep).join('/'));
  }
  return out;
}
const files = jsFiles(extDir);
const code = (rel) => read(rel).split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
  .join('\n');

// ── 1. Chromium-only APIs stay behind their feature-detecting module ───────
// Each of these throws or is undefined on Firefox. The whole point of js/side-panel.js
// and js/browser-api.js is that exactly one file knows which engine it got.
const CONFINED = {
  'chrome.sidePanel': ['js/side-panel.js'],
  'api.sidePanel': ['js/side-panel.js', 'js/browser-api.js'],
  'chrome.sidebarAction': ['js/side-panel.js'],
  'api.sidebarAction': ['js/side-panel.js', 'js/browser-api.js'],
  'chrome.offscreen': ['js/webllm.js'],
  'api.offscreen': ['js/browser-api.js'],
  'chrome.debugger': [],
  'api.debugger': ['js/page-actions-cdp.js', 'js/browser-api.js'],
};
for (const [needle, allowed] of Object.entries(CONFINED)) {
  for (const rel of files) {
    if (allowed.includes(rel)) continue;
    assert.ok(!code(rel).includes(`${needle}.`),
      `${rel} calls ${needle} directly. It does not exist on the other engine — route it through js/side-panel.js or feature-check via js/browser-api.js (allowed: ${allowed.join(', ') || 'nowhere'})`);
  }
}

// ── 2. Chromium-only APIs that DO remain are feature-detected before use ───
// webllm.js may name chrome.offscreen, but only after checking for it — otherwise the
// in-browser model would throw a TypeError on Firefox instead of falling back.
const webllm = read('js/webllm.js');
assert.match(webllm, /!chrome\.offscreen|chrome\.offscreen\s*&&|if \(typeof chrome === 'undefined' \|\| !chrome\.offscreen\)/,
  'js/webllm.js must feature-detect chrome.offscreen before using it; Firefox has no offscreen documents');
assert.match(webllm, /navigator\.gpu/,
  'js/webllm.js must feature-detect WebGPU — Firefox ships it later and on fewer platforms than Chromium');

// ── 3. The trusted-events backend is gated on the debugger API everywhere ──
// Firefox has no CDP (bug 1316741). Both the runtime switch and the settings toggle
// must consult hasDebugger, or Firefox users get a control that does nothing.
assert.match(readFileSync(path.join(extDir, 'sidepanel.js'), 'utf8'), /hasDebugger\s*&&\s*state\.settings\.ui\?\.pageActionsCdp/,
  'sidepanel.js must gate the CDP page-action backend on hasDebugger');
const settings = readFileSync(path.join(extDir, 'settings.js'), 'utf8');
assert.match(settings, /hasDebugger/, 'settings.js must import hasDebugger to hide the Chromium-only page-control toggle');
assert.match(settings, /pref-pageact-cdp-row'\)\.closest\('\.pref-item'\)\.hidden = !hasDebugger/,
  'the High-reliability page control row must be hidden where CDP cannot work');

// ── 4. The user-gesture rule: side-panel.js is STATICALLY imported ─────────
// Firefox only honours sidebarAction.open() during the synchronous run of a user-input
// handler. A dynamic import() at the call site is itself an await, so it would spend the
// gesture and the panel would never open — from a click that looks fine on Chrome.
for (const rel of ['background.js', 'notes.js', 'meetings.js', 'history.js']) {
  const src = read(rel);
  assert.match(src, /^import \{[^}]*openSidePanel[^}]*\} from '\.\/js\/side-panel\.js';$/m,
    `${rel} must STATICALLY import openSidePanel — a dynamic import() spends the user gesture Firefox requires`);
  assert.ok(!/await import\((['"])\.\/js\/side-panel\.js\1\)/.test(src),
    `${rel} dynamically imports js/side-panel.js, which loses the user gesture on Firefox`);
}

// ── 5. Toolbar-button behavior is wired for EVERY surface ─────────────────
// Chromium desktop gets it declaratively via setPanelBehavior; Firefox and every mobile
// browser need an onClicked listener, registered at TOP LEVEL because an event page only
// wakes for those.
const background = read('background.js');
assert.match(background, /^wireActionToPanel\(\);$/m,
  'wireActionToPanel() must be called at top level in background.js — an event page does not wake for listeners registered inside onInstalled');
assert.match(background, /setPanelOpensOnActionClick\(\)/,
  'background.js must still set the Chromium open-on-action-click behavior');

// ── 5b. MOBILE: no browser may be left without a way to open the panel ────
// No mobile browser — Chromium-based (Kiwi, Edge/Android) or Firefox for Android — has
// a side panel API. Without a tab fallback the extension installs and the toolbar entry
// does nothing whatsoever, which is exactly how it failed on those browsers.
const panel = read('js/side-panel.js');
assert.match(panel, /tabs\.create\(/, 'js/side-panel.js needs a tab fallback for browsers with no panel API');
assert.match(panel, /tabs\.query\(/, 'reuse an already-open panel tab rather than stacking one per tap');
assert.match(panel, /export const panelSurface/, 'callers/tests need to know which surface this browser got');

// APIs that DO NOT EXIST on Firefox for Android must never be called bare at the top
// level of the background script: an undefined namespace throws while the script is
// still evaluating, taking the alarms, the licence re-check and the meeting heartbeat
// down with it — the extension then does nothing at all, with no visible error.
for (const [ns, why] of [['contextMenus', 'no menus API on Firefox for Android']]) {
  const bare = new RegExp(`^chrome\\.${ns}\\.`, 'm');
  assert.ok(!bare.test(background),
    `background.js calls chrome.${ns} unguarded at top level — ${why}, and the whole background script would fail to load`);
}

// ── 6. Both packages ship from the same tree ──────────────────────────────
// Anything the Firefox build drops must be genuinely Chromium-only AND unreferenced by
// code that ships to Firefox, or the add-on would 404 its own file.
for (const rel of CHROMIUM_ONLY_FILES) {
  assert.ok(existsSync(path.join(extDir, rel)), `CHROMIUM_ONLY_FILES lists a file that no longer exists: ${rel}`);
  for (const other of files) {
    if (CHROMIUM_ONLY_FILES.includes(other)) continue;
    assert.ok(!code(other).includes(`'${rel}'`) || other === 'js/webllm.js',
      `${other} references ${rel}, which the Firefox package drops. Guard it or keep the file.`);
  }
}

// ── 7. The WebLLM bundle is excluded, and its loader says so ─────────────
// The 6.3 MB runtime cannot initialize on Firefox (maxStorageBuffersPerShaderStage) and
// is over AMO's parse ceiling, so the Firefox package leaves it out. The dynamic import
// must therefore fail with a reason rather than a bare module-resolution error, for the
// day the probe passes in a build that does not carry the bundle.
assert.ok(CHROMIUM_ONLY_FILES.includes('js/vendor/web-llm.js'),
  'the WebLLM bundle must stay out of the Firefox package — it cannot run there and exceeds AMO\'s 5 MB parse limit');
const webllmSrc = read('js/webllm.js');
assert.match(webllmSrc, /WEBLLM_NOT_BUNDLED/,
  'js/webllm.js must report a missing bundle as a clear error, not let the import() reject raw');
assert.match(webllmSrc, /await webgpuSupport\(\)/,
  'ensureEngine must consult the WebGPU limit probe, not just navigator.gpu');
// Only the guarded dynamic import may reference the bundle; a static import would break
// the Firefox package at load time.
for (const rel of files) {
  if (rel === 'js/webllm.js' || CHROMIUM_ONLY_FILES.includes(rel)) continue;
  assert.ok(!code(rel).includes('vendor/web-llm.js'),
    `${rel} references the WebLLM bundle, which the Firefox package does not ship`);
}

// ── 8. The update path points each engine at an artifact it can install ───
const update = read('js/update.js');
assert.match(update, /isGecko/, 'js/update.js must offer Firefox the .xpi, not the Chromium zip');
assert.match(update, /firefox\.xpi/, 'the Firefox download URL must resolve to a signed .xpi');

// ── 9. OAuth: the Firefox redirect list exists and is separate ─────────────
// Firefox mints extensions.allizom.org URIs, not chromiumapp.org. One list for both
// would silently claim hosted sign-in works on an engine where it was never registered.
const oauth = read('js/oauth.js');
assert.match(oauth, /HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS/,
  'js/oauth.js needs a separate Firefox redirect-URI allow-list (Firefox does not use chromiumapp.org)');
assert.match(oauth, /HUGGINGFACE_PRODUCTION_REDIRECT_URIS = \[[\s\S]*?GECKO_REDIRECT_URIS/,
  'the production redirect allow-list must include the Firefox URIs');

console.log('✓ firefox parity: engine APIs confined, gesture preserved, both engines wired, one source tree');
