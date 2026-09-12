import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createToolLoopGuard,
  stableToolCallKey,
} from '../extension/js/providers.js';
import { toolStatus } from '../extension/js/events/tool-hints.js';

assert.equal(
  stableToolCallKey('mcp_demo__search', { limit: 5, query: 'same' }),
  stableToolCallKey('mcp_demo__search', { query: 'same', limit: 5 }),
  'Tool loop keys should be stable across object key order.',
);
assert.notEqual(
  stableToolCallKey('mcp_demo__search', { query: 'same' }),
  stableToolCallKey('mcp_demo__search', { query: 'different' }),
  'Different inputs should remain distinct tool calls.',
);

const guard = createToolLoopGuard({ maxIdenticalCalls: 2 });
assert.equal(guard.check('mcp_demo__search', { query: 'same' }).blocked, false);
assert.equal(guard.check('mcp_demo__search', { query: 'same' }).blocked, false);
const repeated = guard.check('mcp_demo__search', { query: 'same' });
assert.equal(repeated.blocked, true, 'The 3rd identical call (> maxIdenticalCalls) is blocked.');
// No nuclear per-turn kill switch: only the exact looping call is suppressed; the
// guard never globally disables tool use for the rest of the turn.
assert.equal(guard.disabled, false, 'There is no global kill switch.');
assert.match(toolStatus(repeated.result), /^blocked: Skipped a repeated identical/);

// A DIFFERENT tool call still works — one looping tool must not disable the rest.
const otherCall = guard.check('mcp_demo__other', { query: 'different' });
assert.equal(otherCall.blocked, false, 'A distinct tool call is unaffected when another call loops.');

const manyMcpCalls = createToolLoopGuard({ maxIdenticalCalls: 99 });
for (let i = 0; i < 25; i += 1) {
  assert.equal(
    manyMcpCalls.check('mcp_demo__search', { query: `query-${i}` }).blocked,
    false,
    'Distinct MCP tool calls should not hit a per-turn MCP count cap.',
  );
}
assert.equal(manyMcpCalls.disabled, false);

const providersJs = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
assert.doesNotMatch(providersJs, /MCP tool limit reached/, 'Providers should not emit an MCP-specific per-turn cap error.');
assert.match(providersJs, /function streamOpenAI[\s\S]*const loopGuard = createToolLoopGuard\(\);/, 'OpenAI-compatible loop should create a tool loop guard.');
assert.match(providersJs, /createAdaptiveToolPolicy/, 'Providers should create an adaptive tool policy per turn.');
assert.match(providersJs, /adaptivePolicy\.filterOpenAITools\(toolSpecs\)/, 'OpenAI-compatible loop should filter tools suppressed by adaptive policy.');
// Per-call bookkeeping — the adaptive policy and the guard's memory — moved with the
// round into turn-round.js, where it runs once per call in the model's order.
const turnRoundJs = readFileSync(new URL('../extension/js/turn-round.js', import.meta.url), 'utf8');
assert.match(turnRoundJs, /adaptivePolicy\.recordResult\(c\.name, result\)/, 'The tool round should record invalid tool results.');
assert.match(turnRoundJs, /loopGuard\.remember\(guard\.key, c\.name, c\.input, result, \{ readOnly: /, 'The tool round should remember results for replay, gated on the read trait.');
assert.doesNotMatch(providersJs, /REPLAYABLE_TOOLS = new Set/, 'The hand-kept replayable list is gone; traits decide.');
assert.match(providersJs, /function streamOpenAI[\s\S]*runRound\(wanted, \{ tools, agent, loopGuard, adaptivePolicy/, 'OpenAI-compatible loop should hand its guard and policy to the round.');
assert.match(providersJs, /function streamAnthropic[\s\S]*const loopGuard = createToolLoopGuard\(\);/, 'Anthropic loop should create a tool loop guard.');
assert.match(providersJs, /adaptivePolicy\.filterAnthropicTools\(toolSpecs\)/, 'Anthropic loop should filter tools suppressed by adaptive policy.');
assert.match(providersJs, /function streamAnthropic[\s\S]*runRound\(toolUses, \{ tools, agent, loopGuard, adaptivePolicy/, 'Anthropic loop should hand its guard and policy to the round.');
assert.match(providersJs, /relayBridgeTool\(base, ev, tools, onEvent, loopGuard,/, 'Bridge relays should share the turn tool loop guard.');

console.log('provider tool loop tests passed');
