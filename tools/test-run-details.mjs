import assert from 'node:assert/strict';
import { createAppender } from '../extension/js/events/event.js';
import { groupRuns, summarizeRun, findRepeats, verdict, toSanitizedReport } from '../extension/js/run-details.js';

let n = 0;
const a = createAppender({ host: 'ext', now: () => 1_700_000_000_000 + (n * 10), newId: () => `e${n++}` });
const invoked = (turnId, name, key) => a.append('capability.invoked', {
  capability: name, actor: { kind: 'model', id: 'claude' }, scope: { kind: 'session', id: 'c1' },
  effects: 'non-replayable', idempotencyKey: key, turnId, args: { elements: 'array(2)' },
});
const resulted = (turnId, name, key, ok, summary) => a.append('capability.resulted', {
  capability: name, ok, classUsed: 'X', cost: { ms: 12 }, turnId, idempotencyKey: key, summary,
});

// The exact shape of the structured_insert failure: same tool, same error, six times.
const evs = [
  a.append('context.assembled', {
    turnId: 't1', budget: 0, used: 900, parts: { toolSchemas: 768, system: 132 },
    resident: [], reachableCount: 1, tools: ['page'], pageArmed: true,
  }),
  a.append('capability.activated', { capability: 'page.actions', classUsed: 'R', siteKey: 'excalidraw.com', granted: true, reason: 'user-granted-site' }),
];
for (let i = 0; i < 6; i++) {
  evs.push(invoked('t1', 'structured_insert', `k${i}`));
  evs.push(resulted('t1', 'structured_insert', `k${i}`, false, '{"error":"no elements provided"}'));
}

const run = summarizeRun('t1', evs);
assert.equal(run.toolCalls.length, 6);
assert.equal(run.failures.length, 6);
assert.equal(run.tokens, 900);
assert.equal(run.context.pageArmed, true);

// The diagnostic that matters: a repeated identical failure is a harness problem.
assert.equal(run.repeats.length, 1);
assert.equal(run.repeats[0].count, 6);
assert.equal(run.repeats[0].name, 'structured_insert');
assert.match(verdict(run).text, /failed 6× with the same error — likely a harness problem/);
assert.equal(verdict(run).level, 'bad');

// A healthy run reads as healthy.
const good = [
  a.append('context.assembled', { turnId: 't2', budget: 0, used: 800, parts: {}, resident: [], reachableCount: 1 }),
  invoked('t2', 'read_canvas', 'g1'), resulted('t2', 'read_canvas', 'g1', true, 'ok'),
];
assert.equal(verdict(summarizeRun('t2', good)).level, 'ok');
assert.equal(findRepeats(summarizeRun('t2', good).toolCalls).length, 0);

// Runs group by turn and come back newest first — turnId must be per TURN, not per
// conversation, or everything collapses into one run.
const { runs } = groupRuns([...evs, ...good]);
assert.equal(runs.length, 2);
assert.equal(runs[0].turnId, 't2');
assert.ok(runs[0].at >= runs[1].at);

// A declined action is recorded and reads as informational, not as a failure.
const declined = [
  a.append('context.assembled', { turnId: 't3', budget: 0, used: 10, parts: {}, resident: [], reachableCount: 0 }),
  a.append('policy.guard_denied', { capability: 'page.actions', reason: 'user-declined:click_at', turnId: 't3' }),
];
assert.equal(verdict(summarizeRun('t3', declined)).level, 'info');

// The support export carries structure and counts, never payloads.
const report = toSanitizedReport([run]);
const text = JSON.stringify(report);
assert.match(text, /structured_insert/);
assert.ok(!text.includes('"elements":['), 'raw arguments leaked into the sanitized report');
assert.equal(report.runs[0].calls[0].args.elements, 'array(2)');

console.log('✓ run details: grouping, repeated-failure diagnosis, sanitized export');
