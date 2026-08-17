import assert from 'node:assert/strict';
import { createAppender } from '../extension/js/events/event.js';
import { replay, formatReport } from '../extension/js/events/harness.js';

// A turn shaped like the ones the extension actually writes — prompt, context, a dispatched
// tool call and its result, the answer — rather than a fixture built to pass.
let n = 0;
const a = createAppender({ host: 'ext', now: () => 1_700_000_000_000 + n * 10, newId: () => `e${n++}` });
const hash = (c) => `sha256:${c.repeat(64)}`;
const promptRef = { kind: 'chat', id: hash('a'), hash: hash('a') };
const answerRef = { kind: 'chat', id: hash('b'), hash: hash('b') };

const log = [
  a.append('turn.started', { turnId: 't1', kind: 'chat', background: false }),
  a.append('context.assembled', {
    turnId: 't1', budget: 0, used: 832, parts: { toolSchemas: 800, system: 32 },
    resident: [], reachableCount: 2, tools: ['page', 'find'], redaction: true,
  }),
  a.append('assistant.prompted', { turnId: 't1', ref: promptRef, chars: 4210 }),
  a.append('capability.invoked', {
    capability: 'find', actor: { kind: 'model', id: 'gemma' }, scope: { kind: 'session', id: 'c1' },
    effects: 'idempotent', idempotencyKey: 'k1', turnId: 't1', args: { action: 'history_search' },
  }),
  a.append('capability.resulted', { capability: 'find', ok: true, classUsed: 'X', cost: { ms: 120 }, turnId: 't1', idempotencyKey: 'k1', summary: 'ok' }),
  a.append('assistant.message', { turnId: 't1', ref: answerRef, chars: 980 }),
  a.append('turn.ended', { turnId: 't1', reason: 'ok', ms: 3400, tokensIn: 4127, tokensOut: 73, model: 'gemma' }),
];

const allBlobs = { lookup: (r) => ({ hash: r.hash }) };

// ── the claim, checked ───────────────────────────────────────────────────────
const ok = replay(log, { blobs: allBlobs });
assert.equal(ok.ok, true, formatReport(ok));
assert.equal(ok.stable, true);
assert.equal(ok.violations.length, 0);
assert.equal(ok.refs.exact, 2, 'the prompt and the answer were not verified');

// ORDER COMES FROM CAUSES AND SEQUENCE, NEVER A CLOCK. Reading the log back in a different
// order — which is what an export, a merge or a different IndexedDB cursor produces — must
// not change the reconstruction.
const shuffled = [...log].reverse();
const re = replay(shuffled, { blobs: allBlobs });
assert.deepEqual(re.order, ok.order, 'replay depends on how the log was read off disk');

// A SHREDDED BLOB IS A PASS. Deletion is a feature; reporting it as damage would make
// "delete my data" look like corruption.
const shredded = replay(log, { blobs: { lookup: () => null } });
assert.equal(shredded.ok, true, formatReport(shredded));
assert.equal(shredded.refs.unavailable, 2);
assert.match(formatReport(shredded), /shredded\/evicted/);

// CONTENT THAT CHANGED IS A FAILURE — the alternative is replay quietly showing today's
// text as though it were what the model saw.
const drifted = replay(log, { blobs: () => null, ...{ blobs: { lookup: () => ({ hash: hash('z') }) } } });
assert.equal(drifted.ok, false);
assert.equal(drifted.refs.drifted.length, 2);
assert.match(formatReport(drifted), /the source changed since capture/);

// A TURN THAT NEVER RECORDED ITS CONTEXT fails I1: the model-visible input is not
// reconstructable, which is the whole property being claimed.
const noContext = log.filter((e) => e.type !== 'context.assembled');
const bad = replay(noContext, { blobs: allBlobs });
assert.equal(bad.ok, false);
assert.ok(bad.violations.some((v) => v.invariant === 'I1'), formatReport(bad));

// AN EMPTY LOG REPLAYS CLEANLY rather than erroring — a user who cleared their activity
// should not be told their log is corrupt.
assert.equal(replay([], { blobs: allBlobs }).ok, true);

console.log('✓ replay: order from causes not clocks, content verified, shredding is a pass');
