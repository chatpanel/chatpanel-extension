// Notes store: CRUD, encryption at rest, title derivation, export/import round-trip.
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
  getNoteIndex, getNote, saveNote, createNote, deleteNote, clearAllNotes,
  exportNotes, importNotes, noteToMarkdown, deriveTitle, noteKey,
  captureToInbox, INBOX_NOTE_ID,
} = await import('../extension/js/store-notes.js');
const { isEncrypted } = await import('../extension/js/meeting-crypto.js');

// 1) create → indexed, retrievable, encrypted at rest.
{
  assert.deepEqual(await getNoteIndex(), []);
  const rec = await createNote({ body: '# Roadmap\n\nShip the warm tier.' });
  assert.ok(rec.id);
  assert.equal(rec.title, 'Roadmap', 'title derived from first line, heading marks stripped');
  const idx = await getNoteIndex();
  assert.equal(idx.length, 1);
  assert.equal(idx[0].chars > 0, true);
  assert.equal(isEncrypted(storage.get(noteKey(rec.id))), true, 'record stored encrypted');
  assert.equal(isEncrypted(storage.get('chatpanel:noteIndex')), true, 'index stored encrypted');
  assert.deepEqual(await getNote(rec.id), rec);
}

// 2) explicit title wins; save updates + keeps createdAt, bumps updatedAt; newest first.
{
  const a = await createNote({ title: 'Alpha', body: 'first' });
  const created = a.createdAt;
  const b = await createNote({ title: 'Beta', body: 'second' });
  let idx = await getNoteIndex();
  assert.equal(idx[0].id, b.id, 'most-recently-edited first');
  const a2 = await saveNote({ id: a.id, title: 'Alpha', body: 'edited', createdAt: created });
  assert.equal(a2.createdAt, created, 'createdAt preserved');
  assert.ok(a2.updatedAt >= b.updatedAt, 'updatedAt bumped');
  idx = await getNoteIndex();
  assert.equal(idx[0].id, a.id, 'edited note jumps to top');
  assert.equal((await getNote(a.id)).body, 'edited');
}

// 3) delete + clear.
{
  const n = await createNote({ body: 'to delete' });
  await deleteNote(n.id);
  assert.equal(await getNote(n.id), null);
  assert.equal((await getNoteIndex()).some((e) => e.id === n.id), false);
  await clearAllNotes();
  assert.deepEqual(await getNoteIndex(), []);
}

// 4) export → import round-trip preserves ids, body, timestamps.
{
  await clearAllNotes();
  await importNotes([
    { id: 'k1', title: 'Kept', body: 'body one', createdAt: 100, updatedAt: 200, tags: ['x'] },
    { id: 'k2', body: 'body two\nmore', createdAt: 300, updatedAt: 400 },
  ]);
  const dump = await exportNotes();
  assert.equal(dump.length, 2);
  const k1 = dump.find((n) => n.id === 'k1');
  assert.equal(k1.createdAt, 100);
  assert.equal(k1.updatedAt, 200);
  assert.deepEqual(k1.tags, ['x']);
  const k2 = dump.find((n) => n.id === 'k2');
  assert.equal(k2.title, 'body two', 'missing title derived on import');
  // replace mode clears first
  await importNotes([{ id: 'z', body: 'only me' }], { mode: 'replace' });
  assert.equal((await getNoteIndex()).length, 1);
}

// 5) markdown + title helpers.
{
  assert.equal(deriveTitle('## Heading\nrest'), 'Heading');
  assert.equal(deriveTitle('   \n\n  hello world'), 'hello world');
  assert.equal(deriveTitle(''), 'Untitled note');
  assert.equal(noteToMarkdown({ title: 'T', body: 'plain body' }), '# T\n\nplain body');
  assert.equal(noteToMarkdown({ body: '# Already\n\nx' }), '# Already\n\nx', 'no double title');
}

// 6) captureToInbox: one Inbox note, newest clip on top, quoted, with a scroll-to link.
{
  await clearAllNotes();
  await captureToInbox({ text: 'first clip', sourceUrl: 'https://example.com/a', sourceTitle: 'Page A' });
  await captureToInbox({ text: 'second clip', sourceUrl: 'https://example.com/b', sourceTitle: 'Page B' });
  const inbox = await getNote(INBOX_NOTE_ID);
  assert.equal(inbox.title, '📥 Inbox');
  assert.ok(inbox.body.indexOf('second clip') < inbox.body.indexOf('first clip'), 'newest clip on top');
  assert.match(inbox.body, /> second clip/, 'quoted');
  assert.match(inbox.body, /#:~:text=/, 'source link carries a scroll-to-text fragment');
  assert.equal((await getNoteIndex()).length, 1, 'all clips land in the single Inbox note');
  assert.equal((await captureToInbox({ text: '   ' })), null, 'empty selection is a no-op');
}

console.log('store-notes tests passed');
