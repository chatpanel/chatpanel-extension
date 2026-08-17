// RUN DETAILS — turning the event log into something a person can read.
//
// The log answers "what did this turn actually do, what did it cost, and why did the
// agent have the tools it had". A chat transcript collapses all of that into "the
// assistant replied", which is why a failing run is so hard to diagnose from the outside:
// six identical tool errors read as a confused model rather than a harness dropping
// arguments.
//
// PURE ANALYSIS, SEPARATE RENDERING. Everything here takes events and returns data, so it
// is testable without a DOM and reusable by an export, a support bundle, or a second
// client. The canonical value is the summary; the UI is one way to look at it.
//
// This is a PROJECTION, not a re-execution. Replay reconstructs what a turn was given —
// it never re-runs side effects, because a tool call that booked a flight must not be
// repeated to satisfy curiosity.

import { linearize } from './events/order.js';

const TURN_OF = (e) => e.payload?.turnId || null;

/** Group a flat event list into runs, newest first, each in replay order. */
export function groupRuns(events) {
  const ordered = linearize(events);
  const byTurn = new Map();
  const loose = [];
  for (const e of ordered) {
    const t = TURN_OF(e);
    if (!t) { loose.push(e); continue; }
    if (!byTurn.has(t)) byTurn.set(t, []);
    byTurn.get(t).push(e);
  }
  const runs = [...byTurn.entries()].map(([turnId, evs]) => summarizeRun(turnId, evs));
  runs.sort((a, b) => b.at - a.at);
  return { runs, loose };
}

/** One turn, as a readable summary. */
export function summarizeRun(turnId, events) {
  const calls = new Map(); // idempotencyKey -> { name, ok, ms, summary, args }
  let context = null;
  let turn = null;         // explicit boundaries, when the run recorded them
  const capabilities = [];
  const denials = [];

  for (const e of events) {
    const p = e.payload || {};
    switch (e.type) {
      case 'turn.started':
        turn = { ...(turn || {}), startedAt: e.at, kind: p.kind || 'chat', agentId: p.agentId || null };
        break;
      case 'turn.ended':
        turn = { ...(turn || {}), endedAt: e.at, reason: p.reason || 'ok', ms: p.ms ?? null, stepped: p.stepped !== false };
        break;
      case 'context.assembled':
        context = {
          used: p.used || 0,
          parts: p.parts || {},
          tools: p.tools || [],
          reachableCount: p.reachableCount || 0,
          pageArmed: !!p.pageArmed,
        };
        break;
      case 'capability.invoked':
        calls.set(p.idempotencyKey || `${p.capability}:${e.id}`, {
          name: p.capability, args: p.args || {}, ok: null, ms: null, summary: null, at: e.at,
        });
        break;
      case 'capability.resulted': {
        const key = p.idempotencyKey || `${p.capability}:${e.id}`;
        const call = calls.get(key) || { name: p.capability, args: {}, at: e.at };
        call.ok = p.ok !== false;
        call.ms = p.cost?.ms ?? null;
        call.summary = p.summary || null;
        calls.set(key, call);
        break;
      }
      case 'capability.activated':
        capabilities.push({ capability: p.capability, reason: p.reason, siteKey: p.siteKey, granted: !!p.granted });
        break;
      case 'capability.granted':
        capabilities.push({ capability: p.capability, reason: 'user-granted', siteKey: p.siteKey, granted: true });
        break;
      case 'policy.guard_denied':
        denials.push({ capability: p.capability, reason: p.reason });
        break;
      default:
        break;
    }
  }

  const toolCalls = [...calls.values()].sort((a, b) => a.at - b.at);
  return {
    turnId,
    turn,
    // A turn that opened but never closed is still running — or was interrupted by a
    // reload, which is itself worth seeing rather than silently rendering as finished.
    open: !!(turn?.startedAt && !turn?.endedAt),
    at: turn?.startedAt || events[0]?.at || 0,
    ms: turn?.ms ?? null,
    events: events.length,
    context,
    toolCalls,
    capabilities,
    denials,
    failures: toolCalls.filter((c) => c.ok === false),
    repeats: findRepeats(toolCalls),
    tokens: context?.used || 0,
  };
}

/**
 * The diagnostic that matters most: the same tool failing the same way more than once.
 * That pattern is almost never the model's fault — it means the harness keeps returning
 * an error the model cannot act on, and it is invisible in a transcript.
 */
export function findRepeats(toolCalls, min = 2) {
  const seen = new Map();
  for (const c of toolCalls) {
    if (c.ok !== false) continue;
    const key = `${c.name}::${(c.summary || '').slice(0, 80)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, n]) => n >= min)
    .map(([key, count]) => {
      const [name, summary] = key.split('::');
      return { name, summary, count };
    })
    .sort((a, b) => b.count - a.count);
}

/** One-line verdict for a run. */
export function verdict(run) {
  if (run.open) return { level: 'info', text: 'Still running, or interrupted before it finished' };
  if (run.turn?.reason === 'aborted') return { level: 'info', text: 'Stopped by you' };
  if (run.turn?.reason === 'error' && !run.failures.length) {
    return { level: 'warn', text: 'The turn failed before any tool ran' };
  }
  if (run.repeats.length) {
    const r = run.repeats[0];
    return { level: 'bad', text: `${r.name} failed ${r.count}× with the same error — likely a harness problem, not the model` };
  }
  if (run.failures.length) return { level: 'warn', text: `${run.failures.length} tool call(s) failed` };
  if (run.denials.length) return { level: 'info', text: `${run.denials.length} action(s) declined by you` };
  if (!run.toolCalls.length) return { level: 'ok', text: 'No tools used' };
  return { level: 'ok', text: `${run.toolCalls.length} tool call(s), all succeeded` };
}

/** A support-safe export: structure and counts, never payloads. */
export function toSanitizedReport(runs) {
  return {
    generated: 'run-details/v1',
    runs: runs.map((r) => ({
      at: r.at,
      ms: r.ms,
      reason: r.turn?.reason || null,
      tokens: r.tokens,
      parts: r.context?.parts || {},
      toolsOffered: r.context?.reachableCount || 0,
      calls: r.toolCalls.map((c) => ({ name: c.name, ok: c.ok, ms: c.ms, args: c.args })),
      repeats: r.repeats,
      denials: r.denials.map((d) => d.reason),
      verdict: verdict(r).text,
    })),
  };
}
