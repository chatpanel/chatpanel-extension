// Cost estimation for token usage — a small, model-agnostic rate table.
//
// The USAGE METER stores raw tokens only (always correct, provider-neutral).
// Cost is this OPTIONAL layer on top: a {provider, model} → $/1M-token lookup.
// Prices drift independently of our code and are wrong for BYO / free / local
// models, so cost is always "best effort" — `estimated` marks a rate we had to
// guess (or couldn't find), and callers should show it as "≈".
//
// Cache accounting follows the published multipliers: a cache READ costs ~0.1×
// the input rate, a cache WRITE (5-minute TTL) ~1.25×. Providers that bill a
// real per-call cost (e.g. Claude Code via the bridge) can hand us that figure
// directly (see recordUsage `costUsd`) and bypass this table entirely.

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

// $ per 1,000,000 tokens (input / output). Kept deliberately small: the Claude
// rows are authoritative; the rest are common-case conveniences for BYO users.
// A model not listed here resolves to `null` → cost is reported as unknown, not
// as $0 (which would silently under-report).
const RATES = [
  // --- Anthropic (authoritative) ---
  [/claude.*fable.*5|claude.*mythos.*5/, { in: 10, out: 50 }],
  [/claude.*opus.*4[.-]?[678]/, { in: 5, out: 25 }],
  [/claude.*opus/, { in: 5, out: 25 }],
  [/claude.*sonnet/, { in: 3, out: 15 }],
  [/claude.*haiku/, { in: 1, out: 5 }],
  // --- OpenAI (convenience; verify against your plan) ---
  [/gpt-4o-mini|o4-mini|gpt-4\.1-mini/, { in: 0.15, out: 0.6 }],
  [/gpt-4o|gpt-4\.1(?!-mini)/, { in: 2.5, out: 10 }],
  [/o3-mini/, { in: 1.1, out: 4.4 }],
  // --- Google / Gemini (convenience) ---
  [/gemini.*flash/, { in: 0.15, out: 0.6 }],
  [/gemini.*pro/, { in: 1.25, out: 5 }],
];

// Look up per-1M-token rates for a model id. Returns null when unknown.
export function rateFor(model) {
  const s = String(model || '').toLowerCase();
  if (!s) return null;
  for (const [re, rate] of RATES) if (re.test(s)) return rate;
  return null;
}

// Compute the $ cost of one usage record. Prefers a provider-reported cost
// (`costUsd`) when present; otherwise derives it from the rate table. Returns
// { usd, estimated }. `estimated` is true when the token counts themselves were
// estimated OR when we had no rate for the model (usd then null).
export function costFor({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd = null, estimated = false } = {}) {
  if (costUsd != null && Number.isFinite(costUsd)) return { usd: costUsd, estimated };
  const rate = rateFor(model);
  if (!rate) return { usd: null, estimated: true };
  const perM = (n, r) => (Number(n) || 0) * r / 1_000_000;
  const usd =
    perM(inputTokens, rate.in) +
    perM(outputTokens, rate.out) +
    perM(cacheReadTokens, rate.in * CACHE_READ_MULT) +
    perM(cacheWriteTokens, rate.in * CACHE_WRITE_MULT);
  return { usd, estimated };
}

// Small helper for UI: "$0.0123" / "<$0.01" / "n/a".
export function formatUsd(usd) {
  if (usd == null || !Number.isFinite(usd)) return 'n/a';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}
