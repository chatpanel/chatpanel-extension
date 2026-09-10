// What each model has actually been doing lately.
//
// The router's declared attributes are what a model IS; this is how it has been BEHAVING —
// and when the two disagree, behaviour wins. A model whose credits ran out is configured
// perfectly and cannot answer, and routing to it because its config still looks good is the
// error a user experiences as "it keeps picking the broken one".
//
// Deliberately NOT on disk. These are observations about right now, and a failure remembered
// across a browser restart would keep a model sidelined long after the quota reset or the
// outage ended — sidelining a working model is a worse error than trying a broken one once.
//
// But shared across PAGES within the session, and that took a bug to learn. This lived in
// plain module memory, which is per page context: the side panel learned that a local model
// was refusing connections, and briefs.html — a separate page, a separate module instance —
// started every synthesis believing it was fine, dialled it, got ERR_CONNECTION_REFUSED, and
// only then fell over. Auto consults healthOf() at route time, so the router was doing its
// job; it was being asked by a page that knew nothing. `chrome.storage.session` is exactly
// the scope the paragraph above asks for — survives a page switch, dies with the browser.

const health = new Map();   // id -> { until, reason, failures }

// THE SAME MODEL FAILING AT SEVERAL PROVIDERS IS A FACT ABOUT THE MODEL.
//
// "Same model elsewhere" is the right replacement when a PROVIDER declines — out of credits,
// rate limited, identical capability and just a different bill. It is pointless when the
// model itself is the problem, and a user watched a chain go
// "HuggingFace · DeepSeek-V4-Flash → Deepseek · deepseek-v4-flash" and reasonably asked why.
//
// One provider failing says nothing about the model. Two different providers failing on the
// same model name is evidence, so that is the threshold: enough to learn from, not so eager
// that one bad endpoint condemns a working model.
const byModel = new Map();  // normalised model name -> { providers:Set, until, reason }
const MODEL_STANDDOWN_MS = 30 * 60_000;

// ── session-scoped mirror ─────────────────────────────────────────────────────
const SESSION_KEY = 'chatpanel:modelHealth';
const sessionArea = () => globalThis.chrome?.storage?.session || null;

function snapshot() {
  return {
    health: [...health].map(([id, h]) => [id, h]),
    byModel: [...byModel].map(([k, m]) => [k, { providers: [...m.providers], until: m.until, reason: m.reason }]),
  };
}
function persist() {
  const area = sessionArea();
  if (!area) return;
  try { area.set({ [SESSION_KEY]: snapshot() }).catch?.(() => {}); } catch { /* best effort */ }
}
/** Load what the rest of this browser session has already learned. Idempotent; cheap. */
export async function hydrateHealth() {
  const area = sessionArea();
  if (!area) return false;
  try {
    const got = await area.get(SESSION_KEY);
    const snap = got?.[SESSION_KEY];
    if (!snap) return false;
    const now = Date.now();
    for (const [id, h] of snap.health || []) if (h?.until > now && !health.has(id)) health.set(id, h);
    for (const [k, m] of snap.byModel || []) {
      if (!m || byModel.has(k)) continue;
      byModel.set(k, { providers: new Set(m.providers || []), until: m.until || 0, reason: m.reason || null });
    }
    return true;
  } catch { return false; }
}
// Hydrate on import so the first route on a fresh page already knows. Callers that need the
// guarantee before their first decision can await hydrateHealth() themselves.
const _hydrated = hydrateHealth();
export const healthReady = () => _hydrated;
const normModelName = (m) => String(m || '').toLowerCase().replace(/^[^/]+\//, '').replace(/[:@].*$/, '').replace(/[^a-z0-9.]+/g, '');

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
    || /model.*(does not exist|not found|no access|do not have access)|unknown model|no such model/i.test(text)
    // An agent configured for a model it does not have — "invalid model selection",
    // "not recognized as a known model". Nothing about that changes in thirty seconds, and
    // retrying it costs a process spawn to be told the same thing. It is stood down until
    // the user fixes the setting, and every other model can still answer.
    || /invalid model selection|not recognized as a (known|custom) model|unsupported model/i.test(text)) return 'gone';
  if (status >= 500 || /overloaded|unavailable|timeout|ECONNRESET/i.test(text)) return 'server';
  // NOBODY IS LISTENING. A browser fetch to a dead endpoint throws TypeError: Failed to fetch
  // (Safari: "Load failed"); Node says ECONNREFUSED. None of these carry a status, so they
  // fell through to 'unknown' — thirty seconds, and still "available" — and Auto picked the
  // same dead local model again on the next turn, and on every other page that had not seen
  // it fail. This is a provider that is DOWN, and it is treated like one.
  if (/failed to fetch|load failed|networkerror|network error|connection refused|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|EHOSTUNREACH|ECONNABORTED/i.test(text)) return 'unreachable';
  // A BROKEN CONNECTION IS THIS PROVIDER'S, NOT THE REQUEST'S.
  //
  // These were all read as "our fault, every model would refuse it identically" and returned
  // null, which makes the turn DIE rather than fail over. An expired refresh token is the
  // clearest counter-example there is: "OAuth token exchange failed: HTTP 400 — invalid_grant"
  // says this provider's credentials went stale, and every other model would have answered
  // the question fine. The user watched a turn stop dead on it.
  //
  // Stood down for a LONG time, because unlike a rate limit this does not heal on its own —
  // someone has to reconnect the account. Standing it down is what stops the chain walking
  // back into it every turn until they do.
  if (status === 401 || status === 403
    || /oauth|invalid[_ ]?grant|refresh[_ ]?token|token exchange|api[_ ]?key|unauthorized|not authenticated|authentication|credential|expired token|sign in|log ?in again/i.test(text)) {
    return 'auth';
  }
  // A plain 400 usually IS a malformed request — but not always: providers reject each
  // other's parameters, tool schemas and sampling settings all the time, so the same call
  // that one refuses another accepts. Failing over costs one extra attempt; dead-ending costs
  // the user their turn, and the terminal error still names what went wrong when everything
  // has been tried. Nothing ends in limbo.
  if (status === 400) return 'request';
  // Everything else gets tried elsewhere. A router that gives up on an unrecognised failure
  // is a router that gives up, and the user asked for the next option — not for a verdict on
  // whose fault it was.
  return 'unknown';
}

/** Record that a model failed, and stand it down for as long as that failure warrants. */
export function markUnhealthy(id, err, modelName = '') {
  const reason = classifyFailure(err);
  if (!id || !reason) return null;

  // Learn about the MODEL, not only the endpoint. A model that is gone is gone everywhere,
  // so one report is enough; anything else needs two providers to agree before we believe it
  // is the model rather than the provider.
  const key = normModelName(modelName);
  if (key) {
    const seen = byModel.get(key) || { providers: new Set(), until: 0, reason: null };
    seen.providers.add(id);
    if (reason === 'gone' || seen.providers.size >= 2) {
      seen.until = Date.now() + MODEL_STANDDOWN_MS;
      seen.reason = reason;
    }
    byModel.set(key, seen);
  }
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
  persist();
  return { reason, until };
}

/** A model answered, so whatever was wrong is over. */
export function markHealthy(id) {
  if (id) { health.delete(id); persist(); }
}

/** `{ available, rateLimited, reason }` for the router. Unknown models are healthy. */
export function healthOf(id, modelName = '') {
  // A model standing down applies wherever it is served, which is the whole point of
  // learning it — otherwise the chain walks the same dead model across every provider.
  const key = normModelName(modelName);
  if (key) {
    const m = byModel.get(key);
    if (m && m.until && Date.now() < m.until) {
      return { available: false, rateLimited: false, reason: m.reason, until: m.until, model: true };
    }
  }
  const h = health.get(id);
  if (!h || Date.now() >= h.until) {
    if (h) health.delete(id);   // expired; forget it rather than carrying dead state
    return { available: true, rateLimited: false, reason: null };
  }
  return {
    // A rate limit is "not right now"; a quota, outage, retirement, broken connection or
    // rejected request is "not available". The router rejects both, but the reason it shows
    // the user is different.
    //
    // `auth` belongs here and it is the reason this list was wrong: a provider whose
    // credentials expired stayed "available", so the router kept choosing it and the same
    // stale token failed the same way every turn. Standing it down is what makes the failover
    // stick rather than bounce.
    available: !['quota', 'server', 'gone', 'auth', 'request', 'unreachable'].includes(h.reason),
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
export function resetHealth() { health.clear(); byModel.clear(); persist(); }
