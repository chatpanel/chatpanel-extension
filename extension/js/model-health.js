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
  // The model is gone — retired, removed, renamed. It is not coming back, so standing it
  // down for the rest of the session is the honest answer; anything shorter just repeats the
  // same failure on a timer.
  gone: 24 * 60 * 60_000,
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
  // THE MODEL IS GONE, not our request. A 410 saying "reached its end of life", a 404 on the
  // model name, a deprecation notice — every other model would handle this request fine, so
  // failing the turn is the one response that helps nobody. Checked BEFORE the generic 4xx
  // rule, which would otherwise read this as our mistake and refuse to fail over.
  if (status === 410
    || /end of life|no longer available|has been (retired|deprecated|removed)|decommissioned/i.test(text)
    // "The model X does not exist or you do not have access to it" — a 404 naming a model is
    // the provider saying THIS model is unusable, not that our request was malformed. Every
    // other model would have answered, so treating it as our mistake ends the turn for no
    // reason.
    || /model.*(does not exist|not found|no access|do not have access)|unknown model|no such model/i.test(text)) return 'gone';
  if (status >= 500 || /overloaded|unavailable|timeout|ECONNRESET/i.test(text)) return 'server';
  // ONLY these are OUR fault. A 400 is a malformed request, a 401/403 a key problem — every
  // model would refuse them identically, so retrying turns one clear error into four slow
  // ones and hides a configuration problem behind a health one.
  if ([400, 401, 403].includes(status)) return null;
  // Everything else gets tried elsewhere. A router that gives up on an unrecognised failure
  // is a router that gives up, and the user asked for the next option — not for a verdict on
  // whose fault it was.
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
  //
  // The cap never shortens the base. An hour is the right ceiling for escalating a transient
  // failure and the wrong one for a model that has been retired: capping a 24-hour
  // stand-down at an hour would retry a model that no longer exists, 23 times a day.
  const base = COOLDOWN_MS[reason] || COOLDOWN_MS.unknown;
  const ceiling = Math.max(base, 60 * 60_000);
  const until = Date.now() + Math.min(base * failures, ceiling);
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
    // A rate limit is "not right now"; a quota, outage or retirement is "not available". The
    // router rejects both, but the reason it shows the user is different.
    available: !['quota', 'server', 'gone'].includes(h.reason),
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
