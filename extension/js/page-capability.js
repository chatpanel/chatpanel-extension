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
const TOOLS_KEY = 'page.tools';

let registry = null;
let withdraw = null;
let current = null;
let built = null;      // the provider, built at most once per armed context

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
  // P5 — A CAPABILITY IS NOT A PROPERTY OF A TURN.
  //
  // The page tools were only ever constructed while assembling a turn, so nothing else
  // could reach them: a rule, a schedule, or the user pressing a button had no way to act
  // on the page without a conversation existing first. That is the assumption the ADR
  // rejects, and it is why "act on this page" could not become automation.
  //
  // What is published is a FACTORY, not a built provider. Building eagerly on every
  // navigation would drag the page-action and canvas modules onto every tab change —
  // exactly the heavy work they are dynamic-imported to avoid. So the cost stays where it
  // was (first use) while reachability moves to where it belongs (the capability).
  registry.register({
    name: 'page-tools',
    requires: [KEY],
    apply(ctx) {
      const value = ctx.get(KEY);
      ctx.provide(TOOLS_KEY, { build: (agent) => makeProvider(value, agent) });
      // The built provider is an EFFECT, so its inverse drops it when the page changes.
      // Without that, a provider built for one tab would answer for the next one.
      ctx.effect(() => () => { built = null; });
    },
  });
  return registry;
}

let makeProvider = null;

/**
 * Tell the capability HOW to build page tools. Passed in rather than imported so this
 * module stays free of the side panel's 250-line provider and its panel state — the
 * capability owns availability, not construction.
 */
export function setPageToolFactory(fn) { makeProvider = fn; }

/**
 * Get the page toolset without a turn. Returns null when the page is not armed, which is
 * the same answer a turn gets — one path, so a rule cannot accidentally reach further
 * than a conversation can.
 */
export async function acquirePageTools(agent) {
  if (!registry || !registry.has(TOOLS_KEY) || !makeProvider) return null;
  if (!built) built = await registry.get(TOOLS_KEY).build(agent);
  return built;
}

/** Invoke one page action with no conversation in existence. */
export async function invokePageAction(name, args = {}, meta = {}, agent = null) {
  const tools = await acquirePageTools(agent);
  if (!tools) return JSON.stringify({ error: 'Page actions are not available on this tab.' });
  return tools.execute(name, args, meta);
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
  built = null;
  makeProvider = null;
}
