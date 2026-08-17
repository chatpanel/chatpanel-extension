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

import {
  defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom, requirementsFor,
} from './events/router.js';
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

/**
 * Which provider to prefer when two of them offer the same model. Lower wins.
 *
 * Ties were breaking alphabetically, which is not a preference — it is the absence of one,
 * and it sent every equal choice to whichever provider happened to sort first. The order
 * below is a starting point with a reason behind each rung; the user overrides it per model.
 *
 * FEWER HOPS FIRST. A direct API is one network call to the people who run the model; an
 * aggregator adds a hop, its own quotas, and its own outages on top of the provider's. When
 * everything else is equal, the shorter path is the more reliable one.
 */
const PROVIDER_ORDER = [
  // The user's own machine: no quota, no outage, no third party.
  /localhost|127\.0\.0\.1|ollama|lm.?studio/i,
  // First-party APIs.
  /anthropic|openai\.com|api\.deepseek|googleapis|x\.ai/i,
  // Local CLI agents — capable, but they spawn a process and run their own loop.
  /(^|\W)bridge(\W|$)/i,
  // Aggregators and gateways: an extra hop and someone else's quota.
  /openrouter|huggingface|together|groq|fireworks|nvidia|replicate/i,
];

function providerRankOf(target, kind) {
  const hay = `${target.baseUrl || target.url || ''} ${target.name || ''} ${kind || target.kind || ''}`;
  for (let i = 0; i < PROVIDER_ORDER.length; i++) {
    if (PROVIDER_ORDER[i].test(hay)) return i * 10;
  }
  return 50;   // unrecognised: mid-table, so a provider we have no opinion on is not buried
}

/**
 * Roughly how capable a model is, guessed from its name.
 *
 * Shipping the quality lever with no default meant every model scored the same, so a
 * frontier model that declined was replaced by an 8B instant model with equal standing —
 * "same capabilities, cheaper" is what the ranking saw, and it is nonsense. A wrong guess a
 * user can correct beats a blank that makes every model interchangeable.
 *
 * Names are a crude signal and deliberately so: this only has to ORDER models, not score
 * them, and the ordering it needs is the obvious one everybody already knows.
 */
function qualityOf(target) {
  const m = `${target.model || ''} ${target.name || ''}`.toLowerCase();

  // Parameter count, READ AS A NUMBER rather than pattern-matched. A regex for "any digits
  // followed by b" cannot tell 8B from 26B from 405B, and the first version of this scored
  // a 26B model as tiny for exactly that reason. Size is a number; treat it as one.
  const size = Number(/(\d+(?:\.\d+)?)\s*b\b/.exec(m)?.[1]);
  if (Number.isFinite(size)) {
    if (size >= 60) return 0.85;   // frontier-scale open weights
    if (size >= 20) return 0.6;    // the solid mid-range most people run locally
    return 0.3;                    // small and fast, never a stand-in for a frontier model
  }

  // Named tiers, for hosted models that do not advertise a size.
  if (/instant|mini|nano|tiny|lite|-small\b|haiku/.test(m)) return 0.3;
  if (/opus|gpt-5|o1|o3|\bpro\b|ultra|deepseek-r|thinking/.test(m)) return 0.9;
  if (/sonnet|gpt-4|flash|gemini|deepseek|qwen|mistral|codestral/.test(m)) return 0.6;
  return 0.5;   // genuinely unknown: mid-table, so it is neither buried nor promoted
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
  if (Number.isFinite(Number(override.providerRank))) out.providerRank = Number(override.providerRank);
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
      quality: qualityOf(t),
      providerRank: providerRankOf(t, kind),
      available: t.enabled !== false,
    };
    // Behaviour beats configuration. A model whose credits ran out is configured perfectly
    // and cannot answer; routing to it because its config still looks good is what a user
    // experiences as "it keeps picking the broken one".
    const configured = applyOverride(inferred, overrides[id]);
    const live = healthOf(id, configured.model);
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
    let shortlist = best > 0 ? eligible.filter((m) => fit(m) === best) : eligible;

    // STRUCTURED WORK WANTS A MODEL, NOT AN AGENT.
    //
    // A canvas or spreadsheet adapter is one call: hand it the data, it applies it, done. A
    // CLI agent runs its OWN loop — it explores, reads files, decides what to do next — and
    // having applied the shapes correctly it carries on, because finishing is not something
    // its loop is told about. A user watched the circle appear and then waited until they
    // killed the process.
    //
    // Not a hard filter: on a setup with only agents, an agent that overruns still beats no
    // answer.
    if (need.structured) {
      const models = shortlist.filter((m) => m.classUsed !== 'A');
      if (models.length) shortlist = models;
    }
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
    // SAME KIND OF THING. Class is not a quality score, it is how the model is REACHED: an
    // API model answers a request, a CLI agent spawns a process with its own tools, its own
    // loop and its own idea of what to do next. Substituting one for the other mid-task is
    // not a fallback, it is a different program — a drawing request handed to a coding agent
    // went off reading files for a minute instead.
    const sameClass = (m) => !failed.classUsed || m.classUsed === failed.classUsed;
    const rank = (m) => {
      if (sameModel(m)) return 0;
      if (sameClass(m) && covers(m)) return 1;
      if (sameClass(m)) return 2;
      if (covers(m)) return 3;   // capable but a different kind of thing
      return 4;
    };
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

/**
 * "use claude" is an instruction, not a topic.
 *
 * A user naming a model in their message was being ignored entirely — the router read
 * length, modality and tools, and not the one signal that is an explicit answer to the
 * question it was asking. Asking for a specific model and being given another is the most
 * annoying possible failure of a router, because it looks like the request was not read.
 *
 * DELIBERATELY CONSERVATIVE. Only imperative forms count — "use X", "with X", "ask X",
 * "switch to X" — so "tell me about claude" stays a question about Claude rather than a
 * routing instruction. A false positive here silently sends work to the wrong model, which
 * is worse than missing an unusual phrasing.
 *
 * It still cannot widen reach: like every strategy it only ever chooses among candidates the
 * hard constraints already allowed. A device-only request naming a cloud model still stays
 * on-device.
 */
export const explicitModelStrategy = defineRouteStrategy({
  id: 'named-by-user',
  label: 'Use the model you asked for',
  classUsed: 'R',
  decide: async (eligible, need) => {
    const text = String(need.requestText || '').toLowerCase();
    if (!text) return null;
    const directive = /\b(?:use|using|with|via|ask|switch to|route to|try)\s+([a-z0-9][a-z0-9.\- ]{1,28})/g;
    const asked = [];
    for (const m of text.matchAll(directive)) asked.push(m[1].trim());
    if (!asked.length) return null;

    const hit = eligible.find((cand) => {
      const names = [cand.label, cand.model, cand.id].filter(Boolean).map((x) => String(x).toLowerCase());
      return asked.some((want) => names.some((n) => n.includes(want) || want.includes(n.split(' · ')[0])));
    });
    return hit || null;   // named something we do not have? say nothing and let the rest decide
  },
});

export function buildRouter(settings, resolveTarget) {
  return createModelRouter({
    models: candidatesFrom(settings, resolveTarget),
    middleware: [redactionStep],
    // Failover first: when something just declined, replacing it well matters more than the
    // general preference that picked it in the first place.
    // An explicit request outranks every heuristic — the user has answered the question the
    // router was about to guess at. Failover next, because a decline is newer information
    // than the original preference.
    strategies: [explicitModelStrategy, failoverStrategy, complexityStrategy],
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
export async function routeForTurn(settings, resolveTarget, { capabilities = [], force = false, request = null, structured = false, pageTools = false, exclude = [], like = null } = {}) {
  const cfg = routingSettings(settings);
  // `force` is the user having selected Auto, which is the ONLY thing that turns routing on.
  // A settings mode that could route an explicitly chosen model would override the user's own
  // selection — they picked it for a reason.
  if (!force) return null;
  try {
    const router = buildRouter(settings, resolveTarget);
    // One construction, shared with the observer — see needForTurn.
    const decision = await router.routeWith({
      ...needForTurn(settings, { capabilities, request, structured, pageTools }),
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

/**
 * The `need` for one turn, built ONCE.
 *
 * Two call sites were constructing this separately — the observer with bare defaults, the
 * applier with the saved dials, the request signals and the structured flag — so the two
 * disagreed and the log said "would route to Gemma4" about a turn OpenCode answered. Same
 * class of bug as the duplicated engine list: two implementations of one decision drift, and
 * the one nobody is watching is the one that goes wrong.
 */
export function needForTurn(settings, { capabilities = [], request = null, structured = false, pageTools = false, force = false } = {}) {
  const signals = request ? signalsFrom(request) : {};
  // REQUIREMENTS FIRST. What the work needs eliminates candidates; cost and speed only order
  // what survives. A preference lets an unsuitable model win once the better ones decline,
  // which is exactly how a chain of five ended on one that could not do the job.
  const req = requirementsFor(signals, { structured, pageTools, hasTools: capabilities.includes('tools') });
  return {
    // With no stated deadline or budget, "reasonably fast and reasonably cheap" is what
    // anybody means — and it only ever decides between models that already qualify.
    prefer: 'balanced',
    reach: 'any',
    capabilities: [...new Set([...capabilities, ...req.required])],
    minQuality: req.minQuality,
    // Which requirements may be given up if nothing qualifies — never `tools`, and never
    // reach. See requirementsFor.
    negotiable: req.negotiable,
    requirementReasons: req.why,
    signals,
    requestText: request ? String(request.text || (request.messages || []).map((m) => m?.content || '').join('\n')).slice(-2000) : '',
    structured,
    force,
  };
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
