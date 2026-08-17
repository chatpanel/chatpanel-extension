import assert from 'node:assert/strict';
import { classifyFailure, markUnhealthy, markHealthy, healthOf, resetHealth } from '../extension/js/model-health.js';

resetHealth();

// ONLY THE CATEGORIES THAT CHANGE WHAT TO DO. A 402 and a 429 are both "not now", but one is
// "not for a while" and the other is "in a moment" — routing that treats them the same
// either hammers a dead endpoint or abandons a live one.
assert.equal(classifyFailure(new Error('HTTP 402 — {"error":"You have depleted your monthly included credits."}')), 'quota');
assert.equal(classifyFailure({ status: 429 }), 'rate');
assert.equal(classifyFailure({ status: 503 }), 'server');
assert.equal(classifyFailure(new Error('fetch failed: ECONNRESET')), 'server');

// THE MODEL IS GONE, not our request. A real 410: "The model 'deepseek-v4-flash' has reached
// its end of life and is no longer available." Every other model would handle that request
// fine, so failing the turn is the one response that helps nobody — and the generic 4xx rule
// would have read it as our mistake and refused to fail over.
assert.equal(classifyFailure(new Error('HTTP 410 — {"title":"Gone","status":410,"detail":"The model has reached its end of life on 2026-08-07 and is no longer available."}')), 'gone');
assert.equal(classifyFailure({ status: 404, message: 'unknown model xyz' }), 'gone');
assert.equal(classifyFailure(new Error('This model has been deprecated')), 'gone');
markUnhealthy('dead', { status: 410, message: 'end of life' });
assert.equal(healthOf('dead').available, false, 'a retired model stayed in rotation');
// Stood down for the session, because it is not coming back and a shorter wait just repeats
// the same failure on a timer.
assert.ok(healthOf('dead').until - Date.now() > 60 * 60_000);

// A 400 or 401 is OUR request or OUR key being wrong, and every other model would refuse it
// too. Standing the model down would hide a configuration error behind a health problem and
// send the user to fix the wrong thing.
assert.equal(classifyFailure({ status: 400 }), null);
assert.equal(classifyFailure({ status: 401 }), null);
assert.equal(markUnhealthy('m', { status: 401 }), null, 'a bad key stood the model down');
assert.equal(healthOf('m').available, true);

// Quota takes a model out of rotation; the router rejects it as unavailable.
const q = markUnhealthy('hf', new Error('402 depleted your monthly included credits'));
assert.equal(q.reason, 'quota');
assert.equal(healthOf('hf').available, false);

// A rate limit is a different state: still "no", but reported as throttled rather than down.
markUnhealthy('fast', { status: 429 });
assert.equal(healthOf('fast').rateLimited, true);
assert.equal(healthOf('fast').available, true, 'a rate limit was treated as an outage');

// Repeated failures wait longer — a model failing every time should be tried rarely, not
// never, because the thing that broke it may be fixed at any moment.
const first = markUnhealthy('flaky', { status: 503 }).until;
const second = markUnhealthy('flaky', { status: 503 }).until;
assert.ok(second > first);

// Success clears it immediately: whatever was wrong is over.
markHealthy('hf');
assert.equal(healthOf('hf').available, true);

// An unknown model is healthy — the router must not sideline something it has never tried.
assert.equal(healthOf('never-seen').available, true);

// Expiry forgets rather than accumulating dead state.
resetHealth();
assert.deepEqual(healthOf('gone'), { available: true, rateLimited: false, reason: null });

console.log('✓ model health: behaviour beats configuration, and a bad key is not an outage');
