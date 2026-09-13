// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-cache.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// One lookup per run — a run-scoped cache over read-only tools.
//
// Three members of a travel team searched "Snoqualmie Valley School District calendar" five
// times between them. Each member's own turn already dedupes its own repeats; the RUN did
// not, and members in one wave cannot read each other's findings yet. So: a read-only call
// with the same name and arguments, from any member, runs once per run; the rest get the
// first answer back, marked as shared. Only tools that declare themselves read-only (MCP
// annotations, the shared retrieval tools) are cached; a dispatcher's paging (`get_result`)
// and the board are per-member and never are.

const NEVER = new Set(['get_result', 'board', 'team', 'recipe']);
const READ_ONLY_NAME_RE = /^(find|web_search|history_search|history_get_source|history_list|meeting_live_transcript|read|fetch|get_|list_|search)/i;

function stableKey(name, input) {
  const walk = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => { o[k] = walk(v[k]); return o; }, {}) : Array.isArray(v) ? v.map(walk) : v);
  try { return `${name} ${JSON.stringify(walk(input ?? {}))}`; } catch { return `${name} ?`; }
}

export function createRunCache() {
  const hits = new Map(); // key -> { result, by, at }
  let shared = 0;
  return {
    get: (k) => hits.get(k) || null,
    set: (k, v) => { hits.set(k, v); },
    delete: (k) => { hits.delete(k); },
    countShared: () => { shared += 1; },
    get size() { return hits.size; },
    get shared() { return shared; },
  };
}

function isReadOnly(toolset, name) {
  if (NEVER.has(name)) return false;
  const spec = (toolset.specs || []).find((s) => s.name === name);
  if (spec?.annotations?.readOnlyHint === true) return true;
  if (spec?.annotations && spec.annotations.readOnlyHint === false) return false;
  const t = toolset.traits instanceof Map ? toolset.traits.get(name) : null;
  if (t && typeof t.readOnly === 'boolean') return t.readOnly;
  return READ_ONLY_NAME_RE.test(name);
}

/** The toolset with its read-only calls served from the run's cache. */
export function withRunCache(toolset, cache, { role = '' } = {}) {
  if (!toolset || !cache) return toolset;
  return {
    ...toolset,
    execute: async (name, input, ...rest) => {
      if (!isReadOnly(toolset, name)) return toolset.execute(name, input, ...rest);
      const key = stableKey(name, input);
      const hit = cache.get(key);
      if (hit) {
        // Members in one wave ask at the same moment: the second waits on the first's call.
        cache.countShared();
        const result = await hit.promise;
        const note = `[shared: ${hit.by || 'another member'} already ran this in this run]\n`;
        return typeof result === 'string' ? note + result : result;
      }
      const promise = Promise.resolve().then(() => toolset.execute(name, input, ...rest));
      cache.set(key, { promise, by: role, at: Date.now() });
      try { return await promise; } catch (e) { cache.delete(key); throw e; }
    },
  };
}
