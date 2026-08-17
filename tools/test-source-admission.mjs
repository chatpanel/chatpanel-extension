import assert from 'node:assert/strict';
import { registerSource, loadFromSources, clearSources, listSources } from '../extension/js/source-registry.js';

clearSources();
const loaded = [];
const src = (kind, label) => registerSource({
  kind, label, load: async () => { loaded.push(kind); return [{ kind, id: `${kind}-1` }]; }, builtIn: true,
});
src('chat', 'Chats');
src('meeting', 'Meetings');
src('note', 'Notes');

// Without a global switch, behaviour is exactly what it was.
loaded.length = 0;
let out = await loadFromSources({ includeChats: true, includeMeetings: true, includeNotes: true });
assert.deepEqual(loaded.sort(), ['chat', 'meeting', 'note']);
assert.equal(out.length, 3);

// A source the user switched off in Plugins does NO WORK — checked before loading, not by
// filtering results. Loading a meeting store to then discard it would cost the user the
// exact thing they asked to avoid.
loaded.length = 0;
out = await loadFromSources(
  { includeChats: true, includeMeetings: true, includeNotes: true },
  { admit: (s) => s.kind !== 'meeting' },
);
assert.deepEqual(loaded.sort(), ['chat', 'note'], 'a disabled source was still loaded');
assert.ok(!out.some((r) => r.kind === 'meeting'));

// The per-call flags still narrow WITHIN what is admitted: "search everything I allow" and
// "this time only notes" are different questions and both have to work.
loaded.length = 0;
await loadFromSources({ includeChats: false, includeMeetings: false, includeNotes: true }, { admit: () => true });
assert.deepEqual(loaded, ['note']);

// Admission is a global switch, not a way to widen: a source the caller excluded stays
// excluded even when admitted.
loaded.length = 0;
await loadFromSources({ include: ['note'] }, { admit: () => true });
assert.deepEqual(loaded, ['note']);

// No admit function at all means everything is available — the safe default when the
// manifest cannot be read.
loaded.length = 0;
await loadFromSources({ includeChats: true, includeMeetings: true, includeNotes: true }, { admit: null });
assert.equal(loaded.length, 3);

assert.equal(listSources().length, 3);
console.log('✓ sources: a disabled source does no work, per-call flags still narrow');
