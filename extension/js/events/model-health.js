// GENERATED — do not edit.
// Source of truth: chatpanel-events/model-health.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// What a provider failure MEANS, and how long to stand the model down for it.
//
// Lived in the extension as `js/model-health.js`, wrapped around chrome.storage.session.
// The desktop could not read it and so could not fail over at all: a model that returned
// "you have depleted your monthly credits" ended the turn there, while the extension would
// have moved to the next one. The classifier and the ledger are pure; only the persistence
// was the extension's, and that is injected now.
//
// Only the categories that change what to DO are distinguished. A 402 and a 429 are both
// "not now", but one is "not for a while" and the other is "in a moment", and routing that
// treats them the same either hammers a dead endpoint or abandons a live one.
//
// Class R: strings in, a category and a deadline out. The clock is injected.

const MODEL_STANDDOWN_MS = 30 * 60_000;

/** How long to stand a model down, by what went wrong. */
export const COOLDOWN_MS = Object.freeze({
  quota: 30 * 60_000,
  rate: 60_000,
  server: 2 * 60_000,
  // The model is gone — retired, removed, renamed. It is not coming back, so standing it
  // down for the rest of the session is the honest answer; anything shorter just repeats the
  // same failure on a timer.
  gone: 24 * 60 * 60_000,
  // The account needs reconnecting — a human action, on no timetable. Retrying on a short
  // timer just walks the chain back into the same wall every turn.
  auth: 6 * 60 * 60_000,
  // A request this provider would not take. Another may; this one probably still will not,
  // but it is worth re-checking well before an auth problem.
  request: 10 * 60_000,
  // Nobody is listening. A local model that is not running, a hostname that does not
  // resolve, a server that refuses the connection. It is not coming back on a 30-second
  // timer — someone has to start the thing — and re-dialling it every turn was the exact
  // failure a user watched as ERR_CONNECTION_REFUSED, twice, on two different pages.
  unreachable: 5 * 60_000,
  // Anything else — treat as transient and barely stand it down at all.
  unknown: 30_000,
});

/** The reasons that mean "not available" rather than "not right now". */
export const UNAVAILABLE_REASONS = Object.freeze(['quota', 'server', 'gone', 'auth', 'request', 'unreachable']);

export const normModelName = (m) => String(m || '').toLowerCase().replace(/^[^/]+\//, '').replace(/[:@].*$/, '').replace(/[^a-z0-9.]+/g, '');

/**
 * Classify a provider failure — an Error, or a `{ status, message }` the host built from a
 * response it did not throw on.
 */
export function classifyFailure(err) {
  const text = String(err?.message || err?.error || err || '');
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
    // the provider saying THIS model is unusable, not that our request was malformed.
    || /model.*(does not exist|not found|no access|do not have access)|unknown model|no such model/i.test(text)
    // An agent configured for a model it does not have. Nothing about that changes in thirty
    // seconds, and retrying it costs a process spawn to be told the same thing.
    || /invalid model selection|not recognized as a (known|custom) model|unsupported model/i.test(text)) return 'gone';
  if (status >= 500 || /overloaded|unavailable|timeout|ECONNRESET/i.test(text)) return 'server';
  // NOBODY IS LISTENING. A browser fetch to a dead endpoint throws TypeError: Failed to fetch
  // (Safari: "Load failed"); Node says ECONNREFUSED. None carry a status.
  if (/failed to fetch|load failed|networkerror|network error|connection refused|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|EHOSTUNREACH|ECONNABORTED|couldn't reach the gateway|gateway is not answering/i.test(text)) return 'unreachable';
  // A BROKEN CONNECTION IS THIS PROVIDER'S, NOT THE REQUEST'S. An expired refresh token —
  // "OAuth token exchange failed: HTTP 400 — invalid_grant" — says this provider's
  // credentials went stale, and every other model would have answered the question fine.
  if (status === 401 || status === 403
    || /oauth|invalid[_ ]?grant|refresh[_ ]?token|token exchange|api[_ ]?key|unauthorized|not authenticated|authentication|credential|expired token|sign in|log ?in again/i.test(text)) {
    return 'auth';
  }
  // A plain 400 usually IS a malformed request — but providers reject each other's
  // parameters, tool schemas and sampling settings all the time. Failing over costs one
  // extra attempt; dead-ending costs the user their turn.
  if (status === 400) return 'request';
  // Everything else gets tried elsewhere. A router that gives up on an unrecognised failure
  // is a router that gives up.
  return 'unknown';
}

/**
 * The health ledger: which models are standing down, and why.
 *
 * @param now       clock
 * @param onChange  `(snapshot) => void` — the host persists it (the extension: the session
 *                  area; the desktop: memory). Called after every change.
 */
export function createModelHealth({ now = () => Date.now(), onChange = null } = {}) {
  const health = new Map();   // id -> { until, reason, failures }
  const byModel = new Map();  // normalised model name -> { providers:Set, until, reason }

  const snapshot = () => ({
    health: [...health].map(([id, h]) => [id, h]),
    byModel: [...byModel].map(([k, m]) => [k, { providers: [...m.providers], until: m.until, reason: m.reason }]),
  });
  const changed = () => { try { onChange?.(snapshot()); } catch { /* persistence is best effort */ } };

  return {
    snapshot,

    /** Load what another context already learned. Never overwrites what this one knows. */
    hydrate(snap) {
      if (!snap) return false;
      const t = now();
      for (const [id, h] of snap.health || []) if (h?.until > t && !health.has(id)) health.set(id, h);
      for (const [k, m] of snap.byModel || []) {
        if (!m || byModel.has(k)) continue;
        byModel.set(k, { providers: new Set(m.providers || []), until: m.until || 0, reason: m.reason || null });
      }
      return true;
    },

    /** Record that a model failed, and stand it down for as long as that failure warrants. */
    markUnhealthy(id, err, modelName = '') {
      const reason = classifyFailure(err);
      if (!id || !reason) return null;
      // Learn about the MODEL, not only the endpoint. A model that is gone is gone everywhere,
      // so one report is enough; anything else needs two providers to agree before we believe
      // it is the model rather than the provider.
      const key = normModelName(modelName);
      if (key) {
        const seen = byModel.get(key) || { providers: new Set(), until: 0, reason: null };
        seen.providers.add(id);
        if (reason === 'gone' || seen.providers.size >= 2) {
          seen.until = now() + MODEL_STANDDOWN_MS;
          seen.reason = reason;
        }
        byModel.set(key, seen);
      }
      const prev = health.get(id);
      const failures = (prev?.failures || 0) + 1;
      // Repeated failures extend the wait, capped — a model failing every time should be
      // tried rarely, not never. The cap never shortens the base: capping a 24-hour
      // stand-down at an hour would retry a model that no longer exists, 23 times a day.
      const base = COOLDOWN_MS[reason] || COOLDOWN_MS.unknown;
      const ceiling = Math.max(base, 60 * 60_000);
      const until = now() + Math.min(base * failures, ceiling);
      health.set(id, { until, reason, failures });
      changed();
      return { reason, until };
    },

    /** A model answered, so whatever was wrong is over. */
    markHealthy(id) {
      if (id && health.has(id)) { health.delete(id); changed(); }
    },

    /** `{ available, rateLimited, reason, until? }` for the router. Unknown models are healthy. */
    healthOf(id, modelName = '') {
      const key = normModelName(modelName);
      if (key) {
        const m = byModel.get(key);
        if (m && m.until && now() < m.until) return { available: false, rateLimited: false, reason: m.reason, until: m.until, model: true };
      }
      const h = health.get(id);
      if (!h || now() >= h.until) {
        if (h) health.delete(id);   // expired; forget it rather than carrying dead state
        return { available: true, rateLimited: false, reason: null };
      }
      // A rate limit is "not right now"; everything else on the list is "not available". The
      // router rejects both; the reason it shows the user differs.
      return { available: !UNAVAILABLE_REASONS.includes(h.reason), rateLimited: h.reason === 'rate', reason: h.reason, until: h.until };
    },

    /** What is currently stood down, for a settings page. */
    unhealthyModels() {
      const out = [];
      const t = now();
      for (const [id, h] of health) if (t < h.until) out.push({ id, ...h });
      return out;
    },

    /** Forget everything. */
    reset() { health.clear(); byModel.clear(); changed(); },
  };
}
