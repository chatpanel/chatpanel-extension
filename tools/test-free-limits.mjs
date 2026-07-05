// Free-tier lifetime caps for notes + meetings: the cap counts items ever created;
// Pro/Team is unlimited; backup restore is never blocked or double-counted.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, storage.get(k)]).filter(([, v]) => v !== undefined));
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return {};
      },
      async set(values) { Object.entries(values).forEach(([k, v]) => storage.set(k, v)); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => storage.delete(k)); },
    },
  },
};

const K_LICENSE = 'chatpanel:license';
const setPlan = (plan) => (plan === 'free' ? storage.delete(K_LICENSE) : storage.set(K_LICENSE, { plan, status: 'active' }));

const { createNote, noteLimitReached, clearAllNotes, NoteLimitError } = await import('../extension/js/store-notes.js');
const {
  persistMeeting, meetingLimitReached, getMeeting, getMeetingIndex,
  deleteMeeting, clearAllMeetings, importMeetings,
} = await import('../extension/js/store-meetings.js');
const { usageCount } = await import('../extension/js/usage-counters.js');

// ── Notes ────────────────────────────────────────────────────────────────────
{
  setPlan('free');
  for (let i = 0; i < 10; i++) await createNote({ body: `note ${i}` });
  assert.equal(await usageCount('notesCreated'), 10, '10 notes created counts as 10');
  assert.equal((await noteLimitReached()).reached, true, 'at the cap');
  await assert.rejects(() => createNote({ body: 'eleventh' }), NoteLimitError, '11th note throws');

  // Cheat attempt: delete everything, then try again — still blocked (lifetime count).
  await clearAllNotes();
  assert.equal((await noteLimitReached()).count, 10, 'delete does NOT reset the lifetime count');
  await assert.rejects(() => createNote({ body: 'after wipe' }), NoteLimitError, 'still capped after deleting all notes');

  // Pro lifts the cap.
  setPlan('pro');
  assert.equal((await noteLimitReached()).reached, false, 'Pro is never capped');
  const rec = await createNote({ body: 'pro note' });
  assert.ok(rec?.id, 'Pro can create past 10');
}

// ── Meetings ───────────────────────────────────────────────────────────────────
{
  setPlan('free');
  const mkRec = (id) => ({ id, platform: 'zoom', meetingKey: id, title: id, startedAt: 1, endedAt: 2, status: 'ended', segments: [{ t: 1, speaker: 'A', text: 'hi' }] });

  for (let i = 1; i <= 10; i++) {
    const r = await persistMeeting(mkRec(`m${i}`));
    assert.equal(r.ok, true, `meeting m${i} stored`);
  }
  assert.equal(await usageCount('meetingsCreated'), 10, '10 meetings captured counts as 10');
  assert.equal((await meetingLimitReached()).reached, true, 'at the meeting cap');

  const blocked = await persistMeeting(mkRec('m11'));
  assert.equal(blocked.blocked, true, '11th NEW meeting is blocked');
  assert.equal(await getMeeting('m11'), null, 'blocked meeting is NOT stored');
  assert.equal((await getMeetingIndex()).length, 10, 'index stays at 10');

  // Updating an EXISTING meeting is never blocked.
  const upd = await persistMeeting({ ...mkRec('m5'), title: 'm5 edited' });
  assert.equal(upd.ok, true, 'existing meeting update allowed');
  assert.equal((await getMeeting('m5')).title, 'm5 edited');

  // Cheat attempt: delete half, capture again — still blocked (lifetime count).
  for (let i = 1; i <= 5; i++) await deleteMeeting(`m${i}`);
  assert.equal((await getMeetingIndex()).length, 5, 'five deleted');
  const stillBlocked = await persistMeeting(mkRec('m12'));
  assert.equal(stillBlocked.blocked, true, 'deleting meetings does NOT free a slot');
  assert.equal(await usageCount('meetingsCreated'), 10, 'lifetime count unchanged by deletes');

  // Restore is never blocked, and does not inflate the lifetime count.
  const before = await usageCount('meetingsCreated');
  const res = await importMeetings([{ record: mkRec('r1') }, { record: mkRec('r2') }], { mode: 'merge' });
  assert.equal(res.imported, 2, 'restore imports even over the cap');
  assert.ok(await getMeeting('r1'), 'restored meeting stored');
  assert.equal(await usageCount('meetingsCreated'), before, 'restore did not bump the lifetime count');

  // Pro lifts the cap.
  setPlan('pro');
  assert.equal((await meetingLimitReached()).reached, false, 'Pro is never capped');
  const proRec = await persistMeeting(mkRec('pro1'));
  assert.equal(proRec.ok, true, 'Pro can capture past 10');
}

console.log('free-limits tests passed');
