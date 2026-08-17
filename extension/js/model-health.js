// What each model has actually been doing lately.
//
// The router's declared attributes are what a model IS; this is how it has been BEHAVING —
// and when the two disagree, behaviour wins. A model whose credits ran out is configured
// perfectly and cannot answer, and routing to it because its config still looks good is the
// error a user experiences as "it keeps picking the broken one".
//
// Deliberately in memory. These are observations about right now, and a failure remembered
// across a browser restart would keep a model sidelined long after the quota reset or the
// outage ended — sidelining a working model is a worse error than trying a broken one once.

const health = new Map();   // id -> { until, reason, failures }

/** How long to stand a model down, by what went wrong. */
const COOLDOWN_MS = {
  // Credits or quota: nothing changes for a while, so a short retry is pure noise.
  quota: 30 * 60_000,
  // Rate limits lift on their own, usually within a minute.
  rate: 60_000,
  // A server error may be a blip; try again soon, but not immediately.
  server: 2 * 60_000,
  // Anything else — treat as transient and barely stand it down at all.
  unknown: 30_000,
};

/**
 * Classify a provider failure.
 *
 * Only the categories that change what to DO are distinguished. A 402 and a 429 are both
 * "not now", but one is "not for a while" and the other is "in a moment", and routing that
 * treats them the same either hammers a dead endpoint or abandons a live one.
 */
export function classifyFailure(err) {
  const text = String(err?.message || err || '');
  const status = Number(err?.status) || Number(/\b(4\d\d|5\d\d)\b/.exec(text)?.[1]) || 0;
  if (status === 402 || /credit|quota|billing|payment required|depleted/i.test(text)) return 'quota';
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return 'rate';
  if (status >= 500 || /overloaded|unavailable|timeout|ECONNRESET/i.test(text)) return 'server';
  // A 400 or 401 is OUR request or OUR key being wrong. Standing the model down would hide a
  // configuration error behind a health problem, and the user would fix the wrong thing.
  if (status >= 400 && status < 500) return null;
  return 'unknown';
}

/** Record that a model failed, and stand it down for as long as that failure warrants. */
export function markUnhealthy(id, err) {
  const reason = classifyFailure(err);
  if (!id || !reason) return null;
  const prev = health.get(id);
  const failures = (prev?.failures || 0) + 1;
  // Repeated failures extend the wait, capped — a model failing every time should be tried
  // rarely, not never, because the thing that broke it may be fixed at any moment.
  const base = COOLDOWN_MS[reason] || COOLDOWN_MS.unknown;
  const until = Date.now() + Math.min(base * failures, 60 * 60_000);
  health.set(id, { until, reason, failures });
  return { reason, until };
}

/** A model answered, so whatever was wrong is over. */
export function markHealthy(id) {
  if (id) health.delete(id);
}

/** `{ available, rateLimited, reason }` for the router. Unknown models are healthy. */
export function healthOf(id) {
  const h = health.get(id);
  if (!h || Date.now() >= h.until) {
    if (h) health.delete(id);   // expired; forget it rather than carrying dead state
    return { available: true, rateLimited: false, reason: null };
  }
  return {
    // A rate limit is "not right now"; a quota or outage is "not available". The router
    // rejects both, but the reason it shows the user is different.
    available: h.reason !== 'quota' && h.reason !== 'server',
    rateLimited: h.reason === 'rate',
    reason: h.reason,
    until: h.until,
  };
}

/** What is currently stood down, for the settings page. */
export function unhealthyModels() {
  const out = [];
  for (const [id, h] of health) {
    if (Date.now() < h.until) out.push({ id, ...h });
  }
  return out;
}

/** Test-only: forget everything. */
export function resetHealth() { health.clear(); }
