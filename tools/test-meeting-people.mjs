import assert from 'node:assert/strict';

import { isMeetingPersonName, peopleOfMeeting, speakerCountOfMeeting } from '../extension/js/meeting-people.js';

assert.equal(isMeetingPersonName('Speaker'), false);
assert.equal(isMeetingPersonName(' speaker '), false);
assert.equal(isMeetingPersonName('Speaker 1'), false);
assert.equal(isMeetingPersonName('Speaker Labs'), true);
assert.equal(isMeetingPersonName('You to Everyone'), false);
assert.equal(isMeetingPersonName('Chris Doyle to Everyone'), false);

const rec = {
  participants: [{ name: 'Speaker' }, { name: 'Alice' }],
  segments: [
    { speaker: 'Speaker', text: 'hello' },
    { speaker: 'Speaker 1', text: 'follow up' },
    { speaker: 'Bob', text: 'real person' },
    { speaker: 'You to Everyone', text: 'chat echo' },
    { speaker: 'https://example.com/avatar.png', text: 'avatar speaker' },
  ],
};

assert.deepEqual(peopleOfMeeting(rec), ['Alice', 'Bob']);
assert.equal(speakerCountOfMeeting(rec), 1);

console.log('meeting people tests passed');
