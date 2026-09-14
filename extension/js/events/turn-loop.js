// GENERATED — do not edit.
// Source of truth: chatpanel-events/turn-loop.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The turn loop — a model that asks for tools gets them run, and is asked again.
//
// One request either ends with an answer or with tool calls. On the second, the calls are
// run here and their results go back as the next request, until the model answers in words,
// the round cap is reached, or the guard decides the model is going in circles. That loop
// was written three times — once per provider in the extension, once in the desktop — and
// each copy knew something the others did not: the extension withheld tools on the last
// round and noticed a round repeating itself; the desktop kept a transcript, survived an
// abort with the words so far, and nudged a relayed CLI agent that ignores "no tools" until
// it answered. A fix to one never reached the other two. Now there is one loop and three
// bindings, each about thirty lines.
//
// What is injected, because it is the host's:
//   • `stream(req)`      — ONE model request: the provider call, its SSE decoding, its auth.
//                          Returns `{ ok, text, toolCalls, usage, aborted, error, finish,
//                          blocks?, noVision? }`. A thrown error propagates untouched — the
//                          extension's failover reads it.
//   • `tools.execute`    — what a call does. The toolset also carries `specs`, `traits`,
//                          `remoteTools`, `serialTools`.
//   • `transcript`       — how the asked/answered pair is written in this provider's wire
//                          shape. OpenAI (also what the gateway relays) and Anthropic ship
//                          here; a host with a third shape brings its own.
//   • the callbacks      — deltas, activity, steps, wire messages.
//
// What is NOT injected, because it is the point: the guard, the round, the cap, the
// exhaustion, the accounting. Class R with an async seam: no I/O of its own, no clock.

import { runToolRound } from './tool-round.js';
import { toolTraits, effectiveToolName, parallelEligible } from './tool-traits.js';
import { createToolLoopGuard, roundSignature, toolMadeProgress, blockedToolResult } from './tool-loop-guard.js';
import { createAdaptiveToolPolicy, resultText } from './adaptive-tool-policy.js';
import { toolStatus } from './tool-hints.js';

/** Model requests one turn may make when tools are armed. Configurable, 60 is the ceiling either client ran with. */
export const DEFAULT_MAX_ROUNDS = 60;
/** How many stray tool calls a closing request (no tools offered) is answered before the turn ends anyway. */
export const DEFAULT_MAX_FINISH_TRIES = 6;
/** What a step shows of a result — the model receives the whole thing. */
export const STEP_RESULT_MAX_CHARS = 4000;
/** Rounds of one turn are separated in the text the user reads. */
export const ROUND_SEPARATOR = '\n\n';

/**
 * A relayed CLI agent keeps its OWN session and its own tools, so "no tools offered" does
 * not stop it asking — it answered the closing request with another call and an empty text,
 * and a member's whole answer was its opening sentence. Each such call is answered with the
 * next of these until words come back.
 */
export const FINISH_NUDGES = Object.freeze([
  'The tool budget for this turn is spent. Do not call tools again; write your answer now with what you have, including your findings.',
  'No more tool calls will be answered. Reply with your answer as plain text, now — a partial answer beats none.',
  'FINAL: any further tool call ends this turn with no answer. Write what you have found, as text, in this message.',
]);
export const LOOPING_NUDGE = 'You have repeated the same tool call several times. Do not call tools again; answer now with what you have.';
/** Appended by a client that renders the exhausted flag as words — kept here so both say the same thing. */
export const EXHAUSTED_NOTE = '_(Reached the action limit for one turn — say "continue" to keep going.)_';

/**
 * How many rounds this turn may take. The agent's own setting wins, then the user's
 * preference, then the default; a turn without tools is one request.
 */
export function roundCap({ tools, agent, settings, fallback = DEFAULT_MAX_ROUNDS } = {}) {
  if (!tools) return 1;
  const ceiling = Math.max(1, Number(fallback) || DEFAULT_MAX_ROUNDS);
  const own = Number(agent?.maxRequestsPerTurn) || 0;
  if (own > 0) return Math.min(ceiling, own);
  const pref = Number(settings?.ui?.maxToolRoundsPerTurn ?? settings?.maxToolRoundsPerTurn) || 0;
  if (pref > 0) return Math.min(ceiling, pref);
  return ceiling;
}

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

const argString = (c) => (typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? c.input ?? {}));

/** What the model reads back from a tool: the `string | { text }` executor contract. */
export { resultText };

/** A short, display-safe slice of a result for a step — the model still gets the full result. */
export function stepResultText(result) {
  const s = String(resultText(result) || '');
  return s.length > STEP_RESULT_MAX_CHARS ? `${s.slice(0, STEP_RESULT_MAX_CHARS)}…` : s;
}

/** One line for the activity trail — the real action and the argument that identifies it. */
export function describeCall(name, input) {
  const eff = effectiveToolName(name, input);
  const args = input && typeof input === 'object' && input.args && typeof input.args === 'object' ? input.args : (input || {});
  const key = ['query', 'id', 'tool', 'location', 'ref'].find((k) => typeof args[k] === 'string' && args[k]);
  return key ? `${eff} "${String(args[key]).slice(0, 80)}"` : eff;
}

/** Put the toolset's guidance in front of the model, merged into an existing system turn. */
export function withToolSystem(messages, system) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const text = String(system || '').trim();
  if (!text) return list;
  const i = list.findIndex((m) => m?.role === 'system' && typeof m.content === 'string');
  if (i >= 0) { list[i] = { ...list[i], content: `${list[i].content}\n\n${text}` }; return list; }
  return [{ role: 'system', content: text }, ...list];
}

// ---------------------------------------------------------------------------------------
// Usage — adds up across rounds, in both key styles, so a team budget reading
// `prompt_tokens` and a ledger reading `inputTokens` see the same turn.
// ---------------------------------------------------------------------------------------

const n = (v) => Number(v) || 0;

export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const inputTokens = n(u.inputTokens ?? u.input_tokens ?? u.prompt_tokens);
  const outputTokens = n(u.outputTokens ?? u.output_tokens ?? u.completion_tokens);
  const cacheReadTokens = n(u.cacheReadTokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = n(u.cacheWriteTokens ?? u.cache_creation_input_tokens);
  const out = {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: n(u.total_tokens) || inputTokens + outputTokens,
    calls: n(u.calls) || 1,
    reported: u.reported !== false && (inputTokens > 0 || outputTokens > 0),
  };
  const usd = n(u.usd ?? u.cost);
  if (usd) out.usd = usd;
  return out;
}

/** Two usage records as one. Either may be in a provider's raw shape. */
export function addUsage(a, b) {
  const A = normalizeUsage(a); const B = normalizeUsage(b);
  if (!B) return A;
  if (!A) return B;
  const out = {
    inputTokens: A.inputTokens + B.inputTokens, outputTokens: A.outputTokens + B.outputTokens,
    cacheReadTokens: A.cacheReadTokens + B.cacheReadTokens, cacheWriteTokens: A.cacheWriteTokens + B.cacheWriteTokens,
    calls: A.calls + B.calls, reported: A.reported || B.reported,
  };
  out.prompt_tokens = out.inputTokens; out.completion_tokens = out.outputTokens; out.total_tokens = A.total_tokens + B.total_tokens;
  const usd = n(A.usd) + n(B.usd);
  if (usd) out.usd = usd;
  return out;
}

/** ~4 chars/token — ONLY when a provider reported nothing. No tokenizer: real usage is accurate and free. */
export function estimateTokens(text) {
  return Math.max(0, Math.round(String(text || '').length / 4));
}

function estimatedUsage(messages, text) {
  const inText = (messages || []).map((m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || ''))).join('\n');
  return { inputTokens: estimateTokens(inText), outputTokens: estimateTokens(text), cacheReadTokens: 0, cacheWriteTokens: 0, estimated: true };
}

// ---------------------------------------------------------------------------------------
// Transcripts — the asked/answered pair in a provider's wire shape.
// ---------------------------------------------------------------------------------------

/** The OpenAI chat shape: what the gateway relays and every provider behind it understands. */
export const openAiTranscript = Object.freeze({
  asked(res, calls) {
    return {
      role: 'assistant',
      content: String(res?.text || '') || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: argString(c) } })),
    };
  },
  answered(pairs, { noVision = false } = {}) {
    const out = pairs.map(({ call, result }) => ({ role: 'tool', tool_call_id: call.id, content: resultText(result) }));
    // A tool message cannot carry an image. A screenshot goes back as a user message AFTER
    // the round's tool messages (a user turn between two tool turns is rejected by strict
    // providers), or as a note once the model has said it has no vision.
    for (const { call, result } of pairs) {
      const image = result && typeof result === 'object' ? result.image : null;
      if (!image) continue;
      out.push(noVision
        ? { role: 'user', content: `(Screenshot from ${call.name} omitted — this model has no vision. Rely on read_canvas / inspect_page / tool results.)` }
        : { role: 'user', content: [{ type: 'text', text: `(Screenshot from ${call.name})` }, { type: 'image_url', image_url: { url: image } }] });
    }
    return out;
  },
  nudge(calls, text) {
    return [
      { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: argString(c) } })) },
      ...calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: text })),
    ];
  },
  system: (text) => ({ role: 'system', content: text }),
  said: (text) => ({ role: 'assistant', content: text }),
});

/** The Anthropic Messages shape: content blocks, every result of a round in ONE user turn. */
export const anthropicTranscript = Object.freeze({
  asked(res, calls) {
    // Echo the assistant's own blocks when the adapter kept them (text and tool_use in the
    // order they came), dropping empty text — the API rejects zero-length text content.
    const blocks = Array.isArray(res?.blocks) && res.blocks.length
      ? res.blocks.filter((b) => b && (b.type === 'tool_use' || (b.type === 'text' && b.text))).map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? safeJson(b.json) } : { type: 'text', text: b.text }))
      : [...(res?.text ? [{ type: 'text', text: String(res.text) }] : []), ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))];
    return { role: 'assistant', content: blocks };
  },
  answered(pairs) {
    return [{
      role: 'user',
      content: pairs.map(({ call, result }) => {
        const text = resultText(result);
        const image = result && typeof result === 'object' ? result.image : null;
        if (!image) return { type: 'tool_result', tool_use_id: call.id, content: text };
        const im = /^data:([^;]+);base64,(.+)$/s.exec(image);
        const content = [];
        if (im) content.push({ type: 'image', source: { type: 'base64', media_type: im[1], data: im[2] } });
        content.push({ type: 'text', text });
        return { type: 'tool_result', tool_use_id: call.id, content };
      }),
    }];
  },
  nudge(calls, text) {
    return [
      { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) },
      { role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: text })) },
    ];
  },
  // No system role in the message list — the instruction rides as the user's words.
  system: (text) => ({ role: 'user', content: text }),
  said: (text) => ({ role: 'assistant', content: text }),
});

// ---------------------------------------------------------------------------------------
// Calls — one guarded call, one guarded round. The same code answers a call that arrives
// mid-stream from a CLI agent (the bridge relays one at a time) and a round of calls from
// an API model.
// ---------------------------------------------------------------------------------------

/**
 * @param tools      the toolset
 * @param guard      a tool-loop guard (one per turn)
 * @param policy     an adaptive tool policy (one per turn)
 * @param modelLabel `() => string` — WHICH model made this call, read per call: a turn can
 *                   change model mid-flight (failover), and attributing every action to
 *                   whichever model finished misreports the work
 * @param maxCalls   after this many calls in the turn, each further one is answered with a
 *                   "budget spent" nudge instead of running — the cap for a host that has
 *                   no rounds to count (a relayed CLI agent). 0 = no cap.
 * @param onStep     `(step)` — `{ phase, callId, name, action, input, text, status, result, image, model }`
 */
export function createCallRunner({ tools, guard = createToolLoopGuard(), policy = createAdaptiveToolPolicy(), modelLabel = () => null, maxCalls = 0, onStep = null, steps = [] } = {}) {
  let made = 0;
  const traitsOf = (c) => {
    const eff = effectiveToolName(c.name, c.input);
    return tools?.traits?.get(eff) || tools?.traits?.get(c.name) || toolTraits({ name: eff });
  };
  const stepOf = (c, phase, result) => {
    const step = { phase, callId: c.id, name: c.name, action: effectiveToolName(c.name, c.input), input: c.input, text: describeCall(c.name, c.input), model: modelLabel() };
    if (phase === 'done') {
      const image = result && typeof result === 'object' ? result.image : undefined;
      Object.assign(step, { status: toolStatus(result), result: stepResultText(result), ...(image ? { image } : {}) });
    }
    return step;
  };
  const start = (c) => { try { onStep?.(stepOf(c, 'start')); } catch { /* reporting never breaks a turn */ } };
  const done = (c, result) => {
    const step = stepOf(c, 'done', result);
    steps.push(step);
    try { onStep?.(step); } catch { /* reporting never breaks a turn */ }
  };
  const settle = (c, g, result) => {
    policy.recordResult(c.name, result);
    if (!g.blocked && !g.replayed && toolMadeProgress(c.name, result, c.input)) guard.reset(g.key);
    // Only a read is remembered for replay — the traits decide, not a list of names.
    if (!g.replayed) guard.remember(g.key, c.name, c.input, result, { readOnly: !!traitsOf(c)?.readOnly });
  };
  const spent = (c) => blockedToolResult(c.name, FINISH_NUDGES[Math.min(Math.max(0, made - maxCalls - 1), FINISH_NUDGES.length - 1)], { budget: 'spent', calls: made, maxCalls });
  const execute = async (c, g, meta) => {
    made += 1;
    if (maxCalls > 0 && made > maxCalls) return spent(c);
    if (g.blocked || g.replayed) return g.result;
    if (typeof tools?.execute !== 'function') return JSON.stringify({ error: 'no tools armed' });
    return tools.execute(c.name, c.input, { callId: c.id, ...(meta || {}) });
  };

  return {
    guard, policy, steps, traitsOf,
    get calls() { return made; },
    get exhausted() { return maxCalls > 0 && made >= maxCalls; },

    /** One call, arriving on its own (a relayed agent). Every exit produces a result. */
    async one(call, meta = null) {
      const c = { id: call.id, name: call.name, input: call.input ?? safeJson(call.arguments) };
      start(c);
      const g = guard.check(c.name, c.input);
      let result;
      try { result = await execute(c, g, meta); } catch (e) { result = JSON.stringify({ error: String(e?.message || e) }); }
      settle(c, g, result);
      done(c, result);
      return result;
    },

    /**
     * One ROUND — reads overlapped, writes in the model's order, identical calls coalesced
     * (tool-round.js). The guard is consulted up front in the model's order (its counts are
     * order-dependent); the policy and the guard's memory are updated from each result.
     */
    async round(wanted) {
      const calls = wanted.map((c) => ({ id: c.id, name: c.name, input: c.input ?? safeJson(c.arguments) }));
      const guards = calls.map((c) => guard.check(c.name, c.input));
      const { results } = await runToolRound(calls, {
        execute: (c, i) => execute(c, guards[i]),
        traitsOf,
        concurrent: (c, t) => parallelEligible(tools, c, t),
        onStart: (c) => start(c),
        onDone: (c, i, result) => done(c, result),
      });
      results.forEach((result, i) => settle(calls[i], guards[i], result));
      const blocked = guards.filter((g) => g.blocked).length;
      guard.noteRound(blocked, calls.length, roundSignature(calls));
      return { calls, results, blocked };
    },
  };
}

// ---------------------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------------------

/**
 * Run a turn to completion.
 *
 * @param stream       `(req) => { ok, text, toolCalls?, usage?, error?, aborted?, finish?, blocks?, noVision? }`
 *                     — ONE request. `req` is `{ model, messages, tools, signal, redaction, run,
 *                     onDelta(delta), onActivity }`; `req.tools` is the CANONICAL spec list
 *                     (`{ name, description, parameters }`) or null when none are offered — the
 *                     adapter shapes it for its provider.
 * @param tools        `{ specs, execute, traits?, remoteTools?, serialTools?, system? }`; absent = one plain request
 * @param messages     the wire messages as the host assembled them (system turns included)
 * @param transcript   how asked/answered are written — `openAiTranscript` (default) or `anthropicTranscript`
 * @param maxRounds    model requests with tools; see `roundCap`
 * @param maxFinishTries stray calls answered on the closing request before giving up
 * @param onDelta      `(delta, text)` — `text` is everything said so far ACROSS rounds
 * @param onEvent      the extension's activity stream: `{type:'tool'|'finish'|'usage', …}`
 * @param onStep       the desktop's activity trail: one step per call, start and done
 * @param onMessage    `(msg)` each wire message the moment it exists — a record that grows as
 *                     the turn goes, so a process that dies mid-turn leaves the work so far
 * @param usageLabel   `{ provider, model }` stamped on the usage event
 * @returns `{ ok, text, usage, rounds, steps, transcript, exhausted, aborted, error, finish }`
 */
export async function runTurnLoop({
  model, messages, tools, signal, redaction, run, stream,
  transcript = openAiTranscript,
  maxRounds = DEFAULT_MAX_ROUNDS, maxFinishTries = DEFAULT_MAX_FINISH_TRIES,
  guard = createToolLoopGuard(), policy = createAdaptiveToolPolicy(),
  modelLabel = () => model || null, usageLabel = null,
  onDelta = null, onEvent = null, onStep = null, onMessage = null, onActivity = null,
} = {}) {
  if (typeof stream !== 'function') throw new Error('runTurnLoop: stream required');
  const armed = !!(tools && Array.isArray(tools.specs) && tools.specs.length);
  const specs = armed ? tools.specs : null;
  const cap = armed ? Math.max(1, Number(maxRounds) || DEFAULT_MAX_ROUNDS) : 1;
  const steps = [];
  const runner = createCallRunner({
    tools, guard, policy, modelLabel, steps,
    onStep: (step) => {
      try { onStep?.(step); } catch { /* never break a turn */ }
      try { onEvent?.({ type: 'tool', ...step }); } catch { /* never break a turn */ }
    },
  });

  let convo = [...(messages || [])];
  let said = '';        // everything the model has said so far, across rounds
  let usage = null;
  let rounds = 0;
  let noVision = false;
  let finishTries = 0;
  let exhausted = false;
  const push = (msgs) => { for (const m of msgs) { convo = [...convo, m]; try { onMessage?.(m); } catch { /* never break a turn */ } } };
  const finish = (reason) => { try { onEvent?.({ type: 'finish', reason }); } catch { /* ignore */ } };
  const usageEvent = (text) => {
    if (!onEvent) return;
    const u = usage && usage.reported ? { ...usage, estimated: false } : estimatedUsage(convo, text);
    try { onEvent({ type: 'usage', provider: usageLabel?.provider || 'unknown', model: usageLabel?.model || model || null, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, estimated: !!u.estimated }); } catch { /* ignore */ }
  };
  const result = (over) => ({ ok: true, text: said, usage, rounds, steps, transcript: convo, exhausted, aborted: false, ...over });
  const closeWith = (text, over = {}) => {
    const t = String(text || '');
    if (t.trim()) push([transcript.said(t)]);
    return result(over);
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    rounds += 1;
    // The closing request: the cap is reached, the guard says the model is circling, or a
    // stray call already came back to a request that offered nothing. No tools, so the turn
    // ends with words — and if the agent asks anyway, it is answered until it stops.
    const closing = !armed || rounds >= cap || guard.stalled || guard.looping || finishTries > 0;
    const offered = closing ? null : specs.filter((s) => !policy.isSuppressed(s?.name));
    let roundText = '';
    const res = await stream({
      model, messages: convo, tools: offered && offered.length ? offered : null, signal, onActivity,
      // Only when set: a host reads these as "present", not as a value.
      ...(redaction !== undefined ? { redaction } : {}), ...(run ? { run } : {}),
      onDelta: (delta) => {
        if (!delta) return;
        if (!roundText && said) { said += ROUND_SEPARATOR; try { onDelta?.(ROUND_SEPARATOR, said); } catch { /* ignore */ } }
        roundText += delta; said += delta;
        try { onDelta?.(delta, said); } catch { /* ignore */ }
      },
    });
    if (res?.usage) usage = addUsage(usage, res.usage);
    if (res?.noVision) noVision = true;
    // Reconcile: an adapter that returned text without streaming it still gets it into `said`.
    const text = String(res?.text || '');
    if (text && !roundText) { if (said) said += ROUND_SEPARATOR; said += text; roundText = text; }
    // `status` rides along when the adapter had one — a failover classifier reads it.
    if (!res?.ok) { finish('error'); return result({ ok: false, error: res?.error || 'the model did not answer', ...(res?.status ? { status: res.status } : {}), aborted: !!res?.aborted, transcript: text.trim() ? [...convo, transcript.said(said)] : convo }); }
    if (res.aborted || signal?.aborted) { finish('aborted'); return closeWith(said, { aborted: true }); }

    const wanted = (Array.isArray(res.toolCalls) ? res.toolCalls : []).filter((c) => c && c.name).map((c) => ({ id: c.id, name: c.name, input: c.input ?? safeJson(c.arguments), arguments: c.arguments }));
    if (!wanted.length) {
      finish(res.finish || 'stop');
      usageEvent(said);
      return closeWith(said);
    }

    if (!offered || !offered.length) {
      // Asked with nothing offered. A relayed agent does this; answer, don't drop.
      finishTries += 1;
      if (finishTries > maxFinishTries) { finish('tool-step-limit'); usageEvent(said); return closeWith(said, { exhausted: true }); }
      exhausted = exhausted || rounds >= cap;
      push(transcript.nudge(wanted, FINISH_NUDGES[Math.min(finishTries - 1, FINISH_NUDGES.length - 1)]));
      continue;
    }

    push([transcript.asked(res, wanted)]);
    const { calls, results } = await runner.round(wanted);
    push(transcript.answered(calls.map((call, i) => ({ call, result: results[i] })), { noVision }));
    if (signal?.aborted) { finish('aborted'); return closeWith(said, { aborted: true }); }
    if (guard.looping) push([transcript.system(LOOPING_NUDGE)]);
    if (rounds + 1 >= cap) exhausted = true;
  }
}
