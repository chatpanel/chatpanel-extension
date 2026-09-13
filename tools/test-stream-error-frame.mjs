// AN ERROR INSIDE THE STREAM IS AN ERROR, NOT AN EMPTY ANSWER.
//
// The gateway answers 200 and starts streaming before its relay agent has said anything; when
// that agent then exits, the failure arrives as a `data: {"error":…}` frame. A reader that
// only looks at `choices` turns that into a turn that ended with nothing to say — which is
// how a team member "completed" with no answer, and the model that ran the team ran it again.
import assert from 'node:assert/strict';
import { streamChat } from '../extension/js/providers.js';

const enc = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const body = (text) => new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
const real = globalThis.fetch;
try {
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: body(
      frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      + frame({ error: { message: 'Codex exited 1: failed', type: 'bridge_error' } }),
    ),
  });
  let out = '';
  let threw = null;
  try {
    await streamChat({ agent: { name: 't', model: 'claude/opus', baseUrl: 'http://mock', apiKey: 'x' }, messages: [{ role: 'user', content: 'hi' }], settings: { ui: {} }, onDelta: (d) => { out += d; }, onEvent: () => {} });
  } catch (e) { threw = e; }
  assert.ok(threw, 'the turn fails rather than ending empty');
  assert.match(threw.message, /Codex exited 1/);
  assert.equal(out, '');
} finally {
  globalThis.fetch = real;
}
console.log('stream error frame: ok');
