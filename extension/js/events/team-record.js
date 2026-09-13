// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-record.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The run record — a team run folded from its events, the same way on the gateway's store
// and in either client. One fold, so what the desktop shows, what the extension shows and
// what the store holds never disagree; and enough on the record to RESUME the run from
// anywhere: the plan, every task's status and transcript, the board, the spend.
//
// The gateway vendors this file (its store used to carry a mirror of it, which is the copy
// that drifts). `checkpointFrom(run)` is what a client hands `resumeTeam` after reading a
// run the process that started it no longer runs.

import { foldBoard, emptyBoardState } from './team-board.js';

export const LIVE_RUN_STATUSES = Object.freeze(['planning', 'running', 'merging', 'waiting']);
export const RESUMABLE_RUN_STATUSES = Object.freeze(['waiting', 'stopped', 'failed', 'partial', 'over-budget', 'answered']);
const TASK_TEXT_MAX = 20_000;

export function emptyRun({ id, client = '', now = Date.now() } = {}) {
  return { id, client: String(client || '').slice(0, 40), createdAt: now, lastEventAt: now, status: 'planning', team: '', request: '', roles: [], plan: null, tasks: [], board: [], threads: emptyBoardState(), checkpoint: null, proposal: null, usage: null, stopRequested: null, startedAt: null, endedAt: null };
}

const taskOf = (run, id) => run.tasks.find((x) => x.id === id);

/** Fold one event (`{ type, at, payload }`, or a flat `{ type, at, ...payload }`) into the record. */
export function foldRun(run, ev) {
  const type = String(ev?.type || '');
  const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : (ev || {});
  const at = Number(ev?.at) || Date.now();
  run.lastEventAt = at;
  switch (type) {
    case 'run.started':
    case 'run.resumed':
      run.team = p.team || run.team; run.request = p.request ?? run.request; run.budget = p.budget || run.budget;
      run.roles = Array.isArray(p.roles) ? p.roles : run.roles; run.status = 'planning'; run.startedAt = run.startedAt || at;
      if (type === 'run.resumed') { run.endedAt = null; run.checkpoint = null; run.resumedAt = at; }
      break;
    case 'plan.ready':
      run.plan = { by: p.by || 'fixed', tasks: Array.isArray(p.tasks) ? p.tasks : [] };
      // A resume replays the plan: keep what the tasks already hold (transcripts, attempts).
      run.tasks = run.plan.tasks.map((t) => ({ ...(taskOf(run, t.id) || {}), id: t.id, role: t.role, title: t.title, status: taskOf(run, t.id)?.status === 'ok' ? 'ok' : 'pending', findings: taskOf(run, t.id)?.findings || 0 }));
      run.status = 'running';
      break;
    case 'task.started': { const t = taskOf(run, p.taskId); if (t) { t.status = 'running'; t.startedAt = at; t.error = null; } run.status = 'running'; break; }
    case 'task.model': { const t = taskOf(run, p.taskId); if (t) { t.model = p.model; t.attempts = [...(t.attempts || []), { model: p.model, at, attempt: p.attempt }]; } break; }
    case 'task.step': { const t = taskOf(run, p.taskId); if (t && Array.isArray(p.steps)) t.transcript = [...(t.transcript || []), ...p.steps]; break; }
    case 'task.handoff': { const t = taskOf(run, p.taskId); if (t) { t.model = p.to; t.handoffs = [...(t.handoffs || []), { from: p.from, to: p.to, by: p.by, reason: p.reason, at }]; } break; }
    case 'task.tool': { const t = taskOf(run, p.taskId); if (t) t.tools = (t.tools || 0) + 1; break; }
    case 'task.delta': { const t = taskOf(run, p.taskId); if (t) t.text = String(p.text || '').slice(0, TASK_TEXT_MAX); break; }
    case 'task.finding':
      if (p.finding && p.finding.text) { run.board.push({ ...p.finding, at }); const t = taskOf(run, p.taskId); if (t) t.findings += 1; }
      break;
    case 'task.waiting': { const t = taskOf(run, p.taskId); if (t) { t.status = 'waiting'; t.waitingOn = p.threadId; } break; }
    case 'task.done':
    case 'task.failed': { const t = taskOf(run, p.taskId); if (t) { t.status = p.status || (type === 'task.done' ? 'ok' : 'failed'); t.error = p.error || null; t.ms = p.ms; t.endedAt = at; } break; }
    case 'run.merging': run.status = 'merging'; break;
    case 'run.waiting': run.status = 'running'; break;
    case 'run.usage': run.usage = p.usage || run.usage; break;
    case 'run.done':
      run.status = p.status || 'completed'; run.usage = p.usage || run.usage; run.proposal = p.proposal ?? run.proposal; run.endedAt = at;
      if (p.checkpoint) run.checkpoint = p.checkpoint;
      break;
    case 'run.stop-requested': run.stopRequested = at; break;
    case 'board.thread': case 'board.post': case 'board.decision': case 'board.thread-status':
      run.threads = foldBoard(run.threads || emptyBoardState(), ev);
      if (type === 'board.thread-status' && p.status !== 'waiting' && run.status === 'waiting' && !(run.threads.threads || []).some((t) => t.kind === 'ask' && t.status === 'waiting')) run.status = 'answered';
      break;
    default: break;
  }
  return run;
}

/** Fold a whole event list into a fresh record. */
export function runFromEvents(id, events, opts = {}) {
  const run = emptyRun({ id, ...opts });
  for (const ev of events || []) foldRun(run, ev);
  return run;
}

/**
 * What `resumeTeam` needs, from the record alone — the runner's own checkpoint when the run
 * ended with one, else one built from the folded tasks: whatever the process that ran it
 * managed to write before it went. A task recorded `running` (its process died) resumes
 * from its transcript like a waiting one.
 */
export function checkpointFrom(run) {
  if (!run?.plan?.tasks?.length) return null;
  if (run.checkpoint?.plan?.tasks?.length) return { ...run.checkpoint, board: run.threads && run.threads.threads?.length >= (run.checkpoint.board?.threads?.length || 0) ? run.threads : run.checkpoint.board };
  return {
    runId: run.id,
    startedAt: run.startedAt || run.createdAt,
    plan: run.plan,
    tasks: run.tasks.map((t) => ({ id: t.id, role: t.role, title: t.title, status: t.status === 'running' || t.status === 'pending' ? 'stopped' : t.status, text: t.text || '', error: t.error || null, transcript: t.transcript || [], attempts: t.attempts || [], usage: null })),
    board: run.threads || emptyBoardState(),
    budget: { cap: run.usage?.cap || run.budget || {}, spent: run.usage?.spent || {} },
    budgetAsked: false,
  };
}

/** Can this record be picked up again? Not one that completed, not one still being run by a live client. */
export function isResumable(run) {
  if (!run?.plan?.tasks?.length) return false;
  if (RESUMABLE_RUN_STATUSES.includes(run.status)) return true;
  return !!run.stale && LIVE_RUN_STATUSES.includes(run.status); // its client went away mid-run
}
