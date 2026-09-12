// GENERATED — do not edit.
// Source of truth: chatpanel-events/route-strategies.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// HOW A MODEL IS CHOSEN — the strategies and the one step that is never optional.
//
// The routing CONTRACT (createModelRouter, signals, requirements, failover order) has lived
// in this package since it was written; the DECISIONS layered on it — escalate hard work,
// replace like with like, honour "use claude" — were typed in the extension, so the desktop
// was about to copy them. They are pure functions of the candidates and the need, so they
// belong here, and both clients build the same router from the same declarations.
//
// `needForTurn` builds the need from the turn's facts. The source guard (which page or
// record the turn is about, and what that caps reach at) is INJECTED as `guard`, because
// reading it means reading a client's settings; the ceiling itself is enforced here.

import {
  defineMiddleware, defineRouteStrategy, signalsFrom, requirementsFor, preferenceFor,
  failoverOrder, pinnedOrderOf,
} from './router.js';

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

export function needForTurn({ capabilities = [], request = null, structured = false, pageTools = false, force = false, background = false, guard = null } = {}) {
  const signals = request ? signalsFrom(request) : {};
  // REQUIREMENTS FIRST. What the work needs eliminates candidates; cost and speed only order
  // what survives. A preference lets an unsuitable model win once the better ones decline,
  // which is exactly how a chain of five ended on one that could not do the job.
  const req = requirementsFor(signals, { structured, pageTools, hasTools: capabilities.includes('tools'), background });
  // WHERE IT CAME FROM IS A CEILING, NOT A PREFERENCE. Routing asked what the work needed and
  // never asked what it was about, so an internal page was summarised by a public inference
  // host. This narrows reach and can only narrow it — reach is never relaxed (see the
  // relaxation order in the router), so no later step can trade it away for capability.
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
