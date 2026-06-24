import assert from 'node:assert/strict';

const storage = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map((k) => [k, storage.get(k)]).filter(([, v]) => v !== undefined));
        }
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return {};
      },
      async set(values) {
        Object.entries(values).forEach(([key, value]) => storage.set(key, value));
      },
      async remove(keys) {
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => storage.delete(key));
      },
    },
  },
};

const {
  getMeetingIndex,
  getMeeting,
  getMeetingNotes,
  meetingKey,
  persistMeeting,
  pruneMeetings,
} = await import('../extension/js/store-meetings.js');
const { decryptJSON, isEncrypted } = await import('../extension/js/meeting-crypto.js');

const K_MINDEX = 'chatpanel:meetingIndex';
const notesKey = 'chatpanel:meetingNotes:m1';
const record = {
  id: 'm1',
  platform: 'zoom',
  title: 'Plaintext fallback meeting',
  startedAt: 1710000000000,
  endedAt: 1710000060000,
  status: 'ended',
  segments: [{ t: 1710000000000, speaker: 'Priya', text: 'Discussed encryption fallback.' }],
};

storage.set(K_MINDEX, [{ id: 'm1', title: record.title, platform: record.platform }]);
storage.set(meetingKey('m1'), record);
storage.set(notesKey, 'Plaintext notes fallback');

assert.deepEqual(await getMeetingIndex(), [{ id: 'm1', title: record.title, platform: record.platform }]);
assert.deepEqual(await getMeeting('m1'), record);
assert.equal(await getMeetingNotes('m1'), 'Plaintext notes fallback');

assert.equal(isEncrypted(storage.get(K_MINDEX)), true, 'Plaintext meeting index should be repaired to encrypted storage.');
assert.equal(isEncrypted(storage.get(meetingKey('m1'))), true, 'Plaintext meeting record should be repaired to encrypted storage.');
assert.equal(isEncrypted(storage.get(notesKey)), true, 'Plaintext meeting notes should be repaired to encrypted storage.');
assert.deepEqual(await decryptJSON(storage.get(meetingKey('m1'))), record);

storage.clear();
const now = Date.now();
for (let i = 0; i < 80; i++) {
  await persistMeeting({
    id: `recent-${i}`,
    platform: 'zoom',
    title: `Recent meeting ${i}`,
    startedAt: now - i * 60_000,
    endedAt: now - i * 60_000 + 30_000,
    status: 'ended',
    segments: [{ t: now - i * 60_000, speaker: 'Alex', text: `Recent meeting transcript ${i}` }],
  });
}
assert.equal(
  await pruneMeetings(),
  0,
  'Default meeting pruning should not drop recent history just because there are more than 50 meetings.',
);
assert.equal((await getMeetingIndex()).length, 80);

console.log('store meeting encryption tests passed');
