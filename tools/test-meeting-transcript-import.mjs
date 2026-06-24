import assert from 'node:assert/strict';

import {
  parseTranscriptText,
  repairImportedTranscriptDate,
  repairTranscriptParticipants,
} from '../extension/js/meeting-transcript-import.js';

const parsed = parseTranscriptText(`# Link review

_Zoom · 3/9/2024, 8:00:00 AM_

## Transcript

**Alice** _(8:00:00 AM)_: Please review the runbook.

## Chat

[8:00:05 AM] Bob to Everyone: Runbook: https://example.com/runbook

## Participants

AL - Alice Lee (Host)
BO - Bob Olson
`, 'link-review.md', { now: 1710000000000 });

assert.equal(parsed.title, 'Link review');
assert.equal(parsed.segments.length, 1);
assert.equal(parsed.segments[0].speaker, 'Alice');
assert.equal(parsed.chat.length, 1);
assert.equal(parsed.chat[0].sender, 'Bob');
assert.equal(parsed.chat[0].receiver, 'Everyone');
assert.match(parsed.chat[0].text, /https:\/\/example\.com\/runbook/);
assert.deepEqual(parsed.participants, [
  { initials: 'AL', name: 'Alice Lee', role: 'Host' },
  { initials: 'BO', name: 'Bob Olson', role: '' },
]);

const datedFromFilename = parseTranscriptText(`
[8:00:00 AM] Alex: This imported Zoom transcript should keep its original date.
`, 'zoom transcript 98621982224 2026 06 01T15 46 31 915Z.txt', { now: 1710000000000 });
assert.equal(new Date(datedFromFilename.startedAt).toISOString(), '2026-06-01T15:46:31.915Z');
assert.equal(datedFromFilename.segments[0].t, datedFromFilename.startedAt);

const datedFromMetadata = parseTranscriptText(`# Metadata date

_Zoom · 2026-06-01T15:46:31.915Z_

## Transcript

[8:00:00 AM] Alex: This exported markdown should keep its original date.
`, 'metadata-date.md', { now: 1710000000000 });
assert.equal(new Date(datedFromMetadata.startedAt).toISOString(), '2026-06-01T15:46:31.915Z');

const linkOnly = parseTranscriptText(`## Shared Links

- Architecture doc — https://example.com/architecture
`, 'shared-links.txt', { now: 1710000000000 });

assert.equal(linkOnly.chat.length, 1);
assert.equal(linkOnly.chat[0].sender, 'Shared Links');
assert.match(linkOnly.chat[0].text, /https:\/\/example\.com\/architecture/);

const plainText = parseTranscriptText(`--- Meeting Transcript (Zoom) ---

[8:00:00 AM] Alice: Please read this.

--- Chat ---

[8:00:05 AM] Bob to Everyone: Link: https://example.com/plain

--- Participants ---

AL - Alice Lee (Host)
BO - Bob Olson
WC - S - Platform - Eng - Robin Fox
`, 'plain.txt', { now: 1710000000000 });

assert.equal(plainText.segments.length, 1);
assert.equal(plainText.segments[0].speaker, 'Alice');
assert.equal(plainText.chat.length, 1);
assert.match(plainText.chat[0].text, /https:\/\/example\.com\/plain/);
assert.equal(plainText.participants.length, 3);
assert.deepEqual(plainText.participants[2], { initials: 'WC', name: 'Robin Fox', role: 'Platform - Eng' });

const zoomExportWithMeetingSections = parseTranscriptText(`--- Meeting Transcript ---

[8:38:00 AM] Jordan Blake (Platform Eng): Let's finish the review.

--- Meeting Chat Transcript ---

[8:43:06 AM] Chris Doyle [Platform Eng] to Everyone: https://example.com/galaxy is the only Rollout doc I found.
[8:52:33 AM] Mira [Infra Team, EU] to Everyone: Nina ParkOmar Vale
[9:00:17 AM] Sam Carter [Team Alpha] to Everyone: Made @Jordan Blake host - dropping. Thanks all
You to Everyone ntd

--- Meeting Participants ---

SV( - Alex Rivera (Eng) (Me)
MM - Sam Carter [Team Alpha] (Host)
WS - Taylor Reed (Platform Eng)
PG[S( - Chris Doyle [Platform Eng] (He/Him)
DK - Riley Quinn
J[ - Mira [Infra Team, EU]
AC[C - Pat Morgan [Team Beta]
KB - Jordan Blake (Platform Eng)
MM[B( - Lee Hunter [TEAM GAMMA] (he/him)
`, 'zoom.txt', { now: 1710000000000 });

assert.equal(zoomExportWithMeetingSections.chat.length, 4);
assert.deepEqual(
  zoomExportWithMeetingSections.chat.at(-1),
  { t: 1710000012000, sender: 'You', receiver: 'Everyone', text: 'ntd' },
);
assert.deepEqual(
  zoomExportWithMeetingSections.participants.map((p) => p.name),
  [
    'Alex Rivera',
    'Sam Carter',
    'Taylor Reed',
    'Chris Doyle',
    'Riley Quinn',
    'Mira',
    'Pat Morgan',
    'Jordan Blake',
    'Lee Hunter',
  ],
);
assert.deepEqual(
  zoomExportWithMeetingSections.participants.map((p) => p.role),
  [
    'Eng · Me',
    'Team Alpha · Host',
    'Platform Eng',
    'Platform Eng · He/Him',
    '',
    'Infra Team, EU',
    'Team Beta',
    'Platform Eng',
    'TEAM GAMMA · he/him',
  ],
);
assert.equal(zoomExportWithMeetingSections.participants.some((p) => /You to Everyone/i.test(p.name)), false);

const legacyImportedRecord = {
  chat: [
    { t: 1, sender: 'Chris Doyle [Platform Eng]', receiver: 'Everyone', text: 'https://example.com/galaxy' },
    { t: 2, sender: 'You', receiver: 'Everyone', text: 'ntd' },
    { t: 3, sender: 'Chat', receiver: 'Everyone', text: 'SV( - Alex Rivera (Eng) (Me)' },
    { t: 4, sender: 'Chat', receiver: 'Everyone', text: 'MM - Sam Carter [Team Alpha] (Host)' },
    { t: 5, sender: 'Chat', receiver: 'Everyone', text: 'WS - Taylor Reed (Platform Eng)' },
  ],
  participants: [],
};
assert.equal(repairTranscriptParticipants(legacyImportedRecord), true);
assert.deepEqual(legacyImportedRecord.chat.map((c) => c.text), ['https://example.com/galaxy', 'ntd']);
assert.deepEqual(legacyImportedRecord.participants.map((p) => p.name), ['Alex Rivera', 'Sam Carter', 'Taylor Reed']);

const legacyImportedToday = {
  platform: 'imported',
  title: 'zoom transcript 98621982224 2026 06 01T15 46 31 915Z',
  startedAt: 1710000000000,
  endedAt: 1710000012000,
  segments: [{ t: 1710000000000, speaker: 'Alex', text: 'Imported with the wrong date.' }],
  chat: [{ t: 1710000004000, sender: 'Alex', receiver: 'Everyone', text: 'Link' }],
};
assert.equal(repairImportedTranscriptDate(legacyImportedToday), true);
assert.equal(new Date(legacyImportedToday.startedAt).toISOString(), '2026-06-01T15:46:31.915Z');
assert.equal(legacyImportedToday.segments[0].t, legacyImportedToday.startedAt);
assert.equal(legacyImportedToday.chat[0].t, legacyImportedToday.startedAt + 4000);

console.log('meeting transcript import tests passed');
