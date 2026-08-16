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
assert.ok(after < 950, `resident page-tool cost regressed to ${after} tokens`);
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
await dispatch(DISPATCH_TOOL_NAME, { action: 'click_at', args: { x: 10, y: 20 } });
assert.deepEqual(calls.at(-1), { name: 'click_at', args: { x: 10, y: 20 } });
assert.ok(!('action' in calls.at(-1).args), 'the routing key leaked into the action arguments');

// ARGUMENTS MUST SURVIVE A SCHEMA-VALIDATING PROVIDER.
// This is the regression that broke structured_insert: the spec declared only `action`
// and `tool`, so a provider validating against it dropped `elements` before the executor
// ever saw it, and the adapter reported "no elements provided". Anything the model must
// be able to send has to be DECLARED, not merely tolerated by additionalProperties.
const declared = Object.keys(spec.parameters.properties);
assert.ok(declared.includes('args'), 'action arguments need a declared home');

// Simulate the provider: keep only declared properties, then dispatch.
const stripToSchema = (payload) => Object.fromEntries(
  Object.entries(payload).filter(([k]) => declared.includes(k)),
);
const payload = { action: 'fill_form', args: { fields: [{ selector: '#a', value: 'x' }] } };
await dispatch(DISPATCH_TOOL_NAME, stripToSchema(payload));
assert.deepEqual(
  calls.at(-1).args.fields,
  payload.args.fields,
  'action arguments did not survive schema-stripping — this is the structured_insert bug',
);

// ADAPTER TOOLS ROUTE THE SAME WAY. In production the dispatcher is built from
// PAGE_TOOL_SPECS PLUS the active canvas adapter's specs (structured_insert, read_canvas),
// so an array argument on an adapter tool must survive the identical path.
const adapterSpec = {
  name: 'structured_insert',
  description: 'Insert native elements into the canvas app. Provide `elements`.',
  parameters: { type: 'object', properties: { elements: { type: 'array' } }, required: ['elements'] },
};
const withAdapter = [...PAGE_TOOL_SPECS, adapterSpec];
const adapterCalls = [];
const adapterDispatch = makeDispatchExecutor(withAdapter, async (name, args) => {
  adapterCalls.push({ name, args });
  return JSON.stringify({ ok: true });
});
const adapterDeclared = Object.keys(buildDispatchSpec(withAdapter).parameters.properties);
const elements = [{ type: 'ellipse', x: 200, y: 200, width: 300, height: 300 }];
const sent = Object.fromEntries(
  Object.entries({ action: 'structured_insert', args: { elements } })
    .filter(([k]) => adapterDeclared.includes(k)),
);
await adapterDispatch(DISPATCH_TOOL_NAME, sent);
assert.equal(adapterCalls.at(-1).name, 'structured_insert');
assert.deepEqual(adapterCalls.at(-1).args.elements, elements, 'the adapter never received its elements');

// Both shapes work: a model that ignores the envelope must not silently fail either.
await dispatch(DISPATCH_TOOL_NAME, { action: 'click_at', x: 7, y: 8 });
assert.deepEqual(calls.at(-1).args, { x: 7, y: 8 }, 'top-level arguments should still route');
await dispatch(DISPATCH_TOOL_NAME, { action: 'click_at', x: 1, args: { y: 2 } });
assert.deepEqual(calls.at(-1).args, { x: 1, y: 2 }, 'mixed shapes should merge');

// Direct calls still work, so nothing that already spoke to these tools breaks.
await dispatch('inspect_page', {});
assert.equal(calls.at(-1).name, 'inspect_page');

// ---------------------------------------------------------------- reachability
const described = JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: 'describe', args: { tool: 'fill_form' } }));
const real = PAGE_TOOL_SPECS.find((s) => s.name === 'fill_form');
assert.equal(described.name, 'fill_form');
assert.deepEqual(described.parameters, real.parameters, 'describe must return the REAL schema');
assert.equal(described.description, real.description);

// describe accepts either shape too, since a model may put `tool` at the top level.
assert.equal(JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: 'describe', tool: 'fill_form' })).name, 'fill_form');
const unknownDesc = JSON.parse(await dispatch(DISPATCH_TOOL_NAME, { action: 'describe', args: { tool: 'nope' } }));
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
assert.match(missing.hint, /args/, 'the repair hint must teach the envelope');
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
