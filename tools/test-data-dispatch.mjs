import assert from 'node:assert/strict';
import { historyToolProvider } from '../extension/js/history-rag.js';
import { webSearchToolProvider } from '../extension/js/web-search.js';
import { buildToolset } from '../extension/js/toolset.js';
import { dataDispatchProvider, DATA_TOOL_NAME, estimate } from '../extension/js/data-dispatch.js';

const inner = buildToolset([
  historyToolProvider({ includeMeetings: true, explicit: false }),
  webSearchToolProvider({}),
]);
const wrapped = dataDispatchProvider(inner);

// ── the point of the exercise: what a turn PAYS ──────────────────────────────
const beforeTok = estimate(inner.specs) + estimate(inner.system);
const afterTok = estimate(wrapped.specs) + estimate(wrapped.system);
console.log(`  data tools: ${beforeTok} → ${afterTok} tokens (${Math.round((1 - afterTok / beforeTok) * 100)}% off)`);
assert.ok(afterTok < beforeTok / 3, `expected a large cut, got ${beforeTok} → ${afterTok}`);
assert.equal(wrapped.specs.length, 1, 'more than one tool is still resident');

// The 678-token GUIDANCE block must not be resident — that block is what made the model
// open a conversation by reciting its own tools. What IS resident is a capability
// statement, and that one earns its tokens: without it a model answered "I do not have
// access to your meeting history" while this very tool sat in its toolset. The guard is
// against the manual coming back, not against saying what the tool can do.
assert.ok(estimate(wrapped.system) < 120, `resident system is ${estimate(wrapped.system)} tokens — the guidance block is back`);
assert.ok(!/citation/i.test(String(wrapped.system)), 'the detailed guidance leaked into the prompt');

// ── everything stays reachable: nothing was traded away for the saving ───────
const enumerated = wrapped.specs[0].parameters.properties.action.enum;
for (const s of inner.specs) {
  assert.ok(enumerated.includes(s.name), `${s.name} became unreachable`);
}
assert.ok(enumerated.includes('describe'));

// The declared `args` envelope — undeclared top-level properties are stripped by
// providers, which is exactly how structured_insert lost its `elements` array.
assert.equal(wrapped.specs[0].parameters.properties.args.type, 'object');

// ── routing preserves the REAL tool name, so downstream guards still fire ────
const calls = [];
const probe = dataDispatchProvider({
  specs: inner.specs,
  system: inner.system,
  execute: async (name, args) => { calls.push({ name, args }); return JSON.stringify({ ok: true }); },
});
await probe.execute(DATA_TOOL_NAME, { action: 'history_search', args: { query: 'pricing' } });
assert.deepEqual(calls, [{ name: 'history_search', args: { query: 'pricing' } }],
  'the dispatcher must route on the real name, or every guard written against it stops firing');

// Both shapes accepted — a model that ignores the envelope still works rather than
// failing in a way that looks like the tool is broken.
calls.length = 0;
await probe.execute(DATA_TOOL_NAME, { action: 'history_search', query: 'flat' });
assert.deepEqual(calls[0].args, { query: 'flat' });

// A direct call to the underlying tool keeps working, so nothing that already knew the
// old names breaks.
calls.length = 0;
await probe.execute('history_search', { query: 'direct' });
assert.deepEqual(calls, [{ name: 'history_search', args: { query: 'direct' } }]);

// ── describe carries the guidance, so it is read when it is about to be used ─
const described = JSON.parse(await probe.execute(DATA_TOOL_NAME, { action: 'describe', args: { tool: 'history_search' } }));
assert.equal(described.name, 'history_search');
assert.ok(described.parameters, 'describe must return the real schema');
assert.ok(String(described.guidance || '').length > 100, 'the guidance was dropped rather than deferred');

// An unknown action is a correctable error, not a dead turn.
const unknown = JSON.parse(await probe.execute(DATA_TOOL_NAME, { action: 'nope', args: {} }));
assert.match(unknown.error, /Unknown action/);
assert.ok(unknown.actions.includes('history_search'));

console.log('✓ data dispatcher: one resident tool, every source reachable, guards still route by real name');
