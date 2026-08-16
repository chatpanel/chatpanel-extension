// GENERATED — do not edit.
// Source of truth: chatpanel-events/upcast.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Schema evolution — an append-only log outlives every version of the code that wrote
// it, so readers upcast and writers never mutate a stored event.
//
// The machinery exists from v1 with an empty chain, deliberately: the cost of adding it
// later is rewriting every reader, and the cost of having it now is this file.
//
// The log format is a Tesla-rule contract — additive only, guarded by a drift check,
// exactly like the bridge wire protocol.

import { CURRENT_VERSION, EventError, validateEvent } from './event.js';

/**
 * v(n) -> v(n+1) pure functions. Empty at v1.
 * Each MUST be total: it may not throw for any event of its input version.
 */
export const UPCASTERS = Object.freeze({
  // 1: (e) => ({ ...e, v: 2, payload: { ...e.payload, newField: defaultValue } }),
});

/** Carry a stored event forward to CURRENT_VERSION. Pure. */
export function upcast(stored) {
  if (!stored || typeof stored !== 'object') throw new EventError('SHAPE', 'event must be an object');
  let e = stored;
  let guard = 0;
  while (e.v < CURRENT_VERSION) {
    const step = UPCASTERS[e.v];
    if (!step) throw new EventError('UPCAST', `no upcaster from v${e.v}`, e.v);
    e = step(e);
    if (++guard > 64) throw new EventError('UPCAST', 'upcaster chain did not terminate');
  }
  if (e.v > CURRENT_VERSION) {
    throw new EventError('UPCAST', `event is v${e.v}; this reader only knows v${CURRENT_VERSION}`, e.v);
  }
  return validateEvent(e);
}

export function upcastAll(stored) { return stored.map(upcast); }
