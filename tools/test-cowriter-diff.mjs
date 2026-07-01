// Co-writer diff: minimal word-level edits with correct offsets, typo filtering,
// dismissal keys, and application. Pure — the testable heart of the Editor co-writer.
import assert from 'node:assert/strict';
import { wordDiff, filterTypoEdits, editKey, applyEdits } from '../extension/js/cowriter-diff.js';

// 1) single typo → one precise edit with exact offsets.
{
  const orig = 'teh cat sat';
  const e = wordDiff(orig, 'the cat sat');
  assert.equal(e.length, 1);
  assert.deepEqual({ start: e[0].start, end: e[0].end, before: e[0].before, after: e[0].after }, { start: 0, end: 3, before: 'teh', after: 'the' });
  assert.equal(orig.slice(e[0].start, e[0].end), 'teh', 'offsets index the original exactly');
  assert.equal(applyEdits(orig, e), 'the cat sat');
}

// 2) adjacent changes merge into one run; separated changes stay distinct.
{
  const orig = 'i has a cat';
  const e = wordDiff(orig, 'I have a cat');
  assert.deepEqual(e.map((x) => `${x.before}->${x.after}`), ['i has->I have'], 'adjacent edits coalesce');
  assert.equal(applyEdits(orig, e), 'I have a cat');

  const orig2 = 'teh quick borwn fox'; // "quick"/"fox" match → two separate edits
  const e2 = wordDiff(orig2, 'the quick brown fox');
  assert.deepEqual(e2.map((x) => `${x.before}->${x.after}`), ['teh->the', 'borwn->brown']);
}

// 3) insertion (missing word) — start===end, before ''.
{
  const orig = 'cat sat mat';
  const e = wordDiff(orig, 'cat sat on mat');
  assert.equal(e.length, 1);
  assert.equal(e[0].before, '');
  assert.equal(e[0].after.trim(), 'on');
  assert.equal(e[0].start, e[0].end);
  assert.equal(applyEdits(orig, e), 'cat sat on mat', 'insertion applies with correct spacing');
}

// 4) deletion (dup word) — after ''.
{
  const orig = 'the the cat';
  const e = wordDiff(orig, 'the cat');
  assert.equal(applyEdits(orig, e), 'the cat');
  assert.ok(e.some((x) => x.after === ''), 'a deletion is represented');
}

// 5) no change → no edits.
assert.deepEqual(wordDiff('hello world', 'hello world'), []);

// 6) multi-line / markdown preserved: only the typo changes, offsets respect newlines.
{
  const orig = '# Notes\n\nThis is teh plan.';
  const e = wordDiff(orig, '# Notes\n\nThis is the plan.');
  assert.equal(e.length, 1);
  assert.equal(orig.slice(e[0].start, e[0].end), 'teh');
  assert.equal(applyEdits(orig, e), '# Notes\n\nThis is the plan.');
}

// 7) filterTypoEdits keeps small fixes, drops paragraph rewrites + big insertions.
{
  const edits = [
    { start: 0, end: 3, before: 'teh', after: 'the' }, // keep
    { start: 10, end: 10, before: '', after: 'the' }, // keep (small insertion)
    { start: 20, end: 24, before: 'good', after: 'a substantially rewritten and much longer clause here indeed', after_: 1 }, // drop (len)
    { start: 30, end: 30, before: '', after: 'an entire new sentence the model decided to add on its own' }, // drop (big insertion)
  ];
  const kept = filterTypoEdits(edits);
  assert.deepEqual(kept.map((k) => k.after), ['the', 'the']);
}

// 8) dismissal key is stable per before→after.
assert.equal(editKey({ before: 'teh', after: 'the' }), editKey({ before: 'teh', after: 'the' }));
assert.notEqual(editKey({ before: 'teh', after: 'the' }), editKey({ before: 'teh', after: 'The' }));

// 9) applyEdits handles multiple non-adjacent edits without offset drift.
{
  const orig = 'teh quick borwn fox';
  const e = wordDiff(orig, 'the quick brown fox');
  assert.equal(applyEdits(orig, e), 'the quick brown fox');
}

console.log('cowriter-diff tests passed');
