import assert from 'node:assert/strict';

import { PAGE_TOOL_SPECS } from '../extension/js/page-tools.js';
import {
  DISPATCH_TOOL_NAME, buildDispatchSpec, makeDispatchExecutor, validateAction, estimateTokens,
} from '../extension/js/page-dispatch.js';

const spec = buildDispatchSpec(PAGE_TOOL_SPECS);

// ---------------------------------------------------------------- the budget
// This is the point of the whole exercise, so it is a hard assertion, not a note.
const before = estimateTokens(PAGE_TOOL_SPECS);
const after = estimateTokens([spec]);
assert.ok(after < before / 4, `dispatcher must cost under a quarter of the full set (${after} vs ${before})`);
assert.ok(after < 900, `resident page-tool cost regressed to ${after} tokens`);
console.log(`  page tools: ${before} → ${after} tokens (${Math.round((1 - after / before) * 100)}% off)`);

// One registered tool, because over MCP a model may only call what is REGISTERED — an
// index that merely returns schemas would leave the described tools uncallable.
assert.equal(spec.name, DISPATCH_TOOL_NAME);
assert.deepEqual(spec.parameters.required, ['action']);
assert.ok(spec.parameters.additionalProperties, 'each action carries its own arguments');

// Every real action is reachable, and no action is silently dropped.
const actions = spec.parameters.properties.action.enum;
for (const s of PAGE_TOOL_SPECS) assert.ok(actions.includes(s.name), `${s.name} unreachable`);
assert.ok(actions.includes('describe'));
for (const s of PAGE_TOOL_SPECS) assert.ok(spec.description.includes(s.name), `${s.name} missing from the action list`);

// ---------------------------------------------------------------- routing
const calls = [];
const run = async (name, args) => { calls.push({ name, args }); return JSON.stringify({ ok: true, name }); };
const dispatch = makeDispatchExecutor(PAGE_TOOL_SPECS, run);

// The real action name reaches the guard — the dispatcher must never be a way around
// the confirmation gate or the site grant.
await dispatch(DISPATCH_TOOL_NAME, { action: 'click_at', x: 10, y: 20 });
assert.deepEqual(calls.at(-1), { name: 'click_at', args: { x: 10, y: 20 } });
assert.ok(!('action' in calls.at(-1).args), 'the routing key leaked into the action arguments');

// Direct calls still work, so nothing that already spoke to these tools breaks.
await dispatch('inspect_page', {});
assert.equal(calls.at(-1).name, 'inspect_page');

// ---------------------------------------------------------------- reachability
const described = JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: 'describe', tool: 'fill_form' }));
const real = PAGE_TOOL_SPECS.find((s) => s.name === 'fill_form');
assert.equal(described.name, 'fill_form');
assert.deepEqual(described.parameters, real.parameters, 'describe must return the REAL schema');
assert.equal(described.description, real.description);

const unknownDesc = JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: 'describe', tool: 'nope' }));
assert.match(unknownDesc.error, /Unknown action/);
assert.ok(unknownDesc.actions.length === PAGE_TOOL_SPECS.length, 'an unknown lookup should list what exists');

// ---------------------------------------------------------------- bounded repair
// The trade for one compact schema is per-argument checking at request time. It is bought
// back here: a precise, correctable error instead of a dead turn — which is exactly what
// a weak model needs.
const withRequired = PAGE_TOOL_SPECS.find((s) => (s.parameters?.required || []).length);
assert.ok(withRequired, 'expected at least one action with required arguments');
const missing = validateAction(withRequired, {});
assert.ok(missing, 'missing arguments must be caught');
assert.match(missing.error, /Missing required argument/);
assert.deepEqual(missing.required, withRequired.parameters.required);
assert.match(missing.hint, /describe/);
assert.equal(validateAction(withRequired, Object.fromEntries(withRequired.parameters.required.map((k) => [k, 'x']))), null);

const before2 = calls.length;
const bad = JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: withRequired.name }));
assert.match(bad.error, /Missing required argument/);
assert.equal(calls.length, before2, 'a call with missing arguments must not reach the executor');

// An unknown action is refused, not forwarded.
const before3 = calls.length;
const unknown = JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: 'launch_missiles' }));
assert.match(unknown.error, /Unknown action/);
assert.equal(calls.length, before3);

console.log('✓ page dispatcher: one registered tool, every action reachable, guard intact');
