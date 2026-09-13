// GENERATED — do not edit.
// Source of truth: chatpanel-events/model-ledger.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The MODEL LEDGER — an engine's record, the scorecard pattern applied to engines
// (architecture-pillars.md §13.2).
//
// One chained, store-attested ledger per ENGINE — keyed like the scorecard's `byEngine`
// (`model:<provider>/<model>`, `harness:<id>`), because the same model at two providers is
// two records: availability, cost and latency are the provider's, not the model's. Entries
// are FACTS the runner and the gateway observe, never claims:
//
//   call          one turn: time to first token, total, tokens in/out, cost when priced, was
//                 the JSON valid, were the tool calls valid, did it come back empty / refused
//                 / truncated, did it succeed
//   declined      it did not answer, and why (unavailable · auth · rate · credits · timeout ·
//                 context) — the availability signal
//   rotated-from  a task left it for another engine mid-run
//   rating        a task's verdict, attributed to the engine that served it (and to the agent)
//   capability    a proof: it was asked for X and it did / did not deliver
//   price         what a token costs here — from the provider's list or typed by a person
//
// `summarizeEngine(entries)` → the ENGINE CARD: availability, reliability, latency, cost,
// capability proofs (a capability with three failed proofs is WITHDRAWN until a person
// re-enables it), quality by job kind, the last refs. model-candidates.js `applyCard` hands
// the card to `applyOverride`: observed quality / latency / cost replace the name-based
// guess wherever there is enough history (≥ `minCalls`), the guess stays as the prior until
// then, and the result says which it used (`observed[]`). Reach is never learned, only
// typed — a ledger cannot move a model closer than the URL says.
//
// Hashing, attestation and chain verification are scorecard.js's, unchanged: the same store
// marks both, the same `verifyChain` checks both.

import { canonical, sha256, engineKey, normalizeEngine } from './scorecard.js';
export { verifyChain, attest, verifyAttested } from './scorecard.js';

export const LEDGER_VERSION = 1;
export const LEDGER_ENTRY_KINDS = Object.freeze(['call', 'declined', 'rotated-from', 'rating', 'capability', 'price']);
export const DECLINE_REASONS = Object.freeze(['unavailable', 'auth', 'rate', 'credits', 'timeout', 'context', 'other']);
export const STRUCTURED = Object.freeze(['ok', 'bad', 'n/a']);
/** Failed proofs before a capability leaves the card. */
export const WITHDRAW_AFTER = 3;
/** Calls before an observed number outranks the name-based guess. Small; configurable. */
export const DEFAULT_MIN_CALLS = 5;

const n0 = (v) => Math.max(0, Math.round(Number(v) || 0));
const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Number(v)));
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const bool = (v) => v === true;
const str = (v, n = 120) => (v == null || v === '' ? undefined : String(v).slice(0, n));
const strip = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

/** The ledger's key for an engine — the scorecard's `engineKey`, so the two join. */
export function ledgerKey(engine) { return engineKey(engine); }

/** A call fact, normalized. Rates are computed later; here every field is a plain observation. */
export function normalizeCall(c) {
  const src = c && typeof c === 'object' ? c : {};
  return strip({
    ok: src.ok !== false,
    ttftMs: src.ttftMs != null ? n0(src.ttftMs) : undefined,
    totalMs: src.totalMs != null ? n0(src.totalMs) : undefined,
    tokensIn: src.tokensIn != null ? n0(src.tokensIn) : undefined,
    tokensOut: src.tokensOut != null ? n0(src.tokensOut) : undefined,
    // The total when the split is unknown (a harness reports one number, or none).
    tokens: src.tokens != null && src.tokensIn == null && src.tokensOut == null ? n0(src.tokens) : undefined,
    cost: money(src.cost),
    structured: STRUCTURED.includes(src.structured) ? src.structured : 'n/a',
    toolCalls: src.toolCalls && typeof src.toolCalls === 'object' ? { asked: n0(src.toolCalls.asked), valid: Math.min(n0(src.toolCalls.asked), n0(src.toolCalls.valid)) } : undefined,
    empty: bool(src.empty) || undefined,
    refused: bool(src.refused) || undefined,
    truncated: bool(src.truncated) || undefined,
  });
}

/**
 * A new entry chained onto `prev`. `fact.engine` is required and keyed; the rest is by kind.
 * Pure apart from the digest; the store attests.
 */
export async function makeLedgerEntry(fact, prev, { now = () => Date.now(), subtle } = {}) {
  if (!fact || typeof fact !== 'object') throw new Error('model-ledger: an entry needs a fact');
  if (!LEDGER_ENTRY_KINDS.includes(fact.kind)) throw new Error(`model-ledger: kind must be one of ${LEDGER_ENTRY_KINDS.join(', ')}`);
  const engine = normalizeEngine(fact.engine);
  if (!engine) throw new Error('model-ledger: engine required');
  const key = engineKey(engine);
  if (prev && prev.key !== key) throw new Error(`model-ledger: entry for ${key} chained onto ${prev.key}`);
  const e = strip({
    v: LEDGER_VERSION,
    seq: prev ? prev.seq + 1 : 0,
    key,
    engine,
    kind: fact.kind,
    at: Number(fact.at) || now(),
    runId: str(fact.runId), taskId: str(fact.taskId), agentId: str(fact.agentId), jobKind: str(fact.jobKind, 60),
    call: fact.kind === 'call' ? normalizeCall(fact.call) : undefined,
    declined: fact.kind === 'declined' ? { reason: DECLINE_REASONS.includes(fact.declined?.reason) ? fact.declined.reason : 'other', ...(fact.declined?.error ? { error: String(fact.declined.error).slice(0, 300) } : {}) } : undefined,
    rotated: fact.kind === 'rotated-from' ? strip({ to: engineKey(fact.rotated?.to) || undefined, reason: str(fact.rotated?.reason, 300) }) : undefined,
    rating: fact.kind === 'rating' ? strip({ by: String(fact.rating?.by || 'person').slice(0, 40), score: clamp01(fact.rating?.score), jobKind: str(fact.rating?.jobKind || fact.jobKind, 60), agentId: str(fact.rating?.agentId || fact.agentId) }) : undefined,
    capability: fact.kind === 'capability' ? { id: String(fact.capability?.id || '').slice(0, 40), proved: bool(fact.capability?.proved) } : undefined,
    price: fact.kind === 'price' ? strip({ per1kIn: money(fact.price?.per1kIn) ?? 0, per1kOut: money(fact.price?.per1kOut) ?? 0, source: fact.price?.source === 'user' ? 'user' : 'provider', currency: str(fact.price?.currency, 8) }) : undefined,
    refs: Array.isArray(fact.refs) && fact.refs.length ? fact.refs.map(String).slice(0, 12) : undefined,
    prev: prev ? prev.hash : null,
  });
  if (e.kind === 'capability' && !e.capability.id) throw new Error('model-ledger: capability.id required');
  const { hash: _h, sig: _s, ...hashable } = e;
  e.hash = await sha256(canonical(hashable), { subtle });
  return e;
}

const percentile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (n, of) => (of ? Math.round((n / of) * 1000) / 1000 : null);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/**
 * The engine card. `minCalls` marks it `observed` once there is enough history; `now`
 * bounds the by-hour availability band (the last 24 h) and the "declining right now" check.
 */
export function summarizeEngine(entries, { minCalls = DEFAULT_MIN_CALLS, now = Date.now(), recent = 5 } = {}) {
  const list = (entries || []).filter((e) => e && e.kind);
  const calls = list.filter((e) => e.kind === 'call');
  const declines = list.filter((e) => e.kind === 'declined');
  const attempts = calls.length + declines.length;
  // Availability: declines over attempts, and the last 24 hours in bands of one.
  const byHour = Array.from({ length: 24 }, () => ({ calls: 0, declines: 0 }));
  for (const e of [...calls, ...declines]) {
    const h = Math.floor((now - e.at) / 3600000);
    if (h >= 0 && h < 24) byHour[23 - h][e.kind === 'call' ? 'calls' : 'declines'] += 1;
  }
  const declinesBy = {};
  for (const e of declines) declinesBy[e.declined.reason] = (declinesBy[e.declined.reason] || 0) + 1;
  // Declining right now: the last three attempts all declined, within the last hour.
  const lastThree = [...calls, ...declines].sort((a, b) => a.at - b.at).slice(-3);
  const decliningNow = lastThree.length === 3 && lastThree.every((e) => e.kind === 'declined' && now - e.at < 3600000);
  // Reliability: each a rate over the calls it applies to.
  const withJson = calls.filter((e) => e.call.structured !== 'n/a');
  const withTools = calls.filter((e) => e.call.toolCalls?.asked);
  const reliability = {
    failRate: rate(calls.filter((e) => !e.call.ok).length, calls.length),
    empty: rate(calls.filter((e) => e.call.empty).length, calls.length),
    refused: rate(calls.filter((e) => e.call.refused).length, calls.length),
    truncated: rate(calls.filter((e) => e.call.truncated).length, calls.length),
    badJson: rate(withJson.filter((e) => e.call.structured === 'bad').length, withJson.length),
    badToolCall: rate(withTools.reduce((n, e) => n + (e.call.toolCalls.asked - e.call.toolCalls.valid), 0), withTools.reduce((n, e) => n + e.call.toolCalls.asked, 0)),
  };
  // Latency.
  const ttft = calls.map((e) => e.call.ttftMs).filter((v) => v != null);
  const total = calls.map((e) => e.call.totalMs).filter((v) => v != null);
  const latency = { ttft: { p50: percentile(ttft, 50), p95: percentile(ttft, 95), n: ttft.length }, total: { p50: percentile(total, 50), p95: percentile(total, 95), n: total.length } };
  // Cost: the latest price entry prices every call that reported tokens; a call that
  // reported its own cost is taken as is; otherwise the mean tokens per call stands in.
  const price = list.filter((e) => e.kind === 'price').at(-1)?.price || null;
  const costs = calls.map((e) => (e.call.cost != null ? e.call.cost : price && (e.call.tokensIn != null || e.call.tokensOut != null) ? ((e.call.tokensIn || 0) * price.per1kIn + (e.call.tokensOut || 0) * price.per1kOut) / 1000 : null)).filter((v) => v != null);
  const tokens = calls.map((e) => (e.call.tokensIn || 0) + (e.call.tokensOut || 0) + (e.call.tokens || 0)).filter((v) => v > 0);
  const cost = { perTask: r3(mean(costs)), priced: costs.length, tokensPerTask: tokens.length ? Math.round(mean(tokens)) : null, ...(price ? { per1kIn: price.per1kIn, per1kOut: price.per1kOut, source: price.source } : {}) };
  // Capability proofs: asked vs proved; withdrawn after WITHDRAW_AFTER failures unless a
  // later proof succeeded (a person re-enabling it is a proof they record).
  const proofs = {};
  for (const e of list.filter((x) => x.kind === 'capability')) {
    const p = proofs[e.capability.id] || (proofs[e.capability.id] = { asked: 0, proved: 0, failedSince: 0 });
    p.asked += 1;
    if (e.capability.proved) { p.proved += 1; p.failedSince = 0; } else p.failedSince += 1;
  }
  const capabilities = {
    proved: Object.keys(proofs).filter((id) => proofs[id].proved > 0 && proofs[id].failedSince < WITHDRAW_AFTER).sort(),
    withdrawn: Object.keys(proofs).filter((id) => proofs[id].failedSince >= WITHDRAW_AFTER).sort(),
    proofs: Object.fromEntries(Object.entries(proofs).map(([id, p]) => [id, { asked: p.asked, proved: p.proved }])),
  };
  // Quality: mean rating, overall and by job kind.
  const ratings = list.filter((e) => e.kind === 'rating');
  const byJobKind = {};
  for (const e of ratings) { const k = e.rating.jobKind || 'any'; (byJobKind[k] = byJobKind[k] || []).push(e.rating.score); }
  const quality = {
    overall: { avg: r3(mean(ratings.map((e) => e.rating.score))), count: ratings.length },
    byJobKind: Object.fromEntries(Object.entries(byJobKind).map(([k, xs]) => [k, { avg: r3(mean(xs)), count: xs.length }])),
  };
  const rotatedFrom = list.filter((e) => e.kind === 'rotated-from').length;
  return {
    key: list[0]?.key || null,
    engine: list[0]?.engine || null,
    entries: list.length,
    calls: calls.length,
    declines: declines.length,
    observed: calls.length >= minCalls,
    availability: { rate: attempts ? r3(1 - declines.length / attempts) : null, attempts, declinesBy, byHour, decliningNow },
    reliability,
    latency,
    cost,
    capabilities,
    quality,
    rotatedFrom,
    refs: [...new Set(list.flatMap((e) => e.refs || []))].slice(-recent),
    since: list[0]?.at || null,
    last: list.at(-1)?.at || null,
    head: list.at(-1)?.hash || null,
  };
}

// `cardOverride` and `applyCard` — the card over the name-based guess — live in
// model-candidates.js beside `applyOverride`, the seam they feed; this module stays
// importable by a store that has no router (the gateway vendors it with scorecard.js only).
// Agent scores normalised by engine (§13.3) live beside the card they adjust: scorecard.js
// `adjustSummary` and `fit(job, type, summary, { qualityOf })`.
export { adjustSummary } from './scorecard.js';
