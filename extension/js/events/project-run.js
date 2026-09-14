// GENERATED — do not edit.
// Source of truth: chatpanel-events/project-run.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The executive loop — a goal, run as a project (F8 §12.2.5).
//
// A person writes the goal; the executive does what a manager does with it: reads the page,
// posts the first jobs, recruits for each from the pool, runs the recruited pair as a team
// against the briefs, reads what came back, posts the follow-up jobs the results call for,
// asks the stakeholder before anything that spends more or changes scope, and closes when
// done-when holds. Every step is an event on the project record (project.js `foldProject`),
// so both clients draw the project page live and the loop is RESUMABLE from the record: a
// job already done is not redone, one already recruited is not recruited again.
//
// This module never speaks to a model, never runs a tool and never stores anything. The
// host injects: `plan(prompt, schema)` — its structured call on the executive's model;
// `recruit(job)` — its pool through recruit.js `recruitForRun`; `runJobs({ team, request })`
// — its team runner (team-run.js through the host's own callModel, so a job's work is a run
// on the board with threads, a work log and a scorecard fact per member); `ask({ type, text,
// options })` — the stakeholder. What is asked and what is not is the GATE (gate.js): the
// loop reads it at every step where it would otherwise ask, and asks a person only where
// the gate says a person decides.
//
// Nothing here is created without a decision: an agent proposed for a job nobody fits goes
// to the person as a `permission` ask before it exists (§7, D-A2).

import { defineSchema, describeSchema, coerce } from './structured.js';
import { GRANT_RE } from './team.js';
import { normalizeJob, readyJobs, canTransition as jobCanMove } from './job.js';
import { emptyProjectRecord, foldProject, projectProgress } from './project.js';
import { effectiveGate, gateAllows } from './gate.js';
import { carveBudget } from './recruit.js';

export const MAX_JOBS_PER_ROUND = 8;
export const MAX_ROUNDS = 4;
export const EXECUTIVE = 'executive';
export const PROJECT_RUN_STATUSES = Object.freeze(['done', 'open', 'waiting', 'stopped', 'over-budget', 'failed']);

export class ProjectRunError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectRunError'; this.code = code; }
}

const clip = (s, n) => String(s || '').trim().slice(0, n);
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 48);

// ── What the executive answers in ────────────────────────────────────────────────────────

const JOB_FIELDS = {
  id: { type: 'string', required: true, max: 48, describe: 'a short id like j1' },
  title: { type: 'string', required: true, max: 120 },
  brief: { type: 'string', required: true, max: 2000, describe: 'what to do and what done looks like — enough for someone who has not read the goal' },
  skills: { type: 'string[]', maxItems: 6, describe: 'skills the job needs, by name (finance, review, …) — used to pick who takes it' },
  grants: { type: 'string[]', maxItems: 6, describe: 'tools it needs: data, web, history, mcp, shell, fs:write, scm:read, scm:push, scm:pr — or none' },
  dependsOn: { type: 'string[]', maxItems: 6, describe: 'job ids whose results this one needs' },
  why: { type: 'string', max: 200, describe: 'why this job, in a few words' },
};

/** The first jobs for a goal, and the follow-ups after a round. */
export const PROJECT_JOBS_SCHEMA = defineSchema({
  name: 'project_jobs',
  purpose: 'the jobs to post on a project for its goal',
  fields: {
    jobs: { type: 'object[]', required: true, maxItems: MAX_JOBS_PER_ROUND, describe: 'independent where possible; a job that needs another\'s result names it in dependsOn', fields: JOB_FIELDS },
    note: { type: 'string', max: 600, describe: 'what you decided and why, for the project page' },
  },
  nothing: { jobs: [], note: '' },
});

/** After a round: does done-when hold, what is the report, what is still needed. */
export const PROJECT_REVIEW_SCHEMA = defineSchema({
  name: 'project_review',
  purpose: 'the executive\'s reading of a round of jobs against the project\'s goal and done-when',
  fields: {
    done: { type: 'boolean', required: true, describe: 'true only when done-when holds on the results as they are' },
    report: { type: 'string', required: true, max: 6000, describe: 'the project\'s report so far: what was established, with the job it came from; what was not' },
    followUps: { type: 'object[]', maxItems: MAX_JOBS_PER_ROUND, describe: 'the jobs still needed for done-when to hold — empty when it holds or nothing more would help', fields: JOB_FIELDS },
    why: { type: 'string', max: 400, describe: 'why done or not, in a few words' },
  },
  nothing: { done: false, report: '', followUps: [], why: '' },
});

const poolLines = (pool) => (pool || []).filter((a) => a && a.id && a.enabled !== false).slice(0, 40)
  .map((a) => `- ${a.id}: ${a.name || a.id}${a.purpose ? ` — ${clip(a.purpose, 140)}` : ''}${a.skills?.length ? ` (skills: ${a.skills.join(', ')})` : ''}${a.grants?.length ? ` (tools: ${a.grants.join(', ')})` : ''}`).join('\n');

const jobLines = (jobs) => (jobs || []).map((j) => `- ${j.id} [${j.status}]: ${j.title}${j.result?.text ? ` — result: ${clip(j.result.text, 400)}` : ''}`).join('\n');

/** The executive's first instruction: the goal, done-when, the pool, the shape. */
export function jobsPrompt(project, { pool = [], record = null } = {}) {
  const had = (record?.jobs || []).length ? `\nJobs already on the project (do not repeat them):\n${jobLines(record.jobs)}\n` : '';
  return [
    `You are the executive of the project "${project.title}". Post the jobs that get it to done — between 1 and ${MAX_JOBS_PER_ROUND}, independent where possible, each with a brief a stranger could act on.`,
    '',
    `Goal: ${project.goal}`,
    project.doneWhen ? `Done when: ${project.doneWhen}` : '',
    project.budget ? `Budget for the whole project: ${Object.entries(project.budget).map(([k, v]) => `${k} ${v}`).join(', ')}` : '',
    had,
    'Agents in the pool that may take a job (name the skills and tools a job needs; the fit picks who takes it):',
    poolLines(pool) || '- (nobody yet — name the skills and tools anyway; a job nobody fits is proposed as a new agent)',
    '',
    describeSchema(PROJECT_JOBS_SCHEMA),
  ].filter((l) => l !== null && l !== undefined).join('\n');
}

/** The executive's reading of a round: the goal, done-when, every job's result, the shape. */
export function reviewPrompt(project, record, { round = 1 } = {}) {
  return [
    `You are the executive of the project "${project.title}". Round ${round} of jobs has finished. Read the results against the goal and done-when. Write the report so far. Say whether done-when HOLDS on these results — not whether it could with more work. If it does not hold and more work would help, post the follow-up jobs (at most ${MAX_JOBS_PER_ROUND}); if nothing more would help, post none and say why.`,
    '',
    `Goal: ${project.goal}`,
    project.doneWhen ? `Done when: ${project.doneWhen}` : 'Done when: (not stated — hold the results to the goal as written)',
    '',
    'Jobs and their results:',
    jobLines(record?.jobs || []),
    record?.report?.text ? `\nThe report before this round:\n${clip(record.report.text, 3000)}` : '',
    '',
    describeSchema(PROJECT_REVIEW_SCHEMA),
  ].join('\n');
}

/**
 * The executive's answer (text or an already-shaped value) as normalized jobs on the project.
 * Ids the executive reused are suffixed; grants it made up are dropped; a dependency on a job
 * that is not on the project (or on itself) is dropped rather than left dangling.
 */
export function parseJobs(answer, project, { existing = [], now = Date.now(), by = EXECUTIVE, schema = PROJECT_JOBS_SCHEMA, field = 'jobs' } = {}) {
  const value = typeof answer === 'string' ? coerce(answer, schema)?.value : answer;
  const raw = Array.isArray(value?.[field]) ? value[field] : [];
  const taken = new Set((existing || []).map((j) => j.id));
  const out = [];
  for (const [i, j] of raw.entries()) {
    if (!j || !clip(j.title, 200) || !clip(j.brief, 8000)) continue;
    let id = slug(j.id) || `j${i + 1}`;
    if (!/^[a-z]/.test(id)) id = `j-${id}`;
    let n = 1;
    const base = id;
    while (taken.has(id)) { n += 1; id = `${base}-${n}`; }
    taken.add(id);
    const grants = [...new Set((Array.isArray(j.grants) ? j.grants : []).map((g) => String(g).trim().toLowerCase()).filter((g) => GRANT_RE.test(g) && g !== 'none'))].slice(0, 6);
    try {
      out.push(normalizeJob({
        id, projectId: project.id, title: j.title, brief: j.brief,
        needs: { skills: j.skills, grants, tools: [] },
        dependsOn: Array.isArray(j.dependsOn) ? j.dependsOn.map((d) => slug(d)) : [],
        postedBy: by, postedAt: now, status: 'open',
        ...(j.why ? { origin: { kind: 'executive', why: clip(j.why, 200) } } : {}),
      }));
    } catch { /* a job the form refuses is not posted */ }
    if (out.length >= MAX_JOBS_PER_ROUND) break;
  }
  const ids = new Set([...out.map((j) => j.id), ...(existing || []).map((j) => j.id)]);
  for (const j of out) j.dependsOn = j.dependsOn.filter((d) => ids.has(d) && d !== j.id);
  return out;
}

/** The review, coerced: `{ done, report, followUps: jobs[], why }`. */
export function parseReview(answer, project, { existing = [], now = Date.now() } = {}) {
  const value = typeof answer === 'string' ? coerce(answer, PROJECT_REVIEW_SCHEMA)?.value : answer;
  if (!value || typeof value !== 'object') return null;
  return {
    done: value.done === true,
    report: clip(value.report, 6000),
    why: clip(value.why, 400),
    followUps: parseJobs(value, project, { existing, now, field: 'followUps', schema: PROJECT_REVIEW_SCHEMA }),
  };
}

/**
 * The team a round runs as: one role per recruited job (the role id IS the job id, so two
 * jobs taken by the same agent are two members), the job's dependencies as the role's, a
 * fixed plan (one task per role, the brief as the task), the members' work side by side —
 * the executive reads it, so no judge. The budget is the round's carve.
 */
export function teamForRound(project, recruited, { budget, round = 1 } = {}) {
  const ids = new Set(recruited.map((r) => r.job.id));
  return {
    name: project.id,
    description: `${project.title} — round ${round}`,
    plan: 'fixed', merge: 'concat',
    roles: recruited.map(({ job, role }) => ({
      ...role,
      id: job.id,
      name: `${role.name || role.agent || job.id} · ${job.title}`.slice(0, 120),
      dependsOn: (job.dependsOn || []).filter((d) => ids.has(d)),
      job: job.id,
    })),
    budget,
  };
}

/** What a round's run says about each job: the task with the job's id, its status and text. */
export function jobResults(run, jobs, { now = Date.now() } = {}) {
  const out = [];
  for (const job of jobs) {
    const task = (run?.tasks || []).find((t) => t.id === `t_${job.id}` || t.role === job.id);
    if (!task) { out.push({ id: job.id, status: 'failed', result: { text: 'the run never started this job', by: 'runner', at: now } }); continue; }
    const ok = task.status === 'ok';
    const findings = (task.findings || []).map((f) => `- ${f.text}${f.refs?.length ? ` (${f.refs.join(', ')})` : ''}`).join('\n');
    out.push({
      id: job.id,
      status: ok ? 'done' : 'failed',
      result: { text: clip(ok ? (findings || task.text) : (task.error || task.status || 'failed'), 8000), by: task.role || job.id, at: now, refs: [`run:${run.runId}`, ...(task.findings || []).flatMap((f) => f.refs || []).slice(0, 8)] },
    });
  }
  return out;
}

/**
 * The jobs a round runs: every open job whose dependencies are done — and, with them, every
 * open job whose dependencies are done OR in this round. A chain (facts → memo) is one round
 * and one team; the runner's barriers order it (team-run.js), and the executive reviews the
 * whole chain, not half of it.
 */
export function roundJobs(jobs) {
  const wave = readyJobs(jobs);
  const inWave = new Set(wave.map((j) => j.id));
  const byId = new Map((jobs || []).map((j) => [j.id, j]));
  for (;;) {
    const more = (jobs || []).filter((j) => j.status === 'open' && !inWave.has(j.id) && (j.dependsOn || []).every((d) => byId.get(d)?.status === 'done' || inWave.has(d)));
    if (!more.length) break;
    for (const j of more) { wave.push(j); inWave.add(j.id); }
  }
  return wave;
}

/** The round's budget: what the project has left, split over the jobs that run, never under a floor a run can start with. */
export function roundBudget(project, record, jobs) {
  const cap = project.budget || {};
  const spent = record?.spend || {};
  const out = {};
  for (const k of ['tokens', 'calls', 'ms', 'usd']) {
    if (!(Number(cap[k]) > 0)) continue;
    const left = Math.max(0, Number(cap[k]) - (Number(spent[k]) || 0));
    if (left > 0) out[k] = k === 'usd' ? Math.round(left * 100) / 100 : Math.floor(left);
  }
  // A job's own budget caps its share; the round is the sum of the shares, within what is left.
  const shares = jobs.map((j) => carveBudget(j, record)).filter(Boolean);
  if (shares.length === jobs.length) {
    for (const k of Object.keys(out)) {
      const sum = shares.reduce((n, s) => n + (Number(s[k]) || 0), 0);
      if (sum > 0) out[k] = Math.min(out[k], sum);
    }
  }
  return Object.keys(out).length ? out : null;
}

// ── The loop ─────────────────────────────────────────────────────────────────────────────

/**
 * @param project    the page (project.js normalizeProject)
 * @param record     the project record so far (foldProject), for a resume; null starts fresh
 * @param pool       the agent cards the executive may recruit from (read for the prompt; the
 *                   host's `recruit` does the pass)
 * @param gate       the org's gate (gate.js); the project's own partial gate overrides it
 * @param executive  the agent id that runs the loop — on every decision as `by`
 * @param plan       `async (prompt, schema) => value | text | null` — the host's structured call
 * @param recruit    `async (job, { projectId, create? }) => { role, agentId, engine, why, fit } |
 *                   { proposal, why } | null` — the host's pool (recruit.js recruitForRun)
 * @param runJobs    `async ({ team, request, projectId, round }) => run result` — the host's
 *                   team runner; `team` is teamForRound's
 * @param ask        `async ({ type, text, options }) => { text, by } | null` — the stakeholder;
 *                   absent, every ask is answered "no" and the loop stops where it would ask
 * @param emit       `(type, payload)` — every project-record event, in order; the host lands
 *                   them on the gateway's project record (and this call folds them too)
 * @param maxRounds  rounds of post → recruit → run → review before the loop stops and asks
 */
export async function runProject({
  project, record = null, pool = [], gate = null, executive = EXECUTIVE,
  plan, recruit = null, runJobs, ask = null, emit = () => {},
  now = () => Date.now(), signal = null, maxRounds = MAX_ROUNDS,
} = {}) {
  if (!project?.id || !project.goal) throw new ProjectRunError('BAD_PROJECT', 'a project with an id and a goal is required');
  if (typeof plan !== 'function') throw new ProjectRunError('BAD_RUN', 'plan required');
  if (typeof runJobs !== 'function') throw new ProjectRunError('BAD_RUN', 'runJobs required');
  const rec = record && record.id === project.id ? record : emptyProjectRecord({ id: project.id, now: now() });
  if (!rec.page) foldProject(rec, { type: 'project.created', at: now(), payload: { project } });
  const g = effectiveGate(gate, project.gate || null);
  const stopped = () => !!signal?.aborted;
  const say = (type, payload = {}) => { const ev = { type, at: now(), ...payload }; foldProject(rec, { type, at: ev.at, payload }); emit(type, { projectId: project.id, ...ev }); };
  const decide = (kind, text, refs = []) => say('project.decision', { by: executive, kind, text: clip(text, 2000), refs });
  // The recruiter's own events (recruit.js recruitEvents: evaluating → recruited | open + a
  // proposal decision) land on the record as they are.
  const land = (events) => { for (const ev of events || []) { if (!ev?.type) continue; const { type, at: _at, ...payload } = ev; say(type, payload); } };
  const runs = [];
  let rounds = 0;
  const finish = (status, extra = {}) => ({ projectId: project.id, status, rounds, jobs: rec.jobs.map((j) => ({ id: j.id, title: j.title, status: j.status, ...(j.recruited ? { agentId: j.recruited.agentId } : {}), ...(j.runId ? { runId: j.runId } : {}) })), runs, report: rec.report?.text || '', spend: rec.spend, progress: projectProgress(rec), record: rec, ...extra });

  /** The stakeholder, where the gate says a person decides; recorded either way. */
  const askPerson = async ({ type, text, options }) => {
    decide('ask', `${text}${options?.length ? ` [${options.join(' / ')}]` : ''}`);
    if (typeof ask !== 'function') { decide('answer', 'nobody to ask — taken as no'); return null; }
    let a = null;
    try { a = await ask({ type, text, options }); } catch { a = null; }
    decide('answer', a ? `${a.by || 'person'}: ${a.text}` : 'no answer');
    return a;
  };
  const yes = (a) => !!a && /^(yes|ok|allow|approve|go|post|recruit|create|raise|close|done|continue|run)/i.test(String(a.text || '').trim());

  /** The executive's structured call, either shape, never a throw. */
  const structured = async (prompt, schema) => { try { const v = await plan(prompt, schema); return typeof v === 'string' ? coerce(v, schema)?.value ?? null : (v && typeof v === 'object' ? v : null); } catch { return null; } };

  /** Post jobs — the person's say first when the gate wants it. */
  const post = async (jobs, { what }) => {
    if (!jobs.length) return [];
    const lines = jobs.map((j) => `• ${j.id}: ${j.title}${j.needs?.skills?.length ? ` (${j.needs.skills.join(', ')})` : ''}${j.dependsOn?.length ? ` — after ${j.dependsOn.join(', ')}` : ''}`).join('\n');
    // Scope is the stakeholder's (D-A3): the first jobs and any follow-up are posted with
    // their say unless the gate lets the executive recruit on its own.
    if (!gateAllows(g, 'recruit').allowed) {
      const a = await askPerson({ type: 'direction', text: `${what} — post ${jobs.length} job${jobs.length === 1 ? '' : 's'}?\n${lines}`, options: ['Post them', 'Stop here'] });
      if (!yes(a)) return null;
    } else decide('plan', `${what}: ${jobs.length} job${jobs.length === 1 ? '' : 's'} posted\n${lines}`);
    for (const j of jobs) say('job.posted', { job: j, by: executive });
    return jobs;
  };

  if (rec.status === 'draft') say('project.status', { status: 'open', by: executive });
  if (['done', 'closed'].includes(rec.status)) return finish(rec.status === 'done' ? 'done' : 'stopped', { why: `the project is ${rec.status}` });
  // A RESUME: a job the last loop left recruited or running (its process died) is open
  // again — recruited again, run again; one it finished is not. The record is the checkpoint.
  if (record) {
    const stuck = rec.jobs.filter((j) => ['evaluating', 'recruited', 'in-progress'].includes(j.status));
    for (const j of stuck) say('job.updated', { job: { id: j.id, status: 'open' }, by: executive });
    if (stuck.length) decide('resume', `resumed: ${stuck.map((j) => j.id).join(', ')} back to open (left ${stuck.map((j) => j.status).join(', ')} by the last loop)`);
    else if (rec.jobs.length) decide('resume', `resumed with ${rec.jobs.filter((j) => j.status === 'done').length} of ${rec.jobs.length} jobs done`);
  }

  // ── 1. the first jobs (skipped on a resume that already has some) ──
  if (!rec.jobs.length) {
    const value = await structured(jobsPrompt(project, { pool, record: rec }), PROJECT_JOBS_SCHEMA);
    const jobs = parseJobs(value || {}, project, { existing: rec.jobs, now: now(), by: executive });
    if (!jobs.length) {
      decide('plan', 'the executive could not turn the goal into jobs');
      const a = await askPerson({ type: 'direction', text: `I could not turn the goal into jobs. Post one job for the whole goal, or stop?`, options: ['Post one job', 'Stop'] });
      if (!yes(a)) return finish('failed', { why: 'no jobs' });
      jobs.push(normalizeJob({ id: 'j1', projectId: project.id, title: clip(project.title, 200), brief: `${project.goal}${project.doneWhen ? `\n\nDone when: ${project.doneWhen}` : ''}`, needs: { skills: [], grants: ['data', 'web'], tools: [] }, postedBy: executive, postedAt: now() }));
    } else if (value?.note) decide('plan', value.note);
    const posted = await post(jobs, { what: 'First jobs' });
    if (!posted) return finish('stopped', { why: 'the stakeholder did not post the first jobs' });
  }

  // ── rounds: recruit what is ready → run → fold → review → follow-ups ──
  for (;;) {
    if (stopped()) return finish('stopped');
    if (rounds >= maxRounds) {
      decide('review', `${rounds} rounds run; the loop stops here and asks`);
      const a = await askPerson({ type: 'direction', text: `${rounds} rounds have run and done-when does not hold yet. Run another round, or stop with the report so far?`, options: ['Run another round', 'Stop here'] });
      if (!yes(a)) return finish('open', { why: 'rounds exhausted' });
      maxRounds += 1;
    }
    const ready = roundJobs(rec.jobs);
    const stillOpen = rec.jobs.filter((j) => ['open', 'evaluating', 'recruited', 'in-progress'].includes(j.status));
    if (!ready.length) {
      if (!stillOpen.length) return finish(rec.status === 'done' ? 'done' : 'open', { why: 'nothing left to run' });
      // Open jobs whose dependencies failed: they cannot run.
      decide('review', `${stillOpen.length} job${stillOpen.length === 1 ? '' : 's'} cannot run: a dependency failed`);
      for (const j of stillOpen) say('job.updated', { job: { id: j.id, status: 'failed', result: { text: 'a job it depends on failed', by: executive, at: now() } }, by: executive });
      return finish('failed', { why: 'dependencies failed' });
    }

    // ── 2. recruit ──
    const recruited = [];
    for (const job of ready) {
      if (stopped()) return finish('stopped');
      if (typeof recruit !== 'function') { say('job.updated', { job: { id: job.id, status: 'failed', result: { text: 'this host has no pool to recruit from', by: executive, at: now() } }, by: executive }); continue; }
      let r = null;
      try { r = await recruit(job, { projectId: project.id }); } catch (e) { decide('recruit', `recruiting for "${job.title}" failed: ${clip(e?.message || e, 200)}`, [`job:${job.id}`]); }
      // The recruiter's own events (evaluating → recruited | open + proposal) land on the record.
      land(r?.events);
      if (!r?.role && r?.proposal) {
        // Nobody fits: the agent the job describes, proposed — created only on the person's say.
        const card = r.proposal;
        say('project.decision', { by: executive, kind: 'proposal', text: `No one in the pool fits "${job.title}"${r.why ? ` — ${r.why}` : ''}. Proposed: ${card.name}${card.skills?.length ? ` — skills ${card.skills.join(', ')}` : ''}${card.grants?.length ? `; grants ${card.grants.join(', ')}` : ''}.`, refs: [`job:${job.id}`], proposal: { kind: 'agent', agent: card, jobId: job.id } });
        const allowed = gateAllows(g, 'newAgent').allowed;
        const a = allowed ? { text: 'Create it', by: 'gate' } : await askPerson({ type: 'permission', text: `No one fits "${job.title}". Create the agent "${card.name}" (${[card.skills?.length ? `skills ${card.skills.join(', ')}` : '', card.grants?.length ? `grants ${card.grants.join(', ')}` : ''].filter(Boolean).join('; ') || 'no particular skills'}) and give it the job?`, options: ['Create it', 'Skip'] });
        if (yes(a)) {
          try { r = await recruit(job, { projectId: project.id, create: card }); } catch (e) { decide('recruit', `creating "${card.name}" failed: ${clip(e?.message || e, 200)}`, [`job:${job.id}`]); r = null; }
          land(r?.events);
        }
      }
      if (!r?.role) {
        say('job.updated', { job: { id: job.id, status: 'failed', result: { text: `nobody took it${r?.why ? ` — ${r.why}` : ''}`, by: executive, at: now() } }, by: executive });
        continue;
      }
      // A recruited job is recorded so a resume does not recruit it again (the recruiter's
      // events say so when it landed them; a bare role is recorded here).
      const nowJob = rec.jobs.find((j) => j.id === job.id);
      if (nowJob && nowJob.status !== 'recruited' && jobCanMove(nowJob.status, 'recruited')) say('job.updated', { job: { id: job.id, status: 'recruited', recruited: { agentId: r.agentId || r.role.agent || r.role.id, ...(r.engine ? { engine: r.engine } : {}), by: 'fit', at: now(), ...(r.why ? { why: clip(r.why, 600) } : {}) } }, by: executive });
      decide('recruit', `${r.agentId || r.role.agent || r.role.id} took "${job.title}"${r.why ? ` — ${r.why}` : ''}`, [`job:${job.id}`]);
      recruited.push({ job: rec.jobs.find((j) => j.id === job.id) || job, role: r.role });
    }
    if (!recruited.length) {
      if (rec.jobs.some((j) => ['open', 'recruited'].includes(j.status))) continue; // dependents of a failed job: the next pass fails them
      return finish('failed', { why: 'nobody took any job' });
    }

    // ── 3. run the round as one team ──
    const jobs = recruited.map((x) => x.job);
    const budget = roundBudget(project, rec, jobs);
    if (!budget) {
      decide('review', 'the project has no budget left for another round');
      const allowed = gateAllows(g, 'budgetRaise').allowed;
      const a = allowed ? null : await askPerson({ type: 'budget', text: `The project has spent its budget (${Object.entries(rec.spend).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}) with ${jobs.length} job${jobs.length === 1 ? '' : 's'} recruited and not run. Raise it by half, or stop here with the report so far?`, options: ['Raise by half', 'Stop here'] });
      if (!allowed && !yes(a)) return finish('over-budget');
      for (const k of Object.keys(project.budget || {})) project.budget[k] = Math.ceil(project.budget[k] * 1.5);
      say('project.updated', { project: { ...project } });
      decide('answer', `budget raised by half: ${Object.entries(project.budget).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    rounds += 1;
    const team = teamForRound(project, recruited, { budget: roundBudget(project, rec, jobs), round: rounds });
    for (const j of jobs) say('job.updated', { job: { id: j.id, status: 'in-progress' }, by: executive });
    decide('run', `round ${rounds}: ${jobs.map((j) => j.id).join(', ')} run as one team (${Object.entries(team.budget || {}).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    let run = null;
    try {
      run = await runJobs({ team, request: [project.goal, project.doneWhen ? `Done when: ${project.doneWhen}` : ''].filter(Boolean).join('\n'), projectId: project.id, round: rounds, jobs });
    } catch (e) {
      decide('run', `round ${rounds} failed to run: ${clip(e?.message || e, 300)}`);
    }
    if (run?.runId) {
      runs.push({ runId: run.runId, round: rounds, status: run.status });
      for (const j of jobs) say('run.linked', { runId: run.runId, jobId: j.id });
      if (run.usage?.spent) say('run.spent', { runId: run.runId, spent: { ...run.usage.spent, ms: Number(run.usage.spent.ms) || Math.max(0, (run.endedAt || now()) - (run.startedAt || now())) } });
    }
    for (const res of jobResults(run, jobs, { now: now() })) say('job.updated', { job: { ...res, ...(run?.runId ? { runId: run.runId } : {}) }, by: executive });
    if (run && ['stopped', 'waiting'].includes(run.status)) return finish(run.status, { why: `round ${rounds} ${run.status}` });
    if (stopped()) return finish('stopped');

    // ── 4. review: done-when, the report, the follow-ups ──
    const value = await structured(reviewPrompt(project, rec, { round: rounds }), PROJECT_REVIEW_SCHEMA);
    const review = parseReview(value || {}, project, { existing: rec.jobs, now: now() });
    if (review?.report) say('project.report', { text: review.report, by: executive });
    else say('project.report', { text: rec.jobs.map((j) => `## ${j.title} (${j.status})\n${j.result?.text || ''}`).join('\n\n'), by: 'concat' });
    decide('review', review ? `${review.done ? 'done-when holds' : 'done-when does not hold yet'}${review.why ? ` — ${review.why}` : ''}${review.followUps.length ? `; ${review.followUps.length} follow-up${review.followUps.length === 1 ? '' : 's'}` : ''}` : 'the executive did not answer the review; the report is the results as they are');
    if (review?.done) {
      // Closing is the stakeholder's (project.js: done-when held, a person closed it) —
      // unless the gate lets the executive write back on its own.
      const allowed = gateAllows(g, 'writeBack').allowed;
      const a = allowed ? { text: 'Close as done', by: 'gate' } : await askPerson({ type: 'permission', text: `Done-when holds${review.why ? ` — ${review.why}` : ''}. Close the project as done?`, options: ['Close as done', 'Keep it open'] });
      if (yes(a)) { say('project.status', { status: 'done', by: a.by || 'person' }); return finish('done'); }
      return finish('open', { why: 'done-when holds; left open by the stakeholder' });
    }
    if (!review?.followUps?.length) {
      const left = readyJobs(rec.jobs);
      if (left.length) continue; // jobs queued behind this round run next
      return finish('open', { why: review ? 'nothing more would help' : 'no review' });
    }
    const posted = await post(review.followUps, { what: `After round ${rounds}` });
    if (!posted) return finish('open', { why: 'follow-ups not posted' });
  }
}
