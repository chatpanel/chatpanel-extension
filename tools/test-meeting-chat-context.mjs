import assert from 'node:assert/strict';

import { buildMeetingChatAttachment, upsertMeetingChatAttachment } from '../extension/js/meeting-chat-context.js';

const rec = {
  id: 'm-1',
  platform: 'zoom',
  title: 'Weekly sync',
  url: 'https://example.com/meeting',
  startedAt: 1710000000000,
  segments: [
    { t: 1710000000000, speaker: 'Alice', text: 'We should ship the dashboard flow.' },
    { t: 1710000005000, speaker: 'Bob', text: 'I will follow up with screenshots.' },
  ],
};

const attachment = buildMeetingChatAttachment(rec, 'Decision: keep it simple.', { now: 123 });

assert.equal(attachment.id, 'mtg_m-1_123');
assert.equal(attachment.kind, 'meeting');
assert.equal(attachment.title, '🎙 Weekly sync');
assert.equal(attachment.url, 'https://example.com/meeting');
assert.match(attachment.text, /^SUMMARY:\nDecision: keep it simple\./);
assert.match(attachment.text, /TRANSCRIPT:/);
assert.match(attachment.text, /Alice: We should ship the dashboard flow\./);

const attachments = upsertMeetingChatAttachment(
  [{ id: 'mtg_m-1_1', kind: 'meeting', title: 'old', text: 'old' }, { id: 'page_1', kind: 'page', text: 'page' }],
  rec,
  '',
  { now: 456 },
);

assert.equal(attachments.length, 2);
assert.equal(attachments[0].id, 'mtg_m-1_456');
assert.equal(attachments[1].id, 'page_1');

console.log('meeting chat context tests passed');
