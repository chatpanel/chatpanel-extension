// The bridge BLOCKS on /tool-result: it sends no further SSE until we answer a
// tool_request. So the one invariant that matters here is not "the relay works"
// but "the relay always answers" — including when our own bookkeeping throws.
// A regression (an undeclared identifier in the start event) stranded real turns
// for minutes with the tool still showing as running after the work was done.
import assert from 'node:assert/strict';

import { relayBridgeTool } from '../extension/js/providers.js';

const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => '' };
};

const ev = { id: 'call-1', name: 'page', session: 's1', input: { action: 'read_canvas' } };
const tools = { execute: async () => JSON.stringify({ ok: true, text: 'read' }) };

// 1. The ordinary path answers with the tool's result.
posts.length = 0;
await relayBridgeTool('http://127.0.0.1:4319', ev, tools, () => {}, undefined, 'Local · gemma');
assert.equal(posts.length, 1, 'A completed tool call posts exactly one result.');
assert.match(posts[0].url, /\/tool-result$/);
assert.equal(posts[0].body.id, 'call-1');
assert.match(posts[0].body.result, /read/);

// 2. A throw in OUR reporting must not strand the agent. This is the regression:
//    the start event referenced an out-of-scope binding, so the function rejected
//    before reaching the POST and the CLI waited forever.
posts.length = 0;
await relayBridgeTool('http://127.0.0.1:4319', ev, tools, () => {
  throw new Error('activity strip blew up');
});
assert.equal(posts.length, 1, 'A reporting failure still answers the bridge.');

// 3. A tool that throws answers with an error — never with silence.
posts.length = 0;
await relayBridgeTool('http://127.0.0.1:4319', ev, {
  execute: async () => { throw new Error('canvas timed out'); },
}, () => {});
assert.equal(posts.length, 1, 'A failing tool still answers the bridge.');
assert.match(posts[0].body.result, /canvas timed out/, 'The agent is told why, so it can adapt.');

// 4. The relay never rejects — the call site is fire-and-forget by design
//    (awaiting it would deadlock the SSE loop it is reading from).
await assert.doesNotReject(() =>
  relayBridgeTool('http://127.0.0.1:4319', ev, null, null),
);

console.log('bridge tool relay: ok');
