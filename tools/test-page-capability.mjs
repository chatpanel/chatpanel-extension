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
assert.deepEqual(pageCapabilityState().active, ['page-actions']);

// Navigating to a page ChatPanel cannot read WITHDRAWS it — and the dependent unwinds on
// its way out. Nobody calls a reset; the effect's inverse is the reset.
await syncPageContext(null, handlers);
assert.deepEqual(armed, ['arm:excalidraw.com', 'disarm']);
assert.deepEqual(pageCapabilityState().active, [], 'the dependent stayed active with no context');
assert.deepEqual(pageCapabilityState().pending, [{ name: 'page-actions', waitingFor: ['page.context'] }]);
assert.equal(pageContext(), null);

// Navigating back re-arms — the appears / withdraws / returns cycle, load-bearing.
await syncPageContext(tab(2, 'sketch.io'), handlers);
assert.deepEqual(armed.slice(-1), ['arm:sketch.io']);
assert.deepEqual(pageCapabilityState().active, ['page-actions']);

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
assert.deepEqual(pageCapabilityState().provided, ['page.context'], 'a key leaked or was double-provided');
assert.deepEqual(pageCapabilityState().active, ['page-actions']);

// Teardown leaves nothing behind.
await resetPageCapability();
assert.deepEqual(pageCapabilityState(), { active: [], pending: [], provided: [] });

console.log('✓ page capability: arms, withdraws, re-arms, and never leaks a registration');
