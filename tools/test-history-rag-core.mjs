import assert from 'node:assert/strict';

import {
  buildHistoryRagAttachment,
  formatHistoryResults,
  getHistorySource,
  searchHistorySources,
} from '../extension/js/history-rag-core.js';

const sources = [
  {
    id: 'chat:c1',
    type: 'chat',
    title: 'API provider setup',
    date: 1710000000000,
    text: 'We configured OpenRouter and Gemini endpoints. The user asked about model max tokens and API keys.',
  },
  {
    id: 'meeting:m1',
    type: 'meeting',
    title: 'Redis cache design review',
    date: 1710000100000,
    text: 'SUMMARY: The team decided to keep Redis cache invalidation in the API layer.\nTRANSCRIPT: Alice discussed Redis TTL. Bob asked about cache stampede protection. '.repeat(12),
  },
  {
    id: 'meeting:m2',
    type: 'meeting',
    title: 'Budget review',
    date: 1710000200000,
    text: 'The team discussed credits, invoices, and spending limits.',
  },
  {
    id: 'meeting:m3',
    type: 'meeting',
    title: 'Jordan / Alex 1:1',
    date: 1710000300000,
    text: 'SUMMARY: Rollout coverage, cache warming delivery, and vacation planning were discussed.',
    url: 'chrome-extension://abc/meetings.html#m3',
  },
];

const results = searchHistorySources(sources, 'redis cache api layer', {
  scope: 'all',
  includeMeetings: true,
  limit: 3,
  maxChunkChars: 180,
});

assert.equal(results[0].sourceId, 'meeting:m1');
assert.equal(results[0].type, 'meeting');
assert.match(results[0].text, /Redis cache invalidation/);

const freeResults = searchHistorySources(sources, 'redis cache', {
  scope: 'all',
  includeMeetings: false,
  limit: 5,
});
assert.equal(freeResults.some((r) => r.type === 'meeting'), false);

const chatOnly = searchHistorySources(sources, 'api keys', {
  scope: 'chats',
  includeMeetings: true,
  limit: 5,
});
assert.deepEqual(chatOnly.map((r) => r.sourceId), ['chat:c1']);

const titleExact = searchHistorySources(sources, 'jordan', {
  scope: 'meetings',
  includeMeetings: true,
  mode: 'exact',
  field: 'title',
  limit: 5,
});
assert.deepEqual(titleExact.map((r) => r.sourceId), ['meeting:m3']);
assert.equal(titleExact[0].url, 'chrome-extension://abc/meetings.html#m3');

const contentExact = searchHistorySources(sources, 'jordan', {
  scope: 'meetings',
  includeMeetings: true,
  mode: 'exact',
  field: 'content',
  limit: 5,
});
assert.deepEqual(contentExact.map((r) => r.sourceId), [], 'Content-only exact search should not match title-only text.');

const pack = formatHistoryResults(results, { query: 'redis cache', maxChars: 700 });
assert.match(pack, /History search results for: redis cache/);
assert.match(pack, /\[meeting:m1#0\] Redis cache design review/);
assert.match(pack, /Use these sources as retrieved local history/);
assert.match(pack, /<sup>\[1\]<\/sup>/, 'History RAG context should instruct superscript citations.');
assert.match(pack, /Sources/, 'History RAG context should require a Sources section.');

const titlePack = formatHistoryResults(titleExact, { query: 'jordan', maxChars: 700 });
assert.match(titlePack, /Open: \[Open in ChatPanel\]\(chrome-extension:\/\/abc\/meetings\.html#m3\)/);

const directMeetingResults = searchHistorySources(
  [
    {
      id: 'meeting:loose-mention',
      type: 'meeting',
      title: 'zoom full transcript 2026 06 03',
      date: 1710000900000,
      text: Array.from(
        { length: 40 },
        (_, i) => `Jordan was mentioned in an unrelated group transcript while the team discussed storage ${i}.`,
      ).join(' '),
      meta: { people: ['Alex Rivera', 'Alice Example', 'Bob Example', 'Carol Example'] },
    },
    {
      id: 'meeting:direct-title',
      type: 'meeting',
      title: 'Jordan / Alex 1:1',
      date: 1710000200000,
      text: 'SUMMARY: Rollout coverage, cache warming delivery, and vacation planning were discussed.',
      meta: { people: ['Alex Rivera', 'Jordan Blake'] },
    },
    {
      id: 'meeting:direct-people',
      type: 'meeting',
      title: 'Weekly sync',
      date: 1710000100000,
      text: 'SUMMARY: Follow-up on project status.',
      meta: { people: ['Alex Rivera', 'Jordan Blake'] },
    },
  ],
  'what meetings i had with jordan as 1:1',
  { scope: 'meetings', includeMeetings: true, limit: 3, maxChunkChars: 260, overlapChars: 0 },
);
assert.equal(directMeetingResults[0].sourceId, 'meeting:direct-title');
assert.ok(
  directMeetingResults.findIndex((r) => r.sourceId === 'meeting:direct-people')
    < directMeetingResults.findIndex((r) => r.sourceId === 'meeting:loose-mention'),
  'Direct participant evidence should rank above transcript-only person mentions for 1:1 searches.',
);

const repeatedMeetingA = Array.from({ length: 80 }, (_, i) => `Jordan weekly one on one Rollout ${i}.`).join(' ');
const repeatedMeetingB = Array.from({ length: 4 }, (_, i) => `Jordan weekly one on one GPU ${i}.`).join(' ');
const diverse = searchHistorySources(
  [
    { id: 'meeting:long-a', type: 'meeting', title: 'Jordan weekly 1', date: 1710000600000, text: repeatedMeetingA },
    { id: 'meeting:short-b', type: 'meeting', title: 'Jordan weekly 2', date: 1710000500000, text: repeatedMeetingB },
  ],
  'jordan weekly one on one',
  { scope: 'meetings', includeMeetings: true, limit: 2, maxChunkChars: 120, overlapChars: 0 },
);
assert.deepEqual(
  diverse.map((r) => r.sourceId),
  ['meeting:long-a', 'meeting:short-b'],
  'History search should prefer source diversity before returning repeated chunks from one long meeting.',
);

const attachment = buildHistoryRagAttachment('redis cache', results, { maxChars: 700 });
assert.equal(attachment.kind, 'history-rag');
assert.equal(attachment.title, 'History search · 1 source');
assert.match(attachment.text, /History search results/);
assert.equal(attachment.chars, attachment.text.length);

const source = getHistorySource(sources, 'meeting:m1', { maxChars: 1000 });
assert.equal(source.sourceId, 'meeting:m1');
assert.equal(source.truncated, true);
assert.match(source.text, /Redis cache/);

const linkedSource = getHistorySource(sources, 'meeting:m3', { maxChars: 1000 });
assert.equal(linkedSource.url, 'chrome-extension://abc/meetings.html#m3');

console.log('history rag core tests passed');
