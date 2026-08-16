// GENERATED — do not edit.
// Source of truth: chatpanel-events/store.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The log store and the blob store.
//
// PERSISTENCE IS A HOST ADAPTER. The spine is host-independent, so the *semantics* live
// here and each host supplies the storage underneath: IndexedDB in the extension,
// SQLite on a gateway or daemon, a capped ring buffer colocated. One in-memory adapter
// ships here because tests, colocated hosts and the replay harness all want it.
//
// TWO STORES, DELIBERATELY SEPARATE.
//   • the LOG holds events — small, uniform, append-only, ~300-500 B each;
//   • the BLOB store holds content, addressed by hash and deduped, so the same note
//     excerpt attached across a hundred turns costs one copy.
// Keeping them apart is what makes crypto-shredding work: drop a blob and the event
// skeleton, causality chain and audit trail all survive.
//
// APPEND IS IDEMPOTENT ON EVENT ID. Replicating the log to a warm tier can retry
// safely — the log-level counterpart of the idempotency keys capabilities carry.

import { validateEvent, EventError } from './event.js';
import { linearize } from './order.js';

/**
 * Minimal adapter contract a host implements.
 *   get(key) -> value | undefined      put(key, value)      delete(key)
 *   keys(prefix?) -> string[]          size() -> bytes (approximate)
 */
export function createMemoryAdapter() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    put: (k, v) => { map.set(k, v); },
    delete: (k) => map.delete(k),
    keys: (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
    size: () => {
      let n = 0;
      for (const [k, v] of map) n += k.length + (typeof v === 'string' ? v.length : JSON.stringify(v).length);
      return n;
    },
    clear: () => map.clear(),
  };
}

const EV = 'e/';   // event by id
const SEQ = 's/';  // host -> highest seq seen

/** The append-only event log over a host adapter. */
export function createLogStore(adapter = createMemoryAdapter()) {
  const store = {
    /**
     * Append a validated event. Idempotent on `id`: re-appending the same event is a
     * no-op returning `{ appended: false }`, so replication retries are safe.
     * Rejects a seq that moves backwards for a host — that is a corrupt writer, not a gap.
     */
    append(event) {
      validateEvent(event);
      if (adapter.get(EV + event.id) !== undefined) return { appended: false, event };
      const highest = adapter.get(SEQ + event.host);
      if (highest !== undefined && event.seq <= highest) {
        throw new EventError('SEQ', `seq ${event.seq} <= ${highest} already seen for host ${event.host}`, event.host);
      }
      adapter.put(EV + event.id, event);
      adapter.put(SEQ + event.host, event.seq);
      return { appended: true, event };
    },

    appendAll(events) {
      const res = events.map((e) => store.append(e));
      return { appended: res.filter((r) => r.appended).length, total: events.length };
    },

    get: (id) => adapter.get(EV + id),
    has: (id) => adapter.get(EV + id) !== undefined,

    all: () => adapter.keys(EV).map((k) => adapter.get(k)),

    /** Every event in replay order — the only ordering anything should read. */
    ordered: () => linearize(store.all()),

    byType: (type) => store.all().filter((e) => e.type === type),

    /** One host's slice, for replication cursors. */
    range({ host, fromSeq = 0, toSeq = Infinity } = {}) {
      return store.all()
        .filter((e) => (!host || e.host === host) && e.seq >= fromSeq && e.seq <= toSeq)
        .sort((a, b) => a.seq - b.seq);
    },

    /** Highest seq per host — the cursor a replica sends to ask for what it lacks. */
    cursor() {
      const out = {};
      for (const k of adapter.keys(SEQ)) out[k.slice(SEQ.length)] = adapter.get(k);
      return out;
    },

    /** Events a replica with this cursor has not seen. */
    since(cursor = {}) {
      return store.all()
        .filter((e) => e.seq > (cursor[e.host] ?? -1))
        .sort((a, b) => (a.host === b.host ? a.seq - b.seq : a.host < b.host ? -1 : 1));
    },

    /** Walk the causality chain backwards from an event. */
    ancestry(id, seen = new Set()) {
      const e = store.get(id);
      if (!e || seen.has(id)) return [];
      seen.add(id);
      return [e, ...e.causes.flatMap((c) => store.ancestry(c, seen))];
    },

    stats: () => ({ events: adapter.keys(EV).length, bytes: adapter.size() }),
  };
  return store;
}

/**
 * Content-addressed blob store. Dedupes by hash, so attaching the same excerpt a
 * hundred times costs one copy — the rule that keeps the log from growing linearly in
 * content.
 *
 * `digest` is injected: no ambient dependency on a crypto implementation, and tests stay
 * deterministic. Defaults to SHA-256 via WebCrypto, present in browsers and Node >= 18.
 */
export function createBlobStore(adapter = createMemoryAdapter(), { digest = sha256Hex } = {}) {
  const B = 'b/';
  const store = {
    async put(content) {
      const hash = await digest(content);
      const key = B + hash;
      if (adapter.get(key) === undefined) adapter.put(key, content);
      return hash;
    },
    get: (hash) => adapter.get(B + hash),
    has: (hash) => adapter.get(B + hash) !== undefined,

    /**
     * CRYPTO-SHRED. Drops the payload and leaves a tombstone, so "delete this meeting"
     * can be honoured against an append-only log: the content is unrecoverable while
     * every event that referenced it, and the causality chain, stay intact. Replay then
     * reports verified-but-unavailable rather than substituting current content.
     */
    shred(hash) {
      if (adapter.get(B + hash) === undefined) return false;
      adapter.delete(B + hash);
      adapter.put(`t/${hash}`, { shredded: true });
      return true;
    },
    isShredded: (hash) => adapter.get(`t/${hash}`) !== undefined,

    /** Resolve a Ref the way replay must: exact, shredded, or absent. */
    lookup(ref) {
      const value = store.get(ref.hash);
      if (value === undefined) return null;
      return { hash: ref.hash, value };
    },

    stats: () => ({
      blobs: adapter.keys(B).length,
      shredded: adapter.keys('t/').length,
      bytes: adapter.size(),
    }),
  };
  return store;
}

// Global WebCrypto: present in every browser and in Node from 19 onward. Callers on an
// older or unusual runtime inject their own `digest` rather than the package reaching
// for `node:crypto`, which would put a Node import in a browser-first module.
async function sha256Hex(content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
