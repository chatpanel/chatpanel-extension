import assert from 'node:assert/strict';

import { buildGraph, tokenize, topTerms } from '../extension/js/meeting-index.js';

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

const relatedGraph = buildGraph([
  {
    id: 'm1',
    title: 'Jordan 1:1',
    people: ['Alex Rivera', 'Jordan Blake'],
    terms: ['object storage', 'cache warming'],
  },
  {
    id: 'm2',
    title: 'Storage Review',
    people: ['Jordan Blake'],
    terms: ['object storage', 'disaster recovery'],
  },
  {
    id: 'm3',
    title: 'Cache Warming',
    people: ['Dana Example'],
    terms: ['cache warming'],
  },
  {
    id: 'm4',
    title: 'Google Meet Jordan one-on-one',
    people: [],
    terms: [],
  },
  {
    id: 'm5',
    title: 'Zoom transcript Jordan 1 on 1',
    people: [],
    terms: [],
  },
  {
    id: 'm6',
    title: 'Google Meet one-on-one',
    people: [],
    terms: [],
  },
]);

const related = relatedGraph.relatedMeetings('m1');
assert.deepEqual(
  related.find((r) => r.id === 'm2')?.sharedPeople,
  ['Jordan Blake'],
  'related meetings should explain shared participants.',
);
assert.deepEqual(
  related.find((r) => r.id === 'm2')?.sharedTopics,
  ['object storage'],
  'related meetings should explain shared topics.',
);
assert.deepEqual(
  related.find((r) => r.id === 'm3')?.sharedTopics,
  ['cache warming'],
  'topic-only related meetings should still explain the topic reason.',
);
assert.deepEqual(
  related.find((r) => r.id === 'm4')?.sharedTitleTerms,
  ['jordan', 'one-on-one'],
  'title-only related meetings should explain the meaningful title terms.',
);
assert.deepEqual(
  related.find((r) => r.id === 'm5')?.sharedTitleTerms,
  ['jordan', 'one-on-one'],
  'semantic title aliases should connect 1:1, 1 on 1, and one-on-one titles.',
);
assert.equal(
  related.some((r) => r.id === 'm6'),
  false,
  'weak title aliases such as one-on-one should not create related meetings by themselves.',
);

const platformTitleGraph = buildGraph([
  {
    id: 'z1',
    title: 'zoom transcript 8326433615 2026 06 01',
    people: [],
    terms: [],
  },
  {
    id: 'z2',
    title: 'zoom transcript 97010126052 2026 06 02',
    people: [],
    terms: [],
  },
]);
assert.deepEqual(
  platformTitleGraph.relatedMeetings('z1'),
  [],
  'platform/tool boilerplate title words should not create related meetings.',
);

console.log('meeting index tests passed');
