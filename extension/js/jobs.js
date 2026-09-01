// Jobs, as this client stores and wakes them.
//
// The maths, the trigger matching and the missed-window policy all live in
// @chatpanel/events (js/events/schedule.js) so a phone inherits them. What is here is the
// three things only a browser extension can answer: where a job is kept, how the browser is
// asked to wake us, and which half of a job can run without a window open.
//
// THE SPLIT THAT MATTERS. A timer or a reminder is a `notify` action — no model, no network,
// nothing but a message at a time — so the SERVICE WORKER can finish it with the panel
// closed. Anything that needs a model (a skill, a prompt, a monitor) is left PENDING for the
// panel, because a turn needs settings, a licence, the redaction harness and often a tool
// loop, and none of that belongs in a worker that may be killed mid-sentence. A reminder that
// only arrives if you happen to have the panel open is not a reminder; a daily brief that
// silently half-runs in a dying worker is worse than one that waits.
//
// The platform port is INJECTED (`{schedule, cancel}` over chrome.alarms), so everything here
// is testable in Node — a scheduler nobody can test is a scheduler nobody can trust.

import {
  defineJob, dueJobs, nextWakeAt, jobsForEvent, occurrenceKey, createTriggerRegistry,
  BUILTIN_TRIGGERS, timerTrigger, nextFireAt, utteranceLooksComplete,
  coalesceMatches, matchTexts, matchSummary, clipText,
} from './events/schedule.js';

export const JOBS_KEY = 'chatpanel:jobs';        // id -> job
export const RUNS_KEY = 'chatpanel:jobRuns';     // id -> last OCCURRENCE run (not wake time)
export const CLAIMS_KEY = 'chatpanel:jobClaims'; // occurrence keys already taken, bounded
export const PENDING_KEY = 'chatpanel:jobPending'; // occurrences waiting for a window
export const COUNTS_KEY = 'chatpanel:jobCounts';   // id -> { day, n } — the spend ceiling
export const FIRED_KEY = 'chatpanel:jobFired';     // id -> ms of the last event-triggered run
export const LOG_KEY = 'chatpanel:jobLog';         // id -> [{ at, why, convId, ok, note }]

// Per job, because the question is always "what did THIS one do", and because a global log
// would be dominated by whichever job runs most often.
export const MAX_LOG_PER_JOB = 25;

// A phrase said three times in a minute is one thing happening, not three. Without this, a
// meeting that keeps returning to a topic runs the same skill on every mention — which is
// what "it triggers on every utterance" feels like even after the matching is correct.
export const DEFAULT_COOLDOWN_MS = 90_000;

// A job that fails must back off, not retry in a tight loop. The autocomplete-against-a-
// stopped-model failure (65 turns in 2–9ms) is what an unattended loop looks like, and a
// scheduled one would not stop at 65. Every job therefore has a ceiling whether or not its
// author set one; `limits.maxPerDay` only moves it.
export const DEFAULT_MAX_PER_DAY = 24;

const MAX_CLAIMS = 500;
const MAX_PENDING = 50;

export const triggers = createTriggerRegistry(BUILTIN_TRIGGERS);

async function read(key) {
  try {
    const got = await chrome.storage.local.get(key);
    return got?.[key] && typeof got[key] === 'object' ? got[key] : (Array.isArray(got?.[key]) ? got[key] : {});
  } catch {
    return {}; // storage unavailable → behave like an empty shelf rather than throwing
  }
}
const write = (key, value) => chrome.storage.local.set({ [key]: value }).catch(() => {});

export async function listJobs() {
  const all = await read(JOBS_KEY);
  return Object.values(all).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getJob(id) { return (await read(JOBS_KEY))[id] || null; }

/** Store a job. Validated through the shared contract, so a malformed one cannot be saved. */
export async function putJob(spec) {
  const job = defineJob({ createdAt: Date.now(), ...spec });
  const all = await read(JOBS_KEY);
  all[job.id] = job;
  await write(JOBS_KEY, all);
  return job;
}

export async function removeJob(id) {
  const all = await read(JOBS_KEY);
  delete all[id];
  await write(JOBS_KEY, all);
  const runs = await read(RUNS_KEY);
  delete runs[id];
  await write(RUNS_KEY, runs);
  const log = await read(LOG_KEY);
  delete log[id];
  await write(LOG_KEY, log); // orphaned history would be a quiet leak, like widget state
}

export async function setJobEnabled(id, enabled) {
  const all = await read(JOBS_KEY);
  if (!all[id]) return null;
  all[id] = { ...all[id], enabled: !!enabled };
  await write(JOBS_KEY, all);
  return all[id];
}

export async function lastRuns() { return read(RUNS_KEY); }

export async function recordRun(jobId, at) {
  const runs = await read(RUNS_KEY);
  // Never move the watermark backwards: a late catch-up run must not re-open windows that
  // a later occurrence already closed.
  runs[jobId] = Math.max(runs[jobId] || 0, at);
  await write(RUNS_KEY, runs);
}

/**
 * Take an occurrence, once. The service worker and the panel can both wake for the same
 * slot; whoever claims it first runs it.
 *
 * This is a claim, not a lock — two contexts reading at the same millisecond could both win.
 * That is survivable here (the loser's action is idempotent: one extra notification at worst)
 * and the alternative, a real mutex over chrome.storage, is a lot of machinery for a race
 * that needs two wake-ups in the same tick.
 */
export async function claimOccurrence(key) {
  const claims = await read(CLAIMS_KEY);
  if (claims[key]) return false;
  claims[key] = Date.now();
  const keys = Object.keys(claims);
  if (keys.length > MAX_CLAIMS) {
    for (const k of keys.sort((a, b) => claims[a] - claims[b]).slice(0, keys.length - MAX_CLAIMS)) delete claims[k];
  }
  await write(CLAIMS_KEY, claims);
  return true;
}

const dayOf = (ts) => new Date(ts).toDateString();

/**
 * What a job DID, so it can be found after the fact.
 *
 * A run that only announced itself in a toast is a run nobody can see: miss the toast — or
 * be away from the machine, which is the whole point of a job — and there is no way back to
 * what triggered it or what came out. The conversation id is the link: the output already
 * lives in chat history, this is what makes it reachable from the job that caused it.
 */
export async function logRun(jobId, entry) {
  const log = await read(LOG_KEY);
  const list = Array.isArray(log[jobId]) ? log[jobId] : [];
  list.unshift({ at: Date.now(), ...entry });
  log[jobId] = list.slice(0, MAX_LOG_PER_JOB);
  await write(LOG_KEY, log);
}

/**
 * Why a job did NOT run.
 *
 * Every guard below — the ceiling, the cooldown, a missed window, "no panel is open" — was a
 * bare `continue`. From the outside all four are identical to a trigger that does not work,
 * which is exactly how it gets reported: "it just isn't firing." A skip is not a failure and
 * not a run, so it is neither counted as one nor coloured like one.
 *
 * Repeats COLLAPSE onto the newest entry rather than stacking: a cooldown skip recurs on
 * every caption flush, and thirty identical rows would bury the run above them. The count is
 * the useful part — "skipped 30× — cooldown" says more than thirty rows do.
 */
export async function logSkip(jobId, why) {
  const log = await read(LOG_KEY);
  const list = Array.isArray(log[jobId]) ? log[jobId] : [];
  const head = list[0];
  if (head && head.skipped && head.why === why) {
    head.at = Date.now();
    head.n = (head.n || 1) + 1;
  } else {
    list.unshift({ at: Date.now(), skipped: true, why });
  }
  log[jobId] = list.slice(0, MAX_LOG_PER_JOB);
  await write(LOG_KEY, log);
}

/** The reasons a run can be withheld, worded for the person reading the Jobs pane. */
export const SKIP_REASONS = Object.freeze({
  limit: 'hit its daily limit',
  cooldown: 'fired moments ago (cooldown)',
  batched: 'held to answer together with the ones around it',
  window: 'waiting for the side panel to be open',
  missed: 'missed while the browser was closed',
  gone: 'its skill no longer exists',
});

export async function runHistory(jobId) {
  const log = await read(LOG_KEY);
  return Array.isArray(log[jobId]) ? log[jobId] : [];
}

/** Has this job fired too recently to fire again? Event triggers only — a schedule is exact. */
export async function withinCooldown(job, now = Date.now()) {
  const fired = await read(FIRED_KEY);
  const last = fired[job.id] || 0;
  const ms = Number(job.limits?.cooldownMs) >= 0 ? Number(job.limits.cooldownMs) : DEFAULT_COOLDOWN_MS;
  return !last || now - last >= ms;
}

export async function markFired(jobId, now = Date.now()) {
  const fired = await read(FIRED_KEY);
  fired[jobId] = now;
  await write(FIRED_KEY, fired);
}

/**
 * Has this job already run as often today as it is allowed to?
 *
 * Checked at the moment of running rather than when the job is stored, because the ceiling
 * exists to stop a runaway — and a runaway is by definition something the stored schedule
 * did not predict.
 */
export async function withinLimits(job, now = Date.now()) {
  const counts = await read(COUNTS_KEY);
  const rec = counts[job.id];
  const max = Number(job.limits?.maxPerDay) > 0 ? Number(job.limits.maxPerDay) : DEFAULT_MAX_PER_DAY;
  if (!rec || rec.day !== dayOf(now)) return true;
  return rec.n < max;
}

export async function countRun(jobId, now = Date.now()) {
  const counts = await read(COUNTS_KEY);
  const day = dayOf(now);
  const rec = counts[jobId];
  counts[jobId] = rec && rec.day === day ? { day, n: rec.n + 1 } : { day, n: 1 };
  await write(COUNTS_KEY, counts);
}

/** Timer jobs whose moment has come, catch-up policy already applied. */
export async function dueNow(now = Date.now()) {
  const jobs = await listJobs();
  return dueJobs(jobs, { now, lastRun: await lastRuns() });
}

/**
 * Ask the browser to wake us for the soonest job. ONE alarm for all of them — an alarm per
 * job would multiply by every job the user ever creates, and chrome.alarms is a shared,
 * limited resource.
 */
export async function armWake(port, now = Date.now()) {
  const at = nextWakeAt(await listJobs(), { now, lastRun: await lastRuns() });
  if (at === null) { port.cancel(); return null; }
  port.schedule(at);
  return at;
}

/** Model-needing occurrences the worker could not finish, oldest first. */
export async function pendingRuns() {
  const p = await read(PENDING_KEY);
  return Object.values(p).sort((a, b) => a.at - b.at);
}

export async function addPending(entry) {
  const p = await read(PENDING_KEY);
  p[entry.key] = entry;
  const keys = Object.keys(p);
  if (keys.length > MAX_PENDING) {
    // Oldest first: a brief from nine days ago is worth less than the one from this morning,
    // and an unbounded queue is how a week away becomes a hundred model calls.
    for (const k of keys.sort((a, b) => p[a].at - p[b].at).slice(0, keys.length - MAX_PENDING)) delete p[k];
  }
  await write(PENDING_KEY, p);
}

export async function clearPending(key) {
  const p = await read(PENDING_KEY);
  delete p[key];
  await write(PENDING_KEY, p);
}

/** Which actions a window is needed for. Everything else the worker can finish alone. */
export const NEEDS_WINDOW = Object.freeze(['skill', 'prompt', 'monitor']);
export const needsWindow = (job) => NEEDS_WINDOW.includes(job?.action?.kind);

/** Jobs an in-meeting event fires. `ctx.isSelf` decides whose speech counts. */
export async function jobsForMeetingEvent(event, ctx = {}) {
  return jobsForEvent(await listJobs(), event, { registry: triggers, ctx });
}

// ---------------------------------------------------------------------------
// Spoken commands → jobs
// ---------------------------------------------------------------------------

const uid = () => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Turn a parsed voice command into a durable job.
 *
 * A timer is a one-shot notify; a reminder is the same thing with a name and, when it was
 * said that way, a recurrence. Both are class R — they cost nothing and act on nothing but a
 * message — which is exactly why they are the two that may be created by talking.
 */
export function jobFromCommand(cmd, { now = Date.now() } = {}) {
  if (cmd?.intent === 'voice:timer') {
    const label = cmd.args.label ? `Timer — ${cmd.args.label}` : 'Timer';
    return {
      id: uid(),
      name: label,
      trigger: timerTrigger.id,
      schedule: { kind: 'once', at: cmd.args.at },
      action: { kind: 'notify', title: label, body: `${formatDuration(cmd.args.ms)} is up.` },
      onMissed: 'runOnce',
      createdAt: now,
      source: 'voice',
    };
  }
  if (cmd?.intent === 'voice:reminder') {
    // A reminder with no time is not a job — there is nothing to wake for. The caller turns
    // it into a note instead, which is what "remind me to thank the team" actually wants.
    if (!cmd.args.at) return null;
    const schedule = cmd.args.recurrence
      ? { ...cmd.args.recurrence, kind: cmd.args.recurrence.kind }
      : { kind: 'once', at: cmd.args.at };
    return {
      id: uid(),
      name: cmd.args.text,
      trigger: timerTrigger.id,
      schedule,
      action: { kind: 'notify', title: 'Reminder', body: cmd.args.text },
      onMissed: 'runOnce',
      createdAt: now,
      source: 'voice',
    };
  }
  if (cmd?.intent === 'voice:schedule') {
    // The target is a NAME, not a skill id — the caller resolves it against the skills this
    // user actually has, because only it knows them. An unmatched name is still useful: the
    // words become the instruction, so "every morning at 8 run the standup summary" works
    // before any skill by that name exists.
    const schedule = cmd.args.recurrence
      ? { ...cmd.args.recurrence }
      : { kind: 'once', at: cmd.args.at };
    return {
      id: uid(),
      name: cmd.args.target,
      trigger: timerTrigger.id,
      schedule,
      action: { kind: 'prompt', text: cmd.args.target },
      onMissed: 'runOnce',
      createdAt: now,
      source: 'voice',
    };
  }
  return null;
}

/**
 * Point a spoken schedule at a skill the user already wrote, when one matches by name. The
 * skill then stays the single definition of the work and the job says only when — which is
 * the whole reason a job's instruction is a skill id rather than a copy of its prompt.
 */
export function bindSkill(spec, skills = []) {
  if (!spec || spec.action?.kind !== 'prompt') return spec;
  const want = String(spec.action.text || '').trim().toLowerCase();
  if (!want) return spec;
  const hit = skills.find((sk) => {
    const n = String(sk.name || '').trim().toLowerCase();
    return n && (n === want || n.includes(want) || want.includes(n));
  });
  if (!hit) return spec;
  return { ...spec, name: hit.name, action: { kind: 'skill', skillId: hit.id, skillName: hit.name } };
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h} hour${h === 1 ? '' : 's'}`;
}

/** When this job next fires, for a UI that has to say so. */
export function whenNext(job, now = Date.now(), lastRun = 0) {
  if (job.trigger !== timerTrigger.id || !job.schedule) return null;
  try { return nextFireAt(job.schedule, Math.max(now, lastRun)); } catch { return null; }
}

// Re-exported so the panel reaches the shared predicate through the module it already
// loads to run a job, instead of pulling events/schedule.js onto another import path.
export { occurrenceKey, utteranceLooksComplete, coalesceMatches, matchTexts, matchSummary, clipText };

/**
 * Which jobs BATCH their triggers instead of dropping the second one.
 *
 * An action that produces an answer must never discard a trigger: thirteen questions asked
 * in a burst, one answered and twelve skipped "(cooldown)", is a feature that looks broken
 * and is. `notify` and `monitor` are the opposite — one reminder is the whole point, and
 * thirteen monitors on one topic is the runaway the cooldown exists to stop.
 */
export const BATCHES = Object.freeze(['skill', 'prompt']);
export const batches = (job) => BATCHES.includes(job?.action?.kind);

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Jobs and their watermarks. The watermarks matter as much as the jobs: restore the
 * definitions without them and every daily brief since the backup was taken looks missed,
 * so the first wake-up after a restore runs a catch-up nobody asked for.
 *
 * Claims and pending work are deliberately NOT exported — they describe what one machine was
 * part-way through, and carrying them to another would suppress a run that machine never did.
 */
export async function exportJobs() {
  return { jobs: await read(JOBS_KEY), runs: await read(RUNS_KEY), log: await read(LOG_KEY) };
}

export async function importJobs(data, { mode = 'merge' } = {}) {
  if (!data || typeof data !== 'object') return 0;
  const incoming = data.jobs && typeof data.jobs === 'object' ? data.jobs : {};
  const current = mode === 'replace' ? {} : await read(JOBS_KEY);
  const runs = mode === 'replace' ? {} : await read(RUNS_KEY);
  let n = 0;
  for (const [id, job] of Object.entries(incoming)) {
    try {
      current[id] = defineJob(job); // validated on the way in: a job that cannot run is not stored
      n += 1;
    } catch {
      /* skip the malformed one, keep the rest — a bad line must not lose a backup */
    }
  }
  for (const [id, at] of Object.entries(data.runs || {})) {
    if (current[id]) runs[id] = Math.max(runs[id] || 0, Number(at) || 0);
  }
  const log = mode === 'replace' ? {} : await read(LOG_KEY);
  for (const [id, list] of Object.entries(data.log || {})) {
    if (current[id] && Array.isArray(list)) log[id] = list.slice(0, MAX_LOG_PER_JOB);
  }
  await write(JOBS_KEY, current);
  await write(RUNS_KEY, runs);
  await write(LOG_KEY, log);
  return n;
}
