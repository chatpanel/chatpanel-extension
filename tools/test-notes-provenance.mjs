import assert from 'node:assert/strict';

import {
  HUMAN, blankAttribution, diffRange, mergeRuns, spliceAttribution,
  applyAttribution, attributionSummary, normalizeAttribution,
} from '../extension/js/notes-provenance.js';

const sumLen = (runs) => runs.reduce((n, r) => n + r.len, 0);

// ── blankAttribution ──
assert.deepEqual(blankAttribution(0), []);
assert.deepEqual(blankAttribution(3, 'You', 5), [{ len: 3, author: 'You', at: 5 }]);
assert.equal(HUMAN, 'You');

// ── diffRange: the minimal replaced span ──
assert.deepEqual(diffRange('abc', 'abXc'), { start: 2, end: 2, insLen: 1 });   // insertion
assert.deepEqual(diffRange('abc', 'ac'), { start: 1, end: 2, insLen: 0 });     // deletion
assert.deepEqual(diffRange('abc', 'abc'), { start: 3, end: 3, insLen: 0 });    // no change
assert.deepEqual(diffRange('', 'hello'), { start: 0, end: 0, insLen: 5 });     // append to empty

// ── mergeRuns: coalesce same author+time, drop empties ──
assert.deepEqual(
  mergeRuns([{ len: 2, author: 'You', at: 1 }, { len: 0, author: 'AI', at: 2 }, { len: 3, author: 'You', at: 1 }]),
  [{ len: 5, author: 'You', at: 1 }],
);

// ── applyAttribution: typing appends as the author; length stays consistent ──
let runs = blankAttribution(5, 'You', 1);        // "hello" by You
runs = applyAttribution(runs, 'hello', 'hello world', 'Claude', 2); // append " world" by Claude
assert.equal(sumLen(runs), 'hello world'.length);
assert.deepEqual(runs, [{ len: 5, author: 'You', at: 1 }, { len: 6, author: 'Claude', at: 2 }]);

// editing inside the You run splits it and attributes only the changed span
runs = applyAttribution(runs, 'hello world', 'hellX world', 'Claude', 3); // replace 'o' at idx4
assert.equal(sumLen(runs), 'hellX world'.length);
const claudeChars = runs.filter((r) => r.author === 'Claude').reduce((n, r) => n + r.len, 0);
assert.equal(claudeChars, 7); // the 1-char edit + the earlier 6-char " world"

// no-op edit returns the same runs
const before = applyAttribution(runs, 'hellX world', 'hellX world', 'You', 9);
assert.equal(before, runs);

// ── spliceAttribution directly ──
const s = spliceAttribution([{ len: 10, author: 'You', at: 1 }], 3, 6, 2, 'AI', 2);
assert.equal(sumLen(s), 9); // 10 - 3 replaced + 2 inserted
assert.deepEqual(s, [
  { len: 3, author: 'You', at: 1 },
  { len: 2, author: 'AI', at: 2 },
  { len: 4, author: 'You', at: 1 },
]);

// ── attributionSummary ──
const sum = attributionSummary([{ len: 6, author: 'You', at: 1 }, { len: 2, author: 'Claude', at: 2 }, { len: 2, author: 'You', at: 3 }]);
assert.equal(sum.total, 10);
assert.deepEqual(sum.by, [{ author: 'You', chars: 8 }, { author: 'Claude', chars: 2 }]); // sorted desc

// ── normalizeAttribution: adopt only when it matches the body length ──
assert.deepEqual(normalizeAttribution(null, 4, 7), [{ len: 4, author: 'You', at: 7 }]);
assert.deepEqual(normalizeAttribution([{ len: 2, author: 'AI', at: 1 }], 4, 7), [{ len: 4, author: 'You', at: 7 }]); // mismatch → reseed
assert.deepEqual(normalizeAttribution([{ len: 4, author: 'AI', at: 1 }], 4, 7), [{ len: 4, author: 'AI', at: 1 }]); // matches → keep

console.log('notes-provenance tests passed');
