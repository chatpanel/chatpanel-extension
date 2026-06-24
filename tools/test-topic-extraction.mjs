import assert from 'node:assert/strict';

import {
  TOPIC_INDEX_VERSION,
  contentHash,
  fallbackTopicItems,
  parseTopicExtractionResponse,
  shouldExtractTopics,
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

const prompt = topicExtractionPrompt({ kind: 'meeting', title: 'Redis planning', text: meetingText });
assert.match(prompt, /Return only JSON/);
assert.match(prompt, /8 to 15 topics/);
assert.match(prompt, /Redis planning/);

assert.equal(contentHash('a  b\nc'), contentHash('a b c'));
assert.notEqual(contentHash('a b c'), contentHash('a b d'));
const fallbackTopics = fallbackTopicItems("It's if because need don't I'm Apex health access object storage API gateway", 6);
for (const bad of ['its', 'if', 'because', 'need', 'dont', 'im']) {
  assert.equal(fallbackTopics.includes(bad), false);
}
assert.ok(fallbackTopics.includes('apex'));
assert.deepEqual(fallbackTopicItems('Redis cache cache invalidation API layer model tokens', 3).length, 3);

const displayTopics = topicItemsForDisplay(
  { version: TOPIC_INDEX_VERSION - 1, items: ['its', 'if', 'because'] },
  "It's if because need Apex health access object storage",
  5,
);
assert.equal(displayTopics.includes('its'), false);
assert.ok(displayTopics.includes('apex'));

const hash = contentHash(convText);
assert.equal(shouldExtractTopics(null, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION, hash, targetId: 'active', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), false);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION - 1, hash, targetId: 'active', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION, hash: 'old', targetId: 'active', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics({ version: TOPIC_INDEX_VERSION, hash, targetId: 'other', items: ['gemini api key'] }, { hash, targetId: 'active', enabled: true }), true);
assert.equal(shouldExtractTopics(null, { hash, targetId: 'active', enabled: false }), false);

console.log('topic extraction tests passed');
