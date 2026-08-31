// Chrome MV3 manifest → Firefox MV3 manifest.
//
// The Firefox add-on is NOT a fork: it is the SAME extension/ source tree with a
// different manifest and three Chromium-only files removed. Everything that could
// drift if it were hand-maintained is DERIVED here instead — permissions, content
// scripts, matches, icons, CSP, version, description — so a change in
// extension/manifest.json reaches Firefox automatically and the two packages can be
// cut from one tag, in parallel, forever.
//
// This module is a pure function so tools/test-firefox-manifest.mjs can assert the
// mapping without building anything.
//
// The mapping, and why each line exists (verified against MDN browser-compat-data):
//
//   background.service_worker → background.scripts + type:"module"
//       Firefox does not implement background service workers at all. Its MV3
//       equivalent is a non-persistent EVENT PAGE, which has the same
//       wake-on-listener lifecycle the code is already written for (state lives in
//       storage.session; every listener is registered at top level).
//       background.type:"module" is Firefox 112+.
//   side_panel → sidebar_action
//       Different API for the same surface. See extension/js/side-panel.js, which is
//       the only code allowed to know which one it got.
//   options_page → options_ui
//       Firefox does accept options_page, but only as an alias that is ignored when
//       options_ui.page is set and that always opens in a new tab implicitly. We write
//       options_ui with open_in_tab:true so the behavior is stated rather than
//       inherited — a full tab is what the Chromium build gives you and what the
//       settings page's layout assumes.
//   commands._execute_action → commands._execute_sidebar_action
//       Chromium opens the panel by activating the toolbar action (paired with
//       sidePanel.setPanelBehavior). Firefox has a dedicated reserved command that
//       opens the sidebar; _execute_action there would only click the button.
//   minimum_chrome_version → browser_specific_settings.gecko.strict_min_version
//   permissions: drop sidePanel, offscreen, debugger
//       None exist in Firefox. Listing them produces install-time warnings and AMO
//       review questions for capabilities the build cannot use. Each already
//       feature-detects at runtime (browser-api.js), so removing the permission
//       changes behavior in exactly one way: the UI stops offering it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The add-on ID. Firefox REQUIRES an explicit id to sign an MV3 extension (AMO does
// not assign one), and identity.getRedirectURL() is derived from it — so changing
// this string invalidates every registered OAuth redirect URI. Treat it as permanent.
export const GECKO_ID = 'chatpanel@chatpanel.net';

// Floor version, set by the newest thing the manifest actually needs:
//   • data_collection_permissions (below) → Firefox 140, Android 142. This is the
//     binding constraint, and it is not optional: AMO requires the key on new
//     submissions, and its linter warns if the floor predates support for it
//     ("released before version 140 introduced support for …").
//   • content_scripts world:"MAIN" and scripting world MAIN → 128 (this is what keeps
//     live captions flowing in a backgrounded meeting tab — without it meeting capture
//     silently degrades, so it is a hard floor, not a nicety).
//   • management.ExtensionInfo.installType (js/update.js) → 127.
//   • storage.session → 115. tabs.update autoDiscardable → 116. action → 109.
// 140 is also an ESR (128 ESR is end-of-life), so this stays reachable by managed and
// enterprise installs. Android needs its own, higher floor: the same key landed there
// two releases later.
export const STRICT_MIN_VERSION = '140.0';
export const STRICT_MIN_VERSION_ANDROID = '142.0';

// Mandatory for new AMO submissions since 2025-11-03.
//
// "none" is the accurate claim for ChatPanel and it is the whole product thesis:
// the extension transmits nothing to ChatPanel or any third party of our choosing.
// The default target is the in-browser model, which never leaves the device; when a
// user configures an endpoint, traffic goes from their browser straight to the
// service THEY chose, with client-side redaction applied first. See
// docs/firefox-publishing.md for the reviewer-facing wording.
export const DATA_COLLECTION_PERMISSIONS = { required: ['none'] };

// Permissions with no Firefox implementation. Every one of these is feature-detected
// at runtime, so dropping the permission degrades the feature instead of breaking it.
export const CHROMIUM_ONLY_PERMISSIONS = Object.freeze({
  sidePanel: 'Firefox uses sidebar_action; see extension/js/side-panel.js.',
  offscreen: 'No offscreen documents in Firefox; js/webllm.js falls back to the in-panel engine.',
  debugger: 'No extension debugger protocol in Firefox (bug 1316741); page control uses synthetic events.',
});

// Files that cannot do anything on Firefox. Shipping them to AMO would mean a reviewer
// reading code the build can never reach — and, for the 6.3 MB WebLLM bundle, AMO's
// linter rejecting the submission outright.
export const CHROMIUM_ONLY_FILES = Object.freeze([
  // Interactive-artifact sandbox. Firefox MV3 has no manifest "sandbox.pages", so the
  // opaque-origin page can't exist there; js/artifacts.js degrades to Code + "Open ↗"
  // (a blob: tab, which is isolated on every engine). Shipping the files without the
  // manifest key would be a page that silently runs with normal extension privileges —
  // exactly what must never happen.
  'sandbox.html',
  'js/sandbox-runner.js',
  'offscreen.html',         // host page for the offscreen WebLLM engine
  'js/offscreen-webllm.js', // its entry point (statically imports the bundle below)
  // The WebLLM runtime. Dead weight on Firefox in the most literal sense: its runtime
  // requires maxStorageBuffersPerShaderStage = 10 and Firefox reports the WebGPU spec
  // default of 8, so the engine can never initialize there (see js/webgpu-support.js).
  // It is also 6.3 MB, over AMO's 5 MB parse ceiling, which fails validation with
  // "This file is not binary and is too large to parse." Excluding it fixes the
  // submission AND drops ~2 MB from the package. js/webllm.js loads it with a dynamic
  // import() guarded by the WebGPU probe, and reports a clear error if it is ever
  // reached in a build that does not carry it.
  'js/vendor/web-llm.js',
]);

// Manifest keys Firefox does not understand. Left in place they are install warnings.
export const CHROMIUM_ONLY_KEYS = Object.freeze(['sandbox', 'minimum_chrome_version', 'side_panel', 'options_page', 'key', 'update_url', 'oauth2']);

export function readChromeManifest(extDir = path.join(ROOT, 'extension')) {
  return JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
}

/**
 * Derive the Firefox manifest from the Chrome one. Pure: no I/O, no mutation of the
 * input. Everything not explicitly remapped is carried over verbatim, so a new key
 * added for Chrome reaches Firefox by default rather than being silently dropped —
 * and tools/test-firefox-manifest.mjs fails if a key is neither carried nor mapped.
 */
export function toFirefoxManifest(chrome) {
  const ff = structuredClone(chrome);

  for (const key of CHROMIUM_ONLY_KEYS) delete ff[key];

  // Android is opt-IN: per the manifest spec the add-on is desktop-only unless
  // `gecko_android` is present (even as `{}`). We opt in because the one thing that made
  // it impossible — no surface to put the UI on — is solved: Firefox for Android has no
  // sidebar_action, so js/side-panel.js opens the panel page as a TAB there, the same
  // fallback that makes ChatPanel usable in Chromium-based Android browsers.
  //
  // What is genuinely degraded on Android, all of it feature-detected rather than fatal:
  //   • commands      — no keyboard shortcut (there is no keyboard to shortcut).
  //   • menus         — no "Ask ChatPanel about this page" context item.
  //   • identity      — no hosted OAuth sign-in; paste an API key instead.
  //   • windows       — no window focus/lookup; the tab fallback needs none.
  // Everything the product is actually for — chat, notes, page context, storage,
  // downloads, alarms, content scripts incl. world:"MAIN" — is supported.
  ff.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: STRICT_MIN_VERSION,
      data_collection_permissions: structuredClone(DATA_COLLECTION_PERMISSIONS),
    },
    // Android floor is HIGHER than desktop, and only because of one key:
    // data_collection_permissions shipped in Firefox 140 but not until 142 on Android.
    gecko_android: { strict_min_version: STRICT_MIN_VERSION_ANDROID },
  };

  // Event page, not a service worker.
  ff.background = { scripts: [chrome.background?.service_worker || 'background.js'], type: 'module' };

  // The panel.
  if (chrome.side_panel?.default_path) {
    ff.sidebar_action = {
      default_panel: chrome.side_panel.default_path,
      default_title: chrome.action?.default_title || chrome.name,
      default_icon: structuredClone(chrome.icons || {}),
      // Opening the sidebar uninvited on install is the single most-complained-about
      // Firefox add-on behavior; the toolbar button and Ctrl+I are the way in.
      open_at_install: false,
    };
  }

  // The settings page.
  if (chrome.options_page) ff.options_ui = { page: chrome.options_page, open_in_tab: true };

  // The keyboard shortcut: same keys, different reserved command.
  if (chrome.commands?._execute_action) {
    const { _execute_action: action, ...rest } = chrome.commands;
    ff.commands = { ...rest, _execute_sidebar_action: structuredClone(action) };
  }

  ff.permissions = (chrome.permissions || []).filter((p) => !(p in CHROMIUM_ONLY_PERMISSIONS));

  return ff;
}

export default toFirefoxManifest;
