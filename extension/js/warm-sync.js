// WARM tier sync — push the local (already-decrypted) history sources to the LOCAL
// gateway's BM25 index, so the gateway (and other on-device tools like OpenCode/Codex)
// can search the full corpus off the browser thread. On-device only — this talks to
// localhost; the data never leaves the machine. See docs/architecture-data-tiers.
//
// Sends UPSERTS for everything present + TOMBSTONES for ids that vanished since the last
// sync (so deletes propagate). The gateway upsert is idempotent, so a resend is safe.

import { loadHistorySources } from './history-rag.js';

let lastIds = new Set(); // ids sent on the previous successful sync (for tombstoning)
let syncing = false;

// One sync pass. `gatewayUrl` is the local gateway base (e.g. http://127.0.0.1:4320).
// Injectable deps keep it unit-testable. Returns a small summary; never throws.
export async function syncHistoryToGateway(gatewayUrl, {
  signal,
  loadSources = loadHistorySources,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!gatewayUrl || syncing || typeof fetchImpl !== 'function') return { ok: false, skipped: true };
  syncing = true;
  try {
    const sources = await loadSources({ includeChats: true, includeMeetings: true });
    const upserts = sources
      .filter((s) => s && s.id && s.text)
      .map((s) => ({ id: s.id, text: s.text, title: s.title || '', type: s.type || '', date: s.date || 0 }));
    const nowIds = new Set(upserts.map((u) => u.id));
    const removes = [...lastIds].filter((id) => !nowIds.has(id));
    if (!upserts.length && !removes.length) { lastIds = nowIds; return { ok: true, size: 0, sent: 0, removed: 0 }; }
    const res = await fetchImpl(`${String(gatewayUrl).replace(/\/$/, '')}/v1/history/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upserts, removes }),
      signal,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
    const out = await res.json().catch(() => ({}));
    lastIds = nowIds; // only advance the tombstone baseline on success
    return { ok: true, size: out.size, sent: upserts.length, removed: removes.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    syncing = false;
  }
}

// Reset the tombstone baseline (e.g. after the gateway restarts and loses its index, so
// the next sync re-sends everything as upserts rather than only the delta).
export function resetWarmSyncBaseline() { lastIds = new Set(); }
