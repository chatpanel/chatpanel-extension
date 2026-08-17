// The page capability, held by the registry instead of by whoever remembered to call the
// renderer.
//
// The button that shows whether the agent may act on this page was re-rendered from four
// separate places — a grant, the composer refresh, a tab change, and the click handler.
// Every one of those is a place the UI stays correct only because someone remembered, and
// a fifth caller added later silently goes stale. That is the coupling the registry exists
// to remove.
//
// So the page context becomes a PROVIDED CAPABILITY and the button becomes a DEPENDENT.
// Navigate to a page ChatPanel cannot read and the capability withdraws; the dependent
// unwinds and resets the button on its way out — no call site to forget. Navigate back and
// it re-arms. That is exactly the appears/withdraws/returns cycle the ADR probe measured,
// now load-bearing rather than demonstrated.
//
// WHY WITHDRAW-AND-REPROVIDE rather than mutating the value: a registry that models
// availability has one honest way to say "this is different now", and reverting through
// the real path on every change is what keeps the revert path exercised. A revert that
// only runs in the rare case is a revert that is broken when the rare case arrives.

const KEY = 'page.context';

let registry = null;
let withdraw = null;
let current = null;

async function ensureRegistry({ onArm, onDisarm, onEvent }) {
  if (registry) return registry;
  // Dynamic: the registry must not sit on the panel's first-paint graph.
  const { createRegistry } = await import('./events/registry.js');
  registry = createRegistry({ onEvent });
  registry.register({
    name: 'page-actions',
    requires: [KEY],
    apply(ctx) {
      const value = ctx.get(KEY);
      ctx.effect(() => {
        onArm(value);
        return () => onDisarm();
      });
    },
  });
  return registry;
}

/**
 * Publish the current page context, or `null` when there is nothing actionable.
 *
 * @param value  { tab, decision } — everything the dependent needs, so a policy change and
 *               a tab change travel the same path instead of one being a special case.
 */
export async function syncPageContext(value, handlers) {
  const reg = await ensureRegistry(handlers);
  if (withdraw) { withdraw(); withdraw = null; }
  current = value || null;
  if (current) withdraw = reg.provide(KEY, current);
  return reg;
}

export function pageContext() { return current; }

/** Introspection for tests and the Plugins lens: what is armed, and what is waiting. */
export function pageCapabilityState() {
  if (!registry) return { active: [], pending: [], provided: [] };
  return { active: registry.active(), pending: registry.pending(), provided: registry.keys() };
}

/** Test-only: tear the whole thing down so a suite starts clean. */
export async function resetPageCapability() {
  if (registry) await registry.dispose();
  registry = null;
  withdraw = null;
  current = null;
}
