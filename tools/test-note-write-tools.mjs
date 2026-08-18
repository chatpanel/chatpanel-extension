// WRITING NOTES — the half of the notes capability that did not exist.
//
// Asked to save a finding, an agent tried to drive the Notes page with browser automation,
// was correctly blocked from a chrome-extension:// URL, and answered "no direct note-write
// connector is available — I can provide the copy-paste-ready text if you'd like." It was
// right, and the user was left being the clipboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_TOOL_SPECS, makeNoteToolExecutor } from '../extension/js/note-tools.js';

// A stand-in for the notes store, with the same surface the real one exposes.
const makeStore = (seed = {}) => {
  const notes = new Map(Object.entries(seed));
  let n = 0;
  return {
    notes,
    createNote: async ({ title, body, attribution }) => {
      const rec = { id: `note-${++n}`, title: title || 'Untitled', body, attribution };
      notes.set(rec.id, rec);
      return rec;
    },
    getNote: async (id) => notes.get(id) || null,
    saveNote: async (note) => { notes.set(note.id, note); return note; },
  };
};
const run = (exec, args) => exec('note', args).then(JSON.parse);

test('the tool exists, says it writes, and points reads at `find`', () => {
  const spec = NOTE_TOOL_SPECS.find((s) => s.name === 'note');
  assert.ok(spec, 'there is still no note-write tool');
  assert.deepEqual(spec.parameters.properties.action.enum, ['create', 'append', 'update']);
  assert.match(spec.description, /do NOT try to drive the Notes page with browser tools/);
  assert.match(spec.description, /To FIND or READ notes use `find`/);
  // No delete. Recoverable actions only.
  assert.ok(!spec.parameters.properties.action.enum.includes('delete'));
});

test('every write asks first, and a decline is final', async () => {
  const store = makeStore();
  const asked = [];
  const exec = makeNoteToolExecutor({ store, confirm: async (d) => { asked.push(d); return 'deny'; } });
  const out = await run(exec, { action: 'create', title: 'A finding', body: 'text' });
  assert.equal(out.ok, false);
  // The wording page actions use: a model told only "denied" retries with different args.
  assert.match(out.error, /Do not retry it/);
  assert.equal(store.notes.size, 0, 'a declined write still wrote');
  assert.match(asked[0], /Create a note “A finding”/);
});

test('a call that cannot succeed is refused BEFORE the user is asked', async () => {
  // A confirmation card for an impossible call spends the user's attention to tell the model
  // something it could have been told directly.
  const asked = [];
  const exec = makeNoteToolExecutor({ store: makeStore(), confirm: async (d) => { asked.push(d); return 'allow'; } });
  assert.match((await run(exec, { action: 'append', text: 'x' })).error, /needs the note's id/);
  assert.match((await run(exec, { action: 'update', id: 'nope', body: 'x' })).error, /No note with id/);
  assert.match((await run(exec, { action: 'create' })).error, /needs a `title` or a `body`/);
  assert.match((await run(exec, { action: 'destroy' })).error, /Unknown action/);
  assert.equal(asked.length, 0, 'the user was asked to approve a call that could not run');
});

test('create records who wrote it, and shows the user', async () => {
  const store = makeStore();
  const shown = [];
  const exec = makeNoteToolExecutor({
    store, confirm: async () => 'allow', agentLabel: 'Codex', onWrote: (id, a) => shown.push([id, a]),
  });
  const out = await run(exec, { action: 'create', title: 'Finding', body: 'the body' });
  assert.equal(out.ok, true);
  const rec = store.notes.get(out.id);
  assert.equal(rec.body, 'the body');
  assert.equal(rec.attribution[0].by, 'Codex', 'a note written by an agent is not attributed to it');
  // A permission dialog followed by nothing visible asks the user to take the result on trust.
  assert.deepEqual(shown, [[out.id, 'create']]);
});

test('append adds to the end and never rewrites what was there', async () => {
  const store = makeStore({ 'n1': { id: 'n1', title: 'Log', body: 'first', attribution: [{ by: 'me' }] } });
  const exec = makeNoteToolExecutor({ store, confirm: async () => 'allow', agentLabel: 'Codex' });
  const out = await run(exec, { action: 'append', id: 'n1', text: 'second' });
  assert.equal(out.ok, true);
  assert.equal(store.notes.get('n1').body, 'first\n\nsecond');
  assert.equal(store.notes.get('n1').attribution.length, 2, 'the earlier author was dropped');
});

test('update keeps the previous version — the destructive action is recoverable', async () => {
  const store = makeStore({ 'n1': { id: 'n1', title: 'Draft', body: 'the original' } });
  const exec = makeNoteToolExecutor({ store, confirm: async () => 'allow', agentLabel: 'Codex' });
  const out = await run(exec, { action: 'update', id: 'n1', body: 'a rewrite' });
  assert.equal(out.ok, true);
  assert.equal(out.previousVersionKept, true);
  const rec = store.notes.get('n1');
  assert.equal(rec.body, 'a rewrite');
  // Into the note's OWN version ledger — the list the Notes UI already offers to revert to.
  assert.equal(rec.versions[0].body, 'the original', 'the previous body was lost');
  assert.match(rec.versions[0].label, /before Codex revised it/);
  assert.equal(rec.title, 'Draft', 'an update without a title renamed the note');
});

test('a store that refuses reports the reason instead of failing the turn', async () => {
  // The Free lifetime cap arrives as a thrown NoteLimitError. Reported as a fact about the
  // account, so the model explains it rather than retrying it.
  const store = makeStore();
  store.createNote = async () => { throw new Error('Free plan: 10 notes. Upgrade for unlimited.'); };
  const exec = makeNoteToolExecutor({ store, confirm: async () => 'allow' });
  const out = await run(exec, { action: 'create', title: 'x', body: 'y' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Free plan/);
});

test('confirmation can be switched off, matching the page-action preference', async () => {
  // Someone who has already said "stop asking before you act" has answered this too.
  const store = makeStore();
  let asked = 0;
  const exec = makeNoteToolExecutor({ store, confirm: async () => { asked++; return 'allow'; }, needsConfirm: false });
  assert.equal((await run(exec, { action: 'create', title: 'x', body: 'y' })).ok, true);
  assert.equal(asked, 0);
});

console.log('✓ note tools: writes ask first, keep what was there, and show the user');
