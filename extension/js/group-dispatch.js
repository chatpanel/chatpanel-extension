// Turn a group of tools into ONE registered tool — SHARED, in `@chatpanel/events/tool-dispatch.js`.
//
// The page dispatcher proved the shape and earned three bugs doing it (the stripped `args`
// envelope, the blinded loop guard, the unreadable activity rows). Every later group — the
// user's own data, MCP servers, and the desktop's turn — goes through the shared copy
// instead of re-earning them. This file keeps the extension's import path stable.

export { makeDispatchProvider, withGuidance } from './events/tool-dispatch.js';
export { estimateTokens as estimate } from './events/tool-dispatch.js';
