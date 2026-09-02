// WARM tier sync — push the local (already-decrypted) history sources to the LOCAL
// gateway's BM25 index, so the gateway (and other on-device tools like OpenCode/Codex)
// can search the full corpus off the browser thread. On-device only — this talks to
// localhost; the data never leaves the machine. See docs/architecture-data-tiers.
//
// Missing browser records are deliberately not tombstoned: they may have aged out
// of IndexedDB while remaining in an encrypted backup.

import { loadHistorySources } from './history-rag.js';
import { isLoopbackHost } from './net.js';
// Static: warm sync runs on an alarm in the service worker, where `import()` throws. It is
// off every first-paint graph, so there is nothing to keep it off. `store` stays injectable
// for the tests.
import * as memoryStore from './store-memory.js';

// Decrypted history may ONLY be POSTed to a loopback gateway. This is the hard
// privacy boundary of warm sync: the corpus is plaintext in flight, so a
// misconfigured or tampered `warmSearch.url` pointing at a remote host must fail
// closed, not exfiltrate. Reuse the one loopback definition (net.js) rather than
// re-deriving "is this local" here.
export function isLoopbackGateway(gatewayUrl) {
  try { return isLoopbackHost(new URL(gatewayUrl).hostname); } catch { return false; }
}

let syncing = false;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export function chunkHistoryUpserts(upserts, maxBytes = MAX_BATCH_BYTES) {
  const batches = [];
  let batch = [];
  let bytes = 32;
  const encoder = new TextEncoder();
  for (const record of upserts) {
    const recordBytes = encoder.encode(JSON.stringify(record)).byteLength + 2;
    if (batch.length && bytes + recordBytes > maxBytes) {
      batches.push(batch); batch = []; bytes = 32;
    }
    batch.push(record); bytes += recordBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// The change-watermark: id → a cheap signature of what we last pushed. Persisted so an
// INCREMENTAL sync sends only records that are new or changed, and REMOVES records that
// vanished from the browser (a delete or a prune) — instead of re-pushing the whole corpus
// every time a meeting adds one transcript line. Kept in chrome.storage.local so it survives
// the ephemeral service worker.
const SIG_KEY = 'chatpanel:warmSyncSigs';
const sigOf = (u) => `${u.date || 0}:${(u.text || '').length}`;

// Storage adapter — injected in tests; defaults to chrome.storage.local. When absent (a unit
// test that passes no storage), the watermark is empty every time, so the sync degrades to a
// full push and never removes — the safe, pre-incremental behavior.
function defaultStorage() {
  const local = globalThis.chrome?.storage?.local;
  if (!local) return null;
  return {
    async get(key) { try { const g = await local.get(key); return g[key] || {}; } catch { return {}; } },
    async set(key, val) { try { await local.set({ [key]: val }); } catch { /* ignore */ } },
  };
}

// One sync pass. `gatewayUrl` is the local gateway base (e.g. http://127.0.0.1:4320).
// Injectable deps keep it unit-testable. Returns a small summary; never throws.
//
// Incremental by default: diffs the current corpus against the watermark and sends only the
// delta (changed/new upserts + vanished removes). `force: true` re-pushes everything (the
// manual "Sync now" and startup catch-up), which also re-seeds the watermark.
//
// Removes are watermark-scoped ON PURPOSE: only records THIS pipeline synced and then saw
// disappear are removed. Anything the gateway holds that never came through here — e.g.
// records ingested from an encrypted backup — is left alone, so warm can still be a superset
// archive without this sync nuking it.
export async function syncHistoryToGateway(gatewayUrl, {
  signal,
  loadSources = loadHistorySources,
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  force = false,
} = {}) {
  if (!gatewayUrl || syncing || typeof fetchImpl !== 'function') return { ok: false, skipped: true };
  // Fail closed: never send the decrypted corpus off-box. A non-loopback URL here
  // is a configuration error (or worse), not something to "try anyway".
  if (!isLoopbackGateway(gatewayUrl)) return { ok: false, skipped: true, error: 'gateway url is not loopback — refusing to send history off-box' };
  syncing = true;
  try {
    const sources = await loadSources({ includeChats: true, includeMeetings: true, includeNotes: true });
    const all = sources
      .filter((s) => s && s.id && s.text)
      .map((s) => ({ id: s.id, text: s.text, title: s.title || '', type: s.type || '', date: s.date || 0 }));

    const prev = storage ? (await storage.get(SIG_KEY)) || {} : {};
    const curSig = {};
    for (const u of all) curSig[u.id] = sigOf(u);

    // Delta: what to push, what to drop.
    const upserts = force ? all : all.filter((u) => prev[u.id] !== curSig[u.id]);
    const removes = Object.keys(prev).filter((id) => !(id in curSig));

    if (!upserts.length && !removes.length) {
      if (storage) await storage.set(SIG_KEY, curSig); // keep the watermark warm even on a no-op
      return { ok: true, size: undefined, sent: 0, removed: 0, batches: 0, unchanged: true };
    }

    const base = String(gatewayUrl).replace(/\/$/, '');
    const post = async (body) => {
      const res = await fetchImpl(`${base}/v1/history/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal,
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
      return (await res.json().catch(() => ({}))) || {};
    };

    let size;
    // Upserts can be large on a forced full sync → batch them. Removes ride the last POST
    // (or their own, if there were no upserts) so a delete-only sync still goes through.
    const batches = upserts.length ? chunkHistoryUpserts(upserts) : [[]];
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1;
      const out = await post({ upserts: batches[i], removes: last ? removes : [] });
      size = out.size ?? size;
    }

    if (storage) await storage.set(SIG_KEY, curSig); // commit the watermark only after success
    return { ok: true, size, sent: upserts.length, removed: removes.length, batches: batches.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    syncing = false;
  }
}

/**
 * MEMORY sync — two-way, in one round trip.
 *
 * History flows one way: the browser is the origin and the gateway is a warm copy. Memory does
 * not. A CLI agent calling `remember` over MCP writes to the GATEWAY, and that fact has to come
 * back or the feature is two half-memories that disagree — the panel would not know your name
 * because you told Claude Code, which is exactly the failure memory exists to remove.
 *
 * A two-way merge is normally where duplication starts. It is safe here for one reason: both
 * sides reconcile with the SAME function from the same file, and `reconcile` keys on the FACT
 * (its slot, then its wording), not on a row id. So pushing what was already pushed merges
 * nothing, the ids never have to agree, and repeated passes converge instead of doubling.
 *
 * Loopback-only, like the history push: memory is the most personal thing here.
 */
export async function syncMemoryWithGateway(gatewayUrl, {
  signal, fetchImpl = globalThis.fetch, store = null,
} = {}) {
  if (!gatewayUrl || typeof fetchImpl !== 'function') return { ok: false, skipped: true };
  if (!isLoopbackGateway(gatewayUrl)) {
    return { ok: false, skipped: true, error: 'gateway url is not loopback — refusing to send memory off-box' };
  }
  const mem = store || memoryStore;
  try {
    const mine = await mem.getMemories();
    const res = await fetchImpl(`${String(gatewayUrl).replace(/\/$/, '')}/v1/memory/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Sent WITHOUT ids: the gateway matches on the fact, and forcing our row ids onto its
      // store would make the two sides' identities collide for no benefit.
      body: JSON.stringify({
        upserts: mine.map(({ id, ...rest }) => rest),  // eslint-disable-line no-unused-vars
      }),
      signal,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
    const out = (await res.json().catch(() => ({}))) || {};

    // Pull back the merged set. `importMemories` reconciles too, so what we just pushed comes
    // home as duplicates (no-ops) and only what the agents wrote is actually new.
    const pulled = Array.isArray(out.memories)
      ? await mem.importMemories(out.memories.map(({ id, ...rest }) => rest), { mode: 'merge' }) // eslint-disable-line no-unused-vars
      : 0;
    return { ok: true, pushed: mine.length, merged: out.merged || 0, pulled, size: out.size };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Clear the change-watermark so the next sync re-pushes everything (e.g. after the user
// points at a fresh gateway). A subsequent sync with force:true does the same in one call.
export async function resetWarmSyncBaseline(storage = defaultStorage()) {
  if (storage) await storage.set(SIG_KEY, {});
}
