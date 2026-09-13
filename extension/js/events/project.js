// GENERATED — do not edit.
// Source of truth: chatpanel-events/project.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A project — the page a goal starts on, and the record that folds everything done for it.
//
// Every job or goal starts here (F8 §12): the goal, defined by its stakeholder — the *chief
// executive*: a person by default, an agent from the pool when the person delegates it —
// with a done-when a run can be checked against, a budget the jobs are carved from, the
// repos the work happens in, and the gate that says how far a team may go without a person.
// A project is data (a `projects` prefs section, both clients) and a gateway record that
// folds its jobs, runs and spend from events, the way a run folds (team-record.js).
//
// A project's status is a small machine: draft (a goal being written) → open (jobs may be
// posted) → active (a job was recruited) → done (done-when held, a person closed it) or
// closed (abandoned). Nothing here runs anything: project-run.js is the executive loop.

import { validateBudget, normalizeBudget } from './budget.js';
import { normalizeGate, validateGate } from './gate.js';

export const PROJECT_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const PROJECT_STATUSES = Object.freeze(['draft', 'open', 'active', 'done', 'closed']);
const NEXT = Object.freeze({ draft: ['open', 'closed'], open: ['active', 'closed', 'draft'], active: ['done', 'closed', 'open'], done: ['closed', 'open'], closed: ['open'] });
export const MAX_REPOS = 16;

export class ProjectError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectError'; this.code = code; }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => String(s || '').trim().slice(0, n);

export function validateProject(p) {
  const errors = [];
  if (!isRecord(p)) return { ok: false, errors: ['project must be an object'] };
  if (!PROJECT_ID_RE.test(String(p.id || ''))) errors.push('id: a short identifier (letters, digits, _ -)');
  if (!clip(p.title, 200)) errors.push('title: what the project is called');
  if (!clip(p.goal, 4000)) errors.push('goal: what done looks like, in the stakeholder\'s words');
  if (p.doneWhen !== undefined && !clip(p.doneWhen, 2000)) errors.push('doneWhen: a check a run can be held to, or leave it out');
  if (p.stakeholder !== undefined && p.stakeholder !== 'person' && !/^[a-z][a-z0-9_-]{0,63}$/i.test(String(p.stakeholder))) errors.push('stakeholder: "person" or an agent id');
  if (p.status !== undefined && !PROJECT_STATUSES.includes(p.status)) errors.push(`status: one of ${PROJECT_STATUSES.join(', ')}`);
  const b = validateBudget(p.budget);
  if (!b.ok) errors.push(...b.errors.map((e) => `budget: ${e}`));
  if (p.repos !== undefined) {
    if (!Array.isArray(p.repos)) errors.push('repos: a list of repo ids');
    else if (p.repos.length > MAX_REPOS) errors.push(`repos: at most ${MAX_REPOS}`);
  }
  if (p.gate !== undefined && p.gate !== null) errors.push(...validateGate(p.gate, { partial: true }).errors.map((e) => `gate: ${e}`));
  return { ok: errors.length === 0, errors };
}

/** The stored form: defaults filled, the budget normalised, the gate (if any) normalised. */
export function normalizeProject(p) {
  const v = validateProject(p);
  if (!v.ok) throw new ProjectError('INVALID', v.errors.join('; '));
  return {
    id: String(p.id),
    title: clip(p.title, 200),
    goal: clip(p.goal, 4000),
    doneWhen: clip(p.doneWhen, 2000),
    stakeholder: p.stakeholder ? String(p.stakeholder) : 'person',
    budget: normalizeBudget(p.budget),
    status: PROJECT_STATUSES.includes(p.status) ? p.status : 'draft',
    repos: Array.isArray(p.repos) ? [...new Set(p.repos.map((r) => clip(r, 120)).filter(Boolean))].slice(0, MAX_REPOS) : [],
    ...(p.gate ? { gate: normalizeGate(p.gate, { partial: true }) } : {}),
    tags: Array.isArray(p.tags) ? [...new Set(p.tags.map((t) => clip(t, 40)).filter(Boolean))].slice(0, 12) : [],
    createdBy: clip(p.createdBy, 80) || 'person',
    createdAt: Number(p.createdAt) || Date.now(),
    ...(p.updatedAt ? { updatedAt: Number(p.updatedAt) } : {}),
  };
}

export function defineProject(p) { return Object.freeze(normalizeProject(p)); }

/** May the project move from `from` to `to`? The machine above; a person's close is always allowed. */
export function canTransition(from, to) {
  return (NEXT[from] || []).includes(to);
}

/** A blank page for the form. */
export function blankProject() {
  return { id: '', title: '', goal: '', doneWhen: '', stakeholder: 'person', budget: { tokens: 200000, ms: 3600000 }, status: 'draft', repos: [], tags: [] };
}

/** The form → a project, or the errors (the same shaping both clients use). */
export function projectFromForm(form) {
  const budget = {};
  for (const k of ['tokens', 'calls', 'ms', 'usd']) {
    const v = Number(form?.budget?.[k]);
    if (form?.budget?.[k] !== '' && form?.budget?.[k] != null && Number.isFinite(v) && v > 0) budget[k] = v;
  }
  const p = {
    id: String(form?.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 64),
    title: form?.title, goal: form?.goal, doneWhen: form?.doneWhen, stakeholder: form?.stakeholder || 'person',
    budget, status: form?.status || 'draft',
    repos: String(Array.isArray(form?.repos) ? form.repos.join(',') : form?.repos || '').split(/[,\s]+/).filter(Boolean),
    tags: String(Array.isArray(form?.tags) ? form.tags.join(',') : form?.tags || '').split(/[,\s]+/).filter(Boolean),
    ...(form?.gate ? { gate: form.gate } : {}), ...(form?.createdAt ? { createdAt: form.createdAt } : {}),
  };
  const v = validateProject(p);
  return v.ok ? { ok: true, project: normalizeProject(p) } : { ok: false, errors: v.errors };
}

// ── the record: a project folded from its events ────────────────────────────────────────

/** The empty record — what the gateway holds per project and both clients read. */
export function emptyProjectRecord({ id, now = Date.now() } = {}) {
  return { id, page: null, status: 'draft', jobs: [], runs: [], spend: { tokens: 0, calls: 0, usd: 0, ms: 0 }, decisions: [], report: null, createdAt: now, lastEventAt: now };
}

/**
 * Fold one event into the record. Events: `project.created` `{ project }` · `project.updated`
 * `{ project }` · `project.status` `{ status, by, note }` · `job.posted` `{ job }` ·
 * `job.updated` `{ job }` (any field: applications, recruited, status) · `run.linked`
 * `{ runId, jobId }` · `run.spent` `{ runId, spent }` · `project.decision` `{ by, kind, text,
 * refs }` · `project.report` `{ text, by }`. Idempotent by job id and run id.
 */
export function foldProject(rec, ev) {
  const type = String(ev?.type || '');
  const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : (ev || {});
  const at = Number(ev?.at) || Date.now();
  rec.lastEventAt = at;
  switch (type) {
    case 'project.created':
    case 'project.updated':
      if (p.project && typeof p.project === 'object') { rec.page = { ...p.project, updatedAt: at }; rec.status = p.project.status || rec.status; }
      break;
    case 'project.status':
      if (PROJECT_STATUSES.includes(p.status)) { rec.status = p.status; if (rec.page) rec.page.status = p.status; rec.decisions.push({ at, by: p.by || 'person', kind: 'status', text: `${p.status}${p.note ? ` — ${p.note}` : ''}` }); }
      break;
    case 'job.posted':
      if (p.job?.id && !rec.jobs.some((j) => j.id === p.job.id)) rec.jobs.push({ ...p.job, postedAt: at });
      if (rec.status === 'draft') rec.status = 'open';
      break;
    case 'job.updated': {
      const i = rec.jobs.findIndex((j) => j.id === p.job?.id);
      if (i >= 0) rec.jobs[i] = { ...rec.jobs[i], ...p.job, updatedAt: at };
      if (p.job?.status === 'recruited' || p.job?.status === 'in-progress') { if (rec.status === 'open' || rec.status === 'draft') rec.status = 'active'; }
      break;
    }
    case 'run.linked':
      if (p.runId && !rec.runs.some((r) => r.runId === p.runId)) rec.runs.push({ runId: p.runId, jobId: p.jobId || null, at });
      break;
    case 'run.spent': {
      const r = rec.runs.find((x) => x.runId === p.runId);
      const prev = r?.spent || { tokens: 0, calls: 0, usd: 0, ms: 0 };
      const next = { tokens: Number(p.spent?.tokens) || 0, calls: Number(p.spent?.calls) || 0, usd: Number(p.spent?.usd) || 0, ms: Number(p.spent?.ms) || 0 };
      // A run reports its running total; the project's spend is the sum of every run's latest.
      for (const k of Object.keys(next)) rec.spend[k] = Math.max(0, (rec.spend[k] || 0) - (prev[k] || 0) + next[k]);
      if (r) r.spent = next; else rec.runs.push({ runId: p.runId, jobId: null, at, spent: next });
      break;
    }
    case 'project.decision':
      rec.decisions.push({ at, by: p.by || 'person', kind: p.kind || 'note', text: String(p.text || '').slice(0, 2000), refs: Array.isArray(p.refs) ? p.refs.slice(0, 8) : [] });
      break;
    case 'project.report':
      rec.report = { text: String(p.text || ''), by: p.by || 'runner', at };
      break;
    default: break;
  }
  return rec;
}

/** How far along: jobs by status, spend against the budget, whether done-when is claimed. */
export function projectProgress(rec) {
  const by = {};
  for (const j of rec?.jobs || []) by[j.status] = (by[j.status] || 0) + 1;
  const cap = rec?.page?.budget || {};
  const spend = rec?.spend || {};
  const pct = cap.tokens ? Math.min(1, (spend.tokens || 0) / cap.tokens) : cap.usd ? Math.min(1, (spend.usd || 0) / cap.usd) : cap.ms ? Math.min(1, (spend.ms || 0) / cap.ms) : null;
  const total = (rec?.jobs || []).length;
  const done = by.done || 0;
  return { jobs: { total, by }, done, open: (by.open || 0) + (by.evaluating || 0) + (by.recruited || 0) + (by['in-progress'] || 0), spend, cap, budgetUsed: pct, hasReport: !!rec?.report, status: rec?.status || 'draft' };
}
