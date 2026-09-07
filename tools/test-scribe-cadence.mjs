// The meeting scribe must never speed up because its work is failing.
//
// It used to. The delay was picked from `scribeState.size ? min * 60_000 : 4000`, and that
// Map was written only on the paths that succeeded — so a live meeting with no segments, or
// a summariser throwing because the configured model had been deleted, left it empty and the
// panel re-ran the whole tick every four seconds: index read, full AES-GCM transcript
// decrypt, transcript rebuilt as a string, model call. Fifteen times a minute, on the
// panel's main thread, for as long as it stayed open. That is the "opening ChatPanel hangs
// my machine" report, and this file is the reason it cannot come back.
import assert from 'node:assert/strict';

const {
  nextScribeDelay, shouldSkipMeeting,
  SCRIBE_FIRST_LOOK_MS, SCRIBE_MIN_DELAY_MS, SCRIBE_MAX_BACKOFF_MS, SCRIBE_DISCOVERY_MS,
} = await import('../extension/js/scribe-cadence.js');

// --- the scribe is off ------------------------------------------------------
assert.equal(nextScribeDelay({ intervalMin: 0 }), null, 'interval 0 must arm no timer');
assert.equal(nextScribeDelay({ intervalMin: 0, ran: true, liveCount: 3 }), null);

// --- the one fast path, and only once ---------------------------------------
assert.equal(
  nextScribeDelay({ intervalMin: 5, ran: false }), SCRIBE_FIRST_LOOK_MS,
  'the first look after the panel opens should be prompt',
);
assert.notEqual(
  nextScribeDelay({ intervalMin: 5, ran: true, liveCount: 1 }), SCRIBE_FIRST_LOOK_MS,
  'the fast path must not repeat once a tick has run',
);

// --- THE REGRESSION. Every way a tick can do no useful work. -----------------
// Each of these was a `continue` that left the bookkeeping Map empty, and an empty Map
// meant 4000 ms. None of them may produce a delay under the floor.
for (const [name, args] of [
  ['a live meeting that has produced no segments yet', { intervalMin: 5, ran: true, liveCount: 1, summarized: false, failures: 0 }],
  ['every live meeting failing (dead model)', { intervalMin: 5, ran: true, liveCount: 1, summarized: false, failures: 1 }],
  ['failing for a long time', { intervalMin: 5, ran: true, liveCount: 2, summarized: false, failures: 9 }],
  ['nothing live at all', { intervalMin: 5, ran: true, liveCount: 0 }],
  ['a nonsense interval', { intervalMin: 0.001, ran: true, liveCount: 1 }],
]) {
  const ms = nextScribeDelay(args);
  assert.ok(
    ms >= Math.min(SCRIBE_MIN_DELAY_MS, SCRIBE_DISCOVERY_MS),
    `${name}: ${ms} ms is faster than the floor — this is the four-second loop`,
  );
  assert.ok(ms >= 4_001, `${name}: ${ms} ms is the old runaway cadence`);
}

// --- failure makes it SLOWER, monotonically ---------------------------------
const failing = [0, 1, 2, 3, 4].map((f) =>
  nextScribeDelay({ intervalMin: 1, ran: true, liveCount: 1, failures: f }));
for (let i = 1; i < failing.length; i++) {
  assert.ok(failing[i] >= failing[i - 1], `backoff must not shrink: ${failing}`);
}
assert.ok(failing[4] > failing[0], 'sustained failure must back off, not hold steady');
assert.ok(
  nextScribeDelay({ intervalMin: 1, ran: true, liveCount: 1, failures: 50 }) <= Math.max(SCRIBE_MAX_BACKOFF_MS, 60_000),
  'backoff must be capped so a recovered model is picked up again',
);

// --- one success clears it --------------------------------------------------
assert.equal(
  nextScribeDelay({ intervalMin: 5, ran: true, liveCount: 1, summarized: true, failures: 3 }),
  nextScribeDelay({ intervalMin: 5, ran: true, liveCount: 1, summarized: false, failures: 0 }),
  'a summary written this tick should return to the plain interval',
);

// --- the user's interval is honoured above the floor ------------------------
assert.equal(nextScribeDelay({ intervalMin: 10, ran: true, liveCount: 1 }), 10 * 60_000);

// --- per-meeting skip: one bad record must not starve the others ------------
assert.equal(shouldSkipMeeting({ failures: 0 }), false, 'a healthy meeting is never skipped');
assert.equal(shouldSkipMeeting(undefined), false, 'an unseen meeting is never skipped');
const now = 1_000_000;
assert.equal(
  shouldSkipMeeting({ failures: 3, failedAt: now }, { now }), true,
  'a meeting that just failed three times should be given a rest',
);
assert.equal(
  shouldSkipMeeting({ failures: 3, failedAt: now - SCRIBE_MAX_BACKOFF_MS - 1 }, { now }), false,
  'a rested meeting must be retried — a model that was down comes back',
);

console.log('scribe cadence: ok');
