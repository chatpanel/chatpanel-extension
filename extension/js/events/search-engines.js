// GENERATED — do not edit.
// Source of truth: chatpanel-events/search-engines.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Search engines as declarations, not as a literal in two files.
//
// This one is not speculative. The engine list existed as an array in the search runtime
// AND as a copy in the settings page, and when a broken engine was removed from one it kept
// appearing in the other. Two implementations of one list disagree eventually; the only
// reliable fix is for there to be one list.
//
// It is also where the plugin model pays off soonest for a USER: an engine is a name, a URL
// template, and a way to read the result. That is a thing someone could contribute without
// touching any code we wrote.

export class SearchEngineError extends Error {
  constructor(code, message) { super(message); this.name = 'SearchEngineError'; this.code = code; }
}

export const ENGINE_KINDS = Object.freeze(['serp', 'api']);

/**
 * @param kind    'serp' — an HTML results page to read; 'api' — a service that answers
 *                directly. The distinction is not cosmetic: a SERP can be blocked and
 *                needs a fallback, an API can need a key and must not run without one.
 * @param needsKey the engine sends queries to a third party that requires credentials.
 *                Engines that need a key stay OFF until one exists, because a default that
 *                sends the user's queries somewhere they never chose is not a default.
 */
export function defineSearchEngine({ id, name, url, kind = 'serp', enabled = false, needsKey = false, retired = false }) {
  if (!id) throw new SearchEngineError('BAD_ENGINE', 'engine.id required');
  if (!ENGINE_KINDS.includes(kind)) throw new SearchEngineError('BAD_ENGINE', `engine '${id}': unknown kind '${kind}'`);
  if (!retired && !url) throw new SearchEngineError('BAD_ENGINE', `engine '${id}': url required`);
  return Object.freeze({ id, name: name || id, url, kind, enabled, needsKey, retired });
}

/**
 * Reconcile a user's stored list against the declared engines.
 *
 * The one function both the runtime and the settings page call, so what search uses and
 * what settings shows cannot drift — which is the entire bug this replaces.
 */
export function reconcileEngines(stored, declared, { hasKey = false } = {}) {
  const byId = new Map(declared.map((e) => [e.id, e]));
  const retired = new Set(declared.filter((e) => e.retired).map((e) => e.id));

  let out = (Array.isArray(stored) && stored.length ? stored : declared)
    .filter((e) => e?.id && !retired.has(e.id))
    .map((e) => ({ ...(byId.get(e.id) || {}), ...e }));

  // Anything declared but never seen by this user is added, off unless it ships on. A user
  // who has saved settings once must still receive new engines.
  for (const d of declared) {
    if (d.retired || out.some((e) => e.id === d.id)) continue;
    out.push({ ...d });
  }

  out = out.map((e) => {
    const d = byId.get(e.id);
    if (!d?.needsKey) return e;
    // "They turned it off" and "it has never been offered" are different states: a key
    // enables the second, never overrides the first.
    const known = Array.isArray(stored) && stored.some((s) => s?.id === e.id);
    const declined = known && stored.find((s) => s.id === e.id)?.enabled === false;
    return { ...e, enabled: hasKey && !declined };
  });

  // Never leave the user with nothing usable. Retiring an engine can empty a list that
  // contained only that engine, and a search feature that silently has no engines is a
  // worse failure than the one being fixed.
  if (!out.some((e) => e.enabled !== false && !e.needsKey)) {
    for (const d of declared) {
      if (d.retired || d.needsKey) continue;
      const have = out.find((e) => e.id === d.id);
      if (have) have.enabled = d.enabled !== false;
    }
  }
  return out;
}

/** The order to actually try: enabled first (in list order), then the rest as fallbacks. */
export function attemptOrder(engines) {
  const live = engines.filter((e) => !e.retired);
  return [...live.filter((e) => e.enabled !== false), ...live.filter((e) => e.enabled === false)];
}
