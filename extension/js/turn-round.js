// One round of tool calls for the provider loops — the extension's binding of
// events/tool-round.js. Deferred from providers.js (which sits on settings' first paint
// through the redaction test harness): a round only exists once a model has asked for
// tools.

import { runToolRound } from './events/tool-round.js';
import { toolTraits } from './events/tool-traits.js';
import { effectiveToolName, stepResultText, toolMadeProgress, modelLabelOf } from './providers.js';
import { toolStatus } from './tool-hints.js';

// Local tools whose reads may overlap: they touch the user's own data or the network,
// never the one tab a page tool is driving. Everything not remote and not here runs one
// at a time, whatever its name says — a wrong "parallel" races the world, a wrong
// "serial" only costs latency.
export const PARALLEL_LOCAL_RE = /^(history_|web_search$|get_result$|skill_open$|skill_file$|recall$|memory_recall$|meeting_live_transcript$)/;

export function parallelEligible(tools, call, traits) {
  if (!traits?.readOnly) return false;
  if (tools?.serialTools?.has(call.name)) return false;
  const eff = effectiveToolName(call.name, call.input);
  return !!tools?.remoteTools?.has(call.name) || PARALLEL_LOCAL_RE.test(eff) || PARALLEL_LOCAL_RE.test(call.name);
}

/**
 * ONE ROUND of tool calls — reads overlapped, writes in the model's order, identical calls
 * coalesced (events/tool-round.js). Both provider loops used to walk the round with
 * `for … await`, so five independent reads cost five latencies for no reason and a
 * repeated call ran twice.
 *
 * Everything the sequential loop did per call still happens, in the model's order: the
 * loop guard is consulted up front (its identical-call counts are order-dependent), the
 * activity log gets start/done per call, the adaptive policy and the guard's memory are
 * updated from each result. Only the waiting changed.
 */
export async function runRound(wanted, { tools, agent, loopGuard, adaptivePolicy, onEvent, argsOf }) {
  const calls = wanted.map((c) => ({ id: c.id, name: c.name, input: argsOf(c) }));
  const guards = calls.map((c) => loopGuard.check(c.name, c.input));
  const blockedThisRound = guards.filter((g) => g.blocked).length;
  const traitsOf = (c) => {
    const eff = effectiveToolName(c.name, c.input);
    return tools?.traits?.get(eff) || tools?.traits?.get(c.name) || toolTraits({ name: eff });
  };
  const { results } = await runToolRound(calls, {
    execute: (c, i) => (guards[i].blocked || guards[i].replayed ? guards[i].result : tools.execute(c.name, c.input, { callId: c.id })),
    traitsOf,
    concurrent: (c, t) => parallelEligible(tools, c, t),
    // WHICH MODEL MADE THIS CALL. A turn can change model mid-flight — a failover after a
    // provider declines — and attributing every action to whichever model finished the
    // turn misreports the work. The one that drew the circle is not always the one that
    // answered.
    onStart: (c) => onEvent?.({ type: 'tool', name: c.name, phase: 'start', callId: c.id, input: c.input, model: modelLabelOf(agent) }),
    onDone: (c, i, result) => {
      const _image = result && typeof result === 'object' ? result.image : undefined;
      onEvent?.({ type: 'tool', name: c.name, phase: 'done', callId: c.id, image: _image, status: toolStatus(result), result: stepResultText(result) });
    },
  });
  results.forEach((result, i) => {
    const c = calls[i];
    const guard = guards[i];
    adaptivePolicy.recordResult(c.name, result);
    if (!guard.blocked && toolMadeProgress(c.name, result)) loopGuard.reset(guard.key);
    loopGuard.remember(guard.key, c.name, c.input, result);
  });
  return { calls, results, blockedThisRound };
}

