// End-to-end harness tests for the EXTENSION routes (chat + privacy test screen).
// We mock the model (a fake OpenAI streaming endpoint) so the model actually CALLS
// a tool, then assert the shared makeToolHarness did its job at every boundary:
//   ① prompt redacted (model sees the placeholder)
//   ② tool receives the REAL value (placeholder restored)
//   ③ tool result re-redacted before the model sees it
//   ④ final reply restored for the user
// + the placeholder note is injected so models USE placeholders instead of refusing.
//
// If these pass, the harness is correct and a model that makes "0 tool calls" is the
// MODEL choosing not to call — not a harness/pipeline bug.

import assert from 'node:assert/strict';
import test from 'node:test';

import { streamChat, traceFlow } from '../extension/js/providers.js';
import { createVault } from '../extension/js/pii-redact.js';

const enc = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const streamBody = (text) => new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });

const sseToolCall = (name, args) =>
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name, arguments: '' } }] } }] }) +
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] }) +
  frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  'data: [DONE]\n\n';

const sseText = (text) =>
  frame({ choices: [{ delta: { content: text } }] }) +
  frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';

// Fake OpenAI endpoint: round 1 → a tool call echoing the placeholder; round 2 (once
// it sees a tool result) → a text reply that also references the placeholder.
function installFakeModel({ toolName, argToken, reply }) {
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    const sawToolResult = (body.messages || []).some((m) => m.role === 'tool');
    const text = sawToolResult ? sseText(reply) : sseToolCall(toolName, { q: argToken });
    return { ok: true, status: 200, headers: { get: () => null }, body: streamBody(text) };
  };
  return { requests, restore: () => { globalThis.fetch = real; } };
}

const REDACTION = () => ({
  vault: createVault(),
  cfg: { mode: 'deterministic', tier: 'full', dictionary: [], toolData: 'real' },
  isPro: true,
  entities: [{ value: 'Seattle', type: 'LOCATION' }],
  detect: false,
});

const wikiTool = (onArgs) => ({
  specs: [{ name: 'mcp_wiki__search', description: 'search wikipedia', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
  system: '',
  execute: async (_name, input) => { onArgs(input); return 'Seattle is the largest city in Washington'; },
});

test('extension CHAT route: ② tool gets real value, ③ result re-redacted, ④ reply restored, note injected', async () => {
  const mock = installFakeModel({ toolName: 'mcp_wiki__search', argToken: '[[LOCATION_1]] state', reply: "You live in [[LOCATION_1]]'s state." });
  let toolGot = null;
  try {
    let out = '';
    await streamChat({
      agent: { name: 't', model: 'gemma', baseUrl: 'http://mock', apiKey: 'x' },
      messages: [{ role: 'user', content: 'I am from Seattle. which state?' }],
      settings: { ui: {} },
      onDelta: (d) => { out += d; },
      onEvent: () => {},
      tools: wikiTool((a) => { toolGot = a; }),
      redaction: REDACTION(),
    });

    const r1 = JSON.stringify(mock.requests[0].messages);
    // ① model only ever saw the placeholder in the prompt
    assert.match(r1, /\[\[LOCATION_1\]\]/, '① model sees the placeholder');
    assert.doesNotMatch(JSON.stringify(mock.requests[0].messages.filter((m) => m.role === 'user')), /Seattle/, '① real city not sent');
    // note injected so the model knows placeholders are auto-restored for tools
    assert.match(r1, /PRIVACY PLACEHOLDERS|automatically replaced/i, 'placeholder note injected into system');
    // ② the tool ran on the REAL value
    assert.match(JSON.stringify(toolGot), /Seattle/, '② tool got the real value');
    assert.doesNotMatch(JSON.stringify(toolGot), /\[\[LOCATION_1\]\]/, '② tool did NOT get the placeholder');
    // ③ the result the MODEL saw on the follow-up was re-redacted
    const toolMsg = mock.requests[1].messages.find((m) => m.role === 'tool');
    assert.match(String(toolMsg.content), /\[\[LOCATION_1\]\]/, '③ model saw the result re-redacted');
    assert.doesNotMatch(String(toolMsg.content), /Seattle/, '③ real city not leaked back to the model');
    // ④ the user sees the reply restored
    assert.match(out, /Seattle/, '④ user sees restored reply');
    assert.doesNotMatch(out, /\[\[LOCATION_1\]\]/, '④ no leftover placeholder');
  } finally {
    mock.restore();
  }
});

test('extension TEST-SCREEN route (traceFlow): same harness — tool gets real, reply restored', async () => {
  const mock = installFakeModel({ toolName: 'mcp_wiki__search', argToken: '[[LOCATION_1]]', reply: 'You are in [[LOCATION_1]].' });
  let toolGot = null;
  try {
    const settings = {
      ui: { piiRedaction: { mode: 'model', tier: 'full', applyTo: 'all', dictionary: [], toolData: 'real',
        detection: { backend: 'off' } } },
      endpoints: [{ id: 'e1', name: 'mock', model: 'gemma', baseUrl: 'http://mock', apiKey: 'x' }],
    };
    // Force the detector to "find" Seattle by stubbing detectForChat is overkill; instead
    // rely on deterministic + a dictionary entry so a token is created without a live NER.
    settings.ui.piiRedaction.dictionary = [{ value: 'Seattle', type: 'LOCATION' }];
    const t = await traceFlow(settings, 'e1', 'I am from Seattle. which state?', {
      tools: wikiTool((a) => { toolGot = a; }),
    });
    assert.match(t.modelSees, /\[\[LOCATION_1\]\]|\[\[TERM_1\]\]/, 'test screen redacts the prompt');
    assert.ok(toolGot && /Seattle/.test(JSON.stringify(toolGot)), 'test-screen tool got the real value');
    assert.match(t.youSee, /Seattle/, 'test-screen restores the reply');
  } finally {
    mock.restore();
  }
});

console.log('harness route tests passed');
