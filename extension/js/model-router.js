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
  preferenceFor, failoverOrder, pinnedOrderOf,
} from './events/router.js';
import { routeGraph } from './events/route-graph.js';
import { classifySource, sourcePolicyFor, DEFAULT_INTERNAL_PATTERNS } from './events/sources.js';
import { healthOf } from './model-health.js';

/** Where a request must travel to reach this target — the only attribute privacy depends on. */
export function reachOf(target) {
  // A bridge agent runs a CLI on the user's own machine; the model behind it may still be
  // remote, which is why this says 'trusted' rather than 'device'. Claiming otherwise would
  // let a device-only request reach a cloud model through a local process.
  if (target.kind === 'bridge') return 'trusted';
  const url = String(target.baseUrl || target.url || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)) return 'device';
  // A .local or on-LAN host is the user's own machine or network — not a third party, but
  // not the device either. Same private-address rules as the source classifier, so
  // "internal" cannot mean one thing for a page and another for an endpoint.
  //
  // BUT THE FAIL-SAFE DIRECTION IS OPPOSITE HERE. classifySource fails CLOSED — an
  // unreadable URL counts as internal, because a source we cannot identify must not be sent
  // out. A DESTINATION we cannot identify is the reverse: calling it 'trusted' would admit
  // it to a restricted turn. So an unparseable endpoint is treated as the furthest reach.
  const c = classifySource(url);
  return c.internal && c.matched !== 'unparseable' ? 'trusted' : 'any';
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

// Inferred ranks sit ABOVE every number the settings UI can produce (it offers 1..N), so
// an order someone chose by hand always outranks one we guessed. Sharing the range meant
// picking "Order: 1" still lost to a local model we had silently rated 0 — the setting looked
// like the top priority and was not.
const INFERRED_RANK_FLOOR = 1000;

function providerRankOf(target, kind) {
  const hay = `${target.baseUrl || target.url || ''} ${target.name || ''} ${kind || target.kind || ''}`;
  for (let i = 0; i < PROVIDER_ORDER.length; i++) {
    if (PROVIDER_ORDER[i].test(hay)) return INFERRED_RANK_FLOOR + i * 10;
  }
  // Unrecognised: mid-table, so a provider we have no opinion on is not buried.
  return INFERRED_RANK_FLOOR + 50;
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
  // A CLI HARNESS IS NOT AN UNKNOWN MODEL, and the harness's NAME is not its model's name.
  //
  // Claude Code, Codex and the rest usually carry no `model` string — the CLI picks that
  // itself — and 'Claude Code' matches none of the tiers above, so every coding agent landed
  // on the "genuinely unknown" 0.5 below. requirementsFor puts a 0.55 quality floor on
  // complex, code and structured turns, so 0.5 meant a CLI coding agent was ELIMINATED from
  // precisely the tasks it exists for — rejected as "below the quality this task needs" while
  // the work went to an API model. A harness running a frontier model behind its own loop is
  // not the weakest thing configured.
  //
  // LAST, not first: an agent that names its model has told us something better than this
  // default, and overriding it would make a declared `opus` indistinguishable from a bare
  // harness — which is exactly the distance failover ranks by.
  if (target.kind === 'bridge') return 0.8;

  return 0.5;   // genuinely unknown: mid-table, so it is neither buried nor promoted
}

/** Rough relative cost — unitless, and only ever compared against its siblings. */
/**
 * Roughly how long this model takes, from the two things that actually decide it.
 *
 * This used to read WHERE a model runs and nothing else — every hosted model 700ms, every
 * local one 1500ms — so an 8B and a frontier model at the same provider were equally fast.
 * Asking the router for speed could therefore never find the small model, which is the one
 * thing "prefer latency" exists to do.
 *
 * SIZE IS THE OTHER HALF. A frontier model thinks for longer than an 8B wherever it runs,
 * and quality is the only size signal available here — it is already inferred from the
 * parameter count in the name (see qualityOf), and already correctable by the user, so
 * deriving from it keeps one number to fix rather than two.
 *
 * Still a guess, deliberately crude: this only has to ORDER models. Health can measure the
 * real thing later and override it per model, which is exactly why it is a plain field.
 */
function latencyOf(reach, quality) {
  // A local model is slower to first token than a hosted one far more often than not: no
  // warm pool, and usually a laptop rather than a datacentre.
  const base = reach === 'device' ? 1500 : 700;
  const q = Number.isFinite(quality) ? quality : 0.5;
  // 0.6 + q: an 8B (0.3) is ~0.9x the base, a frontier model (0.9) ~1.5x. A spread of under
  // two to one, because the difference is real but not the order of magnitude a bigger
  // coefficient would claim.
  return Math.round(base * (0.6 + q));
}

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
/**
 * A number the user actually SET, or null for "cleared — use what we inferred".
 *
 * CLEARING AN OVERRIDE WAS SETTING IT TO ZERO. The settings selects write `null` for their
 * "default" option, and the guard here was `Number.isFinite(Number(v))` — but `Number(null)`
 * is 0 and 0 is finite, so every cleared field became a real, extreme value. Picking
 * "Speed: default" made a model claim it answers in 0 ms; "Cost: default" made it free;
 * "Quality: default" made it worthless; and clearing Order pinned it at position 0, ahead of
 * everything, flagged as a deliberate choice.
 *
 * It stayed invisible while the balanced score multiplied cost by latency — every free model
 * scored 0 anyway. The moment a request could ask for SPEED, a model with a cleared speed
 * field beat everything that had a real one, and "hi" went to the most expensive model
 * configured. An unset field must read as unset.
 */
function numericOverride(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function applyOverride(inferred, override = {}) {
  if (!override || typeof override !== 'object') return inferred;
  const out = { ...inferred };
  const rank = numericOverride(override.providerRank);
  if (rank !== null) {
    out.providerRank = rank;
    // Flagged as chosen, not guessed: the router honours a hand-set order outright between
    // two routes to one model, and treats the order we inferred as a tie-break only.
    out.orderPinned = true;
  }
  if (Array.isArray(override.capabilities)) out.capabilities = [...override.capabilities];
  for (const key of ['costPer1k', 'latencyMs', 'quality']) {
    const n = numericOverride(override[key]);
    if (n !== null) out[key] = n;
  }
  if (typeof override.available === 'boolean') out.available = override.available;
  if (override.reach && REACH_RANK[override.reach] > REACH_RANK[inferred.reach]) {
    // Outward only. See the note above.
    out.reach = override.reach;
  }
  return out;
}

const REACH_RANK = { device: 0, trusted: 1, any: 2 };
const REACH_STEPS = ['device', 'trusted', 'any'];

/**
 * The reach values a user may declare for a model we detected as `detected`.
 *
 * The rule and the CONTROL that offers it have to come from one place. They did not: the
 * settings page built its options by slicing from the model's CURRENT reach, which is the
 * value after the override has been applied — so saving 'any' left 'any' as the only option
 * and the correction could never be taken back. Enforcing outward-only in applyOverride while
 * a second copy of the rule decided what to offer is what turned a safety rule into a
 * one-way door.
 *
 * Always includes `detected` itself: coming back to what we detected is not moving inward, it
 * is dropping the override. Anything closer in than the detection is never offered, because
 * applyOverride would refuse it and a control that silently discards half its own values is
 * worse than no control.
 */
export function reachChoicesFor(detected) {
  const i = REACH_STEPS.indexOf(detected);
  return i < 0 ? [...REACH_STEPS] : REACH_STEPS.slice(i);
}

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
    // NEVER A GENERATED ID. 'mqr0ifmw7sqxr7' appeared as the answer to "which model did this"
    // in a real log — falling back to the id was the same as having no label at all. A bridge
    // agent the user never renamed still knows which CLI it runs, and that is readable.
    const label = [t.name, t.model && t.model !== t.name ? t.model : null]
      .filter(Boolean).join(' · ')
      || [t.bridgeAgent, t.model].filter(Boolean).join(' · ')
      || t.kind
      || String(id);
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
      latencyMs: latencyOf(reach, qualityOf(t)),
      quality: qualityOf(t),
      providerRank: providerRankOf(t, kind),
      available: t.enabled !== false,
    };
    // Behaviour beats configuration. A model whose credits ran out is configured perfectly
    // and cannot answer; routing to it because its config still looks good is what a user
    // experiences as "it keeps picking the broken one".
    const configured = applyOverride(inferred, overrides[id]);
    // AN EXPLICIT DISABLE OUTRANKS A TUNING OVERRIDE. `enabled: false` is the user saying,
    // right now, "don't use this"; a routing override is a hint saved earlier. A stale
    // `available: true` in that hint was winning, so an agent switched off in Settings still
    // showed as a live routing candidate with no sign it was off. Re-assert it last.
    if (t.enabled === false) configured.available = false;
    // A CORRECTED QUALITY CORRECTS THE SPEED DERIVED FROM IT. Latency is inferred from size
    // (see latencyOf), so a user who tells us a model is stronger than we guessed was leaving
    // behind a latency computed from the guess — the two numbers described different models.
    // Unless they set the speed themselves, in which case theirs is the answer.
    if (numericOverride(overrides[id]?.latencyMs) === null) configured.latencyMs = latencyOf(reach, configured.quality);
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
    // ASKED FOR NOTHING, ESCALATES TO NOTHING. This fired on 'hello' because the caller was
    // passing `structured: structured || pageTools`, so every turn on a page with actions
    // armed looked like exact structured work. Equipment is not demand — the same conflation
    // that put a quality floor on a greeting, in a second place.
    if (sig?.smalltalk) return null;
    // NOR DOES BACKGROUND WORK ESCALATE. Dropping the quality floor for a topic pass and then
    // letting escalation rank by quality anyway would move the same decision one step down
    // and change nothing — the floor eliminated the local models, this would simply rank them
    // last. Both read 'high' from the size of the material rather than the difficulty of the
    // ask, so both have to abstain.
    if (need.background) return null;
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
    // Rank by declared quality — the axis this strategy exists to judge — then by the ORDER
    // the user set, and only then by cost. A model with an unknown quality sits mid-table
    // rather than last, so a newly added model is not permanently skipped.
    //
    // ORDER BEFORE COST, and this is the fix for a real complaint: three CLI agents of
    // identical quality, one of them pinned to Order 1, and escalation picked a different one
    // because it is cheaper per 1k. A hand-set order is a statement — they can see the prices
    // and chose anyway — and it was being honoured in the score path and nowhere else, so
    // the moment any strategy had an opinion the user's own preference stopped existing.
    //
    // Still only a TIE-BREAK: quality decides first, so a genuinely better model beats the
    // pinned one, and an INFERRED order stays below cost where a guess belongs.
    const q = (m) => (Number.isFinite(m.quality) ? m.quality : 0.5);
    return [...shortlist].sort((a, b) => q(b) - q(a)
      || pinnedOrderOf(a) - pinnedOrderOf(b) || a.costPer1k - b.costPer1k);
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
    // THE ORDERING ITSELF LIVES IN @chatpanel/events, because two things need it: this
    // strategy, and the projected chain the trace draws before any of it happens. A picture
    // computed by a second implementation would eventually disagree with the real failover,
    // and one that lies about what the router will do is worse than no picture. The strategy
    // is the thin part — knowing there IS something to replace.
    return failoverOrder(eligible, failed);
  },
});

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

    const matches = eligible.filter((cand) => {
      const names = [cand.label, cand.model, cand.id].filter(Boolean).map((x) => String(x).toLowerCase());
      return asked.some((want) => names.some((n) => n.includes(want) || want.includes(n.split(' · ')[0])));
    });
    if (!matches.length) return null;   // named something we do not have? say nothing and let the rest decide
    // WHICH ONE, when the name matches several. This took the FIRST match in score order, so
    // "use claude" on a setup with three Claude routes picked whichever happened to score
    // best — a cost-and-latency guess deciding a question the user had already answered
    // twice: once by naming the model, and once by ordering the routes to it.
    //
    // Returned as a LIST rather than a single model, so the ones that also matched become the
    // runners-up: if the first declines, failover replaces it with another route to the model
    // that was actually asked for.
    return [...matches].sort((a, b) => pinnedOrderOf(a) - pinnedOrderOf(b));
  },
});

// Ordered deliberately: an explicit request outranks every heuristic, because the user has
// answered the question the router was about to guess at. Failover next — a decline is newer
// information than the preference that made the original choice. Escalation is the general
// case.
export const ROUTE_STRATEGIES = [explicitModelStrategy, failoverStrategy, complexityStrategy];
export const ROUTE_MIDDLEWARE = [redactionStep];

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
  const signals = request ? signalsFrom(request) : {};
  // REQUIREMENTS FIRST. What the work needs eliminates candidates; cost and speed only order
  // what survives. A preference lets an unsuitable model win once the better ones decline,
  // which is exactly how a chain of five ended on one that could not do the job.
  const req = requirementsFor(signals, { structured, pageTools, hasTools: capabilities.includes('tools'), background });
  // WHERE IT CAME FROM IS A CEILING, NOT A PREFERENCE. Routing asked what the work needed and
  // never asked what it was about, so an internal page was summarised by a public inference
  // host. This narrows reach and can only narrow it — reach is never relaxed (see the
  // relaxation order in the router), so no later step can trade it away for capability.
  const guard = sourceGuardFor(settings, sources);
  // WHICH AXIS THIS REQUEST CARES ABOUT, read from the request rather than fixed at
  // 'balanced' for everything. A greeting means fast — no answer to "hi" is improved by a
  // frontier model thinking about it. A refactor means good — three seconds saved on an
  // answer that has to be redone is not a saving. It only ever ORDERS what already
  // qualifies; `req` above is what eliminates.
  const pref = preferenceFor(signals, {
    structured,
    minQuality: req.minQuality,
    // The same fact requirementsFor was given: a turn carrying tools is one that might use
    // them, so it is never "answer fast at any quality".
    hasTools: capabilities.includes('tools'),
    background,
  });
  return {
    prefer: pref.prefer,
    reach: guard ? guard.reach : 'any',
    capabilities: [...new Set([...capabilities, ...req.required])],
    minQuality: req.minQuality,
    // Which requirements may be given up if nothing qualifies — never `tools`, and never
    // reach. See requirementsFor.
    negotiable: req.negotiable,
    requirementReasons: [...(guard ? [...req.why, guard.why] : req.why), pref.why],
    sourceGuard: guard,
    signals,
    requestText: request ? String(request.text || (request.messages || []).map((m) => m?.content || '').join('\n')).slice(-2000) : '',
    structured,
    force,
    background,
  };
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
