import assert from 'node:assert/strict';

import {
  TOPIC_INDEX_VERSION,
  contentHash,
  fallbackTopicItems,
  insightTopicItemsFromNotes,
  parseTopicExtractionResponse,
  shouldExtractTopics,
  topicDisplayForMeetingSource,
  topicDisplayForSource,
  topicItemsForDisplay,
  topicExtractionPrompt,
  topicSourceTextForConversation,
  topicSourceTextForMeeting,
} from '../extension/js/topic-extraction.js';

const parsed = parseTopicExtractionResponse(`
\`\`\`json
{"topics":["Gemini API key","Gemini API key","Speaker","2026 roadmap","cache stampede protection","too many words in this generated topic"]}
\`\`\`
`);
assert.deepEqual(parsed, ['gemini api key', '2026 roadmap', 'cache stampede protection']);

assert.deepEqual(parseTopicExtractionResponse('["OpenRouter credits","model max tokens"]'), ['openrouter credits', 'model max tokens']);
assert.deepEqual(parseTopicExtractionResponse('["it’s","if","because","need","i am","Apex health access"]'), ['apex health access']);
assert.deepEqual(parseTopicExtractionResponse('not json\n- Redis cache\n- API layer'), ['redis cache', 'api layer']);

const convText = topicSourceTextForConversation({
  title: 'Provider setup',
  messages: [
    { role: 'user', content: 'How do I configure Gemini API keys?' },
    { role: 'assistant', agentName: 'OpenRouter', content: 'Set the API key and reduce max tokens.' },
    { role: 'assistant', content: 'hidden pending text', pending: true },
  ],
});
assert.match(convText, /Provider setup/);
assert.match(convText, /Gemini API keys/);
assert.doesNotMatch(convText, /hidden pending/);

const meetingText = topicSourceTextForMeeting(
  {
    title: 'Redis planning',
    segments: [
      { speaker: 'Alice', text: 'Redis cache invalidation belongs in the API layer.' },
      { speaker: 'Bob', text: 'Add cache stampede protection.' },
    ],
  },
  'The team chose Redis for API caching.',
);
assert.match(meetingText, /SUMMARY/);
assert.match(meetingText, /TRANSCRIPT/);

const insightNotes = [
  '## Summary',
  'The team chose Redis for API caching.',
  '',
  '## Topics',
  '- Redis cache: The team chose Redis caching for API-layer invalidation and cache stampede protection.',
  '- API gateway authentication: The group reviewed gateway auth changes needed before rollout.',
  '- Speaker',
  "- It's",
  '',
  '## Key Moments',
  '- [decision] Keep cache invalidation in the API layer.',
].join('\n');
assert.deepEqual(insightTopicItemsFromNotes(insightNotes, 5), ['redis cache', 'api gateway authentication']);
assert.deepEqual(
  insightTopicItemsFromNotes('## Topics\nObject storage; disaster recovery, cache warming\nlease mechanism', 5),
  ['object storage', 'disaster recovery', 'cache warming', 'lease mechanism'],
);
assert.deepEqual(
  insightTopicItemsFromNotes([
    '## Topics',
    '- Object storage lifecycle: The team discussed lifecycle policy cleanup and retention risk.',
    '- Disaster recovery: The group reviewed failover expectations for the storage service.',
    '- cache warming dashboard: The team connected alert routing to the health dashboard work.',
  ].join('\n'), 5),
  ['object storage lifecycle', 'disaster recovery', 'cache warming dashboard'],
);

const insightMeetingText = topicSourceTextForMeeting(
  {
    title: 'Redis planning',
    segments: [
      { speaker: 'Alice', text: 'This transcript body should not be needed when insight topics exist.' },
    ],
  },
  insightNotes,
);
assert.match(insightMeetingText, /INSIGHT TOPICS/);
assert.match(insightMeetingText, /redis cache/);
assert.match(insightMeetingText, /INSIGHTS/);
assert.doesNotMatch(insightMeetingText, /This transcript body should not be needed/);

const prompt = topicExtractionPrompt({ kind: 'meeting', title: 'Redis planning', text: meetingText });
assert.match(prompt, /Return only JSON/);
assert.match(prompt, /8 to 15 topics/);
assert.match(prompt, /Redis planning/);

assert.equal(contentHash('a  b\nc'), contentHash('a b c'));
assert.notEqual(contentHash('a b c'), contentHash('a b d'));
const fallbackTopics = fallbackTopicItems("It's if because need don't I'm Apex health access object storage API gateway", 6);
for (const bad of ['its', 'if', 'because', 'need', 'dont', 'im', 'access']) {
  assert.equal(fallbackTopics.includes(bad), false);
}
assert.ok(fallbackTopics.includes('apex health'));
assert.ok(fallbackTopics.includes('object storage'));
assert.ok(fallbackTopics.includes('api gateway'));
const redisFallbackTopics = fallbackTopicItems('Redis cache cache invalidation API layer model tokens', 3);
assert.equal(redisFallbackTopics.length, 3);
assert.ok(redisFallbackTopics.includes('redis cache'));
assert.ok(redisFallbackTopics.includes('cache invalidation'));
assert.ok(redisFallbackTopics.includes('api layer'));

const noisyFallbackTopics = fallbackTopicItems(
  'Use the proxy command. See the command output. The team said good thing go time password. Object storage lifecycle policy and API gateway authentication were the durable decisions.',
  8,
);
for (const bad of ['use', 'proxy', 'see', 'command', 'time', 'team', 'password', 'go', 'good', 'thing']) {
  assert.equal(noisyFallbackTopics.includes(bad), false, `fallback topics should not include "${bad}"`);
}
for (const badPhrase of ['proxy go', 'go object', 'policy api', 'authentication redis']) {
  assert.equal(noisyFallbackTopics.includes(badPhrase), false, `fallback topics should not bridge through stopwords as "${badPhrase}"`);
}
assert.ok(noisyFallbackTopics.includes('object storage'));
assert.ok(noisyFallbackTopics.includes('api gateway'));
assert.ok(noisyFallbackTopics.includes('lifecycle policy'));
const awkwardFallbackTopics = fallbackTopicItems(
  'The discussion covered object storage disaster recovery and cache warming delivery. cache warming delivery remains in scope. Different docs should add more details. Yeah I think lease mechanism.',
  12,
);
for (const bad of ['discussion covered', 'covered object', 'delivery remains', 'different docs', 'docs should', 'should add', 'more details', 'yeah think', 'think lease', 'storage disaster', 'recovery interview', 'training lease', 'object storage disaster', 'storage disaster recovery']) {
  assert.equal(awkwardFallbackTopics.includes(bad), false, `fallback topics should not include "${bad}"`);
}
assert.ok(awkwardFallbackTopics.includes('object storage'));
assert.ok(awkwardFallbackTopics.includes('disaster recovery'));
assert.ok(awkwardFallbackTopics.includes('cache warming'));

const displayTopics = topicItemsForDisplay(
  { version: TOPIC_INDEX_VERSION - 1, items: ['its', 'if', 'because'] },
  "It's if because need Apex health access object storage",
  5,
);
assert.equal(displayTopics.includes('its'), false);
assert.ok(displayTopics.includes('apex health'));

const display = topicDisplayForSource(
  { version: TOPIC_INDEX_VERSION, items: ['gemini api key'], fallback: false },
  'fallback text',
  5,
);
assert.deepEqual(display, { items: ['gemini api key'], fallback: false });
const fallbackDisplay = topicDisplayForSource(null, 'Redis cache API layer', 5);
assert.equal(fallbackDisplay.fallback, true);
assert.ok(fallbackDisplay.items.includes('redis cache'));

const insightDisplay = topicDisplayForMeetingSource(
  null,
  insightNotes,
  'Use the proxy command. Object storage lifecycle policy.',
  5,
);
assert.equal(insightDisplay.fallback, false);
assert.equal(insightDisplay.source, 'insights');
assert.deepEqual(insightDisplay.items, ['redis cache', 'api gateway authentication']);
const insightDisplayOverStored = topicDisplayForMeetingSource(
  { version: TOPIC_INDEX_VERSION, items: ['stale transcript topic'], fallback: false },
  insightNotes,
  'fallback text',
  5,
);
assert.deepEqual(insightDisplayOverStored.items, ['redis cache', 'api gateway authentication']);

const insightFallbackDisplay = topicDisplayForMeetingSource(
  null,
  [
    '## Summary',
    'The team discussed object storage disaster recovery and cache warming delivery.',
    '',
    '## Topics',
    '',
    '## Key Moments',
    '- [decision] Use the lease mechanism for object storage coordination.',
  ].join('\n'),
  'Yeah I think we should add more details and different docs. Yeah mean figure out the command.',
  8,
);
assert.equal(insightFallbackDisplay.fallback, true);
assert.equal(insightFallbackDisplay.source, 'notes');
for (const bad of ['yeah think', 'yeah mean', 'should add', 'more details', 'different docs', 'figure out', 'think lease', 'mechanism more', 'docs gpu', 'discussion covered', 'covered object', 'delivery remains']) {
  assert.equal(insightFallbackDisplay.items.includes(bad), false, `notes fallback should not include "${bad}"`);
}
assert.ok(insightFallbackDisplay.items.includes('object storage'));
assert.ok(insightFallbackDisplay.items.includes('disaster recovery'));

const hash = contentHash(convText);
assert.equal(shouldExtractTopics(null, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION, hash, targetId: 'active', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), false);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION - 1, hash, targetId: 'active', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION, hash: 'old', targetId: 'active', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION, hash, targetId: 'other', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics(null, { hash, targetId: 'active', enabled: false }), false);

console.log('topic extraction tests passed');
