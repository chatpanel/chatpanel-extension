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
