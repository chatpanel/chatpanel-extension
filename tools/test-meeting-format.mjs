import assert from 'node:assert/strict';

import { meetingToMarkdown, meetingToText } from '../extension/js/store-meetings.js';

const rec = {
  id: 'm-format',
  platform: 'zoom',
  title: 'Link review',
  startedAt: 1710000000000,
  segments: [
    { t: 1710000000000, speaker: 'Alice', text: 'Please look at the runbook.' },
  ],
  chat: [
    { t: 1710000005000, sender: 'Bob', receiver: 'Everyone', text: 'Runbook: https://example.com/runbook' },
  ],
  participants: [
    { initials: 'AL', name: 'Alice Lee', role: 'Host' },
    { initials: 'BO', name: 'Bob Olson', role: '' },
  ],
};

const text = meetingToText(rec);
assert.match(text, /--- Chat ---/);
assert.match(text, /Bob to Everyone: Runbook: https:\/\/example\.com\/runbook/);
assert.match(text, /--- Participants ---/);
assert.match(text, /AL - Alice Lee \(Host\)/);

const markdown = meetingToMarkdown(rec);
assert.match(markdown, /## Transcript/);
assert.match(markdown, /## Chat/);
assert.match(markdown, /Bob to Everyone: Runbook: https:\/\/example\.com\/runbook/);
assert.match(markdown, /## Participants/);
assert.match(markdown, /AL - Alice Lee \(Host\)/);

console.log('meeting format tests passed');
