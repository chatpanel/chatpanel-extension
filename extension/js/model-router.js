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

/** What it can do. Conservative: an unproven capability claimed here becomes a failed turn. */
function capabilitiesOf(target) {
  const caps = ['json'];
  // Bridge agents relay tools through the bridge's MCP server; API endpoints vary, so tool
  // support is assumed only where the user has actually configured a model for it.
  if (target.kind === 'bridge' || target.model) caps.push('tools');
  if (/gpt-4|claude|gemini|vision|vl\b/i.test(String(target.model || ''))) caps.push('vision');
  return caps;
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
    // Rank by declared quality, then by cost as the tiebreak among equals. A model with an
    // unknown quality sits mid-table rather than last, so a newly added model is not
    // permanently skipped.
    const q = (m) => (Number.isFinite(m.quality) ? m.quality : 0.5);
    return [...eligible].sort((a, b) => q(b) - q(a) || a.costPer1k - b.costPer1k);
  },
});

export function buildRouter(settings, resolveTarget) {
  return createModelRouter({
    models: candidatesFrom(settings, resolveTarget),
    middleware: [redactionStep],
    strategies: [complexityStrategy],
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
export async function routeForTurn(settings, resolveTarget, { capabilities = [], force = false, request = null, structured = false, exclude = [] } = {}) {
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
