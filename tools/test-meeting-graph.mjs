import assert from 'node:assert/strict';

import {
  buildMeetingTopicGraph,
  graphParticipantNames,
  graphTopicTerms,
} from '../extension/js/meeting-graph.js';

const meetings = [
  {
    entry: { id: 'm1' },
    rec: { title: 'Jordan 1:1' },
    people: ['Alex Rivera', 'Jordan Blake'],
    terms: ['object storage', 'cache warming'],
    topicSource: 'insights',
  },
  {
    entry: { id: 'm2' },
    rec: { title: 'DR Review' },
    people: ['Jordan Blake'],
    terms: ['disaster recovery'],
    topicSource: 'notes',
  },
  {
    entry: { id: 'm3' },
    rec: { title: 'Storage Design' },
    people: ['Dana Example'],
    terms: ['object storage'],
    topicSource: 'insights',
  },
  {
    entry: { id: 'm4' },
    rec: { title: 'Fallback Transcript' },
    people: ['Jordan Blake', 'Unknown Speaker'],
    terms: ['yeah think'],
    topicSource: 'transcript',
  },
  {
    entry: { id: 'm5' },
    rec: { title: 'Unattributed Captions' },
    people: ['Unknown Speaker'],
    terms: ['object storage'],
    topicSource: 'insights',
  },
];

const focused = buildMeetingTopicGraph(meetings, {
  focusId: 'm1',
  topicPrefix: 'm-topic:',
  participantPrefix: 'm-participant:',
});

const focusedIds = new Set(focused.nodes.map((n) => n.id));
assert.ok(focusedIds.has('m1'), 'graph should include meeting nodes');
assert.ok(focusedIds.has('m-topic:object storage'), 'graph should include shared topic nodes');
assert.ok(focusedIds.has('m-topic:cache warming'), 'focused graph should retain selected meeting topic nodes');
assert.ok(focusedIds.has('m-participant:Jordan Blake'), 'graph should include shared participant nodes');
assert.ok(focusedIds.has('m-participant:Alex Rivera'), 'focused graph should retain selected meeting participant nodes');
assert.equal(focusedIds.has('m-participant:Unknown Speaker'), false, 'graph should not include Unknown Speaker participant nodes');
assert.equal(focusedIds.has('m-topic:yeah think'), false, 'graph should omit transcript-only fallback topics');

const focusedEdges = new Set(focused.links.map((l) => `${l.s}->${l.t}`));
assert.ok(focusedEdges.has('m1->m-topic:object storage'), 'meeting should link to topic');
assert.ok(focusedEdges.has('m3->m-topic:object storage'), 'related meeting should link to shared topic');
assert.ok(focusedEdges.has('m1->m-participant:Jordan Blake'), 'meeting should link to participant');
assert.ok(focusedEdges.has('m2->m-participant:Jordan Blake'), 'related meeting should link to shared participant');

const globalGraph = buildMeetingTopicGraph(meetings, {
  topicPrefix: 'm-topic:',
  participantPrefix: 'm-participant:',
});
const globalIds = new Set(globalGraph.nodes.map((n) => n.id));
assert.equal(globalIds.has('m-participant:Alex Rivera'), false, 'global graph should omit unique participant nodes');
assert.ok(globalIds.has('m-participant:Jordan Blake'), 'global graph should include shared participant nodes');

const searchedGraph = buildMeetingTopicGraph(meetings, {
  topicPrefix: 'm-topic:',
  participantPrefix: 'm-participant:',
  connectorQuery: 'Jordan',
});
const searchedNodeIds = new Set(searchedGraph.nodes.map((n) => n.id));
assert.ok(searchedNodeIds.has('m-participant:Jordan Blake'), 'searched graph should keep the matching participant connector.');
assert.equal(searchedNodeIds.has('m-topic:object storage'), false, 'searched graph should omit non-matching topic connectors when participant connector matches.');
assert.equal(searchedNodeIds.has('m-participant:Alex Rivera'), false, 'searched graph should omit non-matching participant connectors.');
assert.deepEqual(
  searchedGraph.links.map((l) => l.t).sort(),
  ['m-participant:Jordan Blake', 'm-participant:Jordan Blake', 'm-participant:Jordan Blake'],
  'searched graph should keep only links to the matching connector.',
);

assert.deepEqual(graphTopicTerms({ topicSource: 'transcript', terms: ['yeah think'] }), [], 'transcript fallback topics should not graph');
assert.deepEqual(graphParticipantNames({ people: [' Jordan ', '', 'Jordan', 'Unknown Speaker'] }), ['Jordan'], 'participant names should normalize blanks, duplicates, and unknown speakers');

console.log('meeting graph tests passed');
