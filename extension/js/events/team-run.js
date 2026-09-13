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
// task ends with findings; the merge turns the board into ONE proposal — agreed claims
// (converge, W7), a judged answer, or the members' work side by side — and the proposal is
// what a person sees. Nothing here lands anywhere.
//
// Budget first. `createBudget` refuses a team without one; before every model call the run
// asks `canAfford`, and a run that cannot afford its next call stops with what it has and
// says so (`status: 'over-budget'`). Stop is one signal, fanned out.

import { normalizeTeam } from './team.js';
import { createBudget } from './budget.js';
import { fixedPlan, plannerPrompt, parsePlan, waves } from './team-plan.js';
import { createBoard, parseFindings, boardText, findingsInstruction, toBriefClaims, RUNNER } from './team-board.js';
import { boardToolProvider, createAnswerBox, withBoardTool, DEFAULT_ASK_TIMEOUT_MS } from './board-tool.js';
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
  return /model[_ ]not[_ ]found|not found|not deployed|inaccessible|does not exist|no such model|unknown model|unsupported model|not available|unavailable|no api key|not configured|"status":\s*(404|401|403|500|502|503)\b|\b(404|401|403|502|503)\b|exited \d+|returned no answer|did not answer|closed the connection|couldn't reach|could not reach|ECONNREFUSED|overloaded|capacity/i.test(m);
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
 *                   { ok, text, usage?, error?, aborted? }` — the host's model turn
 * @param toolsFor   `(role) => toolset | undefined` — narrowed to the role's grants by the host
 * @param appoint    `(role) => { model, mode } | null` — the host's roster through cowriter-router
 * @param runRecipe  `async (name, params) => result` for `mode: 'recipe'` roles (optional)
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
  const box = answers || createAnswerBox();
  const askMs = answers ? askTimeoutMs : 0;
  const startedAt = resume?.startedAt || now();
  // Tasks a checkpoint already finished are carried over, not re-run.
  const tasksOut = (resume?.tasks || []).filter((x) => x.status === 'ok').map((x) => ({ ...x }));
  const carried = new Set(tasksOut.map((x) => x.id));
  const roleOf = (rid) => t.roles.find((r) => r.id === rid);
  // `exclude` holds what failed as unavailable this run; a re-appointment skips it. A role's
  // pinned model is tried first and, when it is the one that failed, the roster steps in.
  const modelFor = (r, exclude = null) => {
    if (exclude?.size && r.model && exclude.has(r.model)) return appoint ? appoint({ ...r, model: undefined }, { exclude }) : null;
    return (appoint ? appoint(r, { exclude }) : null) || (r.model && !exclude?.has(r.model) ? { model: r.model, mode: r.mode } : null);
  };
  const MAX_APPOINTMENTS = 3;
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
  say('plan.ready', { by: planBy, tasks: tasks.map((x) => ({ id: x.id, role: x.role, title: x.title, dependsOn: x.dependsOn })) });
  // A thread per task, before anything runs: a member's findings and replies have a home.
  for (const task of tasks) board.openThread({ taskId: task.id, kind: 'task', title: task.title || task.id, by: RUNNER });

  const finish = (status, extra = {}) => {
    const usage = budget.snapshot();
    const out = { runId: id, team: t.name, status, plan: { by: planBy, tasks }, tasks: tasksOut, board: board.all(), threads: board.state(), usage, startedAt, endedAt: now(), ...extra };
    // What a resume needs, on the record: the plan, what finished, the board, the spend.
    if (status === 'waiting') out.checkpoint = { runId: id, startedAt, plan: { by: planBy, tasks }, tasks: tasksOut, board: board.state(), budget: { cap: budget.cap, spent: usage.spent } };
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

  // ── fan out, in waves ─────────────────────────────────────────────────────────────────
  let overBudget = false;
  let budgetAsked = !!resume?.budgetAsked;
  for (const wave of waves(tasks.filter((x) => !carried.has(x.id)))) {
    if (stopped() || overBudget || waitingOnPerson) break;
    await pool(wave, maxConcurrency, async (task) => {
      if (stopped() || overBudget || waitingOnPerson) { tasksOut.push({ id: task.id, role: task.role, status: 'skipped', text: '', findings: [] }); return; }
      const role = roleOf(task.role);
      const t0 = now();
      say('task.started', { taskId: task.id, role: task.role, title: task.title });
      let text = '';
      let usage = null;
      let status = 'ok';
      let error = null;
      // The task's own abort: an ask nobody answered in time stops THIS member's turn (the
      // run then checkpoints), without stopping the run's other members.
      const taskAc = new AbortController();
      signal?.addEventListener?.('abort', () => taskAc.abort(), { once: true });
      let askedAndWaiting = null;
      try {
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
            waitFor: askMs > 0 ? async (threadId, ms, sig) => {
              const a = await box.wait(threadId, ms, sig);
              if (!a && !stopped()) { askedAndWaiting = threadId; taskAc.abort(); }
              return a;
            } : null,
          });
          const tools = withBoardTool(await toolsFor(role), boardTool);
          // A model that is not there — not deployed, no key, gone — is not the task failing:
          // the next model on the roster is appointed and the task tried again, up to three
          // models. Anything else (a refusal, a timeout, a bad request) fails the task.
          const exclude = new Set();
          for (let attempt = 1; ; attempt++) {
            const m = modelFor(role, exclude);
            if (!m?.model) throw new Error(exclude.size ? `no model left for role "${role.id}" after ${[...exclude].join(', ')}` : `no model for role "${role.id}"`);
            if (attempt > 1) say('task.reappointed', { taskId: task.id, role: role.id, model: m.model, after: [...exclude] });
            const res = await callModel({
              runId: id, taskId: task.id, role: role.id, model: m.model, mode: m.mode || role.mode,
              system: role.prompt, prompt, tools, signal: taskAc.signal,
              onDelta: (delta, full) => say('task.delta', { taskId: task.id, role: role.id, delta, text: full }),
            });
            usage = res?.usage || null;
            if (usage) budget.charge(usage);
            if (askedAndWaiting) { status = 'waiting'; waitingOnPerson = true; break; }
            if (res?.aborted || taskAc.signal.aborted) { status = 'stopped'; break; }
            // A turn that ended with nothing to say — an agent that exited, a stream that
            // died after its tool calls — is not a done task: three members "completed" empty
            // once, the run merged nothing, and the caller ran the team again. It is treated
            // like an unavailable model, so the next one on the roster gets the task.
            if (res?.ok && String(res?.text || '').trim()) { text = String(res.text); break; }
            const err = res?.ok ? 'the model returned no answer' : (res?.error || 'the model did not answer');
            if (attempt >= MAX_APPOINTMENTS || stopped() || !isModelUnavailable(err)) throw new Error(err);
            exclude.add(m.model);
          }
        }
      } catch (e) {
        if (askedAndWaiting) { status = 'waiting'; waitingOnPerson = true; }
        else { status = overBudget ? 'over-budget' : 'failed'; error = String(e?.message || e); }
      }
      const findings = status === 'ok' ? parseFindings(text, { role: role.id, taskId: task.id }) : [];
      if (findings.length) { board.add(findings); for (const f of findings) say('task.finding', { taskId: task.id, role: role.id, finding: f }); }
      const thread = board.threadForTask(task.id);
      if (thread && status !== 'waiting') board.setThreadStatus(thread.id, 'resolved');
      const row = { id: task.id, role: task.role, title: task.title, status, text, error, usage, ms: now() - t0, findings, ...(askedAndWaiting ? { waitingOn: askedAndWaiting } : {}) };
      tasksOut.push(row);
      say(status === 'ok' ? 'task.done' : 'task.failed', { taskId: task.id, role: task.role, status, error, ms: row.ms, findings: findings.length, ...(askedAndWaiting ? { threadId: askedAndWaiting } : {}) });
      if (budget.exhausted()) overBudget = true;
    });
    // Over budget with work left: ask the person ONCE for more, on the board, before stopping.
    if (overBudget && !budgetAsked && !stopped()) {
      budgetAsked = true;
      const left = tasks.filter((x) => !tasksOut.some((y) => y.id === x.id)).length;
      const spent = budget.snapshot().spent;
      const a = await askPerson({ type: 'budget', text: `The team has used its budget (${Object.entries(spent).filter(([k]) => budget.cap[k] !== undefined).map(([k, v]) => `${k} ${v} of ${budget.cap[k]}`).join(', ')}) with ${left} task${left === 1 ? '' : 's'} left. Raise it by half, or stop here with what it has?`, options: ['Raise by half', 'Stop here'] });
      if (a && /raise|allow|yes|more|continue/i.test(a.text)) { budget.raise(1.5); overBudget = false; }
    }
  }
  // Every planned task gets a row — what never ran is recorded as skipped, not forgotten.
  for (const task of tasks) if (!tasksOut.some((x) => x.id === task.id)) tasksOut.push({ id: task.id, role: task.role, title: task.title, status: 'skipped', text: '', findings: [] });
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
        `You are the ${judge.name || judge.id} of team "${t.name}". Review the team's findings for the request below and write the final answer — accurate, concise, and only what the findings support. Flag anything the members disagreed on.`,
        `Request: ${String(request || '').trim()}`,
        boardText(board),
      ].join('\n\n');
      const res = await callModel({ runId: id, taskId: 'merge', role: judge.id, model: m.model, mode: 'model', system: judge.prompt, prompt, tools: undefined, signal });
      if (res?.usage) budget.charge(res.usage);
      proposal = res?.ok ? { kind: 'answer', text: String(res.text || ''), by: judge.id } : mergeCheap(t, board.all(), tasksOut);
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

/** Continue a run that ended `waiting` from its checkpoint — the answered ask is on the board. */
export function resumeTeam({ checkpoint, ...deps } = {}) {
  if (!checkpoint?.plan?.tasks) throw new TeamRunError('BAD_RESUME', 'a checkpoint with a plan is required');
  // The waiting task runs again; its ask thread now holds the answer, and boardText gives it
  // to the member. Tasks recorded `waiting`/`skipped` are dropped from the carried list.
  return runTeam({ ...deps, resume: checkpoint });
}

/** No model: the members' work side by side, findings first — always available. */
function mergeCheap(team, findings, tasks) {
  const sections = tasks.filter((x) => x.status === 'ok').map((x) => {
    const role = team.roles.find((r) => r.id === x.role);
    const own = (x.findings || []).map((f) => `- ${f.text}${f.refs?.length ? ` (${f.refs.join(', ')})` : ''}`).join('\n');
    return `### ${role?.name || x.role}\n${own || x.text}`;
  });
  return { kind: 'answer', text: sections.join('\n\n'), by: 'concat' };
}
