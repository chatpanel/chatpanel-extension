// The extension's durable event log — the first real consumer of @chatpanel/events.
//
// WHY NOT AN ADAPTER. The package's store contract is synchronous (get/put/keys) and
// IndexedDB is not, so IDB cannot satisfy it directly. Rather than make the whole
// package async — which would buy nothing for the in-memory and colocated hosts — this
// is a SINK: it owns an appender, validates through the shared contract, and persists
// asynchronously. Reads are async and go straight to IDB. The synchronous store stays
// what it is good for: a session working set and the replay harness.
//
// SEQ MUST SURVIVE A SERVICE-WORKER RESTART. `(host, seq)` is the ordering authority, so
// a counter that restarts at 0 would produce events the store rejects and a replay that
// cannot be ordered. On open we read this host's highest stored seq and resume above it.
//
// HOST IDENTITY is per install, persisted once. Two installs are two hosts, which is
// exactly what the linearization rule expects.
//
// Everything here is dynamic-imported at its call site — the log must never sit on the
// panel's first-paint graph.

import { createAppender, validateEvent } from './events/event.js';

const DB = 'chatpanel-log';
const STORE = 'events';
const HOST_KEY = 'chatpanel:logHostId';
const VERSION = 1;

let ready = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('hostSeq', ['host', 'seq'], { unique: true });
        os.createIndex('type', 'type', { unique: false });
        os.createIndex('at', 'at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function hostId() {
  const got = await chrome.storage.local.get(HOST_KEY);
  if (got[HOST_KEY]) return got[HOST_KEY];
  const id = `ext_${crypto.randomUUID().slice(0, 8)}`;
  await chrome.storage.local.set({ [HOST_KEY]: id });
  return id;
}

/** Highest seq already stored for this host, or -1. Resumes the counter across restarts. */
function highestSeq(db, host) {
  return new Promise((resolve) => {
    const idx = db.transaction(STORE, 'readonly').objectStore(STORE).index('hostSeq');
    const range = IDBKeyRange.bound([host, -Infinity], [host, Infinity]);
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => resolve(req.result ? req.result.value.seq : -1);
    req.onerror = () => resolve(-1);
  });
}

async function init() {
  const [db, host] = await Promise.all([openDb(), hostId()]);
  const appender = createAppender({ host, seq: (await highestSeq(db, host)) + 1 });
  return { db, host, appender };
}

function open() {
  if (!ready) ready = init().catch((err) => { ready = null; throw err; });
  return ready;
}

/**
 * Append one durable fact. Returns the event, or null when logging is unavailable.
 *
 * NEVER THROWS INTO A CALLER. A log that can break a chat turn is worse than no log —
 * provenance is not worth failing the thing it describes. Failures are reported once and
 * swallowed.
 */
export async function emit(type, payload, causes = []) {
  try {
    const { db, appender } = await open();
    const event = validateEvent(appender.append(type, payload, causes));
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(event);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return event;
  } catch (err) {
    console.warn('[chatpanel] event log unavailable:', err?.message || err);
    return null;
  }
}

/** Fire-and-forget: for hot paths that must not await a write. */
export function emitAsync(type, payload, causes = []) {
  void emit(type, payload, causes);
}

/** Most recent events, newest first. For the run-details drawer and export. */
export async function recent(limit = 200) {
  const { db } = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('at').openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function all() {
  const { db } = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function stats() {
  const events = await all();
  const bytes = events.reduce((n, e) => n + JSON.stringify(e).length, 0);
  return { events: events.length, bytes };
}

/** Drop everything. Used by the settings "clear activity" control and by tests. */
export async function clear() {
  const { db } = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
