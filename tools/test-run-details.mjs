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

// ---------------------------------------------------------------- turn boundaries
// Explicit turn/start and turn/end are what let a trajectory NEST: without them the log
// is a flat list of calls and you can see what happened but not what it belonged to.
const t = (turnId) => [
  a.append('turn.started', { turnId, kind: 'chat', agentId: 'claude' }),
  a.append('context.assembled', { turnId, budget: 0, used: 900, parts: {}, resident: [], reachableCount: 1 }),
  invoked(turnId, 'click_at', `${turnId}-k`),
  resulted(turnId, 'click_at', `${turnId}-k`, true, 'page ok'),
];

const okRun = summarizeRun('t10', [...t('t10'), a.append('turn.ended', { turnId: 't10', reason: 'ok', stepped: true, ms: 4200 })]);
assert.equal(okRun.turn.reason, 'ok');
assert.equal(okRun.ms, 4200);
assert.equal(okRun.open, false);
assert.equal(verdict(okRun).level, 'ok');

// Stopped by the user reads as a choice, not a failure.
const stopped = summarizeRun('t11', [...t('t11'), a.append('turn.ended', { turnId: 't11', reason: 'aborted', stepped: true, ms: 900 })]);
assert.equal(verdict(stopped).text, 'Stopped by you');
assert.equal(verdict(stopped).level, 'info');

// A turn that opened and never closed is still running — or was interrupted by a reload,
// which is worth seeing rather than silently rendering as finished.
const openRun = summarizeRun('t12', t('t12'));
assert.equal(openRun.open, true);
assert.match(verdict(openRun).text, /Still running, or interrupted/);

// A turn that died before any tool ran is a different failure from a tool that failed.
const early = summarizeRun('t13', [
  a.append('turn.started', { turnId: 't13', kind: 'chat' }),
  a.append('turn.ended', { turnId: 't13', reason: 'error', stepped: false, ms: 120 }),
]);
assert.equal(verdict(early).level, 'warn');
assert.match(verdict(early).text, /failed before any tool ran/);

// Ordering uses the turn's own start, so runs sort by when they began.
const { runs: ordered } = groupRuns([...t('t14'), a.append('turn.ended', { turnId: 't14', reason: 'ok', stepped: true }), ...t('t15')]);
assert.ok(ordered.length >= 2 && ordered[0].at >= ordered[1].at);

console.log('✓ run details: turn boundaries, open runs, abort vs error');

// ---------------------------------------------------------------- dispatcher names
// One registered tool carrying the real action in its arguments meant every row read
// `page`. Forty distinct actions rendered as forty identical chips, which is worse than
// no view at all — the same blindness that stopped the loop guard exempting screenshots.
const dispatched = (turnId, action, key, ms, ok = true, extra = {}) => ([
  a.append('capability.invoked', {
    capability: 'page', actor: { kind: 'model', id: 'm' }, scope: { kind: 'session', id: 'c' },
    effects: 'non-replayable', idempotencyKey: key, turnId, args: { action, ...extra },
  }),
  a.append('capability.resulted', {
    capability: 'page', ok, classUsed: 'X', cost: { ms }, turnId, idempotencyKey: key,
    summary: ok ? 'page ok' : '{"error":"no elements provided"}',
  }),
]);

const disp = summarizeRun('t20', [
  a.append('context.assembled', { turnId: 't20', budget: 0, used: 900, parts: {}, resident: [], reachableCount: 1 }),
  ...dispatched('t20', 'screenshot', 'd1', 1945),
  ...dispatched('t20', 'click_at', 'd2', 25),
  ...dispatched('t20', 'click_at', 'd3', 30),
  ...dispatched('t20', 'type_text', 'd4', 5211),
  ...dispatched('t20', 'describe', 'd5', 10, true, { tool: 'input_sequence' }),
]);

assert.deepEqual(
  disp.toolCalls.map((c) => c.label),
  ['page.screenshot', 'page.click_at', 'page.click_at', 'page.type_text', 'page.describe(input_sequence)'],
  'dispatched calls still render as an undifferentiated "page"',
);

// "What did it spend the time on" is the only useful question on a long run.
assert.equal(disp.actions[0].name, 'page.type_text');
assert.equal(disp.actions[0].ms, 5211);
assert.equal(disp.actions[1].name, 'page.screenshot');
const clicks = disp.actions.find((x) => x.name === 'page.click_at');
assert.equal(clicks.count, 2);
assert.equal(clicks.ms, 55);
assert.equal(disp.toolMs, 1945 + 25 + 30 + 5211 + 10);

// Repeated-failure diagnosis must key on the REAL action, or six failing
// structured_inserts and six failing screenshots look like one twelve-deep loop.
const mixed = summarizeRun('t21', [
  a.append('context.assembled', { turnId: 't21', budget: 0, used: 1, parts: {}, resident: [], reachableCount: 1 }),
  ...dispatched('t21', 'structured_insert', 'x1', 5, false),
  ...dispatched('t21', 'structured_insert', 'x2', 5, false),
  ...dispatched('t21', 'screenshot', 'x3', 5, false),
]);
assert.equal(mixed.repeats.length, 1, 'failures from different actions were merged');
assert.equal(mixed.repeats[0].name, 'page.structured_insert');
assert.equal(mixed.repeats[0].count, 2);

console.log('✓ run details: dispatcher actions resolved, time attributed per action');

// EVERY SURFACE REPORTS, AND A FINISHED RUN MUST READ AS FINISHED.
// The activity log covered chats only until emission moved to the shared chokepoint;
// the move then exposed a second bug — the redaction-off fast path returned before the
// close, so a finished note rendered as "Still running". A run that recorded an end is
// never open, whichever surface it came from.
const noteRun = summarizeRun('t30', [
  a.append('turn.started', { turnId: 't30', kind: 'note', background: false }),
  a.append('context.assembled', { turnId: 't30', budget: 0, used: 2083, parts: {}, resident: [], reachableCount: 0 }),
  a.append('turn.ended', { turnId: 't30', reason: 'ok', ms: 4200 }),
]);
assert.equal(noteRun.open, false, 'a note that recorded turn.ended still reads as running');
assert.equal(noteRun.kind, 'note', 'the surface was lost, so every run looks like a chat');
assert.equal(verdict(noteRun).level, 'ok');

// Infrastructure folds out of the default view but stays in the log: a turn that streams
// nothing to a human and calls no tool is a title or a grammar pass, and a dozen of them
// per note would bury the note's own run.
const helper = summarizeRun('t31', [
  a.append('turn.started', { turnId: 't31', kind: 'note', background: true }),
  a.append('turn.ended', { turnId: 't31', reason: 'ok', ms: 300 }),
]);
assert.equal(helper.background, true);

// ...but a tool call always makes a run foreground, whatever the caller claimed: something
// that acted on the user's behalf is never hidden.
const acted = summarizeRun('t32', [
  a.append('turn.started', { turnId: 't32', kind: 'note', background: true }),
  ...dispatched('t32', 'screenshot', 'y1', 5, true),
  a.append('turn.ended', { turnId: 't32', reason: 'ok', ms: 900 }),
]);
assert.equal(acted.background, false, 'a run that called a tool was hidden from the default view');
