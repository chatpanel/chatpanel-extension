// Deterministic Editor pre-pass: doubled words, space runs, space-before-punctuation,
// lone "i". Pure — the model is skipped when this finds fixes. Reuses the diff applier.
import assert from 'node:assert/strict';
import { lintText } from '../extension/js/cowriter-lint.js';
import { applyEdits } from '../extension/js/cowriter-diff.js';

const apply = (t) => applyEdits(t, lintText(t));

// 1) doubled word collapses.
{
  const t = 'this is is a test';
  const e = lintText(t);
  assert.equal(e.length, 1);
  assert.equal(apply(t), 'this is a test');
}

// 2) run of spaces → single space.
assert.equal(apply('a   b'), 'a b');
assert.equal(apply('one    two   three'), 'one two three');

// 3) space before punctuation.
assert.equal(apply('hello , world .'), 'hello, world.');
assert.equal(apply('really ?'), 'really?');

// 4) lone lowercase i → I, but not the "i.e." abbreviation.
assert.equal(apply('yesterday i went'), 'yesterday I went');
assert.equal(apply('i think so'), 'I think so');
assert.equal(apply('e.g. i.e. stuff'), 'e.g. i.e. stuff', 'i.e. is left alone');
assert.equal(apply('the iphone'), 'the iphone', 'i inside a word untouched');

// 5) clean text yields no edits (so the caller then spends a model token).
assert.deepEqual(lintText('A perfectly clean sentence.'), []);
assert.deepEqual(lintText(''), []);

// 6) multiple issues at once, all applied, non-overlapping.
{
  const t = 'i  saw the the cat , today';
  const fixed = apply(t);
  assert.equal(fixed, 'I saw the cat, today');
}

console.log('cowriter-lint tests passed');
