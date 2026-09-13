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
import { createBoard, parseFindings, boardText, findingsInstruction, toBriefClaims } from './team-board.js';
import { converge } from './promotion.js';

export const RUN_STATUSES = Object.freeze(['planning', 'running', 'merging', 'completed', 'partial', 'over-budget', 'stopped', 'failed']);
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
  return /model[_ ]not[_ ]found|not found|not deployed|inaccessible|does not exist|no such model|unknown model|unsupported model|not available|unavailable|no api key|not configured|"status":\s*(404|401|403)\b|\b(404|401|403)\b/i.test(m);
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
} = {}) {
  if (typeof callModel !== 'function') throw new TeamRunError('BAD_RUN', 'callModel required');
  const t = normalizeTeam(team); // throws on a team without a budget — O1
  const id = runId || newId();
  const budget = createBudget(t.budget, { now });
  const board = createBoard({ now });
  const startedAt = now();
  const tasksOut = [];
  const say = (type, payload = {}) => emit(type, { runId: id, at: now(), ...payload });
  const roleOf = (rid) => t.roles.find((r) => r.id === rid);
  // `exclude` holds what failed as unavailable this run; a re-appointment skips it. A role's
  // pinned model is tried first and, when it is the one that failed, the roster steps in.
  const modelFor = (r, exclude = null) => {
    if (exclude?.size && r.model && exclude.has(r.model)) return appoint ? appoint({ ...r, model: undefined }, { exclude }) : null;
    return (appoint ? appoint(r, { exclude }) : null) || (r.model && !exclude?.has(r.model) ? { model: r.model, mode: r.mode } : null);
  };
  const MAX_APPOINTMENTS = 3;
  const stopped = () => !!signal?.aborted;

  say('run.started', { team: t.name, request: String(request || ''), budget: t.budget, roles: t.roles.map((r) => r.id) });

  // ── plan ──────────────────────────────────────────────────────────────────────────────
  let tasks;
  let planBy = 'fixed';
  if (t.plan === 'planner') {
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

  const finish = (status, extra = {}) => {
    const usage = budget.snapshot();
    const out = { runId: id, team: t.name, status, plan: { by: planBy, tasks }, tasks: tasksOut, board: board.all(), usage, startedAt, endedAt: now(), ...extra };
    say('run.done', { status, usage, proposal: out.proposal || null, failedTaskIds: tasksOut.filter((x) => x.status === 'failed').map((x) => x.id) });
    return out;
  };

  // ── fan out, in waves ─────────────────────────────────────────────────────────────────
  let overBudget = false;
  for (const wave of waves(tasks)) {
    if (stopped() || overBudget) break;
    await pool(wave, maxConcurrency, async (task) => {
      if (stopped() || overBudget) { tasksOut.push({ id: task.id, role: task.role, status: 'skipped', text: '', findings: [] }); return; }
      const role = roleOf(task.role);
      const t0 = now();
      say('task.started', { taskId: task.id, role: task.role, title: task.title });
      let text = '';
      let usage = null;
      let status = 'ok';
      let error = null;
      try {
        if (role.mode === 'recipe') {
          if (typeof runRecipe !== 'function') throw new Error('this host cannot run recipes');
          const r = await runRecipe(role.recipe, { request: String(request || ''), task: task.prompt });
          text = typeof r === 'string' ? r : JSON.stringify(r);
        } else {
          // A call's tokens are unknown until it returns; what can be asked beforehand is
          // whether the budget is already exhausted and whether one more call is allowed.
          if (!budget.canAfford({ tokens: 0 })) { overBudget = true; throw new Error('over budget'); }
          const prior = boardText(board.all(), { taskIds: task.dependsOn?.length ? task.dependsOn : null });
          const prompt = [task.prompt, prior, findingsInstruction()].filter(Boolean).join('\n\n');
          // A host may build a toolset asynchronously (connecting MCP servers takes time).
          const tools = await toolsFor(role);
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
              system: role.prompt, prompt, tools, signal,
              onDelta: (delta, full) => say('task.delta', { taskId: task.id, role: role.id, delta, text: full }),
            });
            usage = res?.usage || null;
            if (usage) budget.charge(usage);
            if (res?.aborted) { status = 'stopped'; break; }
            if (res?.ok) { text = String(res?.text || ''); break; }
            const err = res?.error || 'the model did not answer';
            if (attempt >= MAX_APPOINTMENTS || stopped() || !isModelUnavailable(err)) throw new Error(err);
            exclude.add(m.model);
          }
        }
      } catch (e) {
        status = overBudget ? 'over-budget' : 'failed';
        error = String(e?.message || e);
      }
      const findings = status === 'ok' ? parseFindings(text, { role: role.id, taskId: task.id }) : [];
      if (findings.length) { board.add(findings); for (const f of findings) say('task.finding', { taskId: task.id, role: role.id, finding: f }); }
      const row = { id: task.id, role: task.role, title: task.title, status, text, error, usage, ms: now() - t0, findings };
      tasksOut.push(row);
      say(status === 'ok' ? 'task.done' : 'task.failed', { taskId: task.id, role: task.role, status, error, ms: row.ms, findings: findings.length });
      if (budget.exhausted()) overBudget = true;
    });
  }
  // Every planned task gets a row — what never ran is recorded as skipped, not forgotten.
  for (const task of tasks) if (!tasksOut.some((x) => x.id === task.id)) tasksOut.push({ id: task.id, role: task.role, title: task.title, status: 'skipped', text: '', findings: [] });
  if (stopped()) return finish('stopped');
  if (overBudget) return finish('over-budget', { proposal: mergeCheap(t, board.all(), tasksOut) });

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
        boardText(board.all()),
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
  const failed = tasksOut.some((x) => x.status !== 'ok');
  return finish(failed ? 'partial' : 'completed', { proposal });
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
