// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-groups.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Tool groups as plugins — "here is a set of capabilities, and when to offer them".
//
// The extension assembles a turn's toolset from three hardcoded blocks: the user's own
// data, their MCP servers, and the page. Each block is the same shape — decide whether it
// applies, build a provider, collapse it behind a dispatcher — written out three times, so
// a fourth means editing a shared function and no other client can contribute one at all.
//
// The failure this prevents is not hypothetical. A duplicated search-engine list in two
// files produced a retired engine that kept reappearing in settings; two implementations of
// one decision disagree eventually. A registry makes that unrepresentable: there is one
// list, and it is the registrations.
//
// A group DECIDES and BUILDS; it does not know about the others. Ordering is explicit
// priority rather than call order, because "which tools does the model see first" should be
// a stated decision and not an accident of where someone added a line.

export class ToolGroupError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolGroupError'; this.code = code; }
}

/**
 * @param applies (ctx) => boolean — cheap, synchronous, no side effects. Kept separate from
 *        `build` so "should this be offered" can be answered without paying to construct
 *        it: MCP construction connects to servers, and asking that question should not.
 * @param build   async (ctx) => provider | null. Returning null is normal (nothing
 *        configured), not an error.
 */
export function defineToolGroup({ id, label, applies, build, priority = 0 }) {
  if (!id) throw new ToolGroupError('BAD_GROUP', 'group.id required');
  if (typeof build !== 'function') throw new ToolGroupError('BAD_GROUP', `group '${id}': build required`);
  return Object.freeze({
    id,
    label: label || id,
    priority,
    applies: typeof applies === 'function' ? applies : () => true,
    build,
  });
}

export function createToolGroupRegistry() {
  const groups = [];
  return {
    add(group) {
      groups.push(group);
      return () => { const i = groups.indexOf(group); if (i >= 0) groups.splice(i, 1); };
    },

    list: () => [...groups].sort((a, b) => b.priority - a.priority),

    /**
     * Build every group that applies, in priority order.
     *
     * Groups are built CONCURRENTLY because one of them connects to remote servers and
     * serialising would add its latency to every turn — but the RESULT is re-sorted by
     * priority, so the order the model sees never depends on which finished first.
     *
     * A group that throws is dropped with a report, not propagated: a broken MCP server
     * must not cost the user their history tools. Same isolation rule as the source
     * registry and the adapter registry, for the same reason.
     */
    async build(ctx, { onError = () => {} } = {}) {
      const eligible = this.list().filter((g) => {
        try { return !!g.applies(ctx); } catch (e) { onError(g.id, e); return false; }
      });
      const built = await Promise.all(eligible.map(async (g) => {
        try { return { id: g.id, priority: g.priority, provider: await g.build(ctx) }; } catch (e) {
          onError(g.id, e);
          return null;
        }
      }));
      return built
        .filter((b) => b && b.provider)
        .sort((a, b) => b.priority - a.priority)
        .map((b) => ({ id: b.id, provider: b.provider }));
    },
  };
}
