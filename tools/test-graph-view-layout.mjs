import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const graphViewJs = readFileSync(new URL('../extension/js/graph-view.js', import.meta.url), 'utf8');
const meetingsCss = readFileSync(new URL('../extension/meetings.css', import.meta.url), 'utf8');

assert.match(graphViewJs, /function clusterGraphNodes\(/, 'graph renderer should pre-cluster nodes before layout.');
assert.match(graphViewJs, /function splitLargeCluster\(/, 'graph renderer should split large connected components into seeded visual groups.');
assert.match(graphViewJs, /clusterGraphNodes\(nodes,\s*L\)/, 'drawGraph should use the shared clustering helper.');
assert.match(graphViewJs, /function buildSpatialGrid\(/, 'graph renderer should use a spatial grid for repulsion.');
assert.match(graphViewJs, /MAX_REPULSION_NEIGHBORS/, 'graph renderer should cap nearby repulsion work per node.');
assert.doesNotMatch(graphViewJs, /for\s*\(\s*let i = 0;\s*i < N;\s*i\+\+\s*\)\s*for\s*\(\s*let j = i \+ 1;\s*j < N;\s*j\+\+\s*\)/, 'graph renderer should not use all-pairs O(n^2) repulsion.');
assert.match(graphViewJs, /function labelPriority\(/, 'graph renderer should rank labels instead of showing every label.');
assert.match(graphViewJs, /label-hidden/, 'graph renderer should hide lower-priority labels by default.');
assert.match(graphViewJs, /label-near/, 'graph renderer should reveal adjacent labels on hover.');

assert.match(meetingsCss, /svg \.gnode\.label-hidden text/, 'graph CSS should hide lower-priority node labels.');
assert.match(meetingsCss, /svg \.gnode\.label-near text/, 'graph CSS should reveal neighbor labels on hover.');

console.log('graph view layout tests passed');
