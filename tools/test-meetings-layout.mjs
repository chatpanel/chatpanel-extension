import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const meetingsJs = readFileSync(new URL('../extension/meetings.js', import.meta.url), 'utf8');
const meetingsCss = readFileSync(new URL('../extension/meetings.css', import.meta.url), 'utf8');
const meetingsHtml = readFileSync(new URL('../extension/meetings.html', import.meta.url), 'utf8');
const meetingGraphJs = readFileSync(new URL('../extension/js/meeting-graph.js', import.meta.url), 'utf8');

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
assert.match(meetingsJs, /Suggested Topics/, 'Meetings should label local fallback topics as suggestions.');
assert.match(meetingsJs, /Generate insights to replace these with concrete meeting topics/, 'Meetings should explain transcript fallback topics are replaced by generated topics.');
assert.match(meetingsJs, /Suggested from generated insights/, 'Meetings should explain when suggested topics came from generated insights.');
assert.match(meetingsJs, /function relatedMeetingReason/, 'Related meetings should render explicit relationship reasons.');
assert.match(meetingsJs, /shared participants:/, 'Related meetings should explain participant overlap.');
assert.match(meetingsJs, /shared topics:/, 'Related meetings should explain topic overlap.');
assert.match(meetingsJs, /similar title:/, 'Related meetings should explain title similarity.');
assert.doesNotMatch(meetingsJs, /shared context/, 'Related meetings should not use vague shared-context wording.');
assert.match(meetingsJs, /buildMeetingTopicGraph/, 'Meetings graph should use the shared meeting graph helper.');
assert.match(meetingsJs, /const matchIds = q \? new Set\(searchResults\(q\)/, 'Per-meeting topic graph should filter meetings by the active search results.');
assert.match(meetingsJs, /connectorQuery:\s*q/, 'Meetings graph should filter connector nodes and links by the active search query.');
assert.ok((meetingsJs.match(/connectorQuery:\s*q/g) || []).length >= 2, 'Both per-meeting and global meeting graphs should filter connectors by search query.');
assert.match(meetingsJs, /current\?\.tab === 'topic-graph'\)\s*renderTopicGraph/, 'Search changes should rerender the visible per-meeting graph tab.');
assert.match(meetingGraphJs, /function graphParticipantNames/, 'Meetings graph should include participants as graph nodes.');
assert.match(meetingsJs, /participantPrefix:\s*'m-participant:'/, 'Meetings graph should use stable participant node ids.');
assert.match(meetingsJs, /people:\s*graphParticipantNames\(d\)/, 'Related meeting scoring should include filtered participant names.');
assert.match(meetingGraphJs, /topicSource === 'transcript'/, 'Meetings graph should avoid transcript-only fallback topics.');
assert.match(meetingsCss, /\.sw\.participant/, 'Meetings graph legend should include participants.');
assert.match(meetingsCss, /\.gnode\.participant circle/, 'Meetings graph should style participant nodes separately.');
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
