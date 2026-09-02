// GENERATED — do not edit.
// Source of truth: chatpanel-events/reach.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// reach.js — how far a request may travel, on its own so it can travel alone.
//
// One ordered vocabulary answers "how far may this go" for three very different callers: the
// model router ranks a model's reach against a turn's requirement, pairing gives a phone a
// ceiling, and the bridge maps that ceiling to a toolset. Three declarations, one vocabulary,
// or "how far may this reach" gets three answers that drift.
//
// A separate module rather than a constant inside router.js for the reason scopes.js exists:
// the consumers have wildly different weights. The bridge has zero runtime dependencies by
// design and vendors what it needs — pulling the 50 KB model router in to reach a
// three-element array is exactly the transitive-graph mistake that split DATA_SCOPES out of
// capability.js.
//
// ORDERED, least to most: a ceiling comparison is an index comparison.
export const REACH = Object.freeze(['device', 'trusted', 'any']);

/** Position in the ladder; an unknown tier ranks LOWEST, so a typo never widens reach. */
export const reachRank = (r) => Math.max(0, REACH.indexOf(r));

/** Does `have` satisfy `need`? Fails closed — an unknown `have` is treated as 'device'. */
export function reachSatisfies(have, need) {
  return reachRank(have) >= reachRank(need);
}
