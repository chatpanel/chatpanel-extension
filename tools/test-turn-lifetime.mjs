import assert from 'node:assert/strict';
import { turnSpecFor } from '../extension/js/providers.js';
import { runAsTurn } from '../extension/js/turn-runner.js';

// ── which surface a call belongs to ───────────────────────────────────────────
// Activity covered chats only until emission moved to the chokepoint. These assert the
// classification every surface now depends on.

assert.equal(turnSpecFor({ usage: { surface: 'note' } }).loop.kind, 'note');
assert.equal(turnSpecFor({ usage: { surface: 'meeting' } }).request.kind, 'meeting');
assert.equal(turnSpecFor({}).loop.kind, 'other', 'an untagged call must not masquerade as chat');

// A caller-supplied turn id is carried through verbatim: the side panel passes its
// assistant-message id so the turn record and the tool events that reference it group
// into ONE run. Generating a fresh id here is what split runs in Activity.
assert.equal(turnSpecFor({ usage: { surface: 'chat', turnId: 'm-42' } }).request.turnId, 'm-42');

// ── background vs asked-for ───────────────────────────────────────────────────
const bg = (o) => turnSpecFor(o).loop.background;

assert.equal(bg({ usage: { surface: 'note' } }), true, 'a silent, tool-less call is infrastructure');
assert.equal(bg({ usage: { surface: 'note' }, onDelta: () => {} }), false, 'streaming to a human is not background');
assert.equal(bg({ usage: { surface: 'note' }, tools: { specs: [{ name: 'page' }] } }), false,
  'a call that can act on the user\'s behalf is never hidden');
assert.equal(bg({ usage: { surface: 'chat' }, tools: { specs: [] }, onDelta: () => {} }), false);

// ── the log is a description of the turn, never a participant in it ───────────
// In Node there is no IndexedDB. The log degrades INSIDE event-log.js (it reports
// "event log unavailable" and its writes become no-ops) rather than failing to import, so
// the real runner is what runs here — a stronger result than the fallback path, and the
// property under test either way: a logging failure must never become a chat failure.
const out = await runAsTurn({ id: 'loop:test', kind: 'chat' }, {}, () => 'the answer');
assert.equal(out, 'the answer', 'a turn did not survive an unavailable event log');

// The fallback context still satisfies the contract a loop body is written against, so
// the degraded path does not need its own code path in every caller.
const seen = await runAsTurn({ id: 'loop:test', kind: 'chat' }, {}, (turn) => {
  turn.produced();
  turn.report({ tokensIn: 10 });
  turn.emit('capability.invoked', { capability: 'page' });
  return Object.keys(turn).sort();
});
assert.deepEqual(seen, ['emit', 'kind', 'produced', 'report', 'request', 'signal', 'turnId'],
  'the loop context changed shape — every loop body is written against these keys');

// It still refuses to hand a loop the ability to close its own turn. The guarantee is the
// absence, so it is worth asserting from the consumer side and not only in the package:
// this is the shape the extension's loops actually receive.
for (const forbidden of ['close', 'end', 'turn', 'finish']) {
  assert.ok(!seen.includes(forbidden), `fallback context exposed '${forbidden}'`);
}

// An error propagates rather than being swallowed by the wrapper.
await assert.rejects(
  () => runAsTurn({ id: 'loop:test', kind: 'chat' }, {}, () => { throw new Error('boom'); }),
  /boom/,
);

console.log('✓ turn lifetime: surfaces classified, background folded, log never load-bearing');

// The DEGRADED context must satisfy the same contract. Otherwise the fallback — which
// exists so a logging failure never becomes a chat failure — becomes one: a body calling
// report() would throw there while working everywhere else. Found by this test, not in
// production.
const { getTurnRunner } = await import('../extension/js/turn-runner.js');
const real = await getTurnRunner();
const degraded = { turnId: null, kind: 'other', request: {}, signal: undefined, emit() {}, produced() {}, report() {} };
if (real) {
  const live = await runAsTurn({ id: 'loop:test', kind: 'chat' }, {}, (t) => Object.keys(t).sort());
  assert.deepEqual(live, Object.keys(degraded).sort(), 'the live and degraded contexts have drifted apart');
}
