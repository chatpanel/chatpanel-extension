// A trigger the UI offers must have something that fires it. "When a meeting starts" was
// selectable, a job could be bound to it, and nothing ever emitted `meeting.started` — so it
// silently never ran. Same for "when a meeting ends".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const schedule = readFileSync(new URL('../extension/js/events/schedule.js', import.meta.url), 'utf8');

// Every event a trigger watches must be emitted somewhere in the client, or the trigger is
// decoration. This is the guard that would have caught the original bug.
const watched = [...schedule.matchAll(/watches: \['([a-z.]+)'\]/g)].map((m) => m[1]);
assert.ok(watched.includes('meeting.started'), 'the trigger set includes meeting.started');
for (const type of watched) {
  if (!type.startsWith('meeting.')) continue; // timer/voice/data events have their own paths
  assert.ok(
    new RegExp(`type: '${type.replace('.', '\\.')}'`).test(panel),
    `nothing fires "${type}" — a job bound to it could never run`,
  );
}

// Started fires ONCE per meeting: the live set is recomputed on a poll, and re-announcing
// would re-run the job every few seconds.
assert.match(panel, /meetingStartAnnounced !== state\.liveMeeting\.id/, 'guarded by meeting id');
assert.match(panel, /meetingStartAnnounced = state\.liveMeeting\.id/, 'and the guard is set');
assert.match(panel, /if \(!state\.liveMeeting\?\.id\) meetingStartAnnounced = null/, 'and cleared, so the next call still starts');

// EVERY CLIENT, ONE PATH. The trigger reads the shared meeting index that all four capture
// adapters write, so it is not tied to any one platform — and `platform` must ride along, or
// a job scoped to one client ("when a Zoom call starts") compares against undefined and never
// fires.
assert.match(panel, /platform: state\.liveMeeting\.platform \|\| ''/, 'started carries the platform');
assert.match(panel, /type: 'meeting\.ended'.*platform: e\.platform/, 'and so does ended');
assert.match(panel, /platform: top\.platform \|\| ''/, 'taken from the index every adapter writes');
{
  const { readdirSync } = await import('node:fs');
  const adapters = readdirSync(new URL('../extension/content/', import.meta.url)).filter((f) => /^adapter-/.test(f));
  assert.ok(adapters.length >= 4, `all capture adapters feed it (${adapters.join(', ')})`);
}

console.log(`ok — every meeting trigger has an emitter, on every client (${watched.filter((t) => t.startsWith('meeting.')).length} checked)`);

// END TO END, on every client: the event the panel now fires must actually select the job.
{
  const { jobsForEvent } = await import('../extension/js/events/schedule.js');
  const { triggers } = await import('../extension/js/jobs.js');
  const job = {
    id: 'j1', name: 'Interview', enabled: true,
    trigger: 'meeting:started', params: {},
    action: { kind: 'skill', skill: 'Interview' },
  };
  for (const platform of ['zoom', 'meet', 'teams', 'webex']) {
    const event = { type: 'meeting.started', meetingId: `m-${platform}`, title: `${platform} call`, platform };
    const hits = jobsForEvent([job], event, { registry: triggers });
    assert.equal(hits.length, 1, `a start job fires on ${platform}`);
  }
  // A job scoped to one client fires only there — which needs the platform the panel now sends.
  const zoomOnly = { ...job, params: { platform: 'zoom' } };
  assert.equal(jobsForEvent([zoomOnly], { type: 'meeting.started', meetingId: 'a', platform: 'zoom' }, { registry: triggers }).length, 1);
  assert.equal(jobsForEvent([zoomOnly], { type: 'meeting.started', meetingId: 'b', platform: 'teams' }, { registry: triggers }).length, 0);
}

// THE OCCURRENCE IS THE MEETING, not a wall clock and not zero.
{
  const panelSrc = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const stamp = panelSrc.slice(panelSrc.indexOf('function eventStamp'), panelSrc.indexOf('function eventStamp') + 900);
  assert.match(stamp, /if \(event\.meetingId\) return event\.meetingId;/,
    'a start/end is claimed per meeting — falling through to 0 let the first call ever claim the only slot, permanently');
  // Failures must be visible; a silent catch is why a dead trigger looked like a working one.
  assert.match(panelSrc, /console\.warn\('\[jobs\] meeting trigger failed'/, 'a failing job says so');
}

// YOUR OWN QUESTIONS COUNT. The question trigger defaulted to 'others', so the way people
// actually test it — alone in a call, asking a question themselves — matched nothing, and the
// job looked broken. It also contradicted the documented default ('anyone') two functions up.
{
  const { jobsForEvent } = await import('../extension/js/events/schedule.js');
  const { triggers } = await import('../extension/js/jobs.js');
  const ctx = { isSelf: (sp) => /^you$/i.test(String(sp || '')) };
  const job = (params) => ({ id: 'j', name: 'Interview', enabled: true, trigger: 'meeting:question', params, action: { kind: 'monitor', prompt: 'x' } });
  const said = (speaker) => ({ type: 'meeting.transcript.delta', meetingId: 'm', segments: [{ sid: 's', t: 1, speaker, text: 'What is the first thing we need to do?' }] });

  assert.equal(jobsForEvent([job({})], said('You'), { registry: triggers, ctx }).length, 1, 'your own question fires it');
  assert.equal(jobsForEvent([job({})], said('Alex Rivera'), { registry: triggers, ctx }).length, 1, 'and so does someone else\'s');
  // Anyone who wants only other people's questions can still say so.
  assert.equal(jobsForEvent([job({ speaker: 'others' })], said('You'), { registry: triggers, ctx }).length, 0);
}
