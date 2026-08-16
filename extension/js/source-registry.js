// THE SOURCE REGISTRY — the open contract behind "everything ChatPanel knows".
//
// Chats, meetings and notes were three hand-written loaders concatenated in
// history-rag.js, so a fourth source meant editing that file, then omni-search, then the
// context assembler, then the graph. The SHAPE they produced was already uniform, though
// — the contract existed, it just was not named or open.
//
// Naming it is what makes a source compound: register one and history search, RAG, the
// omni palette, the context assembler and the graph all gain it at once, because each
// consumes the registry rather than a list.
//
// A SOURCE IS A CAPABILITY. `reads` is the declared access statement, readable before
// anything runs, which is what lets a user or an admin approve a source at load time
// instead of discovering its reach afterwards.
//
// ISOLATION IS THE POINT. One bad source must never break search for everything else, so
// a loader that throws yields nothing and is reported — never propagated.

/** @type {Map<string, object>} insertion-ordered, which fixes result order */
const registry = new Map();

/**
 * @param kind    id namespace — sources are addressed `kind:id` (chat:…, meeting:…)
 * @param label   human name, for the Plugins lens and any UI grouping
 * @param reads   declared data scopes, e.g. ['net'] — the access statement
 * @param load    () -> Promise<Source[]>, each { id, title, date, text, … }
 * @param builtIn true for the three ChatPanel owns; false for anything registered later
 * @param enabledByDefault whether it loads when a caller does not name it explicitly
 */
export function registerSource({ kind, label, reads = [], load, builtIn = false, enabledByDefault = true }) {
  if (typeof kind !== 'string' || !kind) throw new TypeError('source: kind required');
  if (typeof load !== 'function') throw new TypeError(`source ${kind}: load() required`);
  if (registry.has(kind)) throw new Error(`source '${kind}' is already registered`);
  registry.set(kind, Object.freeze({ kind, label: label || kind, reads: [...reads], load, builtIn, enabledByDefault }));
  return () => registry.delete(kind);
}

export function listSources() { return [...registry.values()]; }
export function getSource(kind) { return registry.get(kind) || null; }
export function hasSource(kind) { return registry.has(kind); }

/** Test-only: drop everything so a suite starts from a known registry. */
export function clearSources() { registry.clear(); }

/**
 * Which kinds a request wants.
 *
 * `include` names kinds explicitly and wins outright. Otherwise the legacy per-kind flags
 * are honoured — `includeChats` / `includeMeetings` / `includeNotes` — because every
 * existing caller passes those and this refactor must not change one result.
 */
export function resolveKinds(options = {}) {
  const all = listSources();
  if (Array.isArray(options.include)) {
    const want = new Set(options.include);
    return all.filter((s) => want.has(s.kind));
  }
  return all.filter((s) => {
    const flag = options[legacyFlag(s.kind)];
    return flag === undefined ? s.enabledByDefault : !!flag;
  });
}

/** `chat` -> `includeChats`. The shape every current caller already uses. */
export function legacyFlag(kind) {
  return `include${kind.charAt(0).toUpperCase()}${kind.slice(1)}s`;
}

/**
 * Load the selected sources in registration order.
 *
 * `cache` is an optional per-kind store the caller owns, so the existing TTL cache in
 * history-rag keeps working untouched.
 */
export async function loadFromSources(options = {}, { cache = null, onError = null } = {}) {
  const out = [];
  for (const source of resolveKinds(options)) {
    try {
      if (cache) {
        if (!cache[source.kind]) cache[source.kind] = await source.load();
        out.push(...cache[source.kind]);
      } else {
        out.push(...(await source.load()));
      }
    } catch (err) {
      // Degrade, never propagate: a source that cannot load is one missing section of the
      // results, not a failed search.
      (onError || defaultOnError)(source, err);
    }
  }
  return out;
}

function defaultOnError(source, err) {
  console.warn(`[chatpanel] source '${source.kind}' unavailable:`, err?.message || err);
}
