// GENERATED — do not edit.
// Source of truth: chatpanel-events/router.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The model router — which model answers, and what happens to the request on the way.
//
// Two things that look separate and are not. WHERE a request goes decides what may happen
// to it (a local model needs no redaction; a third-party one does), and what happens to it
// decides where it may go (a redacted request is safe somewhere the raw one is not). Wiring
// them separately is how a request reaches a cloud model with the redaction step skipped,
// which is the single worst bug this codebase could have.
//
// So routing and composition are one object, and the ordering guarantee is STRUCTURAL:
// every request passes through the same pipeline, and egress happens at a point the
// pipeline defines rather than wherever a caller remembered to put it.
//
// ROUTING IS CLASS R. A rule picks the model — declared attributes in, a decision plus its
// reasons out. Deterministic, instant, free, and explainable. Asking a language model which
// language model to use would be slower, cost tokens, and produce an answer nobody can
// check.
//
// HARD CONSTRAINTS ARE NOT SCORES. Privacy and capability eliminate candidates; latency,
// cost and load only order the survivors. A privacy requirement that could be outweighed by
// a cheap model is not a requirement — and "cheapest wins" is exactly the pressure that
// would erode it.

export class RouterError extends Error {
  constructor(code, message) { super(message); this.name = 'RouterError'; this.code = code; }
}

/** Where a request may go. Ordered: each level permits everything below it. */
export const REACH = Object.freeze(['device', 'trusted', 'any']);

const reachRank = (r) => Math.max(0, REACH.indexOf(r));

/**
 * Declare a model a request can be routed to.
 *
 * @param reach   the furthest a request may travel to reach it: 'device' (never leaves),
 *                'trusted' (the user's own server or gateway), 'any' (a third party).
 * @param classUsed R/M/L/C/A per the execution classes — what guarantee it offers.
 * @param capabilities what it can do: 'tools', 'vision', 'json', 'long-context'…
 * @param costPer1k  relative cost. Unitless on purpose: the router compares candidates, it
 *                does not bill anyone, and a fake precision here would invite trusting it.
 * @param latencyMs typical time to first token.
 * @param load     0..1, how busy it is right now — supplied by the host, not remembered
 *                here, because a router that cached load would be routing on stale facts.
 */
export function defineModel({
  id, label, reach = 'any', classUsed = 'C', capabilities = [],
  costPer1k = 1, latencyMs = 1000, load = 0, available = true,
  rateLimited = false, observedLatencyMs = null, quality = null, model = '', providerRank = 50, orderPinned = false,
}) {
  if (!id) throw new RouterError('BAD_MODEL', 'model.id required');
  if (!REACH.includes(reach)) throw new RouterError('BAD_MODEL', `model '${id}': unknown reach '${reach}'`);
  return Object.freeze({
    id, label: label || id, reach, classUsed,
    // The underlying model name, so the same model at a different provider is recognisable
    // as the closest possible replacement when one of them declines.
    model,
    capabilities: [...capabilities], costPer1k,
    // MEASURED BEATS DECLARED. A latency someone typed into a config is a guess about a
    // service that changes hourly; a latency we recorded is what it actually did. The
    // declared number stays as the fallback for a model we have never called.
    latencyMs: Number.isFinite(observedLatencyMs) ? observedLatencyMs : latencyMs,
    declaredLatencyMs: latencyMs,
    observedLatencyMs,
    load, available, rateLimited,
    // Which provider to prefer when two of them offer the same thing. Lower wins. Ties were
    // breaking alphabetically, which is not a preference — it is the absence of one, and it
    // sent every equal choice to whichever provider happened to sort first.
    providerRank,
    // Did a PERSON set that order, or did we guess it? Our guess must not overrule a real
    // difference in cost or speed — a stated preference must. Without this distinction the
    // provider ranking we inferred from a URL would quietly outrank a route that is genuinely
    // cheaper, and the user would never see why.
    orderPinned: Boolean(orderPinned),
    // 0..1 benchmark or observed success, when the host has one. Null means unknown, which
    // is different from bad — and scoring an unknown as zero would bury every new model.
    quality,
  });
}

/**
 * A step in the pipeline every request passes through.
 *
 * @param stage 'request'  — before the model is called (redaction, trimming, tool selection)
 *              'response' — after it answers (restoring placeholders, citations)
 * @param priority lower runs first on the request and LAST on the response, so a step that
 *              wraps something unwraps it symmetrically. Getting this backwards is how a
 *              vault gets restored before the text it protects comes back.
 */
export function defineMiddleware({ id, label, stage, priority = 100, run, requiredFor = null }) {
  if (!id) throw new RouterError('BAD_MIDDLEWARE', 'middleware.id required');
  if (!['request', 'response'].includes(stage)) throw new RouterError('BAD_MIDDLEWARE', `middleware '${id}': stage must be request or response`);
  if (typeof run !== 'function') throw new RouterError('BAD_MIDDLEWARE', `middleware '${id}': run required`);
  return Object.freeze({ id, label: label || id, stage, priority, run, requiredFor });
}

/**
 * A way of CHOOSING among candidates — itself a plugin.
 *
 * Scoring by latency and cost is one strategy, not the only defensible one. A small
 * classifier could route by task type; a learned model could route by what has worked
 * before; a user could pin a model for a project. Hard-coding one of those would make the
 * others a rewrite.
 *
 * THE INVARIANT THAT SURVIVES ANY STRATEGY: a strategy may REORDER or NARROW the eligible
 * set. It can never widen it. Hard constraints — reach and capability — are applied before
 * any strategy runs, so no clever router, learned or otherwise, can send a device-only
 * request to a third party. That is why the constraints are not scores: a score is
 * something a strategy could outweigh.
 *
 * @param classUsed what the strategy costs to run. 'R' is a rule, 'M' a small local model.
 *        Declared, because a router that quietly spends tokens to save tokens should be
 *        visible in the log as exactly that.
 * @param decide async (eligible, need, ctx) => ordered candidates, a single candidate, or
 *        null to abstain. Abstaining is normal — a strategy with no opinion should say so
 *        rather than guess.
 */
export function defineRouteStrategy({ id, label, classUsed = 'R', timeoutMs = 0, decide }) {
  if (!id) throw new RouterError('BAD_STRATEGY', 'strategy.id required');
  if (typeof decide !== 'function') throw new RouterError('BAD_STRATEGY', `strategy '${id}': decide required`);
  return Object.freeze({ id, label: label || id, classUsed, timeoutMs, decide });
}

/**
 * Cheap, deterministic signals read straight off the request — the bottom rung of the
 * escalation ladder.
 *
 * Task complexity, modality, volume and language are all things a rule can estimate in
 * microseconds. Sending a request to a classifier to discover it contains an image, or is
 * four hundred tokens long, would spend a model call to learn something already visible.
 * Escalation earns its cost only above whatever this can answer.
 *
 * Every value is a HINT, and named as one. A heuristic presented as a fact is how a
 * mis-detected language quietly routes someone to the wrong model forever.
 */
// How close two scores must be before they count as the same. Latency and cost are
// ESTIMATES; a gap smaller than this says nothing real, so the user's Order decides instead.
const TIE_BAND = 0.10;

// The exchange rate the balanced trade runs on: how many seconds of waiting one unit of
// cost (per 1k tokens) is worth. Adding raw seconds to raw cost would set this to 1 —
// "a second is worth a dollar" — and that is not a decision anyone made, it is the accident
// of two numbers sharing an addition. At 5, a free model on the user's own machine is not
// outbid by a paid one merely for being nearer: no quota, no outage and no third party are
// worth a few seconds, which is the same reasoning the provider order already encodes.
const SECONDS_PER_UNIT_COST = 5;

/**
 * The model name stripped of provider prefix and tag, so the SAME model matches across hosts:
 * `deepseek-ai/DeepSeek-V4-Flash` and `deepseek/deepseek-v4-flash` are one model reached two
 * ways. Both the scorer and failover need this identity, so it belongs to the contract rather
 * than to whichever client asked first.
 */
export function sameModelKey(m) {
  return String(m?.model || m?.label || '')
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/[:@].*$/, '')
    .replace(/[^a-z0-9.]+/g, '');
}

export function signalsFrom(request = {}) {
  const text = String(request.text || (request.messages || []).map((m) => m?.content || '').join('\n') || '');
  const chars = text.length;
  const hasImage = !!(request.images?.length || request.attachments?.some?.((a) => /^image\//.test(a?.type || '')));
  const hasAudio = !!request.audio || !!request.attachments?.some?.((a) => /^audio\//.test(a?.type || ''));
  return {
    // ~4 chars per token, the same rule the dispatcher budget uses. Consistency matters more
    // than accuracy here: two different estimates of "how big is this" is worse than one
    // rough one.
    approxTokens: Math.round(chars / 4),
    modality: hasAudio ? 'audio' : (hasImage ? 'vision' : 'text'),
    // Complexity, from what actually distinguishes a hard request from a simple one at zero
    // cost: length, code, and explicit multi-step language.
    // A keyword in a twenty-character message is not a complex request. "refactor this
    // please" is a sentence, not a project — so keywords only raise complexity once there is
    // enough text for them to be describing something. A code fence is the exception: it
    // carries the work itself, whatever its length.
    // Code is its own signal, not merely a complexity hint: it decides whether the coding
    // capability is required at all.
    //
    // A FENCE IS UNAMBIGUOUS at any length — "```js\nfunction f(){}\n```" is code however
    // short. The keyword heuristics are not, so those need enough surrounding text to be
    // describing code rather than mentioning it: prose can say "import" or end a line with a
    // semicolon without being a programming task.
    code: /```/.test(text)
      || (chars > 80 && /\bfunction\b|\bclass\b|=>|;\s*$|\bdef\b|\bimport\b|\bconst\b/m.test(text)),
    complexity: (chars > 4000 || /```/.test(text)
      || (chars >= 200 && /\bstep by step\b|\bplan\b|\brefactor\b|\bmigrate\b|\banalyse|\banalyze/i.test(text)))
      ? 'high'
      : (chars < 200 ? 'low' : 'medium'),
    // Non-Latin script is the one language signal a rule can read reliably. Anything finer
    // is a guess, so it is not offered.
    nonLatin: /[^\u0000-\u024F\u2000-\u206F]/.test(text),
    // ASKS FOR NOTHING. "hello" and "what can you help with" are conversation, not work —
    // and the equipment a turn happens to carry must not make them expensive.
    //
    // Detected by what is ABSENT rather than by matching greetings: a greeting list fails on
    // the first typo ("what can yo uhelp with" is still small talk), while the absence of any
    // action verb and of any reference to the user's own data is robust to spelling. 'my',
    // 'this page' and 'here' count as references, so "whats my longest streak" is work — it
    // needs the page — even though it is shorter than most greetings.
    // `summar` and `analy` carry an explicit \w* because the alternation ends in \b: written
    // bare, they demanded a word boundary immediately after the prefix, so "summarize this
    // document" matched nothing and was classified as SMALL TALK. A prefix that can never
    // fire is worse than an absent one — it reads as covered.
    smalltalk: chars < 100 && !/```/.test(text)
      && !/\b(draw|click|open|fill|read|find|search|edit|write|create|update|delete|run|fix|change|add|remove|select|scroll|extract|summar\w*|analy\w*|check|review|list|show|go to|navigate|my|mine|this page|here|it|that)\b/i.test(text),
    chars,
  };
}

/**
 * What a request REQUIRES, derived from what it is.
 *
 * The escalation strategy only ever expressed a preference, so a drawing task that needed
 * exact coordinates and a structured payload was allowed to consider an 8B instant model —
 * it merely ranked lower, and ranked lower still wins when the better ones decline. A
 * requirement eliminates; a preference does not, and the difference is the whole reason the
 * chain kept reaching models that could not do the job.
 *
 * Requirements first, then cost and speed among whatever survives. Nothing here is a
 * judgement call a model needs to make — length, code fences, images and adapter tools are
 * all readable for free, which is what makes this class R and instant.
 */
export function requirementsFor(signals = {}, { structured = false, hasTools = false, pageTools = false, background = false } = {}) {
  const required = new Set();
  let minQuality = 0;
  const why = [];

  if (hasTools) { required.add('tools'); why.push('the turn carries tools'); }
  if (signals.modality === 'vision') { required.add('vision'); why.push('the request includes an image'); }
  // DRIVING A PAGE NEEDS TOOLS AND JUDGEMENT — vision only for the steps that look.
  //
  // Requiring vision for the whole turn would rule out a strong reasoning model that would
  // drive the page well and only needs to see a screenshot occasionally. The step that reads
  // an image is one call in a loop, not the character of the whole task, and per-STEP
  // requirements (see requirementsForStep) are where that belongs.
  // EQUIPMENT IS NOT DEMAND. `pageTools` and `structured` say what the turn CARRIES, not what
  // it was asked for — so with page actions switched on, every message got a quality floor
  // and "hello" was routed to a CLI coding agent. What a floor should come from is the
  // request; a turn that asks for nothing needs nothing.
  //
  // The tools stay armed and stay required for anything that is not small talk, so a follow-up
  // that does need the page is unaffected — and once per-step routing lands, the step that
  // actually acts on the page carries its own requirements anyway.
  if (pageTools && !signals.smalltalk) {
    required.add('tools');
    minQuality = Math.max(minQuality, 0.55);
    why.push('driving a page needs exact actions');
  }
  if (signals.approxTokens > 20_000) { required.add('long-context'); why.push('the request is large'); }
  if (signals.code) { required.add('coding'); why.push('the request contains code'); }

  // Structured work — a canvas, a spreadsheet — is exact. A model that fumbles coordinates
  // produces something visibly wrong rather than merely worse, so this sets a FLOOR rather
  // than a preference.
  if (structured && !signals.smalltalk) {
    required.add('tools');
    minQuality = Math.max(minQuality, 0.55);
    why.push('it must produce an exact structured payload');
  }
  // LENGTH IS NOT DIFFICULTY WHEN THE LENGTH IS THE MATERIAL.
  //
  // Complexity is read from the whole prompt, which is right for a chat turn — a long message
  // usually is a harder request. It is backwards for BACKGROUND extraction: the topic pass
  // inlines an entire transcript, so a conversation carrying one pasted dashboard produced a
  // 6,300-character prompt, read as 'high', and a quality floor that eliminated every local
  // model. The one call that should always be cheap got more expensive the more material
  // there was to chew through.
  //
  // Needing to FIT is a separate requirement and is still applied above (long-context).
  // What is dropped here is only the quality FLOOR, and only for work nobody is waiting on.
  if (signals.complexity === 'high' && !background) {
    minQuality = Math.max(minQuality, 0.55);
    why.push('the task is complex');
  }

  // Which of these can be given up if nothing qualifies, and which cannot.
  //
  // `tools` is not negotiable: a turn that carries tools cannot be done by a model that
  // cannot call them, so relaxing it would produce an answer that ignores half the request.
  // The others are strong preferences dressed as requirements — a text-only model CAN drive
  // a page badly, and badly beats not at all.
  // `tools` is normally non-negotiable — but nothing is going to be called for small talk,
  // so insisting on it there would eliminate a perfectly good model over a capability the
  // turn will not use.
  const negotiable = signals.smalltalk ? [...required] : [...required].filter((c) => c !== 'tools');
  return { required: [...required], negotiable, minQuality, why };
}

/**
 * WHICH AXIS THIS REQUEST CARES ABOUT — quality, speed, or the trade between them.
 *
 * `prefer` was hardcoded to 'balanced' for every turn, on the reasoning that "reasonably
 * fast and reasonably cheap is what anybody means". It is not. A greeting means fast: no
 * answer to "hi" is improved by a frontier model thinking about it, and waiting is the only
 * thing the user can perceive. A refactor across five files means good: saving three seconds
 * on an answer that has to be redone is not a saving. The axis that matters is a property of
 * the REQUEST, and it is readable for free from the same signals everything else here uses.
 *
 * Requirements still come first and are unaffected — this only ORDERS what already qualifies.
 * That is what makes 'latency' safe to mean literally the fastest model: a task with a
 * quality floor has already eliminated everything below it, so "fastest" can only ever pick
 * the fastest model that was good enough.
 *
 * Class R: length, code fences, images. No model call.
 */
export function preferenceFor(signals = {}, { structured = false, minQuality = 0, hasTools = false, background = false } = {}) {
  // NOBODY IS WAITING, AND NOBODY IS READING IT. A title, a topic pass, a grammar fix: work
  // the user did not ask for, whose output is a short structured artifact, and which has a
  // deterministic fallback when the model declines. The honest axis for that is what it
  // costs — and it comes first, because such a pass reads as 'high' complexity purely from
  // the size of the material it was handed.
  if (background) return { prefer: 'cost', why: 'background work — spend as little as possible' };
  // EXACTNESS AND DIFFICULTY BUY QUALITY. A structured payload is visibly wrong when it is
  // wrong, and a complex task redone is slower than a slow task done once.
  if (structured || signals.complexity === 'high' || signals.code || signals.modality === 'vision') {
    return { prefer: 'quality', why: 'the task is exact or hard — get it right rather than quick' };
  }
  // NOTHING TO GET RIGHT MEANS GET IT BACK — but only when the turn genuinely asks for
  // nothing, and `smalltalk` alone is too generous to decide that. It calls "what did we
  // decide in the standup" trivial, and answering THAT on an 8B instant model to save half a
  // second is the same mistake as the greeting on a frontier model, pointing the other way.
  //
  // So the turn must ALSO be carrying no tools. That is not a second guess at triviality: it
  // is the answer toolNeedFor already gave, from a much narrower test, and a turn armed with
  // the means to look something up is by definition one that might. Composing the two beats
  // restating either.
  if (signals.smalltalk && !hasTools && !minQuality) {
    return { prefer: 'latency', why: 'nothing to look up — answer fast' };
  }
  return { prefer: 'balanced', why: 'no reason to favour speed or quality' };
}

/**
 * The order to try replacements in when a model declines — CLOSEST FIRST, in both directions.
 *
 * Lives here rather than in the strategy that calls it because two things need this answer:
 * the failover itself, and anything that wants to SHOW the chain before it happens. A
 * projected chain computed by a second implementation would eventually disagree with the real
 * one, and a picture that lies about what the router will do is worse than no picture.
 *
 * Ranking by absolute quality made failover a one-way escalator and was wrong at both ends
 * at once: a greeting on an 8B that declined climbed to a frontier model, and a frontier model
 * that declined dropped to an 8B. The task did not get easier when the provider said no, and
 * it did not get harder when a small one did.
 *
 * So the ordering is DISTANCE from what failed. Quality distance is the spine; being a
 * different KIND of thing (an API model answers a request, a CLI agent runs its own loop) and
 * missing a capability the failed model had are each additional distance rather than separate
 * tiers — a tier ordering let "same class" outrank a two-tier quality drop, which is exactly
 * how the frontier-to-8B hop happened.
 *
 * Nothing is ELIMINATED. A distant model still beats no answer, so the last hop of a long
 * chain is allowed to be a poor match; this decides order, never eligibility.
 *
 * @param failed { model, quality, capabilities, classUsed, reason } — the model that declined.
 *        `reason: 'gone'` means the MODEL is retired rather than the provider saying no, so
 *        the same name elsewhere is equally dead and is dropped instead of preferred.
 */
/**
 * The position the user CHOSE, or Infinity when we only guessed one.
 *
 * A hand-set Order was honoured in the score path and ignored everywhere else, so the moment
 * any strategy had an opinion the user's stated preference stopped existing: three models of
 * identical quality, one of them pinned to Order 1, and escalation picked a different one
 * because it costs less per 1k. The reasoning already written for the score path applies
 * verbatim here — they can see the prices and chose anyway.
 *
 * Strictly a TIE-BREAK, and only for pinned orders. It never outranks the axis a strategy
 * exists to judge: a genuinely better model still wins, and an order we inferred from a URL
 * stays below cost where it belongs.
 */
export function pinnedOrderOf(m) {
  return m?.orderPinned && Number.isFinite(m.providerRank) ? m.providerRank : Infinity;
}

export const FAILOVER_CLASS_GAP = 0.25;
export const FAILOVER_CAPABILITY_GAP = 0.25;

export function failoverOrder(candidates = [], failed = {}) {
  const sameModel = (m) => !!failed.model && sameModelKey(m) === sameModelKey(failed);
  // A RETIRED MODEL IS RETIRED EVERYWHERE. "Same model at another provider" is the ideal
  // replacement when the provider declined — out of credits, rate limited — and the worst
  // possible one when the model is gone: deepseek-v4-flash reaching end of life on one host
  // means the identical name on another is equally dead, so preferring it walks into the
  // same wall.
  let pool = [...candidates];
  if (failed.reason === 'gone') {
    const alive = pool.filter((m) => !sameModel(m));
    if (alive.length) pool = alive;
  }
  const q = (m) => (Number.isFinite(m.quality) ? m.quality : 0.5);
  const covers = (m) => (failed.capabilities || []).every((c) => (m.capabilities || []).includes(c));
  const sameClass = (m) => !failed.classUsed || m.classUsed === failed.classUsed;
  const qf = Number.isFinite(failed.quality) ? failed.quality : null;

  if (qf !== null) {
    // The same model elsewhere is distance zero by definition: identical capability, merely a
    // different bill.
    const distance = (m) => (sameModel(m) ? -1 : Math.abs(q(m) - qf)
      + (sameClass(m) ? 0 : FAILOVER_CLASS_GAP)
      + (covers(m) ? 0 : FAILOVER_CAPABILITY_GAP));
    return pool
      .map((m) => ({ m, d: distance(m) }))
      .sort((a, b) => a.d - b.d
        || pinnedOrderOf(a.m) - pinnedOrderOf(b.m)
        || a.m.costPer1k - b.m.costPer1k
        || String(a.m.id).localeCompare(String(b.m.id)))
      .map((x) => x.m);
  }

  // WITHOUT A QUALITY TO BE CLOSE TO, closeness is not a question that can be asked — so fall
  // back to tiers, which at least keep like with like. A caller inside ChatPanel always knows
  // the quality of the model it just called; an external one describing a failure it did not
  // route may not.
  const rank = (m) => {
    if (sameModel(m)) return 0;
    if (sameClass(m) && covers(m)) return 1;
    if (sameClass(m)) return 2;
    if (covers(m)) return 3;   // capable but a different kind of thing
    return 4;
  };
  return pool.sort((a, b) => rank(a) - rank(b) || q(b) - q(a)
    || pinnedOrderOf(a) - pinnedOrderOf(b) || a.costPer1k - b.costPer1k);
}

/**
 * What ONE step needs — the unit routing should eventually work at.
 *
 * A turn is a chain of sub-tasks with different demands: read the canvas (structure), decide
 * what to draw (reasoning), look at the result (vision), write it (structure again).
 * Choosing one model for all of them means either paying frontier prices to run a loop or
 * doing the hard parts with something that cannot. The honest unit is the step.
 *
 * This is the contract; the loop that acts on it is separate work. Exposed now so a caller
 * can already ask "what does this call need" rather than inferring it from the turn — and so
 * the answer lives in one place when the loop is ready to use it.
 */
export function requirementsForStep(toolName, args = {}) {
  const name = String(toolName || '');
  const action = String(args?.action || '');
  const both = `${name}.${action}`;

  // Looking at pixels — the only steps that genuinely need vision.
  if (/screenshot|marked_screenshot|read_canvas|sense_canvas/.test(both)) {
    return { required: ['vision'], why: 'this step reads an image' };
  }
  // Producing an exact payload: structure matters, sight does not.
  if (/structured_insert|sheet_write|fill_form|input_sequence|draw_path/.test(both)) {
    return { required: ['tools'], minQuality: 0.55, why: 'this step writes an exact payload' };
  }
  // Everything else is ordinary tool use.
  return { required: name ? ['tools'] : [], why: '' };
}

export function createModelRouter({ models = [], middleware = [], strategies = [], admit = null } = {}) {
  const registry = [...models];
  const chain = [...middleware];
  const plans = [...strategies];

  /** Order once: request steps ascending, response steps descending — see defineMiddleware. */
  const stepsFor = (stage) => chain
    .filter((m) => m.stage === stage && (!admit || admit(m)))
    .sort((a, b) => (stage === 'request' ? a.priority - b.priority : b.priority - a.priority));

  return {
    addModel(m) { registry.push(m); return () => { const i = registry.indexOf(m); if (i >= 0) registry.splice(i, 1); }; },
    use(m) { chain.push(m); return () => { const i = chain.indexOf(m); if (i >= 0) chain.splice(i, 1); }; },
    addStrategy(s) { plans.push(s); return () => { const i = plans.indexOf(s); if (i >= 0) plans.splice(i, 1); }; },
    models: () => [...registry],
    middleware: () => [...chain],
    strategies: () => [...plans],

    /**
     * Choose a model. Returns the decision AND why every rejected candidate lost, because
     * "it used the wrong model" is unanswerable otherwise.
     *
     * @param need { reach, capabilities, prefer } — `prefer` is 'latency' | 'cost' |
     *        'balanced'. Preference orders survivors; it never revives a rejected one.
     */
    route(need = {}) {
      const wantReach = REACH.includes(need.reach) ? need.reach : 'any';
      const wantCaps = need.capabilities || [];
      const rejected = [];
      const eligible = registry.filter((m) => {
        if (!m.available) { rejected.push({ id: m.id, why: 'unavailable' }); return false; }
        if (admit && !admit(m)) { rejected.push({ id: m.id, why: 'disabled' }); return false; }
        // PRIVACY IS A CEILING, NOT A PREFERENCE. A request allowed only on-device can never
        // be routed to a third party, however cheap or fast that party is.
        if (reachRank(m.reach) > reachRank(wantReach)) { rejected.push({ id: m.id, why: `reach '${m.reach}' exceeds '${wantReach}'` }); return false; }
        const missing = wantCaps.filter((c) => !m.capabilities.includes(c));
        if (missing.length) { rejected.push({ id: m.id, why: `missing ${missing.join(', ')}` }); return false; }
        // A DEADLINE AND A BUDGET ELIMINATE, they do not discount.
        //
        // "Answer within 800ms" and "spend at most this" are requirements in the same sense
        // privacy is: a model that cannot meet them has not merely scored badly, it cannot do
        // the job. Treating them as weights is how a live voice reply ends up routed to the
        // cheapest model that takes four seconds.
        if (need.maxLatencyMs > 0 && m.latencyMs > need.maxLatencyMs) {
          rejected.push({ id: m.id, why: `${m.latencyMs}ms exceeds the ${need.maxLatencyMs}ms deadline` });
          return false;
        }
        if (need.maxCostPer1k >= 0 && need.maxCostPer1k !== undefined && m.costPer1k > need.maxCostPer1k) {
          rejected.push({ id: m.id, why: `costs ${m.costPer1k} over the ${need.maxCostPer1k} budget` });
          return false;
        }
        // A model that is rate-limited right now is unavailable right now. Ranking it lower
        // would still let it win when it is the only one left, and then fail.
        if (m.rateLimited) { rejected.push({ id: m.id, why: 'rate limited' }); return false; }
        // A model that already failed this request is not a candidate for it. Without this,
        // failover re-picks the model that just returned 402 and the retry is a loop.
        if (need.exclude?.includes?.(m.id)) { rejected.push({ id: m.id, why: 'already failed this request' }); return false; }
        // A QUALITY FLOOR IS A REQUIREMENT, not a ranking. A model that fumbles exact
        // coordinates produces something visibly wrong rather than merely worse — and a
        // model that merely ranks lower still wins once the better ones decline, which is
        // how a chain of five ended on one that could not do the job.
        if (need.minQuality > 0) {
          const q = Number.isFinite(m.quality) ? m.quality : 0.5;
          if (q < need.minQuality) { rejected.push({ id: m.id, why: `below the quality this task needs (${q} < ${need.minQuality})` }); return false; }
        }
        return true;
      });

      if (!eligible.length) {
        // RELAX, VISIBLY. A quality floor that leaves nothing is worse than a mediocre
        // answer, but relaxing it silently would hide why the result is poor. The floor is
        // dropped, the fact is stated, and the hard constraints — reach, capability — are
        // never relaxed, because those are not preferences about how well something goes.
        // RELAX IN ORDER, AND SAY SO. Quality first, since a weaker model doing the right
        // kind of work beats a capable one doing the wrong kind. Then the negotiable
        // capabilities, one group at a time. `tools` and reach are never relaxed: one would
        // ignore half the request, the other would send it somewhere it may not go.
        if (need.minQuality > 0) {
          const relaxed = this.route({ ...need, minQuality: 0 });
          if (relaxed.model) {
            return {
              ...relaxed,
              relaxed: true,
              reasons: [...relaxed.reasons, `no model met the quality this task needs (${need.minQuality}) — used the best available instead`],
            };
          }
        }
        if (need.negotiable?.length) {
          const kept = (need.capabilities || []).filter((c) => !need.negotiable.includes(c));
          const relaxed = this.route({ ...need, minQuality: 0, capabilities: kept, negotiable: [] });
          if (relaxed.model) {
            return {
              ...relaxed,
              relaxed: true,
              reasons: [...relaxed.reasons, `no model offers ${need.negotiable.join(', ')} — used one without it, which may do this task poorly`],
            };
          }
        }
        return { model: null, reasons: ['no candidate satisfies the constraints'], rejected };
      }

      const prefer = need.prefer || 'balanced';
      // LOWER IS BETTER, and each preference optimises the axis it names.
      //
      // Two bugs lived here. The balanced score MULTIPLIED time by money, so a single zero
      // annihilated everything else: every free model scored exactly 0 — a local 8B and a
      // local 26B were indistinguishable, and the winner among them fell to provider order
      // and then to alphabetical id. Meanwhile 'latency' and 'cost' both DIVIDED by quality,
      // which inverts them: asking for speed ranked a frontier model above an 8B at the same
      // latency, and asking for cheap ranked a $5 model above a $2 one. A preference that
      // does the opposite of what it is named is worse than not offering it.
      //
      // So: a single-axis preference reads that axis and nothing else, and only `balanced`
      // trades — adding time and money (never multiplying) and dividing by quality, which is
      // what "worth paying for" means. Requirements have already eliminated everything
      // unsuitable by this point (see requirementsFor), so optimising cost or speed hard
      // cannot reach a model that could not do the job: minQuality is the floor, this is
      // only the ordering above it.
      const score = (m) => {
        // Load is a multiplier rather than a term: a busy model is worse at everything it
        // offers, not merely a bit more expensive.
        const busy = 1 + Math.max(0, Math.min(1, m.load));
        // Known quality divides, and an UNKNOWN one is treated as average rather than as
        // zero — burying every model we have not benchmarked would make the router
        // permanently prefer whatever it happened to measure first.
        const q = Number.isFinite(m.quality) ? Math.max(0.1, m.quality) : 0.5;
        if (prefer === 'latency') return m.latencyMs * busy;
        if (prefer === 'cost') return m.costPer1k * busy;
        if (prefer === 'quality') return busy / q;
        return ((m.latencyMs / 1000) + m.costPer1k * SECONDS_PER_UNIT_COST) * busy / q;
      };
      // ORDER IS A SETTING, NOT A TIE-BREAK THAT NEVER FIRES.
      //
      // `score` multiplies latency, cost and load into a float, so two candidates are almost
      // never bit-for-bit equal — which made the providerRank tie-break that used to sit
      // below it dead code. The Order a user set by hand did nothing at all. Two rules give
      // it effect:
      //
      //   1. SAME MODEL -> ORDER DECIDES, outright. When one model is offered by three
      //      providers only the PATH differs, and Order is exactly the "which path"
      //      preference. A guess at cost has no business overruling a stated preference
      //      between two things that are the same model.
      //   2. CLOSE SCORES ARE A TIE. Latency and cost here are estimates, not measurements;
      //      treating a 3% gap as decisive is false precision. Near-equal scores cluster,
      //      and Order orders the cluster.
      //
      // Clustering by a linear scan, rather than rounding scores into fixed buckets: with
      // buckets, two scores 3% apart still split whenever they straddle an edge, so the tie
      // band would hold or not hold depending on where the numbers happened to land. A scan
      // that grows each cluster from its own leader has no edges to straddle and stays a
      // valid total order, which a bare "within 10%" predicate — not being transitive —
      // would not.
      const scored = new Map();
      const scoreOf = (m) => {
        if (!scored.has(m)) scored.set(m, score(m));
        return scored.get(m);
      };
      const byOrderThenScore = (a, b) => a.providerRank - b.providerRank
        || scoreOf(a) - scoreOf(b)
        || a.id.localeCompare(b.id);

      const byScoreThenOrder = (a, b) => scoreOf(a) - scoreOf(b)
        || a.providerRank - b.providerRank
        || a.id.localeCompare(b.id);

      // Rule 1: collapse each same-model group behind whichever route the user ranked first.
      const groups = new Map();
      for (const m of eligible) {
        // An unnamed model is its own group: with no name we cannot claim it is the same
        // thing as anything else, and guessing would silently hide one of two real choices.
        const key = sameModelKey(m) || `#${m.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      // Same-model siblings stay together directly behind their representative: when the
      // leader declines, the identical model elsewhere is the closest replacement there is.
      // WHOSE ORDER IS IT. A person who ranked these routes by hand gets that ranking
      // honoured outright — they can see the prices and chose anyway. An order we INFERRED
      // from a URL is only a guess, and a guess must not overrule a route that is really
      // cheaper or faster; there it drops back to a tie-break.
      const groupList = [...groups.values()].map((g) => [...g].sort(
        g.some((m) => m.orderPinned) ? byOrderThenScore : byScoreThenOrder,
      ));
      groupList.sort((a, b) => scoreOf(a[0]) - scoreOf(b[0]) || byOrderThenScore(a[0], b[0]));

      // Rule 2: walk the score-ordered groups, gathering each run that is within the band of
      // its own leader, and let Order arrange each run.
      const clusters = [];
      for (const group of groupList) {
        const open = clusters[clusters.length - 1];
        const leader = open ? scoreOf(open[0][0]) : 0;
        if (open && scoreOf(group[0]) <= leader * (1 + TIE_BAND)) open.push(group);
        else clusters.push([group]);
      }
      for (const cluster of clusters) cluster.sort((a, b) => byOrderThenScore(a[0], b[0]));
      let ranked = clusters.flat(2);

      // THE CATCH-ALL IS A MODEL THE USER NAMED, not a guess the score made.
      //
      // When no strategy has an opinion and the request has no axis it cares about, the
      // score was still producing an answer — from inferred latency and a cost regex, i.e.
      // from guesses, and presenting it as a decision. That is the one situation where there
      // IS a right answer and it is not ours to invent: the model the user put at Order 1 is
      // them saying "this one, unless there is a reason". Honouring it everywhere else and
      // then overriding it here, on a guess, is the router ignoring the only explicit
      // instruction it was given.
      //
      // PINNED ONLY. An inferred rank is our guess at provider preference and must not act
      // as a declaration; `orderPinned` is what separates a number the user chose from a
      // number we made up. Most setups pin nothing and are unaffected — the score still
      // decides, exactly as before.
      //
      // AND ONLY WHEN NOTHING HAS AN OPINION. A derived preference IS a rule speaking: a
      // greeting asking for speed, a structured payload asking for quality. Those outrank
      // the default, or every turn would land on Order 1 and the rules would be decoration.
      // 'balanced' is the literal "no reason to favour either axis" case (see preferenceFor),
      // which is precisely when a default is the honest answer.
      //
      // Strategies outrank it too, by construction: routeWith consults them after this and
      // the first opinion wins. Rules first, the user's default when they are silent.
      const declared = prefer === 'balanced'
        ? ranked.filter((m) => m.orderPinned).sort((a, b) => a.providerRank - b.providerRank)[0]
        : null;
      if (declared) ranked = [declared, ...ranked.filter((m) => m !== declared)];

      // Order decided whenever the winning cluster held more than one distinct model — the
      // score alone did not separate them.
      const orderDecided = clusters[0]?.length > 1;
      // HOW MANY ACTUALLY TIED, not how many were eligible. "order 1 broke a tie among 16
      // eligible" reads as sixteen models scoring the same when two did, which sends anyone
      // debugging a surprising route looking in entirely the wrong place.
      const tiedCount = (clusters[0] || []).flat().length;
      const chosen = ranked[0];
      return {
        model: chosen,
        eligible: ranked,
        strategy: declared ? 'declared-default' : 'default-score',
        reasons: [
          `reach '${chosen.reach}' within '${wantReach}'`,
          wantCaps.length ? `has ${wantCaps.join(', ')}` : 'no special capability needed',
          // Say WHICH lever decided. "best by balanced" when the real reason was the
          // Order the user set reads as the router ignoring them — the complaint that
          // surfaced this bug in the first place.
          declared
            ? `your default (Order ${chosen.providerRank}) — nothing about this turn asked for anything else`
            : orderDecided
              ? `order ${chosen.providerRank} broke a ${tiedCount}-way tie by ${prefer}, of ${ranked.length} eligible`
              : `best by ${prefer} (${ranked.length} eligible)`,
        ],
        rejected,
        runnersUp: ranked.slice(1).map((m) => m.id),
      };
    },

    /**
     * Route, letting strategies choose among the candidates the hard constraints allowed.
     *
     * Strategies run in order and the FIRST opinion wins; the rest are not asked, because a
     * chain that kept consulting after an answer would spend a model call per strategy to
     * produce one decision.
     *
     * Every failure mode falls back to the deterministic score rather than failing the
     * request: routing must never break because the thing that picks a model was slow,
     * offline, or wrong. A router that can fail is worse than a router that is occasionally
     * suboptimal.
     */
    async routeWith(need = {}, ctx = {}) {
      const base = this.route(need);
      if (!base.model || !plans.length) return base;
      const allowed = new Map(base.eligible.map((m) => [m.id, m]));

      for (const plan of plans) {
        if (admit && !admit(plan)) continue;
        let picked = null;
        try {
          const call = plan.decide([...base.eligible], need, ctx);
          picked = plan.timeoutMs > 0
            ? await Promise.race([call, new Promise((r) => setTimeout(() => r(null), plan.timeoutMs))])
            : await call;
        } catch {
          picked = null;   // a strategy that throws has no opinion
        }
        if (!picked) continue;

        // NARROW OR REORDER, NEVER WIDEN. Anything the strategy names that was not eligible
        // is dropped — the hard constraints already decided that question, and a learned
        // router confidently naming a forbidden model must not be able to overrule them.
        const list = (Array.isArray(picked) ? picked : [picked])
          .map((m) => (typeof m === 'string' ? allowed.get(m) : allowed.get(m?.id)))
          .filter(Boolean);
        const invented = (Array.isArray(picked) ? picked : [picked]).length - list.length;
        if (!list.length) continue;

        // THE ORDERING IS THE DECISION'S, NOT THE SCORE'S.
        //
        // `eligible` was left as the base ranking while `model` became the strategy's pick,
        // so the two disagreed the moment any strategy fired: the list said opus was first
        // and the chosen model was Codex, sitting somewhere in the middle. Everything
        // downstream reads `eligible` as "the order this decision put them in" — the graph
        // ranks nodes by it, runnersUp slices it — so a stale ordering is not a cosmetic
        // problem, it is the picture contradicting itself in front of the person using it to
        // debug the router.
        //
        // The strategy's list first, then whatever it did not rank, in the order the score
        // left them. A strategy narrows and reorders; it does not delete the rest.
        const rest = base.eligible.filter((m) => !list.includes(m));
        const ordered = [...list, ...rest];
        return {
          ...base,
          model: list[0],
          eligible: ordered,
          strategy: plan.id,
          runnersUp: ordered.slice(1).map((m) => m.id),
          reasons: [
            ...base.reasons.slice(0, -1),
            `chosen by '${plan.id}' (class ${plan.classUsed}) from ${base.eligible.length} eligible`,
            ...(invented > 0 ? [`${invented} suggestion(s) ignored — not eligible under the constraints`] : []),
          ],
        };
      }
      return base;
    },

    /**
     * Run a request through the pipeline and back.
     *
     * `dispatch` is injected — the router composes and decides; it does not know how to talk
     * to a model. A step that declares `requiredFor` and is missing FAILS the request rather
     * than being skipped: that is how "redaction must run before a third party sees this"
     * becomes a property of the system instead of a habit.
     */
    async run(request, { dispatch, need = {} } = {}) {
      if (typeof dispatch !== 'function') throw new RouterError('NO_DISPATCH', 'run needs a dispatch function');
      const decision = await this.routeWith(need, { request });
      if (!decision.model) throw new RouterError('NO_ROUTE', decision.reasons[0]);

      const applies = (m) => !m.requiredFor || m.requiredFor(decision.model, need);
      const required = chain.filter((m) => m.requiredFor && m.requiredFor(decision.model, need));
      const active = new Set(stepsFor('request').concat(stepsFor('response')).map((m) => m.id));
      const missing = required.filter((m) => !active.has(m.id));
      if (missing.length) {
        // Fail loud. Silently proceeding without a required step is the exact failure this
        // whole structure exists to prevent, and a disabled-plugin toggle must not be able
        // to cause it.
        throw new RouterError('MISSING_REQUIRED', `route to '${decision.model.id}' requires ${missing.map((m) => m.id).join(', ')}, which is not active`);
      }

      const ctx = { model: decision.model, need, decision };
      let payload = request;
      for (const step of stepsFor('request')) {
        if (!applies(step)) continue;
        payload = (await step.run(payload, ctx)) ?? payload;
      }
      let answer = await dispatch(payload, ctx);
      for (const step of stepsFor('response')) {
        if (!applies(step)) continue;
        answer = (await step.run(answer, ctx)) ?? answer;
      }
      return { answer, decision };
    },
  };
}
