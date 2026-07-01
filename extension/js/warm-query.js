// WARM-tier query: ask the local gateway's full-corpus index, and fuse its
// ranking with the in-browser (HOT) results via Reciprocal Rank Fusion.
//
// Why fuse instead of replace: HOT carries a mild freshness prior and always has
// the result objects (chunked text/snippets); WARM is a clean BM25 over the whole
// corpus that keeps working when the browser index is still warming up or (later,
// with eviction) holds sources HOT has dropped. RRF needs no score calibration
// between the two engines — it merges by RANK, so a gateway score and a hot score
// never have to mean the same thing. Fail-safe: any gateway error → HOT unchanged.

// Query the gateway warm index. Returns [{id, score, title, type, date}] or [] on
// ANY failure (offline, disabled, 500) — the caller then just uses HOT results.
export async function searchGateway(gatewayUrl, query, { limit = 12, signal, fetchImpl } = {}) {
  const fetcher = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const url = String(gatewayUrl || '').trim();
  const q = String(query || '').trim();
  if (!fetcher || !url || !q) return [];
  try {
    const res = await fetcher(url.replace(/\/+$/, '') + '/v1/history/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q, limit }),
      signal,
    });
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results.filter((r) => r && r.id) : [];
  } catch {
    return [];
  }
}

// WARM eviction: bound the in-browser (HOT) index to the most recent `cap` sources
// so the worker doesn't hold a whole year of transcripts in memory. Only when warm
// is the safety net (`warm` truthy) — warm covers the older tail, and the caller's
// resolveSource() reconstitutes any warm-only match from the full source list, so
// recall is preserved. Without warm we must index everything, so this is a no-op
// then. Returns the same array when no cap is needed (identity → cheap cache key).
export function capHotSources(sources, { cap = 1500, warm = false } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  if (!warm || !cap || list.length <= cap) return list;
  return [...list].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, cap);
}

// Reciprocal Rank Fusion over N ranked id-lists. score(id) = Σ 1/(k + rank),
// rank 0-based. k dampens the weight of top ranks so a single list can't dominate.
// Returns [{id, score}] sorted desc, optionally capped to `limit`.
export function fuseRRF(lists, { k = 60, limit = 0 } = {}) {
  const score = new Map();
  for (const list of lists || []) {
    if (!Array.isArray(list)) continue;
    list.forEach((id, rank) => {
      if (id == null) return;
      score.set(id, (score.get(id) || 0) + 1 / (k + rank));
    });
  }
  const out = [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
  return limit > 0 ? out.slice(0, limit) : out;
}

// Fuse HOT result objects with WARM hits. HOT provides the objects (chunked text,
// url, snippet); WARM contributes a ranking co-signal. Fusion is at SOURCE
// granularity (warm is one doc per source; hot may be several chunks per source),
// then hot chunks are emitted in the fused source order. Warm-only ids that HOT
// never returned are ignored here (no re-chunking) — a no-op while HOT holds the
// full corpus. `resolveSource(id)` (optional) turns a WARM-only source id — one HOT
// never returned (older than the browser index holds, or beyond its limit) — into a
// displayable result, so the extension genuinely FALLS BACK to warm instead of
// dropping those hits. Without it, warm-only ids are skipped. Returns re-ordered
// results, capped to `limit`.
export function fuseHistoryResults(hotResults, warmHits, { limit = 8, resolveSource = null } = {}) {
  const hot = Array.isArray(hotResults) ? hotResults : [];
  const warm = Array.isArray(warmHits) ? warmHits : [];
  if (!warm.length) return hot.slice(0, limit);

  // Group hot chunks under their source id, preserving first-seen order.
  const bySource = new Map();
  const hotOrder = [];
  for (const r of hot) {
    const sid = r.sourceId ?? r.id;
    if (!bySource.has(sid)) {
      bySource.set(sid, []);
      hotOrder.push(sid);
    }
    bySource.get(sid).push(r);
  }
  const fused = fuseRRF([hotOrder, warm.map((h) => h.id)], { limit: 0 });
  const out = [];
  for (const { id, score } of fused) {
    const chunks = bySource.get(id);
    if (chunks) {
      for (const c of chunks) {
        out.push({ ...c, score }); // fused source score, applied to each of its chunks
        if (out.length >= limit) return out;
      }
      continue;
    }
    // WARM-only: resolve it to a result if we can, else skip.
    if (resolveSource) {
      const r = resolveSource(id);
      if (r) {
        out.push({ ...r, score, warmOnly: true });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
