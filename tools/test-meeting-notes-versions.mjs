// Meeting-summary versioning (schema v2) — proves back-compat + DATA SAFETY:
// an old plain-string summary migrates losslessly to a 'live' version, the live
// scribe keeps updating in place, regenerated versions add/switch/delete, and a
// corrupt blob degrades to empty without throwing.
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

const {
  saveMeetingNotes, getMeetingNotes, getMeetingNoteVersions,
  getLiveNotesText, setActiveMeetingNote, deleteMeetingNoteVersion,
} = await import('../extension/js/store-meetings.js');
const { encryptJSON } = await import('../extension/js/meeting-crypto.js');

const ID = 'm1';
const notesKey = `chatpanel:meetingNotes:${ID}`;

// 1) OLD plain-string summary is read back verbatim (back-compat, no migration on read).
storage.set(notesKey, await encryptJSON('Old running summary'));
assert.equal(await getMeetingNotes(ID), 'Old running summary', 'old string read verbatim');
let v = await getMeetingNoteVersions(ID);
assert.equal(v.versions.length, 1, 'old string → exactly one version');
assert.equal(v.versions[0].id, 'live', 'old string becomes the live version');
assert.equal(v.activeId, 'live');

// 2) The live scribe (2-arg save) UPDATES the live version in place — never appends.
await saveMeetingNotes(ID, 'Updated running summary');
v = await getMeetingNoteVersions(ID);
assert.equal(v.versions.length, 1, 'live update stays one version');
assert.equal(await getMeetingNotes(ID), 'Updated running summary');
assert.equal(await getLiveNotesText(ID), 'Updated running summary');

// 3) Regenerate appends a NEW version and makes it active — without losing the live one.
await saveMeetingNotes(ID, '# Detailed minutes', { newVersion: true, style: 'detailed' });
v = await getMeetingNoteVersions(ID);
assert.equal(v.versions.length, 2, 'regenerate adds a version');
assert.equal(await getMeetingNotes(ID), '# Detailed minutes', 'active = the regenerated one');
assert.equal(await getLiveNotesText(ID), 'Updated running summary', 'live version preserved');
const genId = v.versions.find((x) => x.id !== 'live').id;
assert.equal(v.versions.find((x) => x.id === genId).style, 'detailed');

// 4) Scribe keeps updating the LIVE version even while a regenerated one is active,
//    and does NOT steal the user's active selection.
await saveMeetingNotes(ID, 'Even newer running summary');
v = await getMeetingNoteVersions(ID);
assert.equal(v.activeId, genId, 'active selection untouched by a live update');
assert.equal(await getLiveNotesText(ID), 'Even newer running summary');

// 5) Switch active back to the live version.
await setActiveMeetingNote(ID, 'live');
assert.equal(await getMeetingNotes(ID), 'Even newer running summary');

// 6) Delete a regenerated version; the live version is never deletable.
await deleteMeetingNoteVersion(ID, genId);
v = await getMeetingNoteVersions(ID);
assert.equal(v.versions.length, 1, 'regenerated version deleted');
await deleteMeetingNoteVersion(ID, 'live');
v = await getMeetingNoteVersions(ID);
assert.equal(v.versions.length, 1, 'live version is not user-deletable');

// 7) Corrupt/unknown blob → empty, never throws (other meetings stay safe).
storage.set(notesKey, await encryptJSON({ junk: true }));
assert.equal(await getMeetingNotes(ID), '', 'corrupt blob → empty');
assert.deepEqual((await getMeetingNoteVersions(ID)).versions, [], 'corrupt blob → no versions');

// 8) Empty / missing meeting id is a no-op, not a throw.
await saveMeetingNotes('', 'x');
assert.equal(await getMeetingNotes('nope'), '');

console.log('meeting notes versioning tests passed');
