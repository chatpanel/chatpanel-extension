// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-run.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A run — a turn of turns: plan, fan out, merge, propose. One runner for every client.
//
// The runner never speaks to a model and never runs a tool. `callModel` is the host's own
// model turn (the extension's streamChat, the desktop's gateway call — redaction on the way
// out, restore on the way back, the tool loop with its round, shield and gate inside it);
// `toolsFor(role)` is the host's own toolset narrowed to the role's grants. A team therefore
// cannot reach what a single turn cannot, and every guard a client earned stays in force.
//
// Tasks run in WAVES (team-plan.js): everything with its dependencies met runs together
// through the same pool a tool round uses; a dependent task waits and reads the board. A
// member may REQUEST a piece of its task be done by someone else (board tool `request`,
// team-subtask.js): the sub-task joins the plan with its own thread under the parent's, is
// offered to the members that fit, then to the pool through the host's `recruit`, then
// proposed as a new agent to the person — so the plan is a tree the board draws as one. A
// task ends with findings; the merge turns the board into ONE proposal — agreed claims
// (converge, W7), a judged answer, or the members' work side by side — and the proposal is
// what a person sees. Nothing here lands anywhere.
//
// Budget first. `createBudget` refuses a team without one; before every model call the run
// asks `canAfford`, and a run that cannot afford its next call stops with what it has and
// says so (`status: 'over-budget'`). Stop is one signal, fanned out.

import { normalizeTeam } from './team.js';
import { normalizeEngine, normalizeScm } from './scorecard.js';
import { createBudget } from './budget.js';
import { fixedPlan, plannerPrompt, parsePlan } from './team-plan.js';
import { createBoard, parseFindings, boardText, findingsInstruction, toBriefClaims, RUNNER, PERSON } from './team-board.js';
import { subtaskFromRequest, takeUp, takeUpLine, jobFromSubtask, extendDependents, MAX_SUBTASKS, MAX_DEPTH } from './team-subtask.js';
import { proposalToAgent, proposalFromNeeds } from './recruit.js';
import { grantsNeededFor } from './tool-need.js';
import { boardToolProvider, createAnswerBox, withBoardTool, DEFAULT_ASK_TIMEOUT_MS } from './board-tool.js';
import { createRunCache, withRunCache } from './team-cache.js';
import { messagesFor, mergeTranscript, clipTranscript, clipMessage as clipTranscriptOne, newSteps, continuationNote, isThought } from './team-task.js';
import { converge } from './promotion.js';

export const RUN_STATUSES = Object.freeze(['planning', 'running', 'merging', 'waiting', 'completed', 'partial', 'over-budget', 'stopped', 'failed']);
const DEFAULT_CONCURRENCY = 3;

export class TeamRunError extends Error {
  constructor(code, message) { super(message); this.name = 'TeamRunError'; this.code = code; }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return out;
}

const TIER = { cheap: 0, balanced: 1, strong: 2 };
const strongestRole = (team) => [...team.roles].sort((a, b) => (TIER[b.prefer] ?? 1) - (TIER[a.prefer] ?? 1))[0];

/**
 * What a person sees before approving a run: every role with the model it would get, its
 * grants and mode; the plan when it is fixed (a planner plans at run time); the budget.
 */
/**
 * Was this failure the MODEL being unreachable — not found, not deployed, no key, gone —
 * rather than the request being wrong? The runner re-appoints on these and gives up on the
 * rest. Provider wording varies; what they share is that a different model would answer.
 */
export function isModelUnavailable(error) {
  const m = String(error?.message || error || '');
  // Also: a relayed agent that exited, a provider that closed the stream, and a turn that
  // came back with nothing — the model did not answer, and the next one might. A refusal,
  // a timeout the caller set, a bad request or a budget stop are not this.
  // A server that is not there: Node says ECONNREFUSED, a browser says only "Failed to
  // fetch" (the extension reports it as "network error") — a local model killed mid-run
  // arrived as the latter and ended the task on its first attempt with Claude Code sitting
  // idle on the roster.
  return /model[_ ]not[_ ]found|not found|not deployed|inaccessible|does not exist|no such model|unknown model|unsupported model|not available|unavailable|no api key|not configured|"status":\s*(404|401|403|500|502|503)\b|\b(404|401|403|502|503)\b|exited \d+|returned no answer|did not answer|closed the connection|couldn't reach|could not reach|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|socket hang up|fetch failed|failed to fetch|load failed|network ?error|overloaded|capacity/i.test(m);
}

export function dryRunTeam(team, request, { appoint = null } = {}) {
  const t = normalizeTeam(team);
  const roles = t.roles.map((r) => {
    const a = appoint ? appoint(r) : null;
    // `model` is what callModel will be handed (a target id in a client that resolves ids);
    // `label` is what a person should read — the appointer says which, when it knows.
    return { id: r.id, name: r.name, mode: r.mode, prefer: r.prefer, model: a?.model || r.model || null, label: a?.label || a?.model || r.model || null, appointed: !!(a?.model || r.model), grants: r.grants, ...(r.recipe ? { recipe: r.recipe } : {}) };
  });
  const missing = roles.filter((r) => r.mode !== 'recipe' && !r.appointed).map((r) => r.id);
  return {
    name: t.name, description: t.description, plan: t.plan, merge: t.merge, judge: t.judge, budget: t.budget, roles,
    tasks: t.plan === 'fixed' ? fixedPlan(t, request) : null,
    ok: missing.length === 0,
    missing,
  };
}

/**
 * @param callModel  `async ({ runId, taskId, role, model, mode, system, prompt, tools, signal, onDelta }) =>
 *                   { ok, text, usage?, error?, aborted?, scm? }` — the host's model turn; `scm`
 *                   is what a harness did in a git checkout (`{ repo, branch, head, headAfter,
 *                   commits }`), when the bridge reported one
 * @param toolsFor   `(role) => toolset | undefined` — narrowed to the role's grants by the host
 * @param appoint    `(role) => { model, mode, engine?, reasons?, alternatives? } | null` — the host's
 *                   roster through cowriter-router. `engine` (`{ kind: 'model'|'harness', id,
 *                   model? }`) says WHAT the model id is, so the record can split by it;
 *                   `reasons` and `alternatives` are why this one and who else could have —
 *                   said as `task.routed`, which every run records from here on (pillars §13)
 * @param runRecipe  `async (name, params) => result` for `mode: 'recipe'` roles (optional)
 * @param recruit    `async (job, { runId, requestedBy, create? }) => { role, agentId?, engine?, why?, fit? }
 *                   | { proposal? , why? } | null` — the host's job board (recruit.js over its
 *                   pool): a sub-task nobody in the run fits is posted as `job`; the host
 *                   answers with the role to add (job.js jobToRole, resolved to a model), or
 *                   nothing, optionally with the agent it would propose. With `create` (the
 *                   card a person approved on the board) the host adds it to the pool first.
 *                   Absent, a sub-task nobody fits is recorded unassigned.
 * @param projectId  the project a job posting belongs to, when the run has one (else the run id)
 * @param emit       `(type, payload)` — run.started · plan.ready · task.started · task.finding ·
 *                   task.done · task.failed · run.merging · run.done; the host forwards them to
 *                   its UI and to the gateway's run store
 */
export async function runTeam({
  team, request, callModel, toolsFor = () => undefined, appoint = null, runRecipe = null,
  now = () => Date.now(), newId = () => `run_${Math.random().toString(36).slice(2, 10)}`,
  emit = () => {}, signal = null, maxConcurrency = DEFAULT_CONCURRENCY, runId = null,
  // Asks: the box a person's answers arrive in (the host feeds it from its UI and from the
  // run store's tail), and how long a member waits before the run checkpoints. 0 = a member
  // that asks is told to proceed on its own assumption at once.
  answers = null, askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS,
  // A checkpoint from a run that ended `waiting` — see resumeTeam.
  resume = null,
  // The host's control channel (team-task.js createControl): a person hands a task to another
  // model from the board, on either client; the runner continues the task's transcript there.
  control = null,
  recruit = null, projectId = null,
  // Earlier runs' findings for the same request (team-record.js priorWorkFor, fetched by the
  // host): `[{ runId, at, request?, findings: [...] }]`. Posted as a "Prior work" thread every
  // member reads before repeating a lookup — the librarian's first step (§12.2.6).
  prior = null,
} = {}) {
  if (typeof callModel !== 'function') throw new TeamRunError('BAD_RUN', 'callModel required');
  const t = normalizeTeam(team); // throws on a team without a budget — O1
  const id = runId || resume?.runId || newId();
  const budget = createBudget(resume?.budget?.cap || t.budget, { now });
  if (resume?.budget?.spent) budget.charge({ tokens: resume.budget.spent.tokens, calls: resume.budget.spent.calls, usd: resume.budget.spent.usd });
  const say = (type, payload = {}) => emit(type, { runId: id, at: now(), ...payload });
  // Every change to the board is an event the run store folds — the other client reads it live.
  const board = createBoard({ now, state: resume?.board || null, onEvent: (type, ev) => say(type, ev) });
  // No answer box from the host means nobody can answer: asks are off, a member that asks is
  // told to proceed on its own assumption at once, and the budget stop is final.
  const runCache = createRunCache(); // one lookup per run, across members
  const box = answers || createAnswerBox();
  const askMs = answers ? askTimeoutMs : 0;
  const startedAt = resume?.startedAt || now();
  // Tasks a checkpoint already finished are carried over, not re-run. Tasks it left
  // interrupted — waiting, stopped, failed, or running when the process died — are resumed
  // from their transcripts, not started again.
  const tasksOut = (resume?.tasks || []).filter((x) => x.status === 'ok').map((x) => ({ ...x }));
  const carried = new Set(tasksOut.map((x) => x.id));
  const interrupted = new Map((resume?.tasks || []).filter((x) => x.status !== 'ok' && Array.isArray(x.transcript) && x.transcript.length).map((x) => [x.id, x]));
  const roleOf = (rid) => t.roles.find((r) => r.id === rid);
  // `exclude` holds what failed as unavailable this run; a re-appointment skips it. A role's
  // pinned model is tried first and, when it is the one that failed, the roster steps in.
  const modelFor = (r, exclude = null) => {
    if (exclude?.size && r.model && exclude.has(r.model)) return appoint ? appoint({ ...r, model: undefined }, { exclude }) : null;
    return (appoint ? appoint(r, { exclude }) : null) || (r.model && !exclude?.has(r.model) ? { model: r.model, mode: r.mode } : null);
  };
  const MAX_APPOINTMENTS = 3;
  // The routing decision, on the record: which engine, why, who else could have. A host that
  // does not say the kind gets `model` — the honest default for a bare id; the pilot's hosts
  // both say. Exploration (a tier cheaper on purpose) is the project loop's, later; false here.
  const routeOf = (m, role, { attempt = 1, exclude = null, handoff = null } = {}) => {
    const reasons = Array.isArray(m.reasons) ? m.reasons.map(String) : [];
    if (handoff) reasons.unshift(`handed off by ${handoff.by}${handoff.reason ? ` — ${handoff.reason}` : ''}`);
    else if (!reasons.length && role.model && m.model === role.model) reasons.push('pinned by the role');
    if (attempt > 1 && exclude?.size) reasons.push(`after ${[...exclude].join(', ')} (unavailable)`);
    return {
      engine: normalizeEngine(m.engine || { id: m.model }),
      reasons,
      alternatives: (Array.isArray(m.alternatives) ? m.alternatives : []).slice(0, 5).map((a) => normalizeEngine(a)).filter(Boolean),
      exploration: false,
    };
  };
  // A model that was not there for one member is not there for the next: what failed as
  // unavailable anywhere in this run is skipped by every later appointment. Two members
  // each spent two minutes finding out the same agent was down.
  const runExclude = new Set();
  const excluding = (local) => new Set([...runExclude, ...(local || [])]);
  const stopped = () => !!signal?.aborted;

  say(resume ? 'run.resumed' : 'run.started', { team: t.name, request: String(request || ''), budget: budget.cap, roles: t.roles.map((r) => r.id), ...(resume ? { carried: [...carried] } : {}) });

  // ── plan ──────────────────────────────────────────────────────────────────────────────
  let tasks = resume?.plan?.tasks?.length ? resume.plan.tasks : null;
  let planBy = resume?.plan?.by || 'fixed';
  if (!tasks && t.plan === 'planner') {
    const planner = strongestRole(t);
    const m = modelFor(planner);
    if (m && budget.canAfford({ tokens: 0 })) {
      const res = await callModel({ runId: id, taskId: 'plan', role: planner.id, model: m.model, mode: 'model', system: '', prompt: plannerPrompt(t, request), tools: undefined, signal });
      if (res?.usage) budget.charge(res.usage);
      const parsed = res?.ok ? parsePlan(res.text, t) : [];
      if (parsed.length) { tasks = parsed; planBy = 'planner'; }
    }
  }
  if (!tasks) tasks = fixedPlan(t, request);
  say('plan.ready', { by: planBy, tasks: tasks.map((x) => ({ id: x.id, role: x.role, title: x.title, dependsOn: x.dependsOn, ...(x.parent ? { parent: x.parent, requestedBy: x.requestedBy || null } : {}), ...(x.grants ? { grants: x.grants, why: x.why || '' } : {}) })) });
  // A thread per task, before anything runs: a member's findings and replies have a home.
  for (const task of tasks) board.openThread({ taskId: task.id, kind: 'task', title: task.title || task.id, by: task.requestedBy || RUNNER, ...(task.parent ? { parent: task.parent } : {}), ...(task.role && task.parent ? { holder: task.role } : {}) });
  // PRIOR WORK: what an earlier run already found for this request is on the board before
  // anyone starts — a discussion thread per run, its findings as posts with their refs — so a
  // second run of the same question reads instead of re-searching. Only findings a person did
  // not reject; at most 40 per run.
  if (!resume && Array.isArray(prior)) {
    for (const pr of prior.filter((x) => x && Array.isArray(x.findings) && x.findings.length)) {
      const age = Number.isFinite(pr.at) ? Math.max(0, Math.round((now() - pr.at) / 60000)) : null;
      const th = board.openThread({ kind: 'discussion', title: `Prior work — run ${pr.runId}${age != null ? ` (${age < 60 ? `${age} min` : `${Math.round(age / 60)} h`} ago)` : ''}`, by: RUNNER });
      board.post({ threadId: th.id, by: RUNNER, kind: 'note', text: `An earlier run answered ${pr.request ? `"${String(pr.request).slice(0, 200)}"` : 'the same request'}. Its findings follow — read them, verify what is stale, and do not repeat lookups already made.`, refs: [`run:${pr.runId}`] });
      let n = 0;
      for (const f of pr.findings) {
        if (!f || !f.text || f.status === 'rejected' || n >= 40) continue;
        board.post({ threadId: th.id, by: f.role || RUNNER, kind: 'finding', text: String(f.text).slice(0, 2000), refs: [...(Array.isArray(f.refs) ? f.refs : []), `run:${pr.runId}`].slice(0, 8), finding: { kind: f.kind || 'claim', confidence: f.confidence ?? null, prior: true } });
        n += 1;
      }
      say('run.prior', { from: pr.runId, threadId: th.id, findings: n });
    }
  }
  // The planner's TOOL PROPOSAL (§15.2): which tools each task will need and why, as a
  // proposal thread a person reads — and what the nudge below holds the member to.
  if (!resume && tasks.some((x) => x.grants?.length)) {
    const th = board.openThread({ kind: 'proposal', title: 'Tools per task', by: t.roles.find((r) => r.id === (tasks[0]?.role))?.id || RUNNER });
    const lines = tasks.filter((x) => x.grants?.length).map((x) => { const held = t.roles.find((r) => r.id === x.role)?.grants || []; const missing = x.grants.filter((g) => !held.includes(g) && !(g.startsWith('mcp:') && held.includes('mcp'))); return `${x.role} (${x.id}): ${x.grants.join(', ')}${x.why ? ` — ${x.why}` : ''}${missing.length ? ` (not granted: ${missing.join(', ')})` : ''}`; });
    board.post({ threadId: th.id, by: RUNNER, kind: 'draft', status: 'proposed', text: lines.join('\n') });
  }

  const finish = (status, extra = {}) => {
    const usage = budget.snapshot();
    const out = { runId: id, team: t.name, status, plan: { by: planBy, tasks }, tasks: tasksOut, board: board.all(), threads: board.state(), usage, lookups: { distinct: runCache.size, shared: runCache.shared }, startedAt, endedAt: now(), ...extra };
    // What a resume needs, on the record: the plan, what finished, the board, the spend.
    // A run that did not complete can be resumed from its record — the plan, every task's
    // transcript and status, the board, the spend — by any client, any time later.
    if (status !== 'completed') out.checkpoint = { runId: id, startedAt, plan: { by: planBy, tasks }, tasks: tasksOut.map((x) => ({ ...x, findings: undefined })), board: board.state(), budget: { cap: budget.cap, spent: usage.spent }, budgetAsked: !!extra.budgetAsked };
    say('run.done', { status, usage, proposal: out.proposal || null, failedTaskIds: tasksOut.filter((x) => x.status === 'failed').map((x) => x.id), waitingTaskIds: tasksOut.filter((x) => x.status === 'waiting').map((x) => x.id), ...(out.checkpoint ? { checkpoint: out.checkpoint } : {}) });
    return out;
  };

  /**
   * The runner asks the person (a budget, a direction). Same thread shape as a member's ask;
   * answered from either client; null when nobody answered in time or asks are off.
   */
  const askPerson = async ({ type, text, options, taskId = null }) => {
    if (askMs <= 0) return null;
    const { thread } = board.ask({ taskId, by: RUNNER, type, text, options, timeoutMs: askMs });
    say('run.waiting', { threadId: thread.id, askType: type, text, options });
    return box.wait(thread.id, askMs, signal);
  };
  let waitingOnPerson = false; // a task that timed out on its ask — the run checkpoints

  // ── fan out: everything ready runs together; a sub-task requested mid-run joins the plan ──
  let overBudget = false;
  let budgetAsked = !!resume?.budgetAsked;
  const running = new Set();
  const isDone = (tid) => carried.has(tid) || tasksOut.some((x) => x.id === tid);
  // A sub-task with no holder cannot run; it is recorded `unassigned` at the end.
  const ready = () => tasks.filter((x) => x.role && !isDone(x.id) && !running.has(x.id) && (x.dependsOn || []).every(isDone));
  let subtasks = tasks.filter((x) => x.parent).length;

  /**
   * A member's REQUEST (board tool `request`): a sub-task with its own thread, offered to the
   * run's members first, then to the pool through the host's `recruit`, then proposed as a
   * new agent to the person. With `wait` the requester gets the findings back in its turn;
   * without, the sub-task runs after it and whoever depended on the requester reads it too.
   */
  const onRequest = async (parentTask, role, req) => {
    if (subtasks >= MAX_SUBTASKS) return { error: `This run has reached its limit of ${MAX_SUBTASKS} sub-tasks. Do this yourself, or say what you could not do.` };
    if ((Number(parentTask.depth) || 0) >= MAX_DEPTH) return { error: 'A sub-task cannot delegate further. Do this yourself, or say what you could not do.' };
    if (stopped() || overBudget) return { error: 'The run is stopping; do what you can and finish.' };
    subtasks += 1;
    const sub = subtaskFromRequest(req, parentTask, { id: `${parentTask.id}-s${subtasks}`, by: role.id, now: now() });
    tasks.push(sub);
    say('task.requested', { taskId: sub.id, parent: parentTask.id, by: role.id, title: sub.title, prompt: sub.prompt, needs: sub.needs, dependsOn: sub.dependsOn, depth: sub.depth, wait: sub.wait, postId: req.postId || null });
    const thread = board.openThread({ taskId: sub.id, kind: 'task', title: sub.title, by: role.id, parent: parentTask.id });
    // 1. The run's own members, by fit on skills and grants.
    let pick = takeUp(sub, t.roles, { exclude: [role.id] });
    let takenBy = null;
    if (pick.roleId) {
      takenBy = { by: 'fit', roleId: pick.roleId, fit: pick.fit, reasons: pick.reasons };
    } else if (typeof recruit === 'function') {
      // 2. The job board: the pool applies, the host recruits an (agent, engine) pair.
      const job = jobFromSubtask(sub, { runId: id, projectId: projectId || null, by: role.id });
      say('task.posted', { taskId: sub.id, job, why: pick.why });
      board.post({ threadId: thread.id, by: RUNNER, kind: 'note', text: `Posted on the job board — ${pick.why}. Needs: ${describeNeeds(sub.needs)}.` });
      let r = null;
      try { r = await recruit(job, { runId: id, requestedBy: role.id }); } catch (e) { board.post({ threadId: thread.id, by: RUNNER, kind: 'note', text: `Recruiting failed: ${String(e?.message || e).slice(0, 200)}` }); }
      if (r?.role) {
        takenBy = { by: 'recruit', roleId: addRole(r.role, job), agentId: r.agentId || r.role.agent || null, engine: r.engine || null, why: r.why || '', fit: r.fit ?? null };
      } else {
        // 3. Nobody applies: propose the agent the job describes — a person decides; nothing
        // is created here. With asks on, the person is asked now and the run goes on either way.
        const card = r?.proposal || proposalToAgent(proposalFromNeeds(job), job, { by: 'runner' });
        const agentCard = card?.ok === false ? null : (card?.agent || card);
        const pth = board.openThread({ kind: 'proposal', title: `New agent for "${sub.title}"`, by: RUNNER, parent: parentTask.id });
        const post = board.post({ threadId: pth.id, by: RUNNER, kind: 'draft', status: 'proposed', text: `No one in the pool fits "${sub.title}"${r?.why ? ` — ${r.why}` : ''}. Proposed: ${agentCard?.name || sub.title}${agentCard?.skills?.length ? ` — skills ${agentCard.skills.join(', ')}` : ''}${agentCard?.grants?.length ? `; grants ${agentCard.grants.join(', ')}` : ''}.`, refs: [`task:${sub.id}`], ...(agentCard ? { proposal: { kind: 'agent', agent: agentCard, jobId: job.id } } : {}) });
        say('task.proposed', { taskId: sub.id, threadId: pth.id, postId: post.id, agent: agentCard, job, why: r?.why || pick.why });
        const a = agentCard ? await askPerson({ type: 'permission', taskId: sub.id, text: `No one fits "${sub.title}". Create the agent "${agentCard.name}" (${describeNeeds({ skills: agentCard.skills, grants: agentCard.grants })}) and give it the job?`, options: ['Create it', 'Skip'] }) : null;
        if (a && /create|yes|approve|allow|go/i.test(a.text)) {
          board.decide(post.id, 'approved', a.by || PERSON);
          let made = null;
          try { made = await recruit(job, { runId: id, requestedBy: role.id, create: agentCard }); } catch (e) { board.post({ threadId: thread.id, by: RUNNER, kind: 'note', text: `Creating the agent failed: ${String(e?.message || e).slice(0, 200)}` }); }
          if (made?.role) takenBy = { by: 'created', roleId: addRole(made.role, job), agentId: made.agentId || made.role.agent || null, engine: made.engine || null, why: made.why || 'created for this job', fit: null };
        } else if (a) board.decide(post.id, 'rejected', a.by || PERSON);
      }
    }
    if (!takenBy) {
      const why = typeof recruit === 'function' ? 'nobody in the run fits and no agent was recruited' : `${pick.why}; this run has no pool to recruit from`;
      board.post({ threadId: thread.id, by: RUNNER, kind: 'note', text: `Not taken: ${why}.` });
      board.setThreadStatus(thread.id, 'failed');
      say('task.unassigned', { taskId: sub.id, why });
      return { taskId: sub.id, takenBy: null, why, hint: 'Nobody could take this. Do what you can yourself and say what is missing.' };
    }
    sub.role = takenBy.roleId;
    board.setThreadStatus(thread.id, 'open', { holder: takenBy.roleId });
    board.post({ threadId: thread.id, by: RUNNER, kind: 'decision', text: takenBy.by === 'fit' ? takeUpLine(sub, pick) : `${takenBy.roleId} ${takenBy.by === 'created' ? 'was created and' : 'was recruited from the pool and'} took: ${sub.title}${takenBy.why ? ` — ${takenBy.why}` : ''}` });
    say('task.taken', { taskId: sub.id, role: takenBy.roleId, by: takenBy.by, fit: takenBy.fit ?? null, reasons: takenBy.reasons || [], agentId: takenBy.agentId || null, engine: takenBy.engine || null, why: takenBy.why || '' });
    if (sub.wait) {
      // Nested: the requester's turn holds while the sub-task runs; its findings come back here.
      const row = await runTask(sub);
      return { taskId: sub.id, takenBy: takenBy.roleId, status: row.status, ...(row.error ? { error: row.error } : {}), findings: (row.findings || []).map((f) => ({ kind: f.kind, text: f.text, refs: f.refs })), text: String(row.text || '').slice(0, 4000) };
    }
    const extended = extendDependents(tasks, parentTask.id, sub.id);
    return { taskId: sub.id, takenBy: takenBy.roleId, queued: true, hint: `It runs after your task; ${extended.length ? `${extended.join(', ')} will read it too` : 'its findings will be on the board'}. Finish your task and say what depends on it.` };
  };
  /** A recruited agent joins the run as a role — the job's grants narrow it — and is appointed like any other. */
  const addRole = (role, job) => {
    const base = { ...role, id: String(role.id || job.id), grants: role.grants || job.needs?.grants || ['none'] };
    const nt = normalizeTeam({ name: t.name, roles: [base], budget: t.budget });
    const r = { ...nt.roles[0], ...(role.model ? { model: role.model } : {}), ...(role.engine ? { engine: role.engine } : {}), ...(role.skills ? { skills: role.skills } : {}), ...(role.workdir ? { workdir: role.workdir } : {}), recruited: true };
    if (!t.roles.some((x) => x.id === r.id)) { t.roles.push(r); say('run.role-added', { role: { id: r.id, name: r.name, agent: r.agent || null, grants: r.grants, model: r.model || null, engine: r.engine || null }, jobId: job.id }); }
    return r.id;
  };

  const runTask = async (task) => {
    running.add(task.id);
    try { return await runTaskInner(task); } finally { running.delete(task.id); }
  };
  const runTaskInner = async (task) => {
      if (stopped() || overBudget || waitingOnPerson) { const row = { id: task.id, role: task.role, status: 'skipped', text: '', findings: [] }; tasksOut.push(row); return row; }
      const role = roleOf(task.role);
      const t0 = now();
      const was = interrupted.get(task.id) || null;
      say('task.started', { taskId: task.id, role: task.role, title: task.title, ...(task.parent ? { parent: task.parent } : {}), ...(was ? { resumed: true, steps: was.transcript.length } : {}) });
      let text = '';
      let usage = null;
      let status = 'ok';
      let error = null;
      // THE TASK'S TRANSCRIPT — its conversation so far, apart from any one model. An attempt
      // continues it; a hand-off continues it on another model; a resume continues it from
      // the record. Only a task that has never been attempted starts from the bare prompt.
      let transcript = was ? [...was.transcript] : [];
      const attempts = was?.attempts ? [...was.attempts] : [];
      let routed = null; // the last routing decision, on the task row
      let scm = null; // what the last attempt did in a checkout
      // The task's own abort: an ask nobody answered in time stops THIS member's turn (the
      // run then checkpoints), without stopping the run's other members. A person's hand-off
      // aborts it too, and names where the task continues.
      let taskAc = new AbortController();
      const onRunAbort = () => taskAc.abort();
      signal?.addEventListener?.('abort', onRunAbort, { once: true });
      let askedAndWaiting = null;
      let handoffTo = control?._pendingFor?.(task.id) || null;
      const unsubscribe = control?._subscribe?.((req) => {
        if (req.type !== 'handoff' || req.taskId !== task.id) return false;
        handoffTo = req; taskAc.abort(); return true;
      }) || null;
      // Every recorded step says when and under which attempt — the board's work log and the
      // scorecard read the task by these, so a step reported after the fact is stamped now.
      let attemptNo = 0;
      const stamp = (m) => clipTranscriptOne({ ...m, at: Number.isFinite(m?.at) ? m.at : now(), attempt: Number.isFinite(m?.attempt) ? m.attempt : attemptNo });
      const recordSteps = (before, after) => {
        const added = newSteps(before, after);
        if (added.length) say('task.step', { taskId: task.id, role: role.id, steps: added.map(stamp) });
      };
      // The tool-choice guard (§15.2): what this task's wording — and the planner's proposal —
      // say it needs among what the role holds. A model attempt that ends with zero calls
      // while holding one of these is nudged once, then may finish.
      const grantsHeld = role?.grants || [];
      const mustUse = role?.mode === 'model' ? [...new Set([...grantsNeededFor(task.prompt, { held: grantsHeld }), ...(task.grants || []).filter((g) => grantsHeld.includes(g) || (g.startsWith('mcp:') && grantsHeld.includes('mcp')))])] : [];
      let nudged = false;
      try {
        if (!role) throw new Error(`no role "${task.role}" in the team`);
        if (role.mode === 'recipe') {
          if (typeof runRecipe !== 'function') throw new Error('this host cannot run recipes');
          const r = await runRecipe(role.recipe, { request: String(request || ''), task: task.prompt });
          text = typeof r === 'string' ? r : JSON.stringify(r);
        } else {
          // A call's tokens are unknown until it returns; what can be asked beforehand is
          // whether the budget is already exhausted and whether one more call is allowed.
          if (!budget.canAfford({ tokens: 0 })) { overBudget = true; throw new Error('over budget'); }
          // What this member reads: the threads of the tasks it depends on, answered asks (its
          // own — a resumed task finds the person's answer here), settled discussions.
          const prior = boardText(board, { taskIds: task.dependsOn?.length ? task.dependsOn : null, role: role.id });
          const prompt = [task.prompt, prior, findingsInstruction()].filter(Boolean).join('\n\n');
          // A host may build a toolset asynchronously (connecting MCP servers takes time).
          // The board tool rides on top of whatever the role was granted.
          const boardTool = boardToolProvider({
            board, role: role.id, taskId: task.id, taskIds: task.dependsOn?.length ? task.dependsOn : null, askTimeoutMs: askMs, signal: taskAc.signal,
            onAsk: (thread) => { say('task.waiting', { taskId: task.id, role: role.id, threadId: thread.id, text: thread.title }); },
            onRequest: (req) => onRequest(task, role, req),
            waitFor: askMs > 0 ? async (threadId, ms, sig) => {
              const a = await box.wait(threadId, ms, sig);
              if (!a && !stopped()) { askedAndWaiting = threadId; taskAc.abort(); }
              return a;
            } : null,
          });
          const tools = withBoardTool(withRunCache(await toolsFor(role), runCache, { role: role.id }), boardTool);
          // A model that is not there — not deployed, no key, gone — is not the task failing:
          // the next model on the roster is appointed and the task tried again, up to three
          // models. Anything else (a refusal, a timeout, a bad request) fails the task.
          const exclude = new Set();
          let lastErr = '';
          // What the next attempt is told, when it continues rather than starts.
          let note = was ? continuationNote(was.status === 'waiting' ? { kind: 'answer', answer: 'see the board' } : { kind: 'resume', reason: was.error || was.status }) : null;
          let lastModel = was?.attempts?.at?.(-1)?.model || null;
          for (let attempt = 1; ; attempt++) {
            let m;
            const handoffNow = handoffTo;
            if (handoffTo) {
              // A person's hand-off names the model; the task continues there whatever the
              // roster would have chosen. Said on the board, so everyone knows who has it.
              m = { model: handoffTo.model, mode: role.mode };
              const th = board.threadForTask(task.id);
              if (th) board.post({ threadId: th.id, by: RUNNER, kind: 'decision', text: `Handed off from ${lastModel || 'the roster'} to ${handoffTo.model} by ${handoffTo.by}${handoffTo.reason ? ` — ${handoffTo.reason}` : ''}.` });
              say('task.handoff', { taskId: task.id, role: role.id, from: lastModel, to: handoffTo.model, by: handoffTo.by, reason: handoffTo.reason || '' });
              note = continuationNote({ kind: 'handoff', from: lastModel, to: handoffTo.model, reason: `handed off by ${handoffTo.by}` });
              handoffTo = null;
              taskAc = new AbortController(); signal?.addEventListener?.('abort', onRunAbort, { once: true });
            } else if (nudged && lastModel && !exclude.has(lastModel)) {
              m = { model: lastModel, mode: role.mode }; // the nudge continues on the same model
            } else {
              m = modelFor(role, excluding(exclude));
            }
            if (!m?.model) throw new Error(exclude.size ? `no model left for role "${role.id}" after ${[...exclude].join(', ')}` : `no model for role "${role.id}"`);
            if (attempt > 1 && lastErr) say('task.reappointed', { taskId: task.id, role: role.id, model: m.model, after: [...exclude], error: lastErr });
            // Who is doing this task, for a ledger that shows the lanes — said per attempt.
            say('task.model', { taskId: task.id, role: role.id, model: m.model, attempt });
            routed = routeOf(m, role, { attempt, exclude, handoff: handoffNow });
            say('task.routed', { taskId: task.id, role: role.id, attempt, ...routed });
            attempts.push({ model: m.model, engine: routed.engine, at: now(), continued: !!note });
            attemptNo = attempts.length;
            const sent = messagesFor({ transcript }, { prompt, note });
            // The record grows AS THE ATTEMPT GOES: a host that reports each wire message the
            // moment it exists (a tool call, its result) puts it on the record then, so a
            // process that dies mid-attempt leaves the work so far behind it, not nothing.
            let live = sent;
            // (thoughts are on the record but not on the wire, so compare against the wire's view)
            const wireBefore = transcript.filter((m) => !isThought(m));
            if (sent.length > wireBefore.length) recordSteps(wireBefore, sent);
            const onStep = (message) => { if (message && message.role) { live = [...live, message]; say('task.step', { taskId: task.id, role: role.id, steps: [stamp(message)] }); } };
            const res = await callModel({
              runId: id, taskId: task.id, role: role.id, model: m.model, mode: m.mode || role.mode,
              system: role.prompt, prompt, messages: sent, tools, signal: taskAc.signal,
              onDelta: (delta, full) => say('task.delta', { taskId: task.id, role: role.id, delta, text: full }),
              onStep,
            });
            usage = res?.usage || null;
            if (usage) budget.charge(usage);
            // What the attempt did in a checkout, when the host's harness reported one (§14).
            if (normalizeScm(res?.scm)) { scm = normalizeScm(res.scm); say('task.scm', { taskId: task.id, role: role.id, ...scm }); }
            // Whatever the attempt did is the task's now — on the record, before any verdict.
            // What the host already reported step by step is not reported again.
            transcript = mergeTranscript(sent, res);
            if (transcript.length < live.length) transcript = live;
            recordSteps(live, transcript);
            lastModel = m.model;
            attempts[attempts.length - 1].status = res?.ok ? (String(res?.text || '').trim() ? 'ok' : 'empty') : 'error';
            if (askedAndWaiting) { status = 'waiting'; waitingOnPerson = true; break; }
            if (handoffTo) { note = null; continue; } // the person moved it: continue the transcript there
            if (res?.aborted || taskAc.signal.aborted) { status = 'stopped'; break; }
            // A turn that ended with nothing to say — an agent that exited, a stream that
            // died after its tool calls — is not a done task: three members "completed" empty
            // once, the run merged nothing, and the caller ran the team again. It is treated
            // like an unavailable model, so the next one on the roster gets the task.
            if (res?.ok && String(res?.text || '').trim()) {
              // Answered from memory while holding a tool the task calls for: one nudge, on
              // the same model, continuing the transcript — then whatever it says stands.
              const usedNone = !nudged && mustUse.length && routed?.engine?.kind !== 'harness' && !transcript.some((x) => x.role === 'assistant' && Array.isArray(x.tool_calls) && x.tool_calls.some((c) => c.function?.name && c.function.name !== 'board'));
              if (usedNone && budget.canAfford({ tokens: 0 }) && !stopped()) {
                nudged = true;
                note = continuationNote({ kind: 'nudge', reason: mustUse.join(', ') });
                const th = board.threadForTask(task.id);
                if (th) board.post({ threadId: th.id, by: RUNNER, kind: 'note', text: `${role.id} answered without using ${mustUse.join(', ')}, which the task calls for — asked once to use it before finishing.` });
                say('task.nudged', { taskId: task.id, role: role.id, grants: mustUse });
                continue;
              }
              text = String(res.text); break;
            }
            // A member that wrote on the board and then ran out of turn has still answered:
            // what it posted in its own thread during this attempt is its answer. A relayed
            // agent that posted its assessment and kept searching past the cap was being
            // failed for the searching.
            if (res?.ok) {
              const th = board.threadForTask(task.id);
              const mine = th ? board.posts(th.id).filter((p) => p.by === role.id && p.at >= t0 && ['note', 'draft', 'finding'].includes(p.kind)) : [];
              if (mine.length) { text = mine.map((p) => p.text).join('\n\n'); say('task.note', { taskId: task.id, role: role.id, text: 'answered from its board posts' }); break; }
            }
            const err = res?.ok ? 'the model returned no answer' : (res?.error || 'the model did not answer');
            attempts[attempts.length - 1].error = err;
            if (attempt >= MAX_APPOINTMENTS || stopped() || !isModelUnavailable(err)) throw new Error(err);
            exclude.add(m.model); runExclude.add(m.model); lastErr = err;
            // The next model CONTINUES this transcript; it does not start over.
            note = continuationNote({ kind: 'handoff', from: m.model, reason: err });
            const th = board.threadForTask(task.id);
            if (th) board.post({ threadId: th.id, by: RUNNER, kind: 'note', text: `${m.model} stopped (${err.slice(0, 160)}); the task continues on the next model with its work so far.` });
          }
        }
      } catch (e) {
        if (askedAndWaiting) { status = 'waiting'; waitingOnPerson = true; }
        else { status = overBudget ? 'over-budget' : 'failed'; error = String(e?.message || e); }
      } finally {
        unsubscribe?.();
      }
      const findings = status === 'ok' ? parseFindings(text, { role: role?.id, taskId: task.id }) : [];
      if (findings.length) { board.add(findings); for (const f of findings) say('task.finding', { taskId: task.id, role: role?.id, finding: f }); }
      const thread = board.threadForTask(task.id);
      // The thread says how the task ended. A failure is posted in it as well — a person reading
      // the board sees "researcher failed: network error" where it happened, and what was tried.
      if (thread && status === 'ok') board.setThreadStatus(thread.id, 'resolved');
      else if (thread && status !== 'waiting') {
        board.post({ threadId: thread.id, by: RUNNER, kind: 'note', text: `${role?.id || task.role} ${status === 'over-budget' ? 'stopped at the budget' : 'failed'}${error ? `: ${String(error).slice(0, 300)}` : ''}${attempts.length > 1 ? ` (after ${attempts.length} models: ${attempts.map((a) => a.model).join(', ')})` : ''}.` });
        board.setThreadStatus(thread.id, 'failed');
      }
      const row = { id: task.id, role: task.role, title: task.title, status, text, error, usage, ms: now() - t0, findings, transcript: clipTranscript(transcript), attempts, ...(task.parent ? { parent: task.parent } : {}), ...(routed ? { routed } : {}), ...(scm ? { scm } : {}), ...(askedAndWaiting ? { waitingOn: askedAndWaiting } : {}) };
      tasksOut.push(row);
      say(status === 'ok' ? 'task.done' : 'task.failed', { taskId: task.id, role: task.role, status, error, ms: row.ms, findings: findings.length, ...(askedAndWaiting ? { threadId: askedAndWaiting } : {}) });
      // The fact for the member's scorecard (scorecard.js): how big, with what, alongside whom,
      // in which role — produced here, attested by the store, never written by the agent.
      if (role && (status === 'ok' || status === 'failed')) {
        say('task.scored', {
          agentId: role.agent || role.id, taskId: task.id, role: role.id, model: lastModelOf(attempts), engine: routed?.engine || null, scm: scm || undefined, outcome: status === 'ok' ? 'task.done' : 'task.failed',
          size: { ms: row.ms, steps: (row.transcript || []).length, tools: (row.transcript || []).filter((m) => m.role === 'tool').length, findings: findings.length, tokens: usage ? Number(usage.input_tokens || usage.prompt_tokens || 0) + Number(usage.output_tokens || usage.completion_tokens || 0) : 0 },
          roleKind: 'ic', tools: toolNamesOf(row.transcript), with: t.roles.filter((r) => r.id !== role.id).map((r) => r.agent || r.id),
          refs: [`run:${id}`, ...(board.threadForTask(task.id) ? [`thread:${board.threadForTask(task.id).id}`] : [])], error: error || undefined,
          ...(task.parent ? { parent: task.parent, requestedBy: task.requestedBy || null } : {}),
        });
      }
      // The spend so far, after every task — a ledger reads it live instead of at the end.
      say('run.usage', { usage: budget.snapshot() });
      if (budget.exhausted()) overBudget = true;
      return row;
  };

  for (;;) {
    if (stopped() || overBudget || waitingOnPerson) break;
    const wave = ready();
    if (!wave.length) break;
    await pool(wave, maxConcurrency, runTask);
    // Over budget with work left: ask the person ONCE for more, on the board, before stopping.
    if (overBudget && !budgetAsked && !stopped()) {
      budgetAsked = true;
      const left = tasks.filter((x) => x.role && !tasksOut.some((y) => y.id === x.id)).length;
      const spent = budget.snapshot().spent;
      const what = left ? `${left} task${left === 1 ? '' : 's'} and the merge left` : 'only the merge left';
      const a = await askPerson({ type: 'budget', text: `The team has used its budget (${Object.entries(spent).filter(([k]) => budget.cap[k] !== undefined).map(([k, v]) => `${k} ${v} of ${budget.cap[k]}`).join(', ')}) with ${what}. Raise it by half, or stop here with what it has?`, options: ['Raise by half', 'Stop here'] });
      if (a && /raise|allow|yes|more|continue/i.test(a.text)) { budget.raise(1.5); overBudget = false; }
    }
  }
  // Every planned task gets a row — what never ran is recorded as skipped, not forgotten;
  // a sub-task nobody took is `unassigned`, which is its own kind of undone.
  for (const task of tasks) if (!tasksOut.some((x) => x.id === task.id)) tasksOut.push({ id: task.id, role: task.role, title: task.title, status: task.parent && !task.role ? 'unassigned' : 'skipped', text: '', findings: [], ...(task.parent ? { parent: task.parent } : {}) });
  if (stopped()) return finish('stopped');
  if (waitingOnPerson) return finish('waiting', { proposal: null, budgetAsked });
  // Over budget is a STOP only when it left work undone; a budget spent on the last task
  // is a run that finished, and the merge below falls back to the cheap one if it must.
  if (overBudget && tasksOut.some((x) => x.status === 'skipped' || x.status === 'over-budget')) return finish('over-budget', { proposal: mergeCheap(t, board.all(), tasksOut) });

  // ── merge ─────────────────────────────────────────────────────────────────────────────
  say('run.merging', { policy: t.merge });
  const okTasks = tasksOut.filter((x) => x.status === 'ok');
  let proposal;
  if (!okTasks.length) return finish('failed', { proposal: null });
  if (t.merge === 'judge') {
    const judge = roleOf(t.judge) || strongestRole(t);
    const m = modelFor(judge);
    if (m?.model && budget.canAfford({ tokens: 0 })) {
      const prompt = [
        `You are the ${judge.name || judge.id} of team "${t.name}". The members' work is on the board below (and in the board tool). Write the team's FINAL ANSWER to the request: complete, well organised, only what the findings support, with the refs they came from. Say plainly what was not found or assumed. Flag anything the members disagreed on. Do not research from scratch — verify a figure with a tool only where the board is silent or contradictory.`,
        `Request: ${String(request || '').trim()}`,
        boardText(board),
      ].join('\n\n');
      // The judge works with its own grants (it may verify a figure) and the board — and it
      // is a run member like the others: a model that is not there rotates.
      say('task.started', { taskId: 'merge', role: judge.id, title: `merge (${judge.name || judge.id})` });
      const judgeTools = withBoardTool(withRunCache(await toolsFor(judge), runCache, { role: judge.id }), boardToolProvider({ board, role: judge.id, taskId: 'merge', taskIds: null }));
      let res = null;
      const excl = new Set();
      let judgeErr = '';
      let judgeModel = null; // the appointment that answered (or the last one tried)
      let judgeRoute = null;
      for (let attempt = 1; attempt <= MAX_APPOINTMENTS; attempt++) {
        const mm = attempt === 1 ? (runExclude.has(m?.model) ? modelFor(judge, excluding(excl)) : m) : modelFor(judge, excluding(excl));
        if (!mm?.model) break;
        if (attempt > 1) say('task.reappointed', { taskId: 'merge', role: judge.id, model: mm.model, after: [...excl], error: judgeErr });
        say('task.model', { taskId: 'merge', role: judge.id, model: mm.model, attempt });
        judgeModel = mm; judgeRoute = routeOf(mm, judge, { attempt, exclude: excl });
        say('task.routed', { taskId: 'merge', role: judge.id, attempt, ...judgeRoute });
        res = await callModel({ runId: id, taskId: 'merge', role: judge.id, model: mm.model, mode: 'model', system: judge.prompt, prompt, tools: judgeTools, signal, onDelta: (delta, full) => say('task.delta', { taskId: 'merge', role: judge.id, delta, text: full }) });
        if (res?.usage) budget.charge(res.usage);
        if (res?.ok && String(res.text || '').trim()) break;
        const err = res?.ok ? 'the model returned no answer' : (res?.error || 'the model did not answer');
        if (stopped() || !isModelUnavailable(err)) break;
        excl.add(mm.model); runExclude.add(mm.model); judgeErr = err;
      }
      const judged = res?.ok && String(res.text || '').trim();
      say(judged ? 'task.done' : 'task.failed', { taskId: 'merge', role: judge.id, status: judged ? 'ok' : 'failed', error: judged ? null : (res?.error || 'the judge did not answer'), findings: 0 });
      const judgeScm = normalizeScm(res?.scm);
      if (judgeScm) say('task.scm', { taskId: 'merge', role: judge.id, ...judgeScm });
      say('task.scored', { agentId: judge.id, taskId: 'merge', role: judge.id, model: judgeModel?.model || m?.model, engine: judgeRoute?.engine || null, scm: judgeScm || undefined, outcome: judged ? 'task.done' : 'task.failed', size: { ms: 0, steps: 1, tools: 0, findings: board.all().length, tokens: 0 }, roleKind: 'orchestrator', tools: [], with: t.roles.filter((r) => r.id !== judge.id).map((r) => r.agent || r.id), refs: [`run:${id}`] });
      say('run.usage', { usage: budget.snapshot() });
      proposal = judged ? { kind: 'answer', text: String(res.text || ''), by: judge.id } : mergeCheap(t, board.all(), tasksOut);
    } else {
      proposal = mergeCheap(t, board.all(), tasksOut);
    }
  } else if (t.merge === 'converge') {
    const drafts = okTasks.map((x) => ({ claims: toBriefClaims(x.findings) }));
    const { agreed, disputed } = converge(drafts, { minAgree: Math.min(2, drafts.length) });
    proposal = { kind: 'claims', agreed, disputed, by: 'converge' };
  } else if (t.merge === 'first') {
    proposal = { kind: 'answer', text: okTasks[0].text, by: okTasks[0].role };
  } else {
    proposal = mergeCheap(t, board.all(), tasksOut);
  }
  // The merge is a proposal thread: a draft the person approves, rejects or replies to.
  if (proposal?.text || proposal?.agreed) {
    const th = board.openThread({ kind: 'proposal', title: `Proposal — ${t.merge}`, by: proposal.by || RUNNER });
    board.post({ threadId: th.id, by: proposal.by || RUNNER, kind: 'draft', status: 'proposed', text: proposal.text || (proposal.agreed || []).map((c) => c.text).join('\n'), refs: [] });
  }
  const failed = tasksOut.some((x) => x.status !== 'ok');
  return finish(failed ? 'partial' : 'completed', { proposal });
}

/**
 * Continue a run from its checkpoint — one that waited on a person, was stopped, failed, or
 * whose process died. Finished tasks are carried; interrupted ones continue from their
 * transcripts on whatever model the roster gives them now (or a hand-off names); the board
 * and the spend carry over. Any client, any time later: the checkpoint is on the record.
 */
export function resumeTeam({ checkpoint, ...deps } = {}) {
  if (!checkpoint?.plan?.tasks) throw new TeamRunError('BAD_RESUME', 'a checkpoint with a plan is required');
  return runTeam({ ...deps, resume: checkpoint });
}

const lastModelOf = (attempts) => (attempts || []).at(-1)?.model || null;
const describeNeeds = (n) => [n?.skills?.length ? `skills ${n.skills.join(', ')}` : '', n?.grants?.length ? `grants ${n.grants.join(', ')}` : '', n?.tools?.length ? `tools ${n.tools.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing in particular';
const toolNamesOf = (transcript) => [...new Set((transcript || []).flatMap((m) => (m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.function?.name).filter(Boolean) : [])))];

/** No model: the members' work side by side, findings first — always available. */
function mergeCheap(team, findings, tasks) {
  const sections = tasks.filter((x) => x.status === 'ok').map((x) => {
    const role = team.roles.find((r) => r.id === x.role);
    const own = (x.findings || []).map((f) => `- ${f.text}${f.refs?.length ? ` (${f.refs.join(', ')})` : ''}`).join('\n');
    return `### ${role?.name || x.role}\n${own || x.text}`;
  });
  return { kind: 'answer', text: sections.join('\n\n'), by: 'concat' };
}
