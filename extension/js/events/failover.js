// GENERATED — do not edit.
// Source of truth: chatpanel-events/failover.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Run the call, and try the next model when this one cannot answer.
//
// A provider that returns "you have depleted your monthly credits" has not failed the
// request — it has declined it, and there is very likely another model that would say yes.
// Showing that error to the user when an alternative was available is the router not doing
// the one job it exists for.
//
// ONLY WHEN THE ROUTER CHOSE. If the user picked a specific model, silently answering from a
// different one would be worse than the error: they asked for that model for a reason.
//
// This was the extension's `withFailover`; the desktop had none, so the same decline ended
// the turn there. What is shared is the attempt loop and its rules — keep trying (bounded),
// classify before retrying, never announce a model that will not be called, say "N models
// tried" rather than the last provider's error as if it were the whole story. What is
// injected is how the host picks the next model (its router, its roster) and how it tells
// the user.
//
// Class R with an async seam: no I/O of its own.

/** Enough to work through a realistic set of models rather than sampling it — but bounded, because sitting through every failure is its own kind of broken. */
export const FAILOVER_MAX_ATTEMPTS = 6;

/** The terminal message: what was tried, and the last thing that went wrong. */
export function failoverExhausted(tried, err) {
  const n = Array.isArray(tried) ? tried.length : Number(tried) || 0;
  const e = new Error(`${n} model${n === 1 ? '' : 's'} tried, none could answer. Last error — ${err?.message || err}`);
  e.cause = err;
  e.tried = Array.isArray(tried) ? [...tried] : [];
  return e;
}

/**
 * @param first     the target to call first — `{ id, model, name?, routedVia? }` plus whatever the host's call needs
 * @param call      `(target) => Promise<result>` — MUST throw on a failure (an Error with
 *                  `status` when the host has one); a host whose call returns `{ ok: false }`
 *                  converts before handing it here
 * @param chose     did the router choose `first`? When false, a failure is the answer.
 * @param health    a model-health ledger (`createModelHealth`)
 * @param next      `async ({ current, tried, reason, marked }) => target | null` — the host's
 *                  router: the same class of thing, excluding what already failed
 * @param onHop     `({ from, to, reason, reasons, next }) => void` — tell the user, record it
 * @param labelOf   `(target) => string` for messages
 * @param signal    an aborted signal ends the chain with the current error
 */
export async function runWithFailover({
  first, call, chose = false, health = null, next = null, onHop = null, labelOf = defaultLabel, signal = null,
  maxAttempts = FAILOVER_MAX_ATTEMPTS,
} = {}) {
  if (typeof call !== 'function') throw new Error('runWithFailover: call required');
  const tried = [];
  let current = first;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const out = await call(current);
      if (current?.id && health) health.markHealthy(current.id);
      return out;
    } catch (err) {
      lastErr = err;
      if (!chose || signal?.aborted || !health || typeof next !== 'function') throw err;
      // The model name goes with the report, so "this model fails everywhere" is learnable
      // rather than rediscovered at each provider in turn.
      const marked = health.markUnhealthy(current?.id, err, current?.model);
      if (!marked) throw err;
      tried.push(current?.id);

      // Do not ANNOUNCE a model we are not going to call. The loop used to pick and announce
      // the next one and only then discover it was out of attempts, so the chain named a
      // model that never ran and the error shown came from the hop before it.
      if (attempt === maxAttempts - 1) throw failoverExhausted(tried, err);

      const to = await next({ current, tried: [...tried], reason: marked.reason, marked, error: err });
      // Genuinely out of options. Say that, rather than showing the last provider's error as
      // though it were the whole story — "Groq says no" and "every model you have said no"
      // are different problems with different fixes.
      if (!to) throw failoverExhausted(tried, err);

      const hop = {
        from: labelOf(current), to: labelOf(to), reason: marked.reason,
        reasons: [`${labelOf(current)} declined (${marked.reason})`, ...(to.routedVia?.reasons || [])],
        next: to,
      };
      try { onHop?.(hop); } catch { /* telling is best effort */ }
      current = to;
    }
  }
  throw lastErr;
}

function defaultLabel(t) {
  return t?.routedVia?.model || t?.name || t?.label || t?.model || t?.id || 'model';
}
