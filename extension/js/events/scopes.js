// GENERATED — do not edit.
// Source of truth: chatpanel-events/scopes.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// scopes.js — the data-scope vocabulary, on its own so it can travel alone.
//
// One list names what anything in ChatPanel may touch. Capabilities declare `reads`
// and `writes` from it, sources declare `reads`, and a skill package declares `reads`
// — three declarations, one vocabulary, or "what may this reach" gets three answers.
//
// It is a separate module rather than a constant inside capability.js because the
// consumers have very different weights. The bridge vendors the skill contract and has
// zero runtime dependencies by design; pulling the capability machinery and the event
// schema behind it to reach a five-element array would be the transitive-graph mistake
// the extension's first-paint budget exists to prevent, one repo over.
export const DATA_SCOPES = Object.freeze(['notes', 'meetings', 'chats', 'memory', 'page', 'files', 'net']);
