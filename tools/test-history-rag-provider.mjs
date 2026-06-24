import assert from 'node:assert/strict';

globalThis.chrome = {
  runtime: {
    getURL(path) {
      return `chrome-extension://abc/${path}`;
    },
  },
  storage: {
    onChanged: { addListener() {} },
    local: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
};

const {
  conversationSource,
  historyToolProvider,
  inferHistoryScopeFromQuery,
  meetingSource,
  parseHistoryCommand,
  retrieveHistory,
  relatedHistorySources,
} = await import('../extension/js/history-rag.js');

assert.equal(parseHistoryCommand('plain question'), null);
assert.deepEqual(parseHistoryCommand('/history where did we discuss redis?'), {
  enabled: true,
  query: 'where did we discuss redis?',
  scope: 'all',
});
assert.deepEqual(parseHistoryCommand('/history meetings cache plan'), {
  enabled: true,
  query: 'cache plan',
  scope: 'meetings',
});
assert.deepEqual(parseHistoryCommand('/history chats api keys'), {
  enabled: true,
  query: 'api keys',
  scope: 'chats',
});
assert.equal(inferHistoryScopeFromQuery('what meetings i had with jordan as 1:1', { includeMeetings: true }), 'meetings');
assert.equal(inferHistoryScopeFromQuery('search chat history for provider setup', { includeMeetings: true }), 'chats');
assert.equal(inferHistoryScopeFromQuery('summarize this page about meetings', { includeMeetings: true }), 'all');

const chat = conversationSource(
  { id: 'c1', title: 'Provider setup', updatedAt: 1710000000000, agentId: 'agent-openrouter' },
  {
    id: 'c1',
    messages: [
      { role: 'user', content: 'How do I configure Gemini API keys?', attachments: [{ title: 'Settings page', text: 'Gemini auth uses API key.' }] },
      { role: 'assistant', agentName: 'OpenRouter', content: 'Set the API key and reduce max tokens if credits are low.' },
    ],
  },
);
assert.equal(chat.id, 'chat:c1');
assert.equal(chat.type, 'chat');
assert.match(chat.text, /User: How do I configure Gemini API keys/);
assert.match(chat.text, /attached: Settings page/);
assert.match(chat.text, /Agent: agent-openrouter/);

const meeting = meetingSource(
  { id: 'm1', title: 'Redis planning', startedAt: 1710000100000, platform: 'meet' },
  {
    id: 'm1',
    title: 'Redis planning',
    startedAt: 1710000100000,
    platform: 'meet',
    segments: [
      { speaker: 'Alice', text: 'Redis cache invalidation belongs in the API layer.', ts: 1710000101000 },
      { speaker: 'Bob', text: 'We should add cache stampede protection.', ts: 1710000102000 },
    ],
  },
  'The team chose Redis for API caching.',
);
assert.equal(meeting.id, 'meeting:m1');
assert.equal(meeting.type, 'meeting');
assert.match(meeting.text, /SUMMARY/);
assert.match(meeting.text, /TRANSCRIPT/);

const insightTopicMeeting = meetingSource(
  { id: 'm-insights', title: 'Insight topics', startedAt: 1710000100000, platform: 'meet' },
  { id: 'm-insights', title: 'Insight topics', segments: [] },
  [
    '## Summary',
    'The team chose Redis for API caching.',
    '',
    '## Topics',
    '- Redis cache',
    '- API gateway authentication',
  ].join('\n'),
);
assert.deepEqual(insightTopicMeeting.meta.terms, ['redis cache', 'api gateway authentication']);
const insightTopicMeetingWithStoredTopics = meetingSource(
  { id: 'm-insights-stored', title: 'Insight topics stored', startedAt: 1710000100000, platform: 'meet' },
  { id: 'm-insights-stored', title: 'Insight topics stored', segments: [] },
  [
    '## Summary',
    'The team chose Redis for API caching.',
    '',
    '## Topics',
    '- Redis cache',
    '- API gateway authentication',
  ].join('\n'),
  { items: ['stale transcript topic'] },
);
assert.deepEqual(insightTopicMeetingWithStoredTopics.meta.terms, ['redis cache', 'api gateway authentication']);

const sources = [
  chat,
  meeting,
  {
    id: 'chat:c2',
    type: 'chat',
    title: 'Same agent unrelated',
    date: 1710000050000,
    text: 'CHAT: Same agent unrelated\nAgent: agent-openrouter\nUser: Pick a calmer sidebar color palette and tighten button spacing.',
    meta: { agentId: 'agent-openrouter' },
  },
  {
    id: 'chat:c3',
    type: 'chat',
    title: 'Gemini follow-up',
    date: 1710000060000,
    text: 'CHAT: Gemini follow-up\nAgent: agent-codex\nUser: Gemini API keys, model max tokens, and provider setup.',
    meta: { agentId: 'agent-codex' },
  },
  {
    id: 'meeting:m2',
    type: 'meeting',
    title: 'Budget review',
    date: 1710000200000,
    text: 'Credits, invoices, and spending limits.',
  },
  {
    id: 'meeting:m3',
    type: 'meeting',
    title: 'Same people unrelated',
    date: 1710000300000,
    text: 'Holiday schedule, office lunch, and travel preferences.',
    meta: { people: ['Alice', 'Bob'] },
  },
  {
    id: 'meeting:m4',
    type: 'meeting',
    title: 'Cache follow-up',
    date: 1710000400000,
    text: 'The API layer needs Redis cache stampede protection and invalidation tests.',
    meta: { people: ['Dana'] },
  },
];

const freeProvider = historyToolProvider({ includeMeetings: false, loadSources: async () => sources });
assert.ok(freeProvider.specs.some((s) => s.name === 'history_search'));
assert.ok(freeProvider.specs.some((s) => s.name === 'history_get_source'));
assert.ok(freeProvider.specs.some((s) => s.name === 'history_related'));
const searchSpec = freeProvider.specs.find((s) => s.name === 'history_search');
assert.deepEqual(searchSpec.parameters.properties.mode.enum, ['best', 'exact']);
assert.deepEqual(searchSpec.parameters.properties.field.enum, ['all', 'title', 'content']);
assert.match(freeProvider.system, /local chat history/);
assert.doesNotMatch(freeProvider.system, /meeting history/);
assert.match(freeProvider.system, /<sup>\[1\]<\/sup>/, 'History tool prompt should require superscript citations.');
assert.match(freeProvider.system, /Sources/, 'History tool prompt should require a Sources section.');

const freeSearch = await freeProvider.execute('history_search', {
  query: 'redis cache',
  scope: 'all',
  limit: 5,
  maxChars: 2000,
});
assert.match(freeSearch, /No matching local history sources/);
assert.doesNotMatch(freeSearch, /Redis cache invalidation/);

const proProvider = historyToolProvider({ includeMeetings: true, loadSources: async () => sources });
assert.match(proProvider.system, /meeting history/);
const proSearch = await proProvider.execute('history_search', {
  query: 'redis cache',
  scope: 'all',
  limit: 5,
  maxChars: 2000,
});
assert.match(proSearch, /\[meeting:m1#0\] Redis planning/);
assert.match(proSearch, /Redis cache invalidation/);
assert.match(proSearch, /Open: \[Open in ChatPanel\]\(chrome-extension:\/\/abc\/meetings\.html#m1\)/);

const titleOnlyMeeting = meetingSource(
  { id: 'm-title', title: 'Jordan / Alex 1:1', startedAt: 1710000500000, platform: 'zoom' },
  {
    id: 'm-title',
    title: 'Jordan / Alex 1:1',
    startedAt: 1710000500000,
    platform: 'zoom',
    segments: [{ speaker: 'Alex', text: 'Rollout coverage and vacation planning.', ts: 1710000501000 }],
  },
);
const titleProvider = historyToolProvider({ includeMeetings: true, loadSources: async () => [titleOnlyMeeting] });
const titleSearch = await titleProvider.execute('history_search', {
  query: 'jordan',
  scope: 'meetings',
  mode: 'exact',
  field: 'title',
  limit: 5,
});
assert.match(titleSearch, /\[meeting:m-title#0\] Jordan \/ Alex 1:1/);

const contentSearch = await titleProvider.execute('history_search', {
  query: 'jordan',
  scope: 'meetings',
  mode: 'exact',
  field: 'content',
  limit: 5,
});
assert.match(contentSearch, /No matching local history sources/);

const meetingIntentSources = [
  {
    id: 'chat:jordan',
    type: 'chat',
    title: 'Jordan Slack follow-up',
    date: 1710000600000,
    text: 'CHAT: Jordan Slack follow-up\nUser: We discussed docs in a chat thread.',
  },
  titleOnlyMeeting,
];
const meetingIntent = await retrieveHistory('what meetings i had with jordan as 1:1', {
  includeMeetings: true,
  scope: 'all',
  limit: 5,
  loadSources: async () => meetingIntentSources,
});
assert.deepEqual(
  meetingIntent.results.map((r) => r.sourceId),
  ['meeting:m-title'],
  'Meeting-intent history retrieval should not mix in chat hits when meeting history is available.',
);

const fullSource = await proProvider.execute('history_get_source', {
  sourceId: 'meeting:m1',
  maxChars: 2000,
});
assert.match(fullSource, /Source: Redis planning/);
assert.match(fullSource, /Type: meeting/);
assert.match(fullSource, /Open: chrome-extension:\/\/abc\/meetings\.html#m1/);
assert.match(fullSource, /Redis cache invalidation belongs in the API layer/);

const related = relatedHistorySources(sources, 'chat:c1', { includeMeetings: true, limit: 3 });
assert.equal(related[0].sourceId, 'chat:c3');
assert.equal(related.some((r) => r.sourceId === 'chat:c2'), false);
assert.match(related[0].reason, /shared topics/);

const meetingRelated = relatedHistorySources(sources, 'meeting:m1', { includeMeetings: true, limit: 5 });
assert.equal(meetingRelated.some((r) => r.sourceId === 'meeting:m4'), true);
assert.equal(meetingRelated.some((r) => r.sourceId === 'meeting:m3'), false);

const relatedText = await proProvider.execute('history_related', {
  sourceId: 'chat:c1',
  limit: 3,
});
assert.match(relatedText, /Related local history for: chat:c1/);
assert.match(relatedText, /\[chat:c3\] Gemini follow-up/);
assert.doesNotMatch(relatedText, /Same agent unrelated/);

const missing = await proProvider.execute('history_get_source', { sourceId: 'meeting:missing' });
assert.match(missing, /not found/i);

console.log('history rag provider tests passed');
