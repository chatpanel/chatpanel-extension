// Cross-engine WebExtension handle — so the client isn't hard-wired to one browser.
// Firefox/Safari expose `browser`; Chromium exposes `chrome`.
//
// In Firefox MV3 the two namespaces are THE SAME OBJECT (Gecko's
// ExtensionPageChild: "For MV3 and later, this is just an alias for browser"), so
// `chrome.*` there is fully promise-based AND still accepts the optional trailing
// callbacks Chromium code uses. That is why the ~170 modules in this extension can
// keep calling `chrome.*` verbatim on both engines — there is no namespace shim and
// no polyfill. What genuinely differs is the SET of available APIs, which is what
// this module exists to describe.
//
// What ports and what doesn't:
//   • api.scripting / api.tabs / api.storage / api.alarms / api.downloads /
//     api.identity / api.contextMenus / api.webNavigation → Chromium + Firefox.
//     The injected `*InPage` DOM functions are plain DOM → run anywhere.
//   • api.debugger (CDP)  → Chromium ONLY (Firefox bug 1316741, wontfix-for-now).
//     `hasDebugger` gates the trusted-events backend; absence is not an error —
//     page control degrades to the synthetic path, which is cross-engine.
//   • api.sidePanel       → Chromium ONLY. Firefox has `sidebarAction` instead, a
//     differently-shaped API. Never call either directly: use js/side-panel.js.
//   • api.offscreen       → Chromium ONLY. The "keep the in-browser model warm"
//     engine falls back to the in-panel engine everywhere else (js/webllm.js).
export const api =
  (typeof globalThis !== 'undefined' && (globalThis.browser || globalThis.chrome)) || undefined;

// True only where the CDP debugger API exists (Chromium). Used to gate the
// trusted-events backend; absence is not an error — we degrade to synthetic.
export const hasDebugger = !!(api && api.debugger);

// Chromium's offscreen documents (js/webllm.js "stay warm" engine).
export const hasOffscreen = !!(api && api.offscreen);

// The two mutually-exclusive side-panel APIs. Exactly one is present per engine;
// js/side-panel.js is the only place allowed to branch on them.
export const hasSidePanelApi = !!(api && api.sidePanel);
export const hasSidebarAction = !!(api && api.sidebarAction);

// Engine identity, derived from capabilities rather than the user agent (which
// lies, and isn't available in a service worker on every channel). Used for
// copy that must name the browser and for store-specific update links.
export const isGecko = hasSidebarAction && !hasSidePanelApi;
export const engine = isGecko ? 'gecko' : 'chromium';
