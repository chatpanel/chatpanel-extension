import assert from 'node:assert/strict';

import { rankMeetingEntries } from '../extension/js/meeting-search.js';

const entries = [
  {
    id: 'new-budget',
    platform: 'zoom',
    title: 'Budget review',
    startedAt: 1710000300000,
    endedAt: 1710000600000,
    lines: 20,
  },
  {
    id: 'old-cache',
    platform: 'zoom',
    title: 'Architecture sync 8326433615',
    startedAt: 1710000000000,
    endedAt: 1710000200000,
    lines: 45,
  },
];

const details = new Map([
  [
    'new-budget',
    {
      notes: 'The team discussed credits, invoices, and spending limits.',
      rec: { segments: [{ speaker: 'Ana', text: 'Budget owner asked about remaining credits.' }] },
    },
  ],
  [
    'old-cache',
    {
      notes: 'Decision: keep cache invalidation in the API layer.',
      rec: {
        segments: [
          { speaker: 'Priya', text: 'Database indexing and cache stampede protection are the key risks.' },
        ],
      },
    },
  ],
]);

assert.deepEqual(
  rankMeetingEntries(entries, '', details).map((e) => e.id),
  ['new-budget', 'old-cache'],
  'Empty meeting search should keep the recency-first list.',
);

assert.deepEqual(
  rankMeetingEntries(entries, 'database cache api layer', details).map((e) => e.id),
  ['old-cache'],
  'Meeting search should use best-match text across title, notes, and transcript, not only title/date.',
);

assert.deepEqual(
  rankMeetingEntries(entries, 'database api layer', details, { mode: 'keyword' }).map((e) => e.id),
  [],
  'Exact text meeting search should require one literal substring instead of token-based best match.',
);

assert.deepEqual(
  rankMeetingEntries(entries, '8326433615', details).map((e) => e.id),
  ['old-cache'],
  'Meeting search should still support exact numeric title/meeting-id searches.',
);

console.log('meeting search tests passed');
