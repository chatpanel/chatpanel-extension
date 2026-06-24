import assert from 'node:assert/strict';

import { tokenize, topTerms } from '../extension/js/meeting-index.js';

const badWords = ["it's", 'its', 'if', 'because', 'need', "don't", 'dont', "i'm", 'im', 'am'];

const transcript = `
  It's because I don't know if I'm missing something. I am saying we need data.
  Apex health access review covered object storage permissions, API gateway auth,
  browser extension settings, and meeting topic extraction.
  Apex health access needs object storage permission checks and API gateway auth.
  Because if it's not configured, I'm not able to access the data.
`;

const tokens = tokenize(transcript);
for (const word of badWords) {
  assert.equal(tokens.includes(word), false, `tokenize should filter filler token "${word}"`);
}

const terms = topTerms(transcript, 12);
for (const word of badWords) {
  assert.equal(terms.includes(word), false, `topTerms should not return filler topic "${word}"`);
}

assert.ok(terms.includes('apex'), 'topTerms should retain project/product terms');
assert.ok(terms.includes('health'), 'topTerms should retain domain terms');
assert.ok(terms.includes('access'), 'topTerms should retain workflow terms');
assert.ok(terms.includes('api'), 'topTerms should retain architecture/API terms');

console.log('meeting index tests passed');
