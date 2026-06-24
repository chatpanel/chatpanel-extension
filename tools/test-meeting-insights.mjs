import assert from 'node:assert/strict';

import {
  MEETING_INSIGHT_SECTIONS,
  composeMeetingInsightNotes,
  meetingInsightPrompt,
} from '../extension/js/meeting-insights.js';

assert.deepEqual(MEETING_INSIGHT_SECTIONS.map((s) => s.id), ['summary', 'topics', 'moments', 'links', 'actions']);
const topicsSection = MEETING_INSIGHT_SECTIONS.find((s) => s.id === 'topics');
assert.match(topicsSection.instruction, /1 to 2 sentences/i);
assert.match(topicsSection.instruction, /short topic label/i);
assert.match(topicsSection.instruction, /context/i);
assert.doesNotMatch(topicsSection.instruction, /graph/i);
assert.match(topicsSection.instruction, /filler/i);

const transcript = 'Alice: We chose Redis caching.\nBob: I will update the API gateway config.';
for (const section of MEETING_INSIGHT_SECTIONS) {
  const prompt = meetingInsightPrompt(section, transcript);
  assert.match(prompt, /Return only/);
  assert.match(prompt, /Alice: We chose Redis caching/);
  assert.doesNotMatch(prompt, new RegExp(`##\\s+${section.heading}`), 'section prompt should not ask the model to emit markdown headings');
}

const notes = composeMeetingInsightNotes({
  summary: 'The team chose Redis caching for the API path.',
  topics: '- Redis cache: The team chose Redis caching for API-layer invalidation.\n- API gateway: Bob will update the gateway config before rollout.',
  moments: '- [decision] Use Redis for API cache.',
  links: '- Redis runbook — https://example.com/redis',
  actions: '- [ ] Update API gateway config _(Bob)_',
});

assert.match(notes, /## Summary\nThe team chose Redis caching/);
assert.match(notes, /## Topics\n- Redis cache: The team chose Redis caching/);
assert.match(notes, /## Key Moments\n- \[decision\] Use Redis/);
assert.match(notes, /## Shared Links\n- Redis runbook — https:\/\/example\.com\/redis/);
assert.match(notes, /## Action Items\n- \[ \] Update API gateway/);
assert.equal(notes.includes('undefined'), false);

console.log('meeting insight tests passed');
