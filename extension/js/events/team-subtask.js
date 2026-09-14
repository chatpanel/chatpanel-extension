// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-subtask.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A sub-task — a member's request turned into a job on the run (F8 §15.2).
//
// A member breaks its task down by posting a REQUEST in its thread ("writer: I need the
// valuation checked"); the runner turns each into a sub-task with its own thread, a `parent`
// and the parent's dependencies, so the plan is a TREE. Take-up is proactive: the sub-task
// is offered to the run's other members first — `takeUp` scores each on the skills and
// grants the request names (scorecard.js `fit`, the same score a job posting uses) and the
// best fit that meets the hard needs claims it. Nobody fits → the job board: `jobFromSubtask`
// is the posting the pool applies to (recruit.js), and the host's `recruit` hook answers with
// a role or nothing; nothing → an agent is PROPOSED to a person, never created (§7).
//
// Pure: no model call, no clock beyond what is handed in. The runner (team-run.js) owns the
// flow; this module owns the shapes and the decisions that can be tested without a run.

import { fit } from './scorecard.js';
import { GRANT_RE, normalizeGrants } from './team.js';
import { normalizeJob } from './job.js';

export const MAX_SUBTASKS = 8; // per run — a member that needs more than this is re-planning, not delegating
export const MAX_DEPTH = 2; // a sub-task may request a sub-sub-task; not deeper
export const MIN_TAKEUP_FIT = 0.5;
export const MAX_BRIEF = 4000;

const clip = (s, n) => String(s || '').trim().slice(0, n);
const lower = (xs) => (Array.isArray(xs) ? xs : typeof xs === 'string' ? xs.split(/[,\s]+/) : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const uniq = (xs) => [...new Set(xs)];

/** The request as a member states it, checked: a title, a brief, and what it needs. */
export function normalizeRequest(input) {
  const title = clip(input?.title, 120);
  const brief = clip(input?.brief ?? input?.text, MAX_BRIEF);
  if (!title && !brief) return { ok: false, error: 'a request needs a title and a brief — what to do and what done looks like' };
  const grants = uniq(lower(input?.grants).filter((g) => GRANT_RE.test(g) && g !== 'none'));
  return {
    ok: true,
    request: {
      title: title || clip(brief, 80),
      brief: brief || title,
      needs: { skills: uniq(lower(input?.skills)).slice(0, 12), tools: uniq(lower(input?.tools)).slice(0, 12), grants: grants.slice(0, 8) },
      wait: input?.wait !== false && input?.wait !== 'false',
    },
  };
}

/**
 * The sub-task a request becomes: a task row like any planned one (team-plan.js) plus
 * `parent`, `depth`, `needs`, `requestedBy`; `role` is null until someone takes it. It
 * inherits the parent's dependencies so it may read what the parent read.
 */
export function subtaskFromRequest(request, parent, { id, by, now = Date.now() } = {}) {
  const r = request;
  return {
    id,
    role: null,
    title: r.title,
    prompt: [
      `Sub-task requested by ${by} while working on "${clip(parent?.title || parent?.id, 120)}": ${r.title}`,
      r.brief,
      'Do this one thing and finish with your findings; whoever asked reads them on the board.',
    ].join('\n\n'),
    dependsOn: uniq([...(parent?.dependsOn || [])]).filter((d) => d !== id),
    parent: parent?.id || null,
    depth: (Number(parent?.depth) || 0) + 1,
    needs: { skills: [...r.needs.skills], tools: [...r.needs.tools], grants: [...r.needs.grants] },
    requestedBy: by,
    requestedAt: now,
    wait: !!r.wait,
  };
}

/** Does this role hold every grant the request names? `mcp` covers `mcp:<server>`. */
export function holdsGrants(role, grants) {
  const have = new Set(normalizeGrants(role?.grants || []));
  if (have.has('none') && (grants || []).length) return false;
  return (grants || []).every((g) => have.has(g) || (g.startsWith('mcp:') && have.has('mcp')));
}

const coversSkills = (role, skills) => {
  if (!skills?.length) return true;
  const has = new Set(lower(role?.skills));
  return skills.some((s) => has.has(s));
};

/**
 * Offer a sub-task to the run's members: the best fit among those that hold every grant it
 * needs and at least one skill it names (when it names any), at or above `minFit`. The
 * requester is excluded — a request is a delegation — as are recipe roles (a recipe cannot
 * take an arbitrary task) and anything in `exclude`. `summaries` are scorecard cards by
 * agent or role id, when the host has them. Returns `{ roleId, fit, reasons }` or null with
 * `why` on the side: `{ roleId: null, why }`.
 */
export function takeUp(task, roles, { exclude = [], summaries = {}, minFit = MIN_TAKEUP_FIT } = {}) {
  const skip = new Set([task?.requestedBy, ...exclude].filter(Boolean));
  const needs = task?.needs || { skills: [], tools: [], grants: [] };
  const candidates = (roles || []).filter((r) => r && !skip.has(r.id) && r.mode !== 'recipe');
  if (!candidates.length) return { roleId: null, why: 'no other member in the run' };
  const scored = [];
  const rejected = [];
  for (const r of candidates) {
    if (!holdsGrants(r, needs.grants)) { rejected.push(`${r.id} lacks ${needs.grants.filter((g) => !holdsGrants(r, [g])).join(', ')}`); continue; }
    if (!coversSkills(r, needs.skills)) { rejected.push(`${r.id} has none of: ${needs.skills.join(', ')}`); continue; }
    const f = fit({ needs, size: { steps: 0 } }, { skills: r.skills || [], tools: r.grants || [], grants: r.grants || [] }, summaries[r.agent || r.id] || null, { adjust: false });
    scored.push({ roleId: r.id, fit: f.score, reasons: f.reasons });
  }
  scored.sort((a, b) => b.fit - a.fit);
  const best = scored[0];
  if (best && best.fit >= minFit) return best;
  const why = best ? `${best.roleId} fits best at ${Math.round(best.fit * 100)}%, under the ${Math.round(minFit * 100)}% floor` : (rejected.length ? rejected.join('; ') : 'no member fits');
  return { roleId: null, why };
}

/**
 * The posting the pool applies to when nobody in the run fits (job.js). The run stands in
 * for a project when there is none: `projectId` is the run's. The brief carries who asked
 * and for what, so the evaluator and a person read the context.
 */
export function jobFromSubtask(task, { runId, projectId = null, budget = null, by = null } = {}) {
  return normalizeJob({
    id: task.id,
    projectId: projectId || runId,
    title: task.title,
    brief: task.prompt,
    needs: task.needs,
    ...(budget ? { budget } : {}),
    status: 'open',
    postedBy: by || task.requestedBy || 'runner',
    postedAt: task.requestedAt || Date.now(),
    dependsOn: [],
    origin: { kind: 'subtask', runId, parent: task.parent || null, requestedBy: task.requestedBy || null },
  });
}

/**
 * A queued sub-task (the requester did not wait for it) must be read by whoever would have
 * read the requester: every task that depends on the parent now depends on the sub-task too.
 * Mutates the plan in place; returns the ids it extended.
 */
export function extendDependents(tasks, parentId, subtaskId) {
  const out = [];
  for (const t of tasks || []) {
    if (!t || t.id === subtaskId) continue;
    if ((t.dependsOn || []).includes(parentId) && !(t.dependsOn || []).includes(subtaskId)) { t.dependsOn = [...t.dependsOn, subtaskId]; out.push(t.id); }
  }
  return out;
}

/** The plan as a tree — roots first, each with its children — for a board that draws it as one. */
export function taskTree(tasks) {
  const list = (tasks || []).filter(Boolean);
  const ids = new Set(list.map((t) => t.id));
  const byParent = new Map();
  for (const t of list) {
    const key = t.parent && ids.has(t.parent) ? t.parent : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  }
  const build = (key, seen) => (byParent.get(key) || []).filter((t) => !seen.has(t.id)).map((t) => ({ task: t, children: build(t.id, new Set([...seen, t.id])) }));
  return build(null, new Set());
}

/** One line a person reads: "researcher took: check valuation (fit 85%)". */
export function takeUpLine(task, pick) {
  if (!pick?.roleId) return `nobody in the run fits "${task.title}"${pick?.why ? `: ${pick.why}` : ''}`;
  return `${pick.roleId} took: ${task.title} (fit ${Math.round((pick.fit || 0) * 100)}%${pick.reasons?.length ? ` — ${pick.reasons[0]}` : ''})`;
}

/**
 * A run's threads as the board lists them: a sub-task's thread (one whose `parent` names a
 * task) follows its parent's thread, indented — `depth` on each row — so the tree reads as
 * one. Roots keep the order given (a board sorts them newest first); children come in the
 * order they were requested. A thread whose parent is not on the board is a root.
 */
export function threadRows(threads) {
  const list = (threads || []).filter(Boolean);
  const byTask = new Map(list.filter((t) => t.kind === 'task' && t.taskId).map((t) => [t.taskId, t]));
  const children = new Map();
  for (const t of list) {
    if (!t.parent || !byTask.has(t.parent) || byTask.get(t.parent) === t) continue;
    const key = byTask.get(t.parent).id;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(t);
  }
  const isChild = new Set([...children.values()].flat().map((t) => t.id));
  const out = [];
  const walk = (t, depth, seen) => {
    if (seen.has(t.id)) return;
    out.push({ ...t, depth });
    for (const c of (children.get(t.id) || []).sort((a, b) => (a.at || 0) - (b.at || 0))) walk(c, depth + 1, new Set([...seen, t.id]));
  };
  for (const t of list) if (!isChild.has(t.id)) walk(t, 0, new Set());
  return out;
}
