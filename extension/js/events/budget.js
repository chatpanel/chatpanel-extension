// GENERATED — do not edit.
// Source of truth: chatpanel-events/budget.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A budget — the number a run may not exceed, and the record of what it spent.
//
// There was no spend cap anywhere. A live monitor is declared class C and starts model turns
// for the length of a meeting; a spoken "keep an eye on X" arms that with nothing bounding
// it; `jobs.js` caps a per-day job COUNT, not spend. The class declarations on every intent
// and rule were made for exactly this, and nothing read them.
//
// A budget is a VALUE: declared on the thing that spends (a team, a schedule, a monitor),
// charged by whatever runs it, and carried on the run record so the ledger can say what a
// run cost in the same units it was capped in. Four dimensions, because the expensive thing
// differs by executor: tokens and calls for a model, wall time for an agent that thinks for
// minutes, cost when the gateway can report it. Any dimension may be absent; an absent one is
// not enforced. A budget with NO dimension is not a budget — `validateBudget` refuses it, and
// a team without one does not run (F8, O1).
//
// Pure. `now` is injected so a wall-time cap is testable.

export const BUDGET_DIMENSIONS = Object.freeze(['tokens', 'calls', 'ms', 'usd']);

export class BudgetError extends Error {
  constructor(code, message) { super(message); this.name = 'BudgetError'; this.code = code; }
}

/** `{ ok, errors }` — a budget must cap at least one thing, and every cap must be a positive number. */
export function validateBudget(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return { ok: false, errors: ['budget must be an object'] };
  let any = false;
  for (const k of BUDGET_DIMENSIONS) {
    if (b[k] === undefined || b[k] === null) continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${k}: a positive number`);
    else any = true;
  }
  for (const k of Object.keys(b)) if (!BUDGET_DIMENSIONS.includes(k)) errors.push(`${k}: not a budget dimension (${BUDGET_DIMENSIONS.join(', ')})`);
  if (!any) errors.push('a budget must cap at least one of tokens, calls, ms, usd');
  return { ok: errors.length === 0, errors };
}

/** Only the declared dimensions, as numbers. */
export function normalizeBudget(b) {
  const out = {};
  for (const k of BUDGET_DIMENSIONS) {
    const n = Number(b?.[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/**
 * The usage a model call reports, in the shapes the providers use, as one record:
 * `{ tokens, calls, usd }`. `ms` is measured by the budget itself.
 */
export function usageOf(u = {}) {
  const tokens = Number(u.tokens ?? u.total_tokens ?? ((Number(u.input_tokens ?? u.prompt_tokens) || 0) + (Number(u.output_tokens ?? u.completion_tokens) || 0)));
  return { tokens: Number.isFinite(tokens) ? tokens : 0, calls: Number(u.calls ?? 1) || 0, usd: Number(u.usd ?? u.cost) || 0 };
}

/**
 * A live budget for one run.
 *
 *   charge(usage)        add a model call's usage; returns what is left
 *   canAfford(estimate)  false when an estimated call would cross a cap — ask BEFORE calling
 *   exhausted()          the dimension that ran out, or null
 *   snapshot()           { cap, spent, remaining, exhausted } for the run record and the meter
 */
export function createBudget(declared, { now = () => Date.now() } = {}) {
  const v = validateBudget(declared);
  if (!v.ok) throw new BudgetError('INVALID', v.errors.join('; '));
  const cap = normalizeBudget(declared);
  const startedAt = now();
  const spent = { tokens: 0, calls: 0, usd: 0 };
  const elapsed = () => now() - startedAt;
  const remaining = () => {
    const out = {};
    for (const k of BUDGET_DIMENSIONS) {
      if (cap[k] === undefined) continue;
      out[k] = Math.max(0, cap[k] - (k === 'ms' ? elapsed() : spent[k]));
    }
    return out;
  };
  const exhausted = () => {
    for (const k of BUDGET_DIMENSIONS) {
      if (cap[k] === undefined) continue;
      if ((k === 'ms' ? elapsed() : spent[k]) >= cap[k]) return k;
    }
    return null;
  };
  return {
    cap,
    charge(usage) {
      const u = usageOf(usage);
      spent.tokens += u.tokens; spent.calls += u.calls; spent.usd += u.usd;
      return remaining();
    },
    canAfford(estimate = {}) {
      if (exhausted()) return false;
      const e = usageOf({ calls: 1, ...estimate });
      for (const k of ['tokens', 'calls', 'usd']) {
        if (cap[k] !== undefined && spent[k] + e[k] > cap[k]) return false;
      }
      return true;
    },
    remaining,
    exhausted,
    snapshot() {
      return { cap, spent: { ...spent, ms: elapsed() }, remaining: remaining(), exhausted: exhausted() };
    },
  };
}
