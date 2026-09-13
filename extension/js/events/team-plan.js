// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-plan.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Planning a run: which tasks, for which roles, in what order.
//
// Two ways. `fixed` — one task per role, each given the request and its own prompt, run in
// declaration order with the dependencies the roles declare; no model is asked how to
// split the work, so the plan is free and reproducible. `planner` — the strongest appointed
// role is asked, through the shared structured layer (never a hand-typed JSON prompt), to
// break the request into tasks and assign each to a role it may use. A planner that returns
// nothing readable falls back to the fixed plan, which is why a run can always start.
//
// A task's `dependsOn` is what the fan-out turns into barriers: a task with no unmet
// dependency runs alongside the others (the round's pool), a dependent one waits and reads
// the board. That is the whole scheduling model — the same one a tool round uses.

import { defineSchema, describeSchema, coerce } from './structured.js';

export const MAX_TASKS = 12;

export const TEAM_PLAN_SCHEMA = defineSchema({
  name: 'team_plan',
  purpose: 'the tasks a team will run for a request, each assigned to one role',
  fields: {
    tasks: {
      type: 'object[]', required: true, maxItems: MAX_TASKS,
      describe: 'concrete, independent where possible; a task that needs another\'s result names it in dependsOn',
      fields: {
        id: { type: 'string', required: true, max: 32, describe: 'a short id like t1' },
        role: { type: 'string', required: true, max: 32, describe: 'the id of the role that runs it' },
        title: { type: 'string', required: true, max: 80 },
        prompt: { type: 'string', required: true, max: 1200, describe: 'the focused instruction for this task' },
        dependsOn: { type: 'string[]', maxItems: 6, describe: 'task ids whose findings this one needs' },
      },
    },
  },
  nothing: { tasks: [] },
});

/** The planner's instruction — the request, the roles it may use, the shape it must answer in. */
export function plannerPrompt(team, request) {
  const roles = (team.roles || []).map((r) => `- ${r.id}: ${r.name || r.id} — ${r.prompt.slice(0, 200)}${r.grants?.length ? ` (tools: ${r.grants.join(', ')})` : ''}`).join('\n');
  return [
    `You are the planner of a team named "${team.name}". Break the request into 2–${Math.min(MAX_TASKS, Math.max(2, (team.roles || []).length * 2))} tasks and assign each to ONE of these roles by id:`,
    roles,
    '',
    `Request: ${String(request || '').trim()}`,
    '',
    'Prefer tasks that can run at the same time; use dependsOn only when a task truly needs another\'s findings. Do not assign a role a task it has no tools for.',
    '',
    describeSchema(TEAM_PLAN_SCHEMA),
  ].join('\n');
}

/** One task per role, in declaration order, with the roles' own dependencies. */
export function fixedPlan(team, request) {
  const req = String(request || '').trim();
  // The judge's work IS the merge: it reads the whole board and writes the answer. Giving it
  // a task as well made a planner plan twice — once blind, in the first wave, and once at
  // the end — and the first, done with no findings to read, was pure duplicate research.
  const judge = team.merge === 'judge' ? team.judge : null;
  return (team.roles || []).filter((r) => r.id !== judge || (team.roles || []).length === 1).map((r) => ({
    id: `t_${r.id}`,
    role: r.id,
    title: r.name || r.id,
    prompt: r.prompt ? `${r.prompt}\n\nRequest: ${req}` : req,
    dependsOn: (r.dependsOn || []).map((d) => `t_${d}`),
  }));
}

/**
 * Read a planner's answer into tasks, dropping what cannot run: an unknown role, a
 * dependency on nothing, a cycle. Returns [] when nothing survives, so the caller falls back.
 */
export function parsePlan(text, team) {
  const got = coerce(text, TEAM_PLAN_SCHEMA);
  const roles = new Set((team.roles || []).map((r) => r.id));
  const raw = Array.isArray(got?.value?.tasks) ? got.value.tasks : [];
  const tasks = raw
    .filter((t) => t && roles.has(String(t.role || '')) && String(t.prompt || '').trim())
    .map((t, i) => ({
      id: String(t.id || `t${i + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || `t${i + 1}`,
      role: String(t.role),
      title: String(t.title || t.prompt).slice(0, 80),
      prompt: String(t.prompt).trim(),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    }))
    .slice(0, MAX_TASKS);
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.dependsOn = t.dependsOn.filter((d) => ids.has(d) && d !== t.id);
  return breakCycles(tasks);
}

/** A task whose dependencies cannot all be satisfied loses them, rather than never running. */
export function breakCycles(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map(); // id -> 'visiting' | 'done'
  const visit = (t, stack) => {
    if (state.get(t.id) === 'done') return;
    if (state.get(t.id) === 'visiting') return;
    state.set(t.id, 'visiting');
    t.dependsOn = t.dependsOn.filter((d) => {
      const dep = byId.get(d);
      if (!dep) return false;
      if (state.get(d) === 'visiting' || stack.has(d)) return false; // a cycle: drop the edge
      visit(dep, new Set([...stack, t.id]));
      return true;
    });
    state.set(t.id, 'done');
  };
  for (const t of tasks) visit(t, new Set());
  return tasks;
}

/** Tasks in waves: everything runnable now, then what those unblock — the barrier order. */
export function waves(tasks) {
  const out = [];
  const done = new Set();
  let rest = [...tasks];
  while (rest.length) {
    const ready = rest.filter((t) => (t.dependsOn || []).every((d) => done.has(d)));
    if (!ready.length) { out.push(rest); break; } // cannot happen after breakCycles; never loop forever
    out.push(ready);
    for (const t of ready) done.add(t.id);
    rest = rest.filter((t) => !done.has(t.id));
  }
  return out;
}
