// GENERATED — do not edit.
// Source of truth: chatpanel-events/ref.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// References — how the log addresses content WITHOUT copying it.
//
// An event records "note n_88, lines 10-40, hash H" and never the text. Content that
// actually entered a model request is written once into a content-addressed blob store
// keyed by hash, so the same excerpt across a hundred turns costs one copy.
//
// Replay resolves a Ref by hash: match => exact reconstruction; blob absent or
// crypto-shredded => VERIFIED_BUT_UNAVAILABLE. It never silently substitutes today's
// version of the note, because that would make replay quietly wrong instead of loudly
// incomplete.

export const REF_KINDS = Object.freeze(['note', 'meeting', 'chat', 'page', 'result', 'blob']);

export const RESOLUTION = Object.freeze({
  EXACT: 'exact',                              // blob present, hash matches
  UNAVAILABLE: 'verified-but-unavailable',     // we know what it was; we no longer hold it
  DRIFTED: 'drifted',                          // source still exists but its hash changed
});

/** Build a Ref. `hash` is the content hash AT CAPTURE TIME — that is the whole point. */
export function makeRef({ kind, id, hash, range = null, stored = false }) {
  if (!REF_KINDS.includes(kind)) throw new TypeError(`ref: unknown kind ${kind}`);
  if (typeof id !== 'string' || !id) throw new TypeError('ref: id required');
  if (typeof hash !== 'string' || !hash) throw new TypeError('ref: hash required');
  const ref = { kind, id, hash };
  if (range) {
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.to < range.from) {
      throw new TypeError('ref: range must be {from,to} integers with to >= from');
    }
    ref.range = { from: range.from, to: range.to };
  }
  if (stored) ref.stored = true;
  return Object.freeze(ref);
}

export function isRef(v) {
  return !!v && typeof v === 'object'
    && REF_KINDS.includes(v.kind)
    && typeof v.id === 'string' && v.id.length > 0
    && typeof v.hash === 'string' && v.hash.length > 0;
}

/**
 * Classify what a replay can say about a Ref, given what the blob store holds now.
 * `lookup(ref) -> { hash } | null`. Pure: the caller owns the store.
 */
export function resolveRef(ref, lookup) {
  const got = lookup(ref);
  if (!got) return { resolution: RESOLUTION.UNAVAILABLE, ref };
  if (got.hash !== ref.hash) return { resolution: RESOLUTION.DRIFTED, ref, actualHash: got.hash };
  return { resolution: RESOLUTION.EXACT, ref, value: got.value };
}
