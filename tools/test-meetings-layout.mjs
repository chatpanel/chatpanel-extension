import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const meetingsJs = readFileSync(new URL('../extension/meetings.js', import.meta.url), 'utf8');
const meetingsCss = readFileSync(new URL('../extension/meetings.css', import.meta.url), 'utf8');
const meetingsHtml = readFileSync(new URL('../extension/meetings.html', import.meta.url), 'utf8');

assert.match(
  meetingsJs,
  /tileList\(\s*parsed\.moments[\s\S]*'moment-list'/,
  'Key Moments should render a dedicated list class for layout targeting.',
);

assert.match(
  meetingsJs,
  /<ul\$\{listClass \? ` class="\$\{listClass\}"` : ''\}>/,
  'The tile list helper should apply the optional list class to rendered lists.',
);

assert.match(
  meetingsJs,
  /class="moment-text"/,
  'Key Moments text should render a dedicated text span so copy aligns independently from badges.',
);

assert.match(
  meetingsCss,
  /\.moment-list\s+li\s*\{[^}]*grid-template-columns:\s*[^;]+minmax\(0,\s*1fr\)/s,
  'Key Moments rows should use a fixed badge column and flexible text column.',
);

assert.match(
  meetingsCss,
  /\.moment-list\s+\.badge\s*\{[^}]*width:/s,
  'Key Moments badges should use a fixed width so all text starts on the same column.',
);

assert.match(meetingsHtml, />Best match</, 'Meetings search should use a clear relevance-mode label.');
assert.match(meetingsHtml, />Exact text</, 'Meetings search should use a clear literal-mode label.');
assert.doesNotMatch(meetingsHtml, /data-mode="people"/, 'Meetings search should not expose a separate People mode.');
assert.doesNotMatch(meetingsJs, /mode === 'people'|function searchPerson/, 'Meetings search should not retain stale People mode code.');
assert.match(meetingsJs, /peopleText/, 'Meetings searchable text should include attendee and speaker names.');
assert.match(meetingsJs, /data-tab="participants"/, 'Meeting detail tabs should include Participants beside Insights, Related, and Transcript.');
assert.match(meetingsJs, /function renderParticipants/, 'Meetings should render a dedicated Participants tab.');
assert.match(meetingsJs, /data-tab="topic-graph"/, 'Meeting detail tabs should expose Topic Graph as its own tab.');
assert.match(meetingsJs, /function renderTopicGraph/, 'Meetings should render the per-meeting topic graph through its own tab.');
assert.doesNotMatch(meetingsJs, /id="m-relgraph"/, 'Related should not hide the per-meeting topic graph inside the related tab.');
assert.match(meetingsJs, /parsed\.links/, 'Meeting insights should render shared links as a separate section.');
assert.match(meetingsJs, /current\.rec\.chat/, 'Transcript tab should include meeting chat messages so shared links are visible.');
assert.match(meetingsJs, /transcript-section-title/, 'Transcript tab should separate transcript, chat, and participants sections.');
assert.match(meetingsJs, /repairTranscriptParticipants/, 'Meetings should repair legacy imports where participants were stored as chat rows.');
assert.match(meetingsJs, /repairImportedTranscriptDate/, 'Meetings should repair imported transcripts that were previously timestamped as today.');
assert.match(meetingsJs, /await persistMeeting\(rec\)/, 'Meetings should persist repaired legacy participant records.');
assert.match(meetingsJs, /function groupActionsByOwner/, 'Meeting action items should be grouped by owner/person before rendering.');
assert.match(meetingsJs, /action-group/, 'Meeting action item groups should render with a dedicated group class.');
assert.match(meetingsJs, /MEETING_INSIGHT_SECTIONS/, 'Generate insights should use independent section jobs.');
assert.match(meetingsJs, /Promise\.allSettled/, 'Generate insights should run section extraction jobs in parallel.');
assert.match(meetingsJs, /insightDraft/, 'Generate insights should keep a live streaming draft for the UI.');
assert.match(meetingsCss, /\.stream-block/, 'Streaming insight sections should have readable in-progress styling.');

console.log('meetings layout tests passed');
