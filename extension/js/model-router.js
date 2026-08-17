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

import { defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom } from './events/router.js';
import { healthOf } from './model-health.js';

/** Where a request must travel to reach this target — the only attribute privacy depends on. */
function reachOf(target) {
  // A bridge agent runs a CLI on the user's own machine; the model behind it may still be
  // remote, which is why this says 'trusted' rather than 'device'. Claiming otherwise would
  // let a device-only request reach a cloud model through a local process.
  if (target.kind === 'bridge') return 'trusted';
  //判 locality from the URL rather than importing providers.js: this module is loaded by
  // the settings page, and pulling the provider graph in to answer one question would put a
  // large subtree on a page that does not otherwise need it.
  const url = String(target.baseUrl || target.url || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)) return 'device';
  // A .local or on-LAN host is the user's own machine or network — not a third party, but
  // not the device either.
  if (/^https?:\/\/([^/]*\.local|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) return 'trusted';
  return 'any';
}

/**
 * The levers a user can pull, and what each one means for routing.
 *
 * Named rather than free-form: a capability only matters if something asks for it, and a
 * typo in a free-text field would silently make a model ineligible forever with no way to
 * see why.
 */
export const KNOWN_CAPABILITIES = Object.freeze([
  { id: 'tools', label: 'Tools', hint: 'Can call functions — needed for page actions, search and MCP.' },
  { id: 'vision', label: 'Vision', hint: 'Can read images and screenshots.' },
  { id: 'reasoning', label: 'Reasoning', hint: 'Thinks before answering — worth the wait on hard tasks.' },
  { id: 'long-context', label: 'Long context', hint: 'Handles large documents and long meetings.' },
  { id: 'coding', label: 'Coding', hint: 'Strong at writing and refactoring code.' },
  { id: 'json', label: 'Structured output', hint: 'Reliably returns valid JSON.' },
]);

/**
 * What a model can probably do, guessed from its name.
 *
 * Conservative on purpose: an unproven capability claimed here becomes a failed turn, and a
 * missing one only means the router does not volunteer it. The user corrects both — these
 * are a starting point, not a verdict.
 */
function capabilitiesOf(target) {
  const m = String(target.model || '').toLowerCase();
  const caps = new Set(['json']);
  // Bridge agents relay tools through the bridge's MCP server; API endpoints vary, so tool
  // support is assumed only where the user has actually configured a model for it.
  if (target.kind === 'bridge' || target.model) caps.add('tools');
  if (/gpt-4|gpt-5|claude|gemini|vision|vl\b|llava|pixtral/.test(m)) caps.add('vision');
  if (/o1|o3|r1|reason|think|opus|sonnet|deepseek-r/.test(m)) caps.add('reasoning');
  if (/200k|1m\b|long|gemini|claude|gpt-4\.1|gpt-5/.test(m)) caps.add('long-context');
  if (/code|coder|codex|deepseek|qwen|opus|sonnet/.test(m)) caps.add('coding');
  // A CLI coding agent is a coding agent, whatever its model is called.
  if (target.kind === 'bridge') { caps.add('coding'); caps.add('reasoning'); }
  return [...caps];
}

/** Rough relative cost — unitless, and only ever compared against its siblings. */
function costOf(target, reach) {
  if (reach === 'device') return 0;
  const m = String(target.model || '').toLowerCase();
  if (/opus|gpt-4|pro\b/.test(m)) return 5;
  if (/sonnet|mini|flash|haiku/.test(m)) return 1;
  return 2;
}

/**
 * Everything the router infers about one model, and what the user said instead.
 *
 * Defaults are guesses — a name matched against a regex, a URL judged local. They are right
 * often enough to be useful and wrong often enough that someone who knows their own setup
 * must be able to say so. A router that cannot be corrected is one people work around.
 *
 * OVERRIDES CAN ONLY MOVE REACH OUTWARD. Every other attribute is the user's to set, but
 * reach is what privacy depends on, and the two directions are not symmetric:
 *
 *   'this cloud endpoint is really on my device'  — would let a device-only request reach a
 *       third party, from one typo or one synced settings file. Refused.
 *   'this local-looking endpoint actually goes out' — makes FEWER requests eligible for it.
 *       Always allowed, because a user is entitled to trust their own setup less than we do.
 *
 * A model that reaches further can serve fewer kinds of request, so outward is the safe
 * direction and inward is the one that has to be earned rather than declared.
 */
export function applyOverride(inferred, override = {}) {
  if (!override || typeof override !== 'object') return inferred;
  const out = { ...inferred };
  if (Array.isArray(override.capabilities)) out.capabilities = [...override.capabilities];
  for (const key of ['costPer1k', 'latencyMs', 'quality']) {
    if (Number.isFinite(Number(override[key]))) out[key] = Number(override[key]);
  }
  if (typeof override.available === 'boolean') out.available = override.available;
  if (override.reach && REACH_RANK[override.reach] > REACH_RANK[inferred.reach]) {
    // Outward only. See the note above.
    out.reach = override.reach;
  }
  return out;
}

const REACH_RANK = { device: 0, trusted: 1, any: 2 };

/** Build candidates from the user's own configuration. */
export function candidatesFrom(settings = {}, resolveTarget = (x) => x, { ignoreOverrides = false } = {}) {
  const overrides = ignoreOverrides ? {} : (settings?.ui?.routing?.models || {});
  const out = [];
  const seen = new Set();
  const add = (raw, kind) => {
    const t = resolveTarget(raw) || raw;
    if (!t || (!t.model && t.kind !== 'bridge')) return;
    const id = t.id || t.name || t.model;
    if (!id || seen.has(id)) return;
    seen.add(id);
    // A generated id (mqk41ucyhmz1au) is meaningless to the person reading a routing
    // decision. The label is what they actually named the thing, falling back to the model
    // and only then to the id — an explanation nobody can read is not an explanation.
    const label = [t.name, t.model && t.model !== t.name ? t.model : null]
      .filter(Boolean).join(' · ') || String(id);
    const reach = reachOf({ ...t, kind: kind || t.kind });
    const inferred = {
      id,
      label,
      // Kept so failover can recognise the SAME model at another provider — the closest
      // possible replacement, and invisible if only the display label survived.
      model: t.model || '',
      reach,
      classUsed: reach === 'device' ? 'L' : (kind === 'bridge' ? 'A' : 'C'),
      capabilities: capabilitiesOf(t),
      costPer1k: costOf(t, reach),
      // A local model is slower to first token than a hosted one far more often than not.
      latencyMs: reach === 'device' ? 1500 : 700,
      available: t.enabled !== false,
    };
    // Behaviour beats configuration. A model whose credits ran out is configured perfectly
    // and cannot answer; routing to it because its config still looks good is what a user
    // experiences as "it keeps picking the broken one".
    const configured = applyOverride(inferred, overrides[id]);
    const live = healthOf(id);
    out.push(defineModel({
      ...configured,
      available: configured.available && live.available,
      rateLimited: live.rateLimited,
    }));
  };
  for (const ep of settings.endpoints || []) add(ep, 'api');
  for (const ag of settings.agents || []) add(ag, ag.kind || 'bridge');
  return out;
}

/**
 * Redaction is REQUIRED for anything that leaves the user's machine.
 *
 * Declared as middleware with `requiredFor` so the router refuses to route to a third party
 * when it is not active. That is the difference between "we always redact" as a habit and as
 * a property: a disabled plugin, a refactor or a new caller cannot quietly skip it.
 */
export const redactionStep = defineMiddleware({
  id: 'redaction',
  label: 'Redaction',
  stage: 'request',
  priority: 10,   // before anything that reads the text
  requiredFor: (model) => model.reach === 'any',
  // The actual redaction still happens in streamChat's harness. This declares the
  // REQUIREMENT; wiring the implementation through here is the next step, and doing both at
  // once would mean changing what redaction does in the same commit that changes when it runs.
  run: async (request) => request,
});

/**
 * Escalate when the task is actually hard.
 *
 * The router was picking the cheapest eligible model for everything, which is right for
 * "hello" and wrong for "draw a circle around Mickey" — a request needing spatial reasoning
 * and a structured payload went to a 26B model because it was free. Cost is the correct
 * tie-breaker among models that can all do the job; it is the wrong one when they cannot.
 *
 * Class R: length, code fences, image content and page tools are all readable for nothing.
 * The escalation itself costs no model call — only the answer does, and that is the point.
 */
export const complexityStrategy = defineRouteStrategy({
  id: 'escalate-on-complexity',
  label: 'Escalate hard tasks',
  classUsed: 'R',
  decide: async (eligible, need) => {
    const sig = need.signals;
    const hard = sig?.complexity === 'high' || sig?.modality === 'vision' || need.structured;
    if (!hard) return null;   // no opinion on easy work — let cost decide
    // Prefer a model that claims what this task actually wants. Not a hard filter: declaring
    // "reasoning" required would eliminate every model on a setup where nobody has ticked
    // the box, and an empty candidate list is a worse answer than a merely adequate model.
    const wants = new Set();
    if (sig?.complexity === 'high') wants.add('reasoning');
    if (need.structured) wants.add('tools');
    if (sig?.modality === 'vision') wants.add('vision');
    if (sig?.approxTokens > 20_000) wants.add('long-context');
    const fit = (m) => [...wants].filter((c) => m.capabilities.includes(c)).length;
    const best = Math.max(...eligible.map(fit));
    const shortlist = best > 0 ? eligible.filter((m) => fit(m) === best) : eligible;
    // Rank by declared quality, then by cost as the tiebreak among equals. A model with an
    // unknown quality sits mid-table rather than last, so a newly added model is not
    // permanently skipped.
    const q = (m) => (Number.isFinite(m.quality) ? m.quality : 0.5);
    return [...shortlist].sort((a, b) => q(b) - q(a) || a.costPer1k - b.costPer1k);
  },
});

/**
 * When a model declines, replace it with the closest thing available — not the cheapest.
 *
 * A frontier model that ran out of credits mid-task should be replaced by the same model at
 * another provider, or by something comparably capable. Falling back to a small local model
 * is how a drawing that was going well turns into a circle in the wrong place: the task did
 * not get easier when the provider said no.
 *
 * Ranked by closeness to what failed, in the order that actually matters:
 *   1. the SAME model somewhere else — identical capability, merely a different bill;
 *   2. a model with every capability the failed one had, best quality first;
 *   3. anything else, so the turn still completes rather than dying.
 */
export const failoverStrategy = defineRouteStrategy({
  id: 'failover-to-similar',
  label: 'Replace like with like',
  classUsed: 'R',
  decide: async (eligible, need) => {
    const failed = need.like;
    if (!failed) return null;
    const sameModel = (m) => !!failed.model && normModel(m) === normModel(failed);
    // A RETIRED MODEL IS RETIRED EVERYWHERE. "Same model at another provider" is the ideal
    // replacement when the provider declined — out of credits, rate limited — and the worst
    // possible one when the MODEL is gone: deepseek-v4-flash reaching end of life on
    // HuggingFace means the identical name on NVIDIA is equally dead, so preferring it walks
    // straight into the same wall.
    if (failed.reason === 'gone') {
      const alive = eligible.filter((m) => !sameModel(m));
      if (alive.length) eligible = alive;
    }
    const covers = (m) => (failed.capabilities || []).every((c) => m.capabilities.includes(c));
    const q = (m) => (Number.isFinite(m.quality) ? m.quality : 0.5);
    const rank = (m) => (sameModel(m) ? 0 : covers(m) ? 1 : 2);
    return [...eligible].sort((a, b) => rank(a) - rank(b) || q(b) - q(a) || a.costPer1k - b.costPer1k);
  },
});

/** The model name without its provider prefix or tag, so the same model matches across hosts. */
function normModel(m) {
  return String(m?.model || m?.label || '')
    .toLowerCase()
    .replace(/^[^/]+\//, '')      // deepseek-ai/DeepSeek-V4-Flash → deepseek-v4-flash
    .replace(/[:@].*$/, '')       // gemma4:latest → gemma4
    .replace(/[^a-z0-9.]+/g, '');
}

export function buildRouter(settings, resolveTarget) {
  return createModelRouter({
    models: candidatesFrom(settings, resolveTarget),
    middleware: [redactionStep],
    // Failover first: when something just declined, replacing it well matters more than the
    // general preference that picked it in the first place.
    strategies: [failoverStrategy, complexityStrategy],
  });
}

/** The user's saved dials, with defaults that change nothing. */
export function routingSettings(settings = {}) {
  const r = settings?.ui?.routing || {};
  return {
    mode: r.mode || 'observe',
    reach: r.reach || 'any',
    prefer: r.prefer || 'balanced',
    maxLatencyMs: Number(r.maxLatencyMs) || 0,
    maxCostPer1k: r.maxCostPer1k == null ? undefined : Number(r.maxCostPer1k),
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
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
export async function routeForTurn(settings, resolveTarget, { capabilities = [], force = false, request = null, structured = false, exclude = [], like = null } = {}) {
  const cfg = routingSettings(settings);
  // `force` is the user having selected Auto: choosing the router IS the instruction to
  // route, and making them also flip a settings dial would be asking for the same consent
  // twice.
  if (!force && cfg.mode !== 'on') return null;
  try {
    const router = buildRouter(settings, resolveTarget);
    const decision = await router.routeWith({
      ...cfg,
      // What the TURN needs is a hard requirement and outranks the saved preference: a turn
      // with tools cannot use a model without them, whatever the dials say.
      capabilities: [...new Set([...(cfg.capabilities || []), ...capabilities])],
      // The signals a strategy needs to tell "hello" from real work — read for free.
      signals: request ? signalsFrom(request) : undefined,
      structured,
      exclude,
      like,
    });
    if (!decision.model) return null;
    const raw = [...(settings.endpoints || []), ...(settings.agents || [])]
      .find((t) => (t.id || t.name || t.model) === decision.model.id);
    if (!raw) return null;
    const target = resolveTarget ? resolveTarget(raw) : raw;
    return target ? { target, decision } : null;
  } catch {
    return null;
  }
}

/** What the router WOULD choose for a turn — recorded, not obeyed, until routing is on. */
export async function previewRoute(settings, resolveTarget, need = {}) {
  try {
    const router = buildRouter(settings, resolveTarget);
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
    };
  } catch (e) {
    return { chosen: null, error: e.message };
  }
}
