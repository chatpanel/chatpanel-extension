import assert from 'node:assert/strict';
import {
  registerSource, listSources, getSource, hasSource, clearSources,
  resolveKinds, legacyFlag, loadFromSources,
} from '../extension/js/source-registry.js';

const src = (kind, ids, opts = {}) => registerSource({
  kind,
  label: kind,
  load: async () => ids.map((id) => ({ id: `${kind}:${id}`, title: `${kind} ${id}`, date: 1, text: 't' })),
  ...opts,
});

// ---------------------------------------------------------------- parity
// The refactor must not move a single result. Registration order IS result order, and the
// legacy per-kind flags must keep meaning exactly what they meant.
clearSources();
src('chat', ['a', 'b'], { enabledByDefault: true });
src('meeting', ['m'], { enabledByDefault: false });
src('note', ['n'], { enabledByDefault: true });

const dflt = await loadFromSources({ includeChats: true, includeMeetings: false, includeNotes: true });
assert.deepEqual(dflt.map((s) => s.id), ['chat:a', 'chat:b', 'note:n'], 'default selection changed');

const withMeetings = await loadFromSources({ includeChats: true, includeMeetings: true, includeNotes: true });
assert.deepEqual(withMeetings.map((s) => s.id), ['chat:a', 'chat:b', 'meeting:m', 'note:n'], 'order changed');

// Meetings stay OFF unless asked — the original default, and the one that matters most
// because meeting transcripts are the most sensitive corpus.
assert.deepEqual((await loadFromSources({})).map((s) => s.id), ['chat:a', 'chat:b', 'note:n']);
assert.equal(legacyFlag('chat'), 'includeChats');
assert.equal(legacyFlag('meeting'), 'includeMeetings');

// Turning one off removes exactly that one.
assert.deepEqual(
  (await loadFromSources({ includeChats: false, includeNotes: true })).map((s) => s.id),
  ['note:n'],
);

// ---------------------------------------------------------------- openness
// The point of the whole exercise: a source nobody hardcoded is picked up with no edit to
// any consumer.
src('linear', ['ISSUE-1'], { reads: ['net'] });
const withNew = await loadFromSources({ includeChats: true, includeMeetings: false, includeNotes: true, includeLinears: true });
assert.ok(withNew.some((s) => s.id === 'linear:ISSUE-1'), 'a newly registered source was not picked up');

// Explicit selection wins over every flag.
assert.deepEqual(
  (await loadFromSources({ include: ['linear'], includeChats: true })).map((s) => s.id),
  ['linear:ISSUE-1'],
);

// ---------------------------------------------------------------- isolation
// This is the test that decides whether the registry is safe to open at all: one bad
// source must cost its own section of the results and nothing else.
clearSources();
src('chat', ['a']);
registerSource({ kind: 'broken', label: 'broken', load: async () => { throw new Error('backend down'); } });
src('note', ['n']);

const errors = [];
const survived = await loadFromSources(
  { includeChats: true, includeBrokens: true, includeNotes: true },
  { onError: (s, e) => errors.push(`${s.kind}:${e.message}`) },
);
assert.deepEqual(survived.map((s) => s.id), ['chat:a', 'note:n'], 'a failing source broke the whole search');
assert.deepEqual(errors, ['broken:backend down'], 'the failure was swallowed silently');

// ---------------------------------------------------------------- declared access
// `reads` is the statement a user or an admin approves BEFORE anything runs.
clearSources();
src('linear', ['x'], { reads: ['net'] });
src('note', ['n'], { reads: ['notes'] });
assert.deepEqual(getSource('linear').reads, ['net']);
assert.ok(!getSource('note').reads.includes('net'), 'a local source must not claim network access');
assert.ok(hasSource('linear') && !hasSource('nope'));
// Descriptors are frozen, so a registered source cannot quietly widen its own access.
assert.throws(() => { 'use strict'; getSource('linear').reads = ['notes', 'net']; }, TypeError);

// ---------------------------------------------------------------- caching
clearSources();
let loads = 0;
registerSource({ kind: 'chat', label: 'chat', load: async () => { loads++; return [{ id: 'chat:a', text: 't' }]; } });
const cache = {};
await loadFromSources({ includeChats: true }, { cache });
await loadFromSources({ includeChats: true }, { cache });
assert.equal(loads, 1, 'the per-kind cache stopped working');
await loadFromSources({ includeChats: true });
assert.equal(loads, 2, 'an uncached call should still load');

// A duplicate kind is refused rather than silently shadowing.
assert.throws(() => src('chat', ['dup']), /already registered/);

clearSources();
console.log('✓ source registry: parity, openness, isolation, declared access, caching');
