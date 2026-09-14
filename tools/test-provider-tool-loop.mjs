// The extension's tool loop IS the shared one (@chatpanel/events/turn-loop.js). What this
// file checks is the BINDING: one request per provider, the transcript in that provider's
// shape, the cap from the agent and the user's preference, the events the side panel reads,
// and the two behaviours the extension had that the shared loop now carries for everyone —
// tools withheld on the last request, and a stalled turn made to answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { streamChat } from '../extension/js/providers.js';
import { createToolLoopGuard, stableToolCallKey } from '../extension/js/events/tool-loop-guard.js';
import { EXHAUSTED_NOTE, DEFAULT_MAX_ROUNDS } from '../extension/js/events/turn-loop.js';
import { toolStatus } from '../extension/js/events/tool-hints.js';

// ── the guard, now shared, behaves as the extension's did ─────────────────────────────
assert.equal(stableToolCallKey('mcp_demo__search', { limit: 5, query: 'same' }), stableToolCallKey('mcp_demo__search', { query: 'same', limit: 5 }));
assert.notEqual(stableToolCallKey('mcp_demo__search', { query: 'same' }), stableToolCallKey('mcp_demo__search', { query: 'different' }));
{
  const guard = createToolLoopGuard({ maxIdenticalCalls: 2 });
  assert.equal(guard.check('mcp_demo__search', { query: 'same' }).blocked, false);
  assert.equal(guard.check('mcp_demo__search', { query: 'same' }).blocked, false);
  const repeated = guard.check('mcp_demo__search', { query: 'same' });
  assert.equal(repeated.blocked, true, 'The 3rd identical call (> maxIdenticalCalls) is blocked.');
  assert.equal(guard.disabled, false, 'There is no global kill switch.');
  assert.match(toolStatus(repeated.result), /^blocked: Skipped a repeated identical/);
  assert.equal(guard.check('mcp_demo__other', { query: 'different' }).blocked, false, 'A distinct tool call is unaffected when another call loops.');
  const many = createToolLoopGuard({ maxIdenticalCalls: 99 });
  for (let i = 0; i < 25; i += 1) assert.equal(many.check('mcp_demo__search', { query: `query-${i}` }).blocked, false, 'Distinct MCP tool calls should not hit a per-turn MCP count cap.');
}

// ── a fake OpenAI-compatible endpoint: each request answers from a script ────────────
const enc = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sse = (text) => new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
const answer = (text) => frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame({ usage: { prompt_tokens: 10, completion_tokens: 2 } }) + 'data: [DONE]\n\n';
const asks = (calls) => calls.map((c, i) => frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }] })).join('') + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + frame({ usage: { prompt_tokens: 10, completion_tokens: 1 } }) + 'data: [DONE]\n\n';

function endpoint(script) {
  const requests = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    const out = typeof step === 'function' ? step(body) : step;
    return { ok: true, status: 200, headers: { get: () => null }, body: sse(out) };
  };
  return requests;
}
const agent = { name: 't', kind: 'openai', model: 'gpt-x', baseUrl: 'http://mock/v1', apiKey: 'x' };
const toolset = (execute) => ({
  specs: [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }],
  system: 'Use web_search.',
  traits: new Map([['web_search', { readOnly: true }]]),
  remoteTools: new Set(), serialTools: new Set(),
  execute,
});
const real = globalThis.fetch;
try {
  // 1. ask → run → answer; the transcript is the OpenAI shape; the events are the panel's.
  {
    const ran = [];
    const requests = endpoint([asks([{ id: 'c1', name: 'web_search', args: { query: 'x' } }]), answer('Done.')]);
    const events = [];
    let out = '';
    const full = await streamChat({ agent, messages: [{ role: 'user', content: 'q' }], settings: { ui: {} }, tools: toolset(async (n, a) => { ran.push([n, a]); return 'found it'; }), onDelta: (d) => { out += d; }, onEvent: (e) => events.push(e) });
    assert.equal(full, 'Done.');
    assert.equal(out, 'Done.');
    assert.deepEqual(ran, [['web_search', { query: 'x' }]]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools[0].function.name, 'web_search', 'tools shaped for the provider');
    assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, '{"query":"x"}');
    assert.deepEqual(requests[1].messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'found it' });
    const tool = events.filter((e) => e.type === 'tool');
    assert.deepEqual(tool.map((e) => e.phase), ['start', 'done']);
    assert.equal(tool[0].model, 'gpt-x', 'each call names the model that made it');
    assert.equal(tool[1].result, 'found it');
    assert.equal(events.find((e) => e.type === 'finish').reason, 'stop');
    const usage = events.find((e) => e.type === 'usage');
    assert.equal(usage.inputTokens, 20, 'usage adds up across both requests');
    assert.equal(usage.estimated, false);
  }
  // 2. the cap is the agent's, the last request offers no tools, and the user is told.
  {
    let n = 0;
    const requests = endpoint([(body) => (body.tools ? asks([{ id: `c${n += 1}`, name: 'web_search', args: { query: `q${n}` } }]) : answer('last words'))]);
    let out = '';
    const full = await streamChat({ agent: { ...agent, maxRequestsPerTurn: 3 }, messages: [{ role: 'user', content: 'q' }], settings: { ui: {} }, tools: toolset(async () => 'r'), onDelta: (d) => { out += d; }, onEvent: () => {} });
    assert.equal(requests.length, 3, 'three requests: two with tools, the closing one without');
    assert.equal(requests[2].tools, undefined);
    assert.ok(full.endsWith(EXHAUSTED_NOTE), 'the returned text says the cap was hit');
    assert.equal(out, full, 'and so does what was streamed');
  }
  // 3. …or the user's preference, under the shared ceiling.
  {
    let n = 0;
    const requests = endpoint([(body) => (body.tools ? asks([{ id: `c${n += 1}`, name: 'web_search', args: { query: `q${n}` } }]) : answer('ok'))]);
    await streamChat({ agent, messages: [{ role: 'user', content: 'q' }], settings: { ui: { maxToolRoundsPerTurn: 2 } }, tools: toolset(async () => 'r'), onDelta: () => {}, onEvent: () => {} });
    assert.equal(requests.length, 2);
    assert.ok(DEFAULT_MAX_ROUNDS === 60, 'the ceiling is 60');
  }
  // 4. a stalled turn (the same round twice) is offered no more tools.
  {
    const same = asks([{ id: 'c', name: 'web_search', args: { query: 'same' } }]);
    const requests = endpoint([same, same, answer('fine')]);
    let ran = 0;
    const full = await streamChat({ agent, messages: [{ role: 'user', content: 'q' }], settings: { ui: {} }, tools: toolset(async () => { ran += 1; return 'r'; }), onDelta: () => {}, onEvent: () => {} });
    assert.equal(full, 'fine');
    assert.equal(ran, 2, 'ran twice, then the round repeated itself');
    assert.equal(requests[2].tools, undefined, 'the third request offers nothing');
  }
} finally {
  globalThis.fetch = real;
}

// ── the source: one request per provider, the loop and the guard from the package ────
const providersJs = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
assert.doesNotMatch(providersJs, /MCP tool limit reached/, 'Providers should not emit an MCP-specific per-turn cap error.');
assert.doesNotMatch(providersJs, /function createToolLoopGuard|const MAX_TOOL_STEPS|function toolStepCap/, 'the guard and the cap live in the shared package');
assert.match(providersJs, /import\('\.\/events\/turn-loop\.js'\)/, 'the loop is loaded on demand, off first paint');
assert.match(providersJs, /function streamOpenAI[\s\S]*return runSharedLoop\(/, 'the OpenAI provider is one request plus the shared loop');
assert.match(providersJs, /function streamAnthropic[\s\S]*return runSharedLoop\(/, 'the Anthropic provider is one request plus the shared loop');
assert.match(providersJs, /relayBridgeTool\(base, ev, turnTools, onEvent, runner,/, 'Bridge relays share one call runner per session.');
assert.doesNotMatch(providersJs, /REPLAYABLE_TOOLS = new Set/, 'The hand-kept replayable list is gone; traits decide.');

console.log('provider tool loop tests passed');
