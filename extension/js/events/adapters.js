// GENERATED — do not edit.
// Source of truth: chatpanel-events/adapters.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Surface adapters — the plugin contract for "this app is driven better by its own data
// format than by pointer automation".
//
// Excalidraw is drawn by writing scene elements, a spreadsheet is filled by addressing
// cells, a diagram tool by inserting nodes. Each of those is the SAME shape of thing:
// recognise a page, offer a tool, say how to use it, execute it. That was hardcoded as a
// list inside one 1,200-line module, which meant every new app edited a shared file and
// nothing outside the extension could offer one at all.
//
// As a plugin contract instead (P15): an adapter is declared, registered with the kernel,
// and discovered. The desktop and mobile clients get the same registry; a user or a skill
// can eventually contribute one without touching this code.
//
// WHAT IS SHARED IS THE CONTRACT, NOT THE ADAPTER. Recognition and selection are pure and
// live here; the execution of any real adapter needs a platform (chrome.scripting, CDP)
// and therefore lives in the client, injected at registration.

export class AdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'AdapterError'; this.code = code; }
}

/**
 * Declare an adapter.
 *
 * @param matches  (url, caps) => boolean. Given the URL and whatever capability probe the
 *                 host performed, so an adapter can recognise a self-hosted or embedded
 *                 instance rather than only a known hostname — the reason a hostname table
 *                 was rejected in the first place.
 * @param priority higher wins when two adapters match. Ties break on registration order,
 *                 so the answer is stable rather than dependent on activation timing.
 */
export function defineAdapter({ id, label, matches, toolSpecs, guidance, execute, priority = 0 }) {
  if (!id) throw new AdapterError('BAD_ADAPTER', 'adapter.id required');
  if (typeof matches !== 'function') throw new AdapterError('BAD_ADAPTER', `adapter '${id}': matches required`);
  if (typeof execute !== 'function') throw new AdapterError('BAD_ADAPTER', `adapter '${id}': execute required`);
  return Object.freeze({
    id,
    label: label || id,
    matches,
    priority,
    toolSpecs: typeof toolSpecs === 'function' ? toolSpecs : () => [],
    guidance: typeof guidance === 'function' ? guidance : () => '',
    execute,
  });
}

/**
 * The registry a host binds adapters into.
 *
 * Deliberately independent of the kernel: a plugin registers through the kernel and calls
 * `add` from its activate, but a host with no kernel yet can still use this. Coupling them
 * would make the plugin model a prerequisite for a feature rather than a way to build it.
 */
export function createAdapterRegistry() {
  const adapters = [];
  return {
    /** Register an adapter. Returns its remover, so registration is revertible (P15). */
    add(adapter) {
      adapters.push(adapter);
      return () => {
        const i = adapters.indexOf(adapter);
        if (i >= 0) adapters.splice(i, 1);
      };
    },

    list: () => [...adapters],

    /**
     * The adapter for a page, or null.
     *
     * A matcher that throws is treated as "no match" rather than taking the page down: one
     * badly-written adapter must not stop the others being offered, which is the same
     * isolation rule the source registry follows.
     */
    for(url, caps = {}) {
      const hits = adapters.filter((a) => {
        try { return !!a.matches(url, caps); } catch { return false; }
      });
      if (!hits.length) return null;
      return hits.sort((a, b) => b.priority - a.priority)[0];
    },
  };
}
