// WARM tier sync — push the local (already-decrypted) history sources to the LOCAL
// gateway's BM25 index, so the gateway (and other on-device tools like OpenCode/Codex)
// can search the full corpus off the browser thread. On-device only — this talks to
// localhost; the data never leaves the machine. See docs/architecture-data-tiers.
//
// Missing browser records are deliberately not tombstoned: they may have aged out
// of IndexedDB while remaining in an encrypted backup.

import { loadHistorySources } from './history-rag.js';
import { isLoopbackHost } from './net.js';

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

// One sync pass. `gatewayUrl` is the local gateway base (e.g. http://127.0.0.1:4320).
// Injectable deps keep it unit-testable. Returns a small summary; never throws.
export async function syncHistoryToGateway(gatewayUrl, {
  signal,
  loadSources = loadHistorySources,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!gatewayUrl || syncing || typeof fetchImpl !== 'function') return { ok: false, skipped: true };
  // Fail closed: never send the decrypted corpus off-box. A non-loopback URL here
  // is a configuration error (or worse), not something to "try anyway".
  if (!isLoopbackGateway(gatewayUrl)) return { ok: false, skipped: true, error: 'gateway url is not loopback — refusing to send history off-box' };
  syncing = true;
  try {
    const sources = await loadSources({ includeChats: true, includeMeetings: true, includeNotes: true });
    const upserts = sources
      .filter((s) => s && s.id && s.text)
      .map((s) => ({ id: s.id, text: s.text, title: s.title || '', type: s.type || '', date: s.date || 0 }));
    if (!upserts.length) return { ok: true, size: 0, sent: 0, removed: 0, batches: 0 };
    let size = 0;
    const batches = chunkHistoryUpserts(upserts);
    for (const batch of batches) {
      const res = await fetchImpl(`${String(gatewayUrl).replace(/\/$/, '')}/v1/history/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upserts: batch, removes: [] }), signal,
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
      const out = await res.json().catch(() => ({}));
      size = out.size ?? size;
    }
    return { ok: true, size, sent: upserts.length, removed: 0, batches: batches.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    syncing = false;
  }
}

// Retained for callers/tests from the earlier tombstone implementation. Every
// archive-preserving sync now sends current records as idempotent upserts.
export function resetWarmSyncBaseline() { /* retained for API compatibility */ }
