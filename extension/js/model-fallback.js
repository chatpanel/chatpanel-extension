// Try the models you have, in order, and remember which one just failed.
//
// Two features shipped the same bug independently: suggestions and autocomplete each
// picked ONE model and gave up if it did not answer. A user whose local model was not
// running got an instant connection refusal on every keystroke — 60 failed turns in a
// 90-minute session — while a working remote endpoint and a working CLI agent sat unused.
// The user's explicitly chosen autocomplete model was never reached, because a dead
// endpoint earlier in the list won every time.
//
// One place, so the third feature that needs this inherits the behaviour instead of
// re-deriving it. Deliberately holds no opinion about what a candidate IS: callers order
// their own list and supply their own runner, because "which model is cheapest here"
// is a question only the caller can answer.

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * @param key       identity of a candidate — two candidates with the same key share health.
 * @param cooldownMs how long a failed candidate is skipped. Long enough that a dead local
 *                  model is not re-dialled on every keystroke; short enough that starting
 *                  it makes the feature work again without a reload.
 */
export function createFallbackChain({ key, cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
  const failedAt = new Map();
  const idOf = key || ((c) => String(c));
  const isCold = (c) => {
    const at = failedAt.get(idOf(c));
    return at == null || now() - at > cooldownMs;
  };

  return {
    isCold,
    markFailed: (c) => failedAt.set(idOf(c), now()),
    markOk: (c) => failedAt.delete(idOf(c)),
    reset: () => failedAt.clear(),

    /**
     * Run `attempt` against each candidate until one produces a truthy result.
     *
     * Candidates cooling off are tried LAST rather than skipped: if every candidate has
     * failed recently, the alternative is a feature that stays dead until something
     * clears the memo. A stale memo must never be the reason a working model goes unused.
     */
    async run(candidates, attempt) {
      const list = [...(candidates || [])];
      if (!list.length) return { ok: false, result: null, candidate: null };
      const order = [...list.filter(isCold), ...list.filter((c) => !isCold(c))];
      for (const c of order) {
        try {
          const result = await attempt(c);
          if (result) {
            failedAt.delete(idOf(c));
            return { ok: true, result, candidate: c };
          }
          // A clean empty answer is not a failure — the model replied, it just had
          // nothing to add. Marking it failed would punish a model that is working.
        } catch {
          failedAt.set(idOf(c), now());
        }
      }
      return { ok: false, result: null, candidate: null };
    },
  };
}
