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
  rateLimited = false, observedLatencyMs = null, quality = null, model = '', providerRank = 50,
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
    complexity: (chars > 4000 || /```/.test(text)
      || (chars >= 200 && /\bstep by step\b|\bplan\b|\brefactor\b|\bmigrate\b|\banalyse|\banalyze/i.test(text)))
      ? 'high'
      : (chars < 200 ? 'low' : 'medium'),
    // Non-Latin script is the one language signal a rule can read reliably. Anything finer
    // is a guess, so it is not offered.
    nonLatin: /[^\u0000-\u024F\u2000-\u206F]/.test(text),
    chars,
  };
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
        return true;
      });

      if (!eligible.length) {
        return { model: null, reasons: ['no candidate satisfies the constraints'], rejected };
      }

      const prefer = need.prefer || 'balanced';
      const score = (m) => {
        // Load is a multiplier rather than a term: a busy model is worse at everything it
        // offers, not merely a bit more expensive.
        const busy = 1 + Math.max(0, Math.min(1, m.load));
        // Known quality divides, and an UNKNOWN one is treated as average rather than as
        // zero — burying every model we have not benchmarked would make the router
        // permanently prefer whatever it happened to measure first.
        const q = Number.isFinite(m.quality) ? Math.max(0.1, m.quality) : 0.5;
        if (prefer === 'latency') return (m.latencyMs * busy) / q;
        if (prefer === 'cost') return (m.costPer1k * busy) / q;
        if (prefer === 'quality') return busy / q;
        return ((m.latencyMs / 1000) * m.costPer1k * busy) / q;
      };
      const ranked = [...eligible].sort((a, b) => score(a) - score(b)
        || a.providerRank - b.providerRank
        || a.id.localeCompare(b.id));
      const chosen = ranked[0];
      return {
        model: chosen,
        eligible: ranked,
        strategy: 'default-score',
        reasons: [
          `reach '${chosen.reach}' within '${wantReach}'`,
          wantCaps.length ? `has ${wantCaps.join(', ')}` : 'no special capability needed',
          `best by ${prefer} (${ranked.length} eligible)`,
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

        return {
          ...base,
          model: list[0],
          strategy: plan.id,
          runnersUp: list.slice(1).map((m) => m.id),
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
