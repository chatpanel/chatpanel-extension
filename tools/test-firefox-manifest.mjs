import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, GECKO_ID, STRICT_MIN_VERSION, STRICT_MIN_VERSION_ANDROID, DATA_COLLECTION_PERMISSIONS,
  CHROMIUM_ONLY_PERMISSIONS, CHROMIUM_ONLY_KEYS, CHROMIUM_ONLY_FILES,
  readChromeManifest, toFirefoxManifest,
} from './firefox-manifest.mjs';

// THE BUG THIS PREVENTS. Chrome and Firefox ship from ONE source tree and ONE tag, so
// the Firefox manifest is derived, never hand-written. The failure mode of a derived
// artifact is silent omission: someone adds a key/permission/content script for Chrome,
// the transform carries it or doesn't, and nobody notices until a Firefox user reports
// a feature that "just doesn't do anything". These assertions make that a build failure.

const chrome = readChromeManifest();
const before = JSON.stringify(chrome);
const ff = toFirefoxManifest(chrome);

// The transform must be pure — it runs inside the packager, the preflight and here.
assert.equal(JSON.stringify(chrome), before, 'toFirefoxManifest mutated its input');

// ── every Chrome key is consciously handled ────────────────────────────────
// This is the anti-drift core: a NEW key in extension/manifest.json is either carried
// to Firefox, deliberately dropped, or it fails this test. There is no third outcome
// where it quietly vanishes.
const MAPPED = { side_panel: 'sidebar_action', options_page: 'options_ui', background: 'background', commands: 'commands' };
for (const key of Object.keys(chrome)) {
  if (CHROMIUM_ONLY_KEYS.includes(key)) {
    assert.ok(!(key in ff), `"${key}" is listed as Chromium-only but survived into the Firefox manifest`);
    assert.ok(!MAPPED[key] || MAPPED[key] in ff, `"${key}" was dropped without writing its Firefox equivalent "${MAPPED[key]}"`);
    continue;
  }
  assert.ok(key in ff, `manifest key "${key}" was added for Chrome but never reaches Firefox — map it in tools/firefox-manifest.mjs or add it to CHROMIUM_ONLY_KEYS`);
}

// ── carried verbatim: the things that ARE the product ──────────────────────
// If any of these diverged, the two builds would stop being the same extension.
for (const key of ['manifest_version', 'name', 'version', 'description', 'icons', 'action',
                   'content_scripts', 'web_accessible_resources', 'host_permissions', 'content_security_policy']) {
  assert.deepEqual(ff[key], chrome[key], `"${key}" must be identical in both builds — Firefox is the same extension, not a variant`);
}
// Same version string is what lets both stores ship from one `ext-v*` tag.
assert.equal(ff.version, chrome.version);
assert.ok((ff.description || '').length <= 132, 'description exceeds the 132-char store limit');

// ── background: event page, not a service worker ───────────────────────────
assert.equal(ff.background.service_worker, undefined, 'Firefox has no background service workers');
assert.deepEqual(ff.background, { scripts: [chrome.background.service_worker], type: 'module' });

// ── the panel ──────────────────────────────────────────────────────────────
assert.equal(ff.side_panel, undefined);
assert.equal(ff.sidebar_action.default_panel, chrome.side_panel.default_path,
  'the Firefox sidebar must load the SAME page as the Chromium side panel');
assert.equal(ff.sidebar_action.open_at_install, false, 'never open the sidebar uninvited at install');
assert.deepEqual(ff.sidebar_action.default_icon, chrome.icons);

// ── settings page ──────────────────────────────────────────────────────────
assert.equal(ff.options_page, undefined);
assert.deepEqual(ff.options_ui, { page: chrome.options_page, open_in_tab: true });

// ── keyboard shortcut: same keys, the command that actually opens a sidebar ─
assert.equal(ff.commands._execute_action, undefined,
  '_execute_action only clicks the toolbar button on Firefox; the sidebar needs _execute_sidebar_action');
assert.deepEqual(ff.commands._execute_sidebar_action, chrome.commands._execute_action,
  'the Firefox shortcut must use the same key combination as Chromium');

// ── permissions: drop only what Firefox cannot implement, keep the rest in order ─
const dropped = chrome.permissions.filter((p) => p in CHROMIUM_ONLY_PERMISSIONS);
assert.deepEqual(ff.permissions, chrome.permissions.filter((p) => !(p in CHROMIUM_ONLY_PERMISSIONS)));
for (const p of Object.keys(CHROMIUM_ONLY_PERMISSIONS)) {
  assert.ok(!ff.permissions.includes(p), `"${p}" has no Firefox implementation and must not be requested`);
}
assert.ok(dropped.length, 'expected at least one Chromium-only permission to be dropped — did the Chrome manifest change?');
// Everything Firefox CAN do must still be asked for, or the feature dies silently.
for (const p of ['storage', 'tabs', 'scripting', 'activeTab', 'contextMenus', 'alarms', 'notifications', 'identity', 'downloads', 'unlimitedStorage', 'webNavigation']) {
  assert.ok(ff.permissions.includes(p), `permission "${p}" is supported on Firefox and must be carried over`);
}

// ── gecko block ────────────────────────────────────────────────────────────
const gecko = ff.browser_specific_settings.gecko;
assert.equal(gecko.id, GECKO_ID, 'the add-on ID is permanent: identity.getRedirectURL() is derived from it');
assert.equal(gecko.strict_min_version, STRICT_MIN_VERSION);
assert.ok(parseFloat(gecko.strict_min_version) >= 128,
  'content_scripts world:"MAIN" needs Firefox 128 — a lower floor means meeting capture breaks on install');
// The binding constraint, and the one AMO's linter checks: declaring
// data_collection_permissions (which AMO REQUIRES) below Firefox 140 warns on every
// submission. Desktop 140 / Android 142.
assert.ok(parseFloat(gecko.strict_min_version) >= 140,
  'data_collection_permissions needs Firefox 140; a lower floor makes AMO warn on every upload');
assert.deepEqual(gecko.data_collection_permissions, DATA_COLLECTION_PERMISSIONS,
  'AMO rejects new submissions without data_collection_permissions');
assert.ok(!(gecko.data_collection_permissions.required.includes('none') && gecko.data_collection_permissions.required.length > 1),
  '"none" cannot be combined with other data-collection values');

// ── Android is opt-in, and only safe because the panel has a tab fallback ──
// Firefox for Android has no sidebar_action. Listing an add-on there without somewhere
// else to put the UI means it installs and the user can never open it — so this key and
// the tab fallback in js/side-panel.js must travel together.
const android = ff.browser_specific_settings.gecko_android;
assert.ok(android, 'gecko_android must be present or the add-on is desktop-only');
assert.equal(android.strict_min_version, STRICT_MIN_VERSION_ANDROID,
  'Android needs its OWN floor: data_collection_permissions shipped in Firefox 140 but not until 142 on Android, and AMO warns on each separately');
assert.ok(parseFloat(android.strict_min_version) >= 142, 'Android floor must cover data_collection_permissions (142)');
const panelSrc = readFileSync(path.join(ROOT, 'extension', 'js', 'side-panel.js'), 'utf8');
assert.match(panelSrc, /tabs\.create\(/,
  'gecko_android is set but js/side-panel.js has no tab fallback — on Android the panel would be unreachable');

// ── content scripts must be byte-identical: this is meeting capture ────────
// world:"MAIN" at document_start is what keeps live captions flowing in a backgrounded
// tab. Dropping it on Firefox would look like "meetings sometimes record nothing".
const mainWorld = ff.content_scripts.find((c) => c.world === 'MAIN');
assert.ok(mainWorld, 'the MAIN-world content script must survive to Firefox (needs 128+, which strict_min_version guarantees)');
assert.equal(mainWorld.run_at, 'document_start');

// ── files the Firefox build drops must exist to be dropped ────────────────
for (const rel of CHROMIUM_ONLY_FILES) {
  assert.ok(existsSync(path.join(ROOT, 'extension', rel)),
    `CHROMIUM_ONLY_FILES lists "${rel}" which no longer exists — remove it from tools/firefox-manifest.mjs`);
}

// ── nothing the Firefox package ships may exceed AMO's 5 MB parse ceiling ──
// addons-linter refuses to parse a non-binary file over 5 MB ("This file is not binary
// and is too large to parse"), which blocks the submission. That is how the 6.3 MB
// WebLLM bundle failed validation; catching it here means the next big bundle fails a
// test instead of an upload.
const AMO_MAX_PARSE_BYTES = 5 * 1024 * 1024;
const PARSED = new Set(['.js', '.mjs', '.json', '.css', '.html']);
function shipped(dir, base, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (e.isDirectory()) { if (!e.name.startsWith('.')) shipped(full, base, out); continue; }
    if (CHROMIUM_ONLY_FILES.includes(rel)) continue; // not in the Firefox package
    if (PARSED.has(path.extname(e.name))) out.push({ rel, size: statSync(full).size });
  }
  return out;
}
const extDir = path.join(ROOT, 'extension');
for (const f of shipped(extDir, extDir)) {
  assert.ok(f.size <= AMO_MAX_PARSE_BYTES,
    `${f.rel} is ${(f.size / 1024 / 1024).toFixed(1)} MB — AMO cannot parse a non-binary file over 5 MB and will reject the submission. Split it, or exclude it via CHROMIUM_ONLY_FILES if it cannot run on Firefox.`);
}

console.log('✓ firefox manifest: derived from Chrome, nothing dropped silently, same version/content/shortcut');
