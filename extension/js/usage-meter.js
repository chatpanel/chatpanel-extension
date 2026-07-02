// Token accounting across EVERY model-bound call — chat, notes (all agent /
// swarm / ambient calls), meetings, autocomplete, topic extraction.
//
// Model-agnostic by construction: the single chokepoint `providers.streamChat`
// records here whenever a provider adapter reports usage (see the `usage` event
// in providers.js). The meter never makes a model call itself and never blocks
// one — writes are best-effort, exactly like pii-usage.js.
//
// Two views, both in chrome.storage.local (so the side panel, notes, and the
// settings page all read the same numbers):
//   • ROLLUPS  — aggregate per {surface, agentId, model, day}. Bounded, cheap;
//     answers "notes ambient is burning N tokens" without scanning a log.
//   • LOG      — a capped ring buffer of the most recent calls, for drill-down
//     (which note / conversation / meeting spent what). Pruned to RING_MAX.
//
// Tokens are the source of truth; $ cost is derived on read via usage-pricing.js
// (BYO/free/local models have no reliable rate, so cost is always best-effort).

const ROLLUP_KEY = 'chatpanel:usageRollups';
const LOG_KEY = 'chatpanel:usageLog';
const RING_MAX = 500; // most-recent calls kept for drill-down

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

async function readKey(key, fallback) {
  try {
    const got = await chrome.storage.local.get(key);
    return got[key] ?? fallback;
  } catch { return fallback; }
}

// Serialize read-modify-write so concurrent calls (the notes swarm fires many
// agents in parallel) don't clobber each other's rollup increments. Per-context
// chain — cheap, and covers the parallelism that actually matters.
let writeChain = Promise.resolve();

// Record ONE completed model call. Called fire-and-forget from streamChat; a
// storage failure must never surface to the user or block the turn.
export async function recordUsage(entry = {}) {
  writeChain = writeChain.then(() => writeUsage(entry)).catch(() => {});
  return writeChain;
}

async function writeUsage(entry = {}) {
  const ts = entry.ts || Date.now();
  const rec = {
    ts,
    surface: entry.surface || 'other', // note | chat | meeting | autocomplete | other
    sourceId: entry.sourceId || null, // noteId / convId / meetingId
    agentId: entry.agentId || null,
    provider: entry.provider || null, // openai | anthropic | bridge
    model: entry.model || null,
    inputTokens: num(entry.inputTokens),
    outputTokens: num(entry.outputTokens),
    cacheReadTokens: num(entry.cacheReadTokens),
    cacheWriteTokens: num(entry.cacheWriteTokens),
    estimated: !!entry.estimated,
    costUsd: entry.costUsd != null ? num(entry.costUsd) : null, // provider-reported (bridge)
  };
  // Skip empty records (an errored call with no tokens) so they don't pad counts.
  if (!rec.inputTokens && !rec.outputTokens && !rec.cacheReadTokens && !rec.cacheWriteTokens) return;

  try {
    const store = await readKey(ROLLUP_KEY, {});
    const key = `${rec.surface}|${rec.agentId || '?'}|${rec.model || '?'}|${dayOf(ts)}`;
    const r = store[key] || { surface: rec.surface, agentId: rec.agentId, model: rec.model, day: dayOf(ts), calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCalls: 0, costUsd: 0 };
    r.calls += 1;
    r.inputTokens += rec.inputTokens;
    r.outputTokens += rec.outputTokens;
    r.cacheReadTokens += rec.cacheReadTokens;
    r.cacheWriteTokens += rec.cacheWriteTokens;
    if (rec.estimated) r.estimatedCalls += 1;
    if (rec.costUsd != null) r.costUsd += rec.costUsd; // only bridge-reported cost is summed here
    store[key] = r;

    const log = await readKey(LOG_KEY, []);
    log.push(rec);
    if (log.length > RING_MAX) log.splice(0, log.length - RING_MAX);

    await chrome.storage.local.set({ [ROLLUP_KEY]: store, [LOG_KEY]: log });
  } catch { /* best effort — never block a turn on accounting */ }
}

// Read-only rollup snapshot for the UI. Optionally filter by surface and/or a
// `sinceDays` window. Groups by the requested dimension and attaches $ cost
// (dynamic-imports the rate table so it stays off the boot path).
export async function usageSummary({ surface, sinceDays, groupBy = 'surface' } = {}) {
  const store = await readKey(ROLLUP_KEY, {});
  const { costFor } = await import('./usage-pricing.js');
  const cutoff = sinceDays ? dayOf(Date.now() - sinceDays * 86400_000) : null;

  const groups = new Map();
  let total = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, estimated: false };
  for (const r of Object.values(store)) {
    if (surface && r.surface !== surface) continue;
    if (cutoff && r.day < cutoff) continue;
    const gk = groupBy === 'model' ? (r.model || '?')
      : groupBy === 'agent' ? (r.agentId || '?')
      : (r.surface || 'other');
    const g = groups.get(gk) || { key: gk, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, estimated: false };
    for (const f of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) { g[f] += r[f] || 0; total[f] += r[f] || 0; }
    // Prefer a bridge-reported cost; else derive from the rate table.
    const { usd, estimated } = r.costUsd
      ? { usd: r.costUsd, estimated: r.estimatedCalls > 0 }
      : costFor({ model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, estimated: r.estimatedCalls > 0 });
    if (usd != null) { g.usd += usd; total.usd += usd; }
    if (estimated) { g.estimated = true; total.estimated = true; }
    groups.set(gk, g);
  }
  return { groups: [...groups.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)), total };
}

// Most-recent calls (newest first) for drill-down UI.
export async function recentUsage(limit = 100) {
  const log = await readKey(LOG_KEY, []);
  return log.slice(-limit).reverse();
}

// Reset all accounting (settings "clear usage").
export async function clearUsage() {
  try { await chrome.storage.local.remove([ROLLUP_KEY, LOG_KEY]); } catch { /* best effort */ }
}
