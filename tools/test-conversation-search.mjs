import assert from 'node:assert/strict';

import { paginateEntries, rankConversationEntries } from '../extension/js/conversation-search.js';

const entries = [
  { id: 'newer', title: 'Casual greeting', updatedAt: 1710000900000, msgs: 2, agentId: 'free' },
  { id: 'older', title: 'SFTP ingestion planning', updatedAt: 1710000100000, msgs: 4, agentId: 'codex' },
  { id: 'other', title: 'Drawing a car', updatedAt: 1710000000000, msgs: 2, agentId: 'free' },
];

const conversations = new Map([
  [
    'newer',
    {
      messages: [
        { role: 'user', content: 'Hello, can you help?' },
        { role: 'assistant', content: 'Yes.' },
      ],
    },
  ],
  [
    'older',
    {
      messages: [
        { role: 'user', content: 'We need a secure SFTP dropbox ingestion flow.' },
        { role: 'assistant', content: 'Use a container with SSH keys and checksum validation.' },
      ],
    },
  ],
  [
    'other',
    {
      messages: [
        { role: 'user', content: 'Draw a simple car with squares.' },
        { role: 'assistant', content: 'Here is a car drawing plan.' },
      ],
    },
  ],
]);

assert.deepEqual(
  rankConversationEntries(entries, '', conversations, { mode: 'smart' }).map((e) => e.id),
  ['newer', 'older', 'other'],
  'Empty chat search should keep recency ordering.',
);

assert.deepEqual(
  rankConversationEntries(entries, 'secure sftp ingestion checksum', conversations, { mode: 'smart' }).map((e) => e.id),
  ['older'],
  'Best match chat search should rank by messages and title, not only title or date.',
);

assert.deepEqual(
  rankConversationEntries(entries, 'secure sftp ingestion checksum', conversations, { mode: 'keyword' }).map((e) => e.id),
  [],
  'Exact text chat search should require the literal query string.',
);

assert.deepEqual(
  rankConversationEntries(entries, 'SFTP dropbox ingestion', conversations, { mode: 'keyword' }).map((e) => e.id),
  ['older'],
  'Exact text chat search should match literal text inside messages.',
);

const page = paginateEntries(Array.from({ length: 55 }, (_, i) => ({ id: `c${i}` })), { page: 3, pageSize: 20 });
assert.deepEqual(page.items.map((e) => e.id), Array.from({ length: 15 }, (_, i) => `c${i + 40}`));
assert.equal(page.totalPages, 3);
assert.equal(page.start, 41);
assert.equal(page.end, 55);
assert.equal(page.hasPrev, true);
assert.equal(page.hasNext, false);

console.log('conversation search tests passed');
