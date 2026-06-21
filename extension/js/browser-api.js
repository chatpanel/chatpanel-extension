// Cross-engine WebExtension handle — so the page-action layer isn't hard-wired to
// one browser. Firefox/Safari expose `browser`; Chromium exposes `chrome` (and
// Firefox also aliases `chrome`). Using `api.*` instead of `chrome.*` keeps the
// portable surface (scripting / tabs) engine-agnostic.
//
// What ports and what doesn't:
//   • api.scripting / api.tabs  → all Chromium + Firefox (MV3) + Safari (limited).
//     The injected `*InPage` DOM functions are plain DOM → run anywhere.
//   • api.debugger (CDP)        → Chromium ONLY. There is no extension debugger
//     protocol in Firefox or Safari, so high-reliability/trusted-events mode is a
//     Chromium-only enhancement. `hasDebugger` feature-detects it; everything else
//     falls back to the synthetic path, which is cross-engine.
export const api =
  (typeof globalThis !== 'undefined' && (globalThis.browser || globalThis.chrome)) || undefined;

// True only where the CDP debugger API exists (Chromium). Used to gate the
// trusted-events backend; absence is not an error — we degrade to synthetic.
export const hasDebugger = !!(api && api.debugger);
