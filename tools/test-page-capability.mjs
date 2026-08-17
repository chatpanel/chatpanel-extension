// The button was re-rendered from four separate places. Each was a spot where the UI
// stayed correct only because someone remembered — and a fifth caller added later would
// silently go stale. These tests assert the registry closes that, and that the withdrawal
// path (the one that only runs when you navigate away) actually runs.

import assert from 'node:assert/strict';
import { syncPageContext, pageContext, pageCapabilityState, resetPageCapability } from '../extension/js/page-capability.js';

const armed = [];
const handlers = {
  onArm: (v) => armed.push(`arm:${v.decision.siteKey}`),
  onDisarm: () => armed.push('disarm'),
};
const tab = (id, siteKey) => ({ tab: { id }, decision: { siteKey, decision: 'arm' } });

await resetPageCapability();

// Publishing context arms the dependent.
await syncPageContext(tab(1, 'excalidraw.com'), handlers);
assert.deepEqual(armed, ['arm:excalidraw.com']);
assert.deepEqual(pageCapabilityState().active, ['page-actions', 'page-tools']);

// Navigating to a page ChatPanel cannot read WITHDRAWS it — and the dependent unwinds on
// its way out. Nobody calls a reset; the effect's inverse is the reset.
await syncPageContext(null, handlers);
assert.deepEqual(armed, ['arm:excalidraw.com', 'disarm']);
assert.deepEqual(pageCapabilityState().active, [], 'the dependent stayed active with no context');
assert.deepEqual(pageCapabilityState().pending, [
  { name: 'page-actions', waitingFor: ['page.context'] },
  { name: 'page-tools', waitingFor: ['page.context'] },
]);
assert.equal(pageContext(), null);

// Navigating back re-arms — the appears / withdraws / returns cycle, load-bearing.
await syncPageContext(tab(2, 'sketch.io'), handlers);
assert.deepEqual(armed.slice(-1), ['arm:sketch.io']);
assert.deepEqual(pageCapabilityState().active, ['page-actions', 'page-tools']);

// A CHANGE reverts through the real path rather than mutating in place, so the revert is
// exercised on every tab switch instead of only in the rare case — a revert that runs only
// rarely is one that is broken when the rare case arrives.
armed.length = 0;
await syncPageContext(tab(3, 'docs.google.com'), handlers);
assert.deepEqual(armed, ['disarm', 'arm:docs.google.com']);

// A policy change travels the identical path — no special case for "same tab, new grant".
armed.length = 0;
await syncPageContext(tab(3, 'docs.google.com'), handlers);
assert.deepEqual(armed, ['disarm', 'arm:docs.google.com']);

// Repeated identical syncs stay balanced: no double-provide, no leaked registration.
for (let i = 0; i < 20; i++) await syncPageContext(tab(4, 'a.example'), handlers);
// `page.tools` is provided BY a dependent, so it appearing here is the point: the page
// toolset is now a capability in its own right rather than something only a turn could
// construct. Twenty identical syncs must still leave exactly one of each.
assert.deepEqual(pageCapabilityState().provided, ['page.context', 'page.tools'], 'a key leaked or was double-provided');
assert.deepEqual(pageCapabilityState().active, ['page-actions', 'page-tools']);

// Teardown leaves nothing behind.
await resetPageCapability();
assert.deepEqual(pageCapabilityState(), { active: [], pending: [], provided: [] });

console.log('✓ page capability: arms, withdraws, re-arms, and never leaks a registration');

// ── P5: a capability is not a property of a turn ─────────────────────────────
// Page tools were only ever constructed while assembling a turn, so nothing else could
// reach them — a rule, a schedule or a button had no way to act on the page unless a
// conversation existed first. That assumption is what stopped "act on this page" from
// becoming automation.
import { setPageToolFactory, acquirePageTools, invokePageAction } from '../extension/js/page-capability.js';

await resetPageCapability();
let builds = 0;
setPageToolFactory(async () => {
  builds++;
  return { specs: [{ name: 'click_at' }], execute: async (n, a) => JSON.stringify({ ran: n, args: a }) };
});

// Not armed: a non-turn caller gets the same answer a turn would, so automation can never
// reach further than a conversation can.
assert.equal(await acquirePageTools(), null);
assert.match(JSON.parse(await invokePageAction('click_at', { x: 1 })).error, /not available/);

await syncPageContext(tab(9, 'excalidraw.com'), handlers);
const tools = await acquirePageTools();
assert.ok(tools, 'page tools are still unreachable without a turn');
assert.equal(JSON.parse(await invokePageAction('click_at', { x: 5, y: 6 })).ran, 'click_at');

// Built at most once per armed context — publishing a FACTORY rather than a built provider
// is what keeps the heavy page/canvas modules off every tab change.
await acquirePageTools(); await invokePageAction('click_at', {});
assert.equal(builds, 1, 'the provider was rebuilt; the factory indirection is not doing its job');

// A new page rebuilds. Reusing the old provider would let it answer for a tab it was never
// built for — the dangling-observer bug, in the capability that drives the browser.
await syncPageContext(tab(10, 'sketch.io'), handlers);
await acquirePageTools();
assert.equal(builds, 2, 'a provider built for one tab survived into the next');

await resetPageCapability();
console.log('✓ page capability: reachable without a turn, built once per page');
