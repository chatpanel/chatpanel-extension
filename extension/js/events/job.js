// GENERATED — do not edit.
// Source of truth: chatpanel-events/job.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A job — a posting on a project's board that the pool applies to.
//
// The executive posts the first jobs; a recruited agent posts more when the work needs more
// hands, a skill or a tool it does not have; a person posts one by hand. A job says what it
// needs (skills, tools, grants), what it may cost (carved from the project's budget), and
// where the work happens (a repo and a base branch — the bridge gives it a worktree). Agents
// in the pool APPLY by construction (recruit.js scores every type at once); an evaluator
// picks; the pick is recruited with a budget and the job becomes a role on a run.
//
// A job's status is a machine: open → evaluating → recruited → in-progress → done | failed,
// with withdrawn from any of the first three. Every move is an event on the project's
// record (project.js foldProject: `job.posted`, `job.updated`).

import { validateBudget, normalizeBudget } from './budget.js';
import { GRANT_RE } from './team.js';

export const JOB_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const JOB_STATUSES = Object.freeze(['open', 'evaluating', 'recruited', 'in-progress', 'done', 'failed', 'withdrawn']);
const NEXT = Object.freeze({
  open: ['evaluating', 'recruited', 'withdrawn'], evaluating: ['recruited', 'open', 'withdrawn'], recruited: ['in-progress', 'open', 'withdrawn'],
  'in-progress': ['done', 'failed', 'open'], done: [], failed: ['open'], withdrawn: ['open'],
});
export const MAX_NEEDS = 24;
export const MAX_APPLICATIONS = 64;

export class JobError extends Error {
  constructor(code, message) { super(message); this.name = 'JobError'; this.code = code; }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => String(s || '').trim().slice(0, n);
const list = (xs, n, max) => [...new Set((Array.isArray(xs) ? xs : typeof xs === 'string' ? xs.split(/[,\s]+/) : []).map((x) => clip(x, n)).filter(Boolean))].slice(0, max);

export function validateJob(j) {
  const errors = [];
  if (!isRecord(j)) return { ok: false, errors: ['job must be an object'] };
  if (!JOB_ID_RE.test(String(j.id || ''))) errors.push('id: a short identifier (letters, digits, _ -)');
  if (!JOB_ID_RE.test(String(j.projectId || ''))) errors.push('projectId: the project this job belongs to');
  if (!clip(j.title, 200)) errors.push('title: what the job is');
  if (!clip(j.brief, 8000)) errors.push('brief: what to do, what done looks like');
  if (j.needs !== undefined) {
    if (!isRecord(j.needs)) errors.push('needs: { skills[], tools[], grants[] }');
    else {
      const badGrants = (Array.isArray(j.needs.grants) ? j.needs.grants : []).filter((g) => !GRANT_RE.test(String(g)));
      if (badGrants.length) errors.push(`needs.grants: not grantable: ${badGrants.join(', ')}`);
    }
  }
  if (j.budget !== undefined) { const b = validateBudget(j.budget); if (!b.ok) errors.push(...b.errors.map((e) => `budget: ${e}`)); }
  if (j.status !== undefined && !JOB_STATUSES.includes(j.status)) errors.push(`status: one of ${JOB_STATUSES.join(', ')}`);
  if (j.dependsOn !== undefined && !Array.isArray(j.dependsOn)) errors.push('dependsOn: a list of job ids');
  if (j.workspace !== undefined && j.workspace !== null && !isRecord(j.workspace)) errors.push('workspace: { repoId, base, branch? }');
  if (j.deadline !== undefined && j.deadline !== null && !Number.isFinite(Number(j.deadline))) errors.push('deadline: a time');
  return { ok: errors.length === 0, errors };
}

export function normalizeJob(j) {
  const v = validateJob(j);
  if (!v.ok) throw new JobError('INVALID', v.errors.join('; '));
  return {
    id: String(j.id),
    projectId: String(j.projectId),
    title: clip(j.title, 200),
    brief: clip(j.brief, 8000),
    needs: {
      skills: list(j.needs?.skills, 80, MAX_NEEDS),
      tools: list(j.needs?.tools, 120, MAX_NEEDS),
      grants: list(j.needs?.grants, 64, MAX_NEEDS).filter((g) => GRANT_RE.test(g)),
    },
    ...(j.budget ? { budget: normalizeBudget(j.budget) } : {}),
    size: { steps: Math.max(0, Math.round(Number(j.size?.steps) || 0)) },
    status: JOB_STATUSES.includes(j.status) ? j.status : 'open',
    postedBy: clip(j.postedBy, 80) || 'person',
    postedAt: Number(j.postedAt) || Date.now(),
    ...(j.deadline ? { deadline: Number(j.deadline) } : {}),
    dependsOn: list(j.dependsOn, 64, 32).filter((d) => d !== j.id),
    ...(j.workspace ? { workspace: { repoId: clip(j.workspace.repoId, 120), base: clip(j.workspace.base, 120) || 'main', ...(j.workspace.branch ? { branch: clip(j.workspace.branch, 200) } : {}), ...(j.workspace.worktreePath ? { worktreePath: clip(j.workspace.worktreePath, 400) } : {}) } } : {}),
    applications: Array.isArray(j.applications) ? j.applications.slice(0, MAX_APPLICATIONS).map(normalizeApplication).filter(Boolean) : [],
    ...(j.recruited ? { recruited: normalizeRecruit(j.recruited) } : {}),
    ...(j.runId ? { runId: String(j.runId) } : {}),
    ...(j.result ? { result: { text: clip(j.result.text, 8000), by: clip(j.result.by, 80), at: Number(j.result.at) || Date.now(), ...(Array.isArray(j.result.refs) ? { refs: j.result.refs.slice(0, 12) } : {}) } } : {}),
    ...(j.origin && isRecord(j.origin) ? { origin: { ...j.origin } } : {}),
  };
}

function normalizeApplication(a) {
  if (!isRecord(a) || !a.agentId) return null;
  return { agentId: String(a.agentId), ...(a.engine ? { engine: a.engine } : {}), fit: Math.max(0, Math.min(1, Number(a.fit) || 0)), reasons: Array.isArray(a.reasons) ? a.reasons.map((r) => clip(r, 200)).slice(0, 8) : [], pitch: clip(a.pitch, 600), at: Number(a.at) || Date.now() };
}
function normalizeRecruit(r) {
  return { agentId: String(r.agentId), ...(r.engine ? { engine: r.engine } : {}), ...(r.budget ? { budget: normalizeBudget(r.budget) } : {}), by: clip(r.by, 80) || 'evaluator', at: Number(r.at) || Date.now(), ...(r.why ? { why: clip(r.why, 600) } : {}) };
}

export function defineJob(j) { return Object.freeze(normalizeJob(j)); }

/** May the job move from `from` to `to`? */
export function canTransition(from, to) { return (NEXT[from] || []).includes(to); }

/** Applications are computed, not asked for: every eligible type in the pool applies at once. */
export function applyAll(job, pool, fitFn, { cards = {} } = {}) {
  const now = Date.now();
  return (pool || [])
    .filter((a) => a && a.enabled !== false && (a.appliesTo || ['jobs']).includes('jobs'))
    .map((a) => { const f = fitFn(job, a, cards[a.id] || null); return { agentId: a.id, fit: f.score, reasons: f.reasons, pitch: '', at: now }; })
    .sort((x, y) => y.fit - x.fit)
    .slice(0, MAX_APPLICATIONS);
}

/** A recruited job as the role a run gives the agent: the brief is the prompt, the needs are the grants. */
export function jobToRole(job, agent) {
  return {
    id: agent?.id || job.id,
    agent: agent?.id,
    name: agent?.name || job.title,
    prompt: [agent?.prompt, `Job: ${job.title}\n\n${job.brief}`].filter(Boolean).join('\n\n'),
    grants: (job.needs?.grants?.length ? job.needs.grants : agent?.grants) || ['none'],
    ...(job.dependsOn?.length ? { dependsOn: job.dependsOn } : {}),
    ...(job.workspace ? { workspace: job.workspace } : {}),
  };
}

/** The jobs that may run now: every dependency done, and not already taken. */
export function readyJobs(jobs) {
  const byId = new Map((jobs || []).map((j) => [j.id, j]));
  return (jobs || []).filter((j) => j.status === 'open' && (j.dependsOn || []).every((d) => byId.get(d)?.status === 'done'));
}

/** A blank posting for the form. */
export function blankJob(projectId = '') {
  return { id: '', projectId, title: '', brief: '', needs: { skills: [], tools: [], grants: [] }, budget: { tokens: 40000, ms: 900000 }, status: 'open', dependsOn: [] };
}

export function jobFromForm(form) {
  const budget = {};
  for (const k of ['tokens', 'calls', 'ms', 'usd']) {
    const v = Number(form?.budget?.[k]);
    if (form?.budget?.[k] !== '' && form?.budget?.[k] != null && Number.isFinite(v) && v > 0) budget[k] = v;
  }
  const j = {
    id: String(form?.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 64),
    projectId: form?.projectId, title: form?.title, brief: form?.brief,
    needs: { skills: form?.needs?.skills, tools: form?.needs?.tools, grants: form?.needs?.grants },
    ...(Object.keys(budget).length ? { budget } : {}),
    status: form?.status || 'open', postedBy: form?.postedBy || 'person', dependsOn: form?.dependsOn,
    ...(form?.workspace?.repoId ? { workspace: form.workspace } : {}), ...(form?.size ? { size: form.size } : {}),
  };
  const v = validateJob(j);
  return v.ok ? { ok: true, job: normalizeJob(j) } : { ok: false, errors: v.errors };
}
