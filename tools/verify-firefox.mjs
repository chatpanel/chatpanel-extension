// Firefox / addons.mozilla.org preflight for the derived manifest and package.
//
//   node tools/verify-firefox.mjs        # report, exit 1 on hard blockers
//   npm run verify:firefox
//
// The counterpart to tools/verify-manifest.mjs (which guards the Chrome/Edge zip).
// This one asserts the DERIVED Firefox manifest is actually installable and that the
// shared source has not grown a Chromium-only dependency that Firefox can't satisfy.
// It is advisory except where a check would produce a package Firefox refuses.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, CHROMIUM_ONLY_PERMISSIONS, CHROMIUM_ONLY_FILES, CHROMIUM_ONLY_KEYS,
  GECKO_ID, STRICT_MIN_VERSION, readChromeManifest, toFirefoxManifest,
} from './firefox-manifest.mjs';

const extDir = path.join(ROOT, 'extension');
const errors = []; const warns = []; const infos = []; const oks = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);
const info = (m) => infos.push(m);
const ok = (m) => oks.push(m);

const chrome = readChromeManifest(extDir);
const ff = toFirefoxManifest(chrome);

// --- The keys Firefox needs, and the ones it must not see ------------------
const gecko = ff.browser_specific_settings?.gecko;
if (!gecko?.id) err('browser_specific_settings.gecko.id is missing — AMO cannot sign an MV3 add-on without an explicit ID.');
else if (gecko.id !== GECKO_ID) warn(`gecko.id is "${gecko.id}", not the pinned "${GECKO_ID}". Changing it invalidates every registered OAuth redirect URI.`);
else ok(`gecko.id "${gecko.id}" (identity.getRedirectURL() is derived from this — permanent).`);

if (!gecko?.strict_min_version) err('browser_specific_settings.gecko.strict_min_version is missing.');
else if (parseFloat(gecko.strict_min_version) < 128) {
  err(`strict_min_version ${gecko.strict_min_version} is below 128.0, but the shared content scripts use world:"MAIN" (Firefox 128+). Meeting capture would break on older Firefox.`);
} else if (gecko.data_collection_permissions && parseFloat(gecko.strict_min_version) < 140) {
  err(`strict_min_version ${gecko.strict_min_version} predates Firefox 140, which introduced data_collection_permissions — AMO's linter warns on every submission. Raise the floor or drop the key (AMO requires the key, so raise the floor).`);
} else ok(`strict_min_version ${gecko.strict_min_version} (data_collection_permissions needs 140; world:"MAIN" needs 128; ${STRICT_MIN_VERSION} is also an ESR).`);

const androidMin = ff.browser_specific_settings?.gecko_android?.strict_min_version;
if (androidMin && gecko.data_collection_permissions && parseFloat(androidMin) < 142) {
  err(`gecko_android.strict_min_version ${androidMin} predates Firefox for Android 142, which introduced data_collection_permissions — AMO's linter warns on it separately from the desktop floor.`);
} else if (androidMin) ok(`gecko_android.strict_min_version ${androidMin} (Android got data_collection_permissions in 142, two releases after desktop).`);

// Mandatory for new AMO submissions since 2025-11-03.
const dc = gecko?.data_collection_permissions;
if (!dc?.required?.length) err('browser_specific_settings.gecko.data_collection_permissions.required is missing — AMO rejects new submissions without it.');
else if (dc.required.includes('none') && dc.required.length > 1) err(`data_collection_permissions.required mixes "none" with ${dc.required.filter((r) => r !== 'none').join(', ')} — "none" must stand alone.`);
else ok(`data_collection_permissions.required = [${dc.required.join(', ')}].`);

for (const key of CHROMIUM_ONLY_KEYS) {
  if (key in ff) err(`manifest key "${key}" survived the transform — Firefox does not support it.`);
}
if (ff.background?.service_worker) err('background.service_worker is present; Firefox has no background service workers (use background.scripts).');
if (!ff.background?.scripts?.length) err('background.scripts is missing — the event page would never run.');
else if (ff.background.type !== 'module') err('background.type must be "module": background.js uses ES imports.');
else ok(`background: event page ${ff.background.scripts.join(', ')} (type: module, Firefox 112+).`);

if (!ff.sidebar_action?.default_panel) err('sidebar_action.default_panel is missing — the extension would have no panel on Firefox.');
else if (!existsSync(path.join(extDir, ff.sidebar_action.default_panel))) err(`sidebar_action.default_panel "${ff.sidebar_action.default_panel}" does not exist.`);
else ok(`sidebar_action ("${ff.sidebar_action.default_panel}", open_at_install: ${ff.sidebar_action.open_at_install}).`);

if (chrome.options_page && !ff.options_ui?.page) err('options_page was dropped but options_ui was not written — settings would be unreachable.');
else if (ff.options_ui?.page) ok(`options_ui ("${ff.options_ui.page}", open_in_tab: ${ff.options_ui.open_in_tab}).`);

if (chrome.commands?._execute_action) {
  if (ff.commands?._execute_action) err('commands._execute_action survived — on Firefox that clicks the toolbar button instead of opening the sidebar.');
  else if (!ff.commands?._execute_sidebar_action) err('commands._execute_sidebar_action is missing — the keyboard shortcut would not open the panel.');
  else {
    const k = ff.commands._execute_sidebar_action.suggested_key;
    ok(`commands._execute_sidebar_action (${k?.mac || k?.default}).`);
    info('Firefox drops a suggested_key it considers reserved (Cmd+I is Page Info on macOS). Users can rebind it at about:addons → gear → Manage Extension Shortcuts.');
  }
}

// --- Permissions -----------------------------------------------------------
for (const [perm, why] of Object.entries(CHROMIUM_ONLY_PERMISSIONS)) {
  if ((ff.permissions || []).includes(perm)) err(`permission "${perm}" survived the transform — ${why}`);
}
ok(`permissions: ${(ff.permissions || []).join(', ')}`);
if ((ff.host_permissions || []).includes('<all_urls>')) {
  warn('Broad host access (`<all_urls>`) is user-revocable on Firefox MV3 and draws AMO review questions. From Firefox 127 it is shown in the install prompt; justify it in the submission notes.');
}

// --- CSP: MV3 Firefox allows only \'none\', \'self\' and \'wasm-unsafe-eval\' ----
const csp = ff.content_security_policy?.extension_pages;
if (csp) {
  const scriptish = csp.split(';').map((d) => d.trim()).filter((d) => /^(script-src|script-src-elem|worker-src|default-src)\b/.test(d));
  const allowed = new Set(["'none'", "'self'", "'wasm-unsafe-eval'"]);
  const bad = scriptish.flatMap((d) => d.split(/\s+/).slice(1)).filter((src) => !allowed.has(src));
  if (bad.length) err(`content_security_policy.extension_pages uses ${bad.join(', ')} in a script directive; Firefox MV3 permits only 'none', 'self' and 'wasm-unsafe-eval'.`);
  else ok(`content_security_policy.extension_pages is MV3-legal on Firefox (${scriptish.join('; ')}).`);
}

// --- The shared source must not reach a Chromium-only API unguarded --------
// Every one of these has a Firefox-safe path; the failure mode is a call site that
// forgets to take it, which only shows up as a dead button on Firefox.
const GUARDED = {
  'chrome.sidePanel': ['js/side-panel.js'],
  'api.sidePanel': ['js/side-panel.js', 'js/browser-api.js'],
  'chrome.offscreen': ['js/webllm.js'],
  'api.debugger': ['js/page-actions-cdp.js', 'js/browser-api.js'],
  'chrome.debugger': [],
};
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(full, out); }
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const sourceFiles = walk(extDir);
let strays = 0;
for (const [needle, allowedFiles] of Object.entries(GUARDED)) {
  for (const file of sourceFiles) {
    const rel = path.relative(extDir, file).split(path.sep).join('/');
    if (allowedFiles.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    // Ignore prose: only flag it where it is actually called.
    for (const [i, line] of text.split('\n').entries()) {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      if (line.includes(`${needle}.`)) {
        err(`${rel}:${i + 1} calls ${needle} directly. It does not exist on Firefox — go through js/side-panel.js or a feature check from js/browser-api.js.`);
        strays++;
      }
    }
  }
}
if (!strays) ok('No Chromium-only API is called outside its designated feature-detecting module.');

// --- Chromium-only files must not be referenced by anything that ships -----
for (const rel of CHROMIUM_ONLY_FILES) {
  if (!existsSync(path.join(extDir, rel))) warn(`CHROMIUM_ONLY_FILES lists "${rel}", which no longer exists — drop it from tools/firefox-manifest.mjs.`);
}
ok(`Chromium-only files excluded from the Firefox package: ${CHROMIUM_ONLY_FILES.join(', ')}.`);

// --- OAuth redirect URIs ---------------------------------------------------
// Firefox mints https://<hash>.extensions.allizom.org/ rather than chromiumapp.org, so
// a URI literal pinned to either engine will not match the other at runtime.
const PINNED_RE = /https:\/\/[a-z0-9-]+\.(chromiumapp\.org|extensions\.allizom\.org)[^\s'"`]*/g;
const pinned = [];
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(PINNED_RE)) {
    pinned.push({ file: path.relative(ROOT, file), line: text.slice(0, m.index).split('\n').length, url: m[0] });
  }
}
if (pinned.length) {
  for (const h of pinned) warn(`${h.file}:${h.line} hardcodes ${h.url}. Confirm the matching engine's URI is registered with the provider too.`);
} else ok('No OAuth redirect URI is hardcoded to one engine.');

const oauthSrc = existsSync(path.join(extDir, 'js', 'oauth.js')) ? readFileSync(path.join(extDir, 'js', 'oauth.js'), 'utf8') : '';
const geckoBlock = oauthSrc.match(/HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS\s*=\s*\[([\s\S]*?)\]/);
if (geckoBlock) {
  // Strip line comments FIRST: the list ships with a commented-out example of the
  // shape to add, and counting that as registered would silently claim hosted HF
  // sign-in works on Firefox when it does not.
  const body = geckoBlock[1].replace(/\/\/.*$/gm, '');
  const uris = [...body.matchAll(/'(https:[^']+)'/g)].map((m) => m[1]);
  if (!uris.length) {
    warn(
      'Hosted Hugging Face sign-in is not enabled on Firefox yet: HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS in js/oauth.js is empty. ' +
      'After the first signed AMO build, read the Redirect URI shown in Settings on Firefox (an extensions.allizom.org URL), add it to that ' +
      'list AND to the redirect_uris of https://chatpanel.net/.well-known/oauth-cimd. Until then Firefox users sign in with their own HF Client ID.',
    );
  } else ok(`Hosted Hugging Face sign-in is registered for Firefox (${uris.join(', ')}).`);
}

// --- AMO source-code submission -------------------------------------------
const vendor = path.join(extDir, 'js', 'vendor');
if (existsSync(vendor)) {
  const generated = readdirSync(vendor).filter((f) => f.endsWith('.js'));
  if (generated.length) {
    info(`The package contains generated/third-party bundles (${generated.join(', ')}), so AMO requires a source upload. tools/build-firefox.mjs emits dist/chatpanel-firefox-sources.zip with build instructions for exactly this.`);
  }
}

// --- Report ----------------------------------------------------------------
const line = (icon, m) => console.log(`  ${icon} ${m}`);
console.log(`\nFirefox preflight — derived manifest v${ff.version}\n`);
for (const m of oks) line('✓', m);
for (const m of infos) line('ℹ', m);
for (const m of warns) line('⚠', m);
for (const m of errors) line('✗', m);
console.log(
  `\n${errors.length} blocker(s), ${warns.length} warning(s), ${infos.length} note(s).` +
    (errors.length ? ' Fix blockers before building the Firefox package.\n' : ' No hard blockers — the Firefox package is installable.\n'),
);
process.exit(errors.length ? 1 : 0);
