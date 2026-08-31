// Jobs as this client stores and wakes them: durability, one alarm, occurrence dedup, and
// the split between what a service worker can finish and what needs a window.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return storage.has(key) ? { [key]: storage.get(key) } : {}; },
      async set(values) { Object.entries(values).forEach(([k, v]) => storage.set(k, v)); },
    },
  },
};

const jobs = await import('../extension/js/jobs.js');
const { timerTrigger, phraseTrigger } = await import('../extension/js/events/schedule.js');

const MON_10AM = new Date(2026, 5, 1, 10, 0, 0, 0).getTime();
const local = (days, hour, minute = 0) => new Date(2026, 5, 1 + days, hour, minute, 0, 0).getTime();

// ── storage ────────────────────────────────────────────────────────────────
{
  const job = await jobs.putJob({
    id: 'j1', name: 'Daily brief', trigger: timerTrigger.id,
    schedule: { kind: 'daily', hour: 8 }, action: { kind: 'skill', skillId: 'sk1' }, createdAt: MON_10AM,
  });
  assert.equal(job.name, 'Daily brief');
  assert.equal((await jobs.listJobs()).length, 1);
  assert.equal((await jobs.getJob('j1')).enabled, true);

  await jobs.setJobEnabled('j1', false);
  assert.equal((await jobs.getJob('j1')).enabled, false);
  await jobs.setJobEnabled('j1', true);

  // A malformed job cannot reach storage — the shared contract validates on the way in.
  await assert.rejects(() => jobs.putJob({ id: 'bad', name: 'x', trigger: timerTrigger.id, action: { kind: 'skill' } }));
  assert.equal((await jobs.listJobs()).length, 1);
}

// ── one alarm, for the soonest job ─────────────────────────────────────────
{
  const armed = [];
  const port = { schedule: (at) => armed.push(at), cancel: () => armed.push(null) };
  const at = await jobs.armWake(port, MON_10AM);
  assert.equal(at, local(1, 8), 'tomorrow morning');
  assert.deepEqual(armed, [at], 'one alarm for every job, not one alarm each');
}

// ── occurrences are claimed once, whoever wakes first ──────────────────────
{
  const key = jobs.occurrenceKey('j1', local(1, 8));
  assert.equal(await jobs.claimOccurrence(key), true);
  assert.equal(await jobs.claimOccurrence(key), false, 'the second waker must not run it again');
}

// ── the split: what needs a window ─────────────────────────────────────────
{
  assert.equal(jobs.needsWindow({ action: { kind: 'skill' } }), true);
  assert.equal(jobs.needsWindow({ action: { kind: 'monitor' } }), true);
  assert.equal(jobs.needsWindow({ action: { kind: 'notify' } }), false,
    'a reminder must arrive with the panel closed, or it is not a reminder');
}

// ── due, and the watermark ─────────────────────────────────────────────────
{
  await jobs.recordRun('j1', MON_10AM);
  const due = await jobs.dueNow(local(1, 9));
  assert.equal(due.length, 1);
  assert.equal(due[0].at, local(1, 8));

  await jobs.recordRun('j1', local(1, 8));
  assert.deepEqual(await jobs.dueNow(local(1, 9)), [], 'a run occurrence closes its window');

  // A late catch-up must never re-open a window a later occurrence already closed.
  await jobs.recordRun('j1', local(0, 8));
  assert.equal((await jobs.lastRuns()).j1, local(1, 8), 'the watermark only moves forward');
}

// ── pending work for a window, bounded and drainable ───────────────────────
{
  await jobs.addPending({ key: 'k1', jobId: 'j1', at: 2 });
  await jobs.addPending({ key: 'k2', jobId: 'j1', at: 1 });
  assert.deepEqual((await jobs.pendingRuns()).map((p) => p.key), ['k2', 'k1'], 'oldest first');
  await jobs.clearPending('k2');
  assert.deepEqual((await jobs.pendingRuns()).map((p) => p.key), ['k1']);
}

// ── spoken commands become durable jobs ────────────────────────────────────
{
  const timer = jobs.jobFromCommand(
    { intent: 'voice:timer', args: { ms: 600_000, at: MON_10AM + 600_000, label: 'demo' } }, { now: MON_10AM },
  );
  assert.equal(timer.schedule.kind, 'once');
  assert.equal(timer.action.kind, 'notify', 'a timer costs nothing and acts on nothing');
  assert.match(timer.action.body, /10 minutes/);
  assert.equal(timer.name, 'Timer — demo');

  const recurring = jobs.jobFromCommand({
    intent: 'voice:reminder',
    args: { text: 'check the release queue', at: local(1, 9), recurrence: { kind: 'daily', hour: 9, minute: 0, weekdaysOnly: true } },
  }, { now: MON_10AM });
  assert.equal(recurring.schedule.kind, 'daily');
  assert.equal(recurring.schedule.weekdaysOnly, true);

  // "Remind me to thank the team" — no time, so there is nothing to wake for.
  assert.equal(jobs.jobFromCommand({ intent: 'voice:reminder', args: { text: 'thank the team', at: null } }), null);
  assert.equal(jobs.jobFromCommand({ intent: 'voice:note', args: { text: 'x' } }), null);
}

// ── a spoken schedule points AT a skill, when one matches ──────────────────
{
  const spec = jobs.jobFromCommand({
    intent: 'voice:schedule',
    args: { target: 'daily brief', at: local(1, 8), recurrence: { kind: 'daily', hour: 8, minute: 0, weekdaysOnly: true } },
  }, { now: MON_10AM });
  assert.equal(spec.action.kind, 'prompt', 'until a skill is found, the words ARE the instruction');

  const bound = jobs.bindSkill(spec, [{ id: 'sk9', name: 'Daily Brief', prompt: '...' }]);
  assert.equal(bound.action.kind, 'skill');
  assert.equal(bound.action.skillId, 'sk9', 'the skill stays the single definition of the work');
  assert.equal(bound.name, 'Daily Brief');

  // No such skill → still a usable job, not a failure.
  assert.equal(jobs.bindSkill(spec, [{ id: 'x', name: 'Something else' }]).action.kind, 'prompt');
}

// ── an event fires the jobs bound to it ────────────────────────────────────
{
  await jobs.putJob({
    id: 'j2', name: 'Log action items', trigger: phraseTrigger.id,
    params: { any: ['action item'], speaker: 'anyone' },
    action: { kind: 'skill', skillId: 'sk2' }, createdAt: MON_10AM,
  });
  const hits = await jobs.jobsForMeetingEvent(
    { type: 'meeting.transcript.delta', meetingId: 'm1', segments: [{ t: 1, speaker: 'Jordan Blake', text: 'that is an action item' }] },
    { isSelf: () => false },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].job.id, 'j2');

  await jobs.setJobEnabled('j2', false);
  assert.equal((await jobs.jobsForMeetingEvent(
    { type: 'meeting.transcript.delta', segments: [{ t: 1, speaker: 'x', text: 'that is an action item' }] }, {},
  )).length, 0, 'a disabled job is off, including for events');
}

// ── the ceiling every job has, set or not ──────────────────────────────────
{
  const job = { id: 'j3', name: 'Chatty', limits: {} };
  assert.equal(await jobs.withinLimits(job), true);
  for (let i = 0; i < jobs.DEFAULT_MAX_PER_DAY; i++) await jobs.countRun('j3');
  assert.equal(await jobs.withinLimits(job), false, "a runaway job stops after a day's worth of runs");
  // A job that asked for more gets more — the default is a floor under carelessness, not a policy.
  assert.equal(await jobs.withinLimits({ id: 'j3', limits: { maxPerDay: 100 } }), true);
  // Tomorrow is a fresh budget.
  assert.equal(await jobs.withinLimits(job, Date.now() + 86_400_000), true);
}

// ── what the create-a-job form builds ──────────────────────────────────────
{
  const { scheduleFor } = await import('../extension/js/jobs-panel.js');
  assert.deepEqual(scheduleFor('daily', 8, 30, 1), { kind: 'daily', hour: 8, minute: 30, weekdaysOnly: false });
  assert.deepEqual(scheduleFor('weekdays', 8, 0, 1), { kind: 'daily', hour: 8, minute: 0, weekdaysOnly: true });
  assert.deepEqual(scheduleFor('weekly', 9, 0, 3), { kind: 'weekly', weekday: 3, hour: 9, minute: 0 },
    'Wednesday is 3 — an off-by-one here is a job that runs on the wrong day forever');

  // "Once at 08:00" means the next 08:00, never one in the past.
  const once = scheduleFor('once', 8, 0, 0);
  assert.equal(once.kind, 'once');
  assert.ok(once.at > Date.now(), 'a one-shot must not be born already spent');
  assert.equal(new Date(once.at).getHours(), 8);

  // And every shape the form can produce must survive the contract's validation.
  const { validateSchedule } = await import('../extension/js/events/schedule.js');
  for (const id of ['daily', 'weekdays', 'weekly', 'once']) validateSchedule(scheduleFor(id, 8, 0, 3));
}

// ── formatting ─────────────────────────────────────────────────────────────
{
  assert.equal(jobs.formatDuration(45_000), '45 seconds');
  assert.equal(jobs.formatDuration(600_000), '10 minutes');
  assert.equal(jobs.formatDuration(5_400_000), '1h 30m');
  assert.equal(jobs.formatDuration(3_600_000), '1 hour');
}

console.log('jobs tests passed');
