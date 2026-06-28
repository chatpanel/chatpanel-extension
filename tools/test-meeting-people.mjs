import assert from 'node:assert/strict';

import {
  isMeetingPersonName,
  participantRowsOfMeeting,
  peopleOfMeeting,
  speakerCountOfMeeting,
} from '../extension/js/meeting-people.js';

assert.equal(isMeetingPersonName('Speaker'), false);
assert.equal(isMeetingPersonName(' speaker '), false);
assert.equal(isMeetingPersonName('Speaker 1'), false);
assert.equal(isMeetingPersonName('Unknown Speaker'), false);
assert.equal(isMeetingPersonName('Speaker Labs'), true);
assert.equal(isMeetingPersonName('You to Everyone'), false);
assert.equal(isMeetingPersonName('Chris Doyle to Everyone'), false);

const rec = {
  participants: [{ name: 'Speaker' }, { name: 'Alice' }],
  segments: [
    { speaker: 'Speaker', text: 'hello' },
    { speaker: 'Speaker 1', text: 'follow up' },
    { speaker: 'Unknown Speaker', text: 'unattributed caption' },
    { speaker: 'Bob', text: 'real person' },
    { speaker: 'You to Everyone', text: 'chat echo' },
    { speaker: 'https://example.com/avatar.png', text: 'avatar speaker' },
  ],
};

assert.deepEqual(peopleOfMeeting(rec), ['Alice', 'Bob']);
assert.equal(speakerCountOfMeeting(rec), 1);

const variants = {
  participants: [
    { initials: 'AR', name: 'Alex Rivera', role: 'Eng · Me' },
    { initials: 'RF', name: 'S', role: 'Platform - Eng · Robin Fox' },
    { initials: 'PN', name: 'Priya Nair', role: '' },
    { initials: 'CL', name: 'Casey Lin', role: 'Platform Eng · Host' },
    { initials: 'TR', name: 'Taylor Reed', role: 'Platform Eng' },
  ],
  segments: [
    { speaker: 'Alex Rivera (Eng)', text: 'status' },
    { speaker: 'Robin Fox [Platform - Eng]', text: 'follow up' },
    { speaker: 'Taylor Reed (Platform Eng)', text: 'risk' },
    { speaker: 'Casey Lin (Platform _ Eng)', text: 'host note' },
    { speaker: 'Late Speaker', text: 'not in participant roster' },
  ],
};

const rows = participantRowsOfMeeting(variants);
assert.deepEqual(rows.map((p) => p.name), [
  'Alex Rivera',
  'Robin Fox',
  'Priya Nair',
  'Casey Lin',
  'Taylor Reed',
  'Late Speaker',
]);
assert.equal(rows.find((p) => p.name === 'Robin Fox')?.role, 'Platform - Eng');
assert.equal(rows.find((p) => p.name === 'Late Speaker')?.role, 'Speaker');
assert.deepEqual(peopleOfMeeting(variants), [
  'Alex Rivera',
  'Robin Fox',
  'Priya Nair',
  'Casey Lin',
  'Taylor Reed',
  'Late Speaker',
]);
assert.equal(speakerCountOfMeeting(variants), 5);

console.log('meeting people tests passed');
