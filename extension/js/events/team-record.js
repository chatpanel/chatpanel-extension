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
  return { id, client: String(client || '').slice(0, 40), createdAt: now, lastEventAt: now, status: 'planning', team: '', request: '', roles: [], plan: null, tasks: [], jobs: [], board: [], threads: emptyBoardState(), checkpoint: null, proposal: null, usage: null, stopRequested: null, startedAt: null, endedAt: null };
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
      run.tasks = run.plan.tasks.map((t) => ({ ...(taskOf(run, t.id) || {}), id: t.id, role: t.role, title: t.title, status: taskOf(run, t.id)?.status === 'ok' ? 'ok' : (t.parent && !t.role ? 'unassigned' : 'pending'), findings: taskOf(run, t.id)?.findings || 0, ...(t.parent ? { parent: t.parent, requestedBy: t.requestedBy || null } : {}), ...(t.grants ? { grants: t.grants, why: t.why || '' } : {}), ...(t.kind ? { kind: t.kind } : {}) }));
      run.status = 'running';
      break;
    // A SUB-TASK (§15.2): requested by a member mid-run, it joins the plan under its parent;
    // taken by a member, recruited from the pool, created on a person's approval — or not.
    case 'task.requested':
      if (p.taskId && !taskOf(run, p.taskId)) {
        const task = { id: p.taskId, role: null, title: p.title || p.taskId, prompt: p.prompt || '', dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [], parent: p.parent || null, requestedBy: p.by || null, needs: p.needs || null, depth: p.depth || 1, wait: p.wait !== false };
        if (run.plan) run.plan.tasks = [...(run.plan.tasks || []), task];
        run.tasks.push({ id: task.id, role: null, title: task.title, status: 'requested', findings: 0, parent: task.parent, requestedBy: task.requestedBy, needs: task.needs, requestedAt: at });
      }
      break;
    // A TASK ADDED AFTER THE PLAN — the merge (the judge's task, opened when the members are
    // done). It joins the plan so a resume carries it and the board draws its thread and log.
    case 'task.added':
      if (p.taskId && !taskOf(run, p.taskId)) {
        const task = { id: p.taskId, role: p.role || null, title: p.title || p.taskId, dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [], ...(p.kind ? { kind: p.kind } : {}) };
        if (run.plan) run.plan.tasks = [...(run.plan.tasks || []), task];
        run.tasks.push({ id: task.id, role: task.role, title: task.title, status: 'pending', findings: 0, ...(p.kind ? { kind: p.kind } : {}) });
      }
      break;
    case 'task.taken': { const t = taskOf(run, p.taskId); if (t) { t.role = p.role; t.status = 'pending'; t.takenBy = { by: p.by || 'fit', role: p.role, fit: p.fit ?? null, reasons: p.reasons || [], agentId: p.agentId || null, engine: p.engine || null, why: p.why || '', at }; } const pt = run.plan?.tasks?.find((x) => x.id === p.taskId); if (pt) pt.role = p.role; break; }
    case 'task.posted': { const t = taskOf(run, p.taskId); if (t) t.job = p.job || null; if (p.job && !run.jobs.some((j) => j.id === p.job.id)) run.jobs.push({ ...p.job, taskId: p.taskId, at }); break; }
    case 'task.proposed': { const t = taskOf(run, p.taskId); if (t) t.proposal = { agent: p.agent || null, threadId: p.threadId || null, postId: p.postId || null, why: p.why || '', at }; break; }
    case 'task.unassigned': { const t = taskOf(run, p.taskId); if (t) { t.status = 'unassigned'; t.error = p.why || null; t.endedAt = at; } const j = run.jobs.find((x) => x.taskId === p.taskId); if (j) j.status = 'failed'; break; }
    case 'task.nudged': { const t = taskOf(run, p.taskId); if (t) t.nudged = [...(t.nudged || []), { grants: p.grants || [], at }]; break; }
    case 'run.role-added': if (p.role?.id && !run.roles.includes(p.role.id)) { run.roles.push(p.role.id); run.recruited = [...(run.recruited || []), { ...p.role, jobId: p.jobId || null, at }]; const j = run.jobs.find((x) => x.id === p.jobId); if (j) { j.status = 'recruited'; j.recruited = { agentId: p.role.agent || p.role.id, engine: p.role.engine || null, at }; } } break;
    case 'task.started': {
      // A start the plan never named (a record from a build whose merge was not a task) gets
      // its row here rather than being dropped — the fold never loses a task that ran.
      let t = taskOf(run, p.taskId);
      if (!t && p.taskId) { t = { id: p.taskId, role: p.role || null, title: p.title || p.taskId, status: 'pending', findings: 0, ...(p.taskId === 'merge' ? { kind: 'merge' } : {}) }; run.tasks.push(t); }
      if (t) { t.status = 'running'; t.startedAt = at; t.error = null; }
      run.status = 'running'; break;
    }
    case 'task.model': { const t = taskOf(run, p.taskId); if (t) { t.model = p.model; t.attempts = [...(t.attempts || []), { model: p.model, ...(p.label ? { label: p.label } : {}), at, attempt: p.attempt }]; } break; }
    // Which engine the attempt runs on (pillars §13): kept on the attempt, so a record folded
    // from events names the model the way the runner's own `attempts` do.
    case 'task.routed': { const t = taskOf(run, p.taskId); const a = t?.attempts?.at?.(-1); if (a && p.engine && (a.attempt == null || a.attempt === p.attempt)) a.engine = p.engine; break; }
    case 'task.step': { const t = taskOf(run, p.taskId); if (t && Array.isArray(p.steps)) t.transcript = [...(t.transcript || []), ...p.steps]; break; }
    case 'task.handoff': { const t = taskOf(run, p.taskId); if (t) { t.model = p.to; t.handoffs = [...(t.handoffs || []), { from: p.from, to: p.to, by: p.by, reason: p.reason, at }]; } break; }
    case 'task.tool': { const t = taskOf(run, p.taskId); if (t) t.tools = (t.tools || 0) + 1; break; }
    case 'task.delta': { const t = taskOf(run, p.taskId); if (t) t.text = String(p.text || '').slice(0, TASK_TEXT_MAX); break; }
    case 'task.finding':
      if (p.finding && p.finding.text) { run.board.push({ ...p.finding, at }); const t = taskOf(run, p.taskId); if (t) t.findings += 1; }
      break;
    case 'task.waiting': { const t = taskOf(run, p.taskId); if (t) { t.status = 'waiting'; t.waitingOn = p.threadId; } break; }
    case 'task.done':
    case 'task.failed': {
      const t = taskOf(run, p.taskId);
      if (t) { t.status = p.status || (type === 'task.done' ? 'ok' : 'failed'); t.error = p.error || null; t.ms = p.ms; t.endedAt = at; }
      // A job posting's outcome is the sub-task's (§15.2.5): taken by, finished how.
      const j = run.jobs.find((x) => x.taskId === p.taskId);
      if (j) { j.status = type === 'task.done' ? 'done' : 'failed'; j.endedAt = at; }
      break;
    }
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

/**
 * The run's spend against its cap, as a board shows it: the record's last `run.usage` (or
 * nothing spent yet) with `ms` measured LIVE for a run still going — the stored figure is as
 * of the last task's end, and a board read "0 s" through a ten-minute research task.
 */
export function spendOf(run, { now = Date.now() } = {}) {
  const cap = run?.usage?.cap || run?.budget || null;
  if (!cap || !Object.keys(cap).length) return null;
  const spent = { tokens: 0, calls: 0, usd: 0, ms: 0, ...(run?.usage?.spent || {}) };
  // The clock runs while the client is writing, and STOPS where it stopped: a run whose
  // record says `running` because its client died (or its end never landed) is not still
  // spending — it read "18m13s / 5m00s" and counting for a member that had finished.
  const st = runState(run, { now });
  if (LIVE_RUN_STATUSES.includes(run?.status) && run?.startedAt) spent.ms = Math.max(spent.ms || 0, (st.key === 'stalled' ? Number(run.lastEventAt) || now : now) - run.startedAt);
  const pct = cap.tokens ? Math.min(100, Math.round(((spent.tokens || 0) / cap.tokens) * 100)) : cap.ms ? Math.min(100, Math.round(((spent.ms || 0) / cap.ms) * 100)) : null;
  const over = BUDGET_KEYS.filter((k) => cap[k] && (spent[k] || 0) >= cap[k]);
  return { cap, spent, pct, exhausted: run?.usage?.exhausted || over[0] || null, over };
}
const BUDGET_KEYS = ['tokens', 'calls', 'usd', 'ms'];

export const STALLED_AFTER_MS = 2 * 60_000;

/**
 * What a run IS right now, for a person: the record's status read against the clock. A
 * record that says `running` with no event for minutes is STALLED — its client stopped
 * writing (died, or its end never landed) — not running. `{ key, label, tone, detail }`;
 * `tone` is the chip: on · warn · ok · err · muted.
 */
export function runState(run, { now = Date.now(), stalledAfterMs = STALLED_AFTER_MS } = {}) {
  const s = String(run?.status || 'planning');
  const quiet = Number.isFinite(run?.quietMs) ? run.quietMs : Math.max(0, now - (Number(run?.lastEventAt) || now));
  const agoText = (ms) => { const sec = Math.round(ms / 1000); return sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`; };
  if (s === 'waiting') return { key: 'waiting', label: 'waiting on you', tone: 'warn', detail: '' };
  if (LIVE_RUN_STATUSES.includes(s)) {
    if (run?.stale === true || quiet > stalledAfterMs) return { key: 'stalled', label: 'stalled', tone: 'err', detail: `no events for ${agoText(quiet)} — its client stopped writing; Resume here picks it up from the record` };
    return { key: 'running', label: s === 'merging' ? 'merging' : s === 'planning' ? 'planning' : 'running', tone: 'on', detail: `last event ${agoText(quiet)} ago` };
  }
  if (s === 'completed') return { key: 'done', label: 'done', tone: 'ok', detail: '' };
  if (s === 'partial') return { key: 'partial', label: 'done with failures', tone: 'warn', detail: 'a member failed; the rest merged' };
  if (s === 'answered') return { key: 'answered', label: 'answered — resume to continue', tone: 'warn', detail: '' };
  if (s === 'over-budget') return { key: 'over-budget', label: 'over budget', tone: 'err', detail: 'stopped with what it had' };
  if (s === 'stopped') return { key: 'stopped', label: 'stopped', tone: 'muted', detail: '' };
  if (s === 'failed') return { key: 'failed', label: 'failed', tone: 'err', detail: '' };
  return { key: s, label: s, tone: 'muted', detail: '' };
}

/**
 * Earlier runs whose work a new run should read before repeating it (§12.2.6, the librarian's
 * first step): the same team (or any, when `team` is empty), a request that says the same
 * thing (word overlap ≥ `minSimilarity`), findings on the record, not the run itself, newest
 * first. `runs` is the store's list (`findings` is a count there). Returns
 * `[{ id, at, similarity, findings }]`; the host fetches the record for the findings.
 */
export function priorWorkFor(runs, { team = '', request = '', excludeId = null, minSimilarity = 0.6, maxAgeMs = 7 * 24 * 3600_000, now = Date.now(), limit = 3 } = {}) {
  const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
  const want = words(request);
  if (!want.size) return [];
  const sim = (t) => { const have = words(t); if (!have.size) return 0; let hit = 0; for (const w of want) if (have.has(w)) hit += 1; return hit / Math.max(want.size, have.size); };
  return (runs || [])
    .filter((r) => r && r.id && r.id !== excludeId && (!team || r.team === team) && !LIVE_RUN_STATUSES.includes(r.status) && (Number(r.findings) || (Array.isArray(r.board) ? r.board.length : 0)) > 0 && now - (Number(r.createdAt) || 0) <= maxAgeMs)
    .map((r) => ({ id: r.id, at: r.createdAt, similarity: Math.round(sim(r.request) * 100) / 100, findings: Number(r.findings) || (Array.isArray(r.board) ? r.board.length : 0), status: r.status }))
    .filter((r) => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity || b.at - a.at)
    .slice(0, limit);
}

const secs = (ms) => { const s = Math.max(0, Math.round((Number(ms) || 0) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const num = (n) => (Number(n) || 0).toLocaleString('en-US');

/** One line: `1,240 / 40,000 tokens · 3 / 20 calls · 2m10s / 15m00s`. Only the capped dimensions. */
export function describeSpend(spend) {
  if (!spend?.cap) return '';
  const { cap, spent } = spend;
  const over = (k) => ((spend.over || []).includes(k) ? ' (over)' : '');
  return [
    cap.tokens ? `${num(spent.tokens)} / ${num(cap.tokens)} tokens${over('tokens')}` : '',
    cap.calls ? `${num(spent.calls)} / ${num(cap.calls)} calls${over('calls')}` : '',
    cap.usd ? `$${(Number(spent.usd) || 0).toFixed(2)} / $${Number(cap.usd).toFixed(2)}${over('usd')}` : '',
    cap.ms ? `${secs(spent.ms)} / ${secs(cap.ms)}${over('ms')}` : '',
  ].filter(Boolean).join(' · ');
}
