// The router, bound to the models this user actually has.
//
// The shared contract knows how to choose; it does not know what a ChatPanel endpoint or
// bridge agent is. This turns the user's configured targets into candidates with the
// attributes routing needs — how far a request must travel to reach them, what they can do,
// roughly what they cost — and declares the one middleware that must never be optional.
//
// OBSERVE FIRST. Routing starts in a mode where it decides and RECORDS but does not
// override: the existing target selection still runs. A router that took over every message
// on its first day would be indistinguishable, when something felt wrong, from any other
// change made the same day. Once the recorded decisions look right, switching it on is one
// setting.

import { createModelRouter } from './events/router.js';
import { routeGraph } from './events/route-graph.js';
import { sourcePolicyFor, DEFAULT_INTERNAL_PATTERNS } from './events/sources.js';
import { healthOf } from './model-health.js';

// WHAT A MODEL IS and HOW ONE IS CHOSEN now live in @chatpanel/events (model-candidates.js,
// route-strategies.js) — the desktop builds the same router over the gateway's model list,
// and a second copy of a guess is two guesses that drift. Re-exported here so the settings
// page, the tests and the route graph keep importing them from where they always did.
export {
  reachOf, KNOWN_CAPABILITIES, applyOverride, reachChoicesFor,
} from './events/model-candidates.js';
export {
  redactionStep, complexityStrategy, failoverStrategy, explicitModelStrategy,
  ROUTE_STRATEGIES, ROUTE_MIDDLEWARE,
} from './events/route-strategies.js';
import { inferCandidate } from './events/model-candidates.js';
import { ROUTE_STRATEGIES, ROUTE_MIDDLEWARE, needForTurn as sharedNeedForTurn } from './events/route-strategies.js';

/** Build candidates from the user's own configuration. */
export function candidatesFrom(settings = {}, resolveTarget = (x) => x, { ignoreOverrides = false } = {}) {
  const overrides = ignoreOverrides ? {} : (settings?.ui?.routing?.models || {});
  const out = [];
  const seen = new Set();
  const add = (raw, kind) => {
    const t = resolveTarget(raw) || raw;
    if (!t) return;
    const id = t.id || t.name || t.model;
    if (!id || seen.has(id)) return;
    // Behaviour beats configuration: a model whose credits ran out is configured perfectly and
    // cannot answer. The health map is this client's measurement, handed to the shared
    // inference rather than read by it.
    const m = inferCandidate(t, kind || t.kind, { override: overrides[id], health: healthOf(id, t.model || '') });
    if (!m) return;
    seen.add(id);
    out.push(m);
  };
  for (const ep of settings.endpoints || []) add(ep, 'api');
  for (const ag of settings.agents || []) add(ag, ag.kind || 'bridge');
  return out;
}


/**
 * Declare the router's parts so they appear in Plugins like everything else.
 *
 * The routing CONTRACT already lives in @chatpanel/events and runs anywhere — the gateway or
 * a desktop client can build the same router from the same declarations. What was missing is
 * the other half of being a plugin: showing up in the inventory and being switchable. A
 * strategy nobody can see or turn off is a hard-coded behaviour wearing a plugin's interface.
 */
export async function declareRouterPlugins() {
  const { declarePlugins } = await import('./plugins.js');
  return declarePlugins([
    ...ROUTE_STRATEGIES.map((st) => ({
      id: `route:${st.id}`, kind: 'route-strategy', label: st.label,
      description: `Chooses among the models a request already qualifies for (class ${st.classUsed}).`,
    })),
    ...ROUTE_MIDDLEWARE.map((mw) => ({
      id: `route-step:${mw.id}`, kind: 'route-step', label: mw.label,
      description: 'Runs on every request the router sends. Required for anything leaving this device.',
    })),
  ]);
}

export function buildRouter(settings, resolveTarget, { manifest = null } = {}) {
  return createModelRouter({
    models: candidatesFrom(settings, resolveTarget),
    middleware: ROUTE_MIDDLEWARE,
    strategies: ROUTE_STRATEGIES,
    // Strategies are switchable; the redaction step is not. Its `requiredFor` already makes
    // the router refuse to reach a third party without it, so honouring a toggle here would
    // turn a refusal into a silently skipped guarantee. Turning every strategy off degrades
    // to plain deterministic scoring, not to no routing.
    admit: manifest ? (x) => (x.stage ? true : manifest.isEnabled(`route:${x.id}`)) : null,
  });
}

/**
 * What is actually SAVED about routing — and it is almost nothing.
 *
 * The settings panel's reach / cost / speed controls are a TEST HARNESS: they answer "what
 * would this pick for a request like that". They were also being persisted and applied to
 * every real turn, so a value someone set while exploring silently constrained everything
 * afterwards. A panel that says "which model would answer, and why" must not be the thing
 * deciding it.
 *
 * What a real turn needs comes from the TURN — the tools it carries, the length and modality
 * of the request, whether an adapter is involved. Those are facts about the work, not
 * preferences someone left behind in a form.
 */
export function routingSettings(settings = {}) {
  const r = settings?.ui?.routing || {};
  return {
    // Recording only. It never changes which model answers.
    mode: r.mode || 'observe',
    // Per-model facts still apply — they describe the models, they do not pin a choice.
    models: r.models || {},
  };
}

/**
 * The model the router would use for a real turn, or null to leave the choice alone.
 *
 * Returns null in every uncertain case — mode off, no decision, or a decision naming
 * something we cannot resolve back to a usable target. Routing must never be the reason a
 * message fails to send: a router that occasionally defers is fine, one that can break a
 * turn is not.
 */
export async function routeForTurn(settings, resolveTarget, { capabilities = [], force = false, request = null, structured = false, pageTools = false, exclude = [], like = null, sources = [], background = false } = {}) {
  // Nothing is read from `ui.routing` here — deliberately. The dials are a test harness, and
  // the only thing a real turn takes from settings is the model list itself (candidatesFrom,
  // via buildRouter below) plus the per-model FACTS the user corrected there.
  // `force` is the user having selected Auto, which is the ONLY thing that turns routing on.
  // A settings mode that could route an explicitly chosen model would override the user's own
  // selection — they picked it for a reason.
  if (!force) return null;
  try {
    const router = buildRouter(settings, resolveTarget);
    // One construction, shared with the observer — see needForTurn.
    const decision = await router.routeWith({
      ...needForTurn(settings, { capabilities, request, structured, pageTools, sources, background }),
      exclude,
      like,
    });
    if (!decision.model) return null;
    const raw = [...(settings.endpoints || []), ...(settings.agents || [])]
      .find((t) => (t.id || t.name || t.model) === decision.model.id);
    if (!raw) return null;
    const target = resolveTarget ? resolveTarget(raw) : raw;
    // The whole picture, alongside the answer: every candidate with the numbers that decided
    // it, and the chain this turn would walk if the model declines. Derived from the decision
    // that was already made — arithmetic, no second routing pass — so recording it on every
    // turn costs nothing worth measuring, and finding a wrong decision stops meaning reading
    // the code.
    return target ? { target, decision, graph: routeGraph({ decision, models: router.models() }) } : null;
  } catch {
    return null;
  }
}

/**
 * The `need` for one turn, built ONCE.
 *
 * Two call sites were constructing this separately — the observer with bare defaults, the
 * applier with the saved dials, the request signals and the structured flag — so the two
 * disagreed and the log said "would route to Gemma4" about a turn OpenCode answered. Same
 * class of bug as the duplicated engine list: two implementations of one decision drift, and
 * the one nobody is watching is the one that goes wrong.
 */
/**
 * The internal-source policy, read from settings in ONE place.
 *
 * Defaults are ON and claim only what an address proves — private ranges and single-label
 * hosts genuinely cannot be public sites, so there is nothing to opt into and no false
 * positives to apologise for. Anything beyond that (a company domain on public DNS) is the
 * user's own pattern, because from here it is indistinguishable from any other public host.
 */
export function sourcePolicySettings(settings = {}) {
  const cfg = settings?.privacy || {};
  // NEVER CONFIGURED and CONFIGURED TO NOTHING are different answers. Undefined means the
  // user has not been here yet, so the built-ins apply; an array — even an empty one — is a
  // list they edited, and prepending our own to it would make a default impossible to
  // remove. Someone testing against localhost has a real reason to delete that line.
  const saved = cfg.internalPatterns;
  const list = Array.isArray(saved)
    ? saved
    : (saved == null ? DEFAULT_INTERNAL_PATTERNS : String(saved).split(/[\s,]+/));
  return {
    enabled: cfg.internalGuard !== false,
    patterns: list.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean),
    ceiling: cfg.internalCeiling === 'trusted' ? 'trusted' : 'device',
  };
}

/** What the sources of a turn allow. Returns null when the guard is off or nothing matched. */
export function sourceGuardFor(settings, sources = []) {
  const policy = sourcePolicySettings(settings);
  if (!policy.enabled || !sources?.length) return null;
  const p = sourcePolicyFor(sources, { patterns: policy.patterns, ceiling: policy.ceiling });
  return p.internal ? p : null;
}

export function needForTurn(settings, { capabilities = [], request = null, structured = false, pageTools = false, force = false, sources = [], background = false } = {}) {
  // The need is built by the shared module; only the source guard is this client's to
  // read, because it comes from this client's settings.
  return sharedNeedForTurn({ capabilities, request, structured, pageTools, force, background, guard: sourceGuardFor(settings, sources) });
}

/** What the router WOULD choose for a turn — recorded, not obeyed, until routing is on. */
export async function previewRoute(settings, resolveTarget, need = {}) {
  try {
    const { pluginManifest } = await import('./plugins.js');
    const router = buildRouter(settings, resolveTarget, { manifest: await pluginManifest().catch(() => null) });
    const decision = await router.routeWith(need);
    const nameOf = (id) => router.models().find((m) => m.id === id)?.label || id;
    return {
      chosen: decision.model?.label || null,
      chosenId: decision.model?.id || null,
      strategy: decision.strategy,
      reasons: decision.reasons,
      rejected: (decision.rejected || []).map((x) => ({ ...x, id: nameOf(x.id) })),
      runnersUp: (decision.runnersUp || []).map(nameOf),
      eligible: (decision.eligible || []).map((m) => m.label),
      // The picture, on the OBSERVED path too. A turn where the user picked the model
      // themselves is exactly where "what would the router have done, and why" is worth
      // seeing — and it was the one path that recorded `graph: null`.
      graph: routeGraph({ decision, models: router.models() }),
    };
  } catch (e) {
    return { chosen: null, error: e.message };
  }
}
