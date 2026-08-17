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
// The real Groq 404: a model that does not exist is the provider saying THIS model is
// unusable, not that our request was malformed. Every other model would have answered.
assert.equal(classifyFailure(new Error('HTTP 404 — {"error":{"message":"The model llama-3.1-8b-instant does not exist or you do not have access to it."}}')), 'gone');
assert.equal(classifyFailure(new Error('This model has been deprecated')), 'gone');
// An agent configured for a model it does not have. Nothing about that changes in thirty
// seconds, and retrying costs a process spawn to be told the same thing — so it is stood
// down until the setting is fixed, while every other model can still answer.
assert.equal(classifyFailure(new Error('Antigravity exited 1: Error: invalid model selection (--model "Gemini" --effort ""): model Gemini is not recognized as a known model or custom model in settings')), 'gone');
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
assert.equal(classifyFailure({ status: 403 }), null);

// EVERYTHING ELSE GETS TRIED ELSEWHERE. A router that gives up on an unrecognised failure is
// a router that gives up — the user asked for the next option, not for a verdict on whose
// fault it was.
assert.equal(classifyFailure({ status: 404, message: 'Not Found' }), 'unknown');
assert.equal(classifyFailure({ status: 422, message: 'Unprocessable' }), 'unknown');
assert.equal(classifyFailure(new Error('socket hang up')), 'unknown');
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

// ── the same model failing at several providers is a fact about the MODEL ────
// "Same model elsewhere" is the right replacement when a PROVIDER declines, and pointless
// when the model itself is the problem. A user watched a chain go "HuggingFace ·
// DeepSeek-V4-Flash → Deepseek · deepseek-v4-flash" and reasonably asked why.
resetHealth();

// One provider failing says nothing about the model — the model stays available elsewhere.
markUnhealthy('hf', { status: 402, message: 'credits depleted' }, 'deepseek-ai/DeepSeek-V4-Flash');
assert.equal(healthOf('other', 'deepseek-v4-flash').available, true,
  'one provider running out of credits condemned the model everywhere');

// Two different providers failing on the same model IS evidence.
markUnhealthy('nvidia', { status: 402, message: 'credits depleted' }, 'deepseek-ai/deepseek-v4-flash');
assert.equal(healthOf('third', 'deepseek-v4-flash').available, false,
  'the model kept being tried after failing at two providers');

// Provider prefixes and tags must not stop a model matching itself, or the count never
// reaches two.
assert.equal(healthOf('fourth', 'DeepSeek-V4-Flash:latest').available, false);

// A RETIRED model needs only one report: gone is gone everywhere, and waiting for a second
// provider to confirm it just spends another turn finding out.
resetHealth();
markUnhealthy('groq', { status: 410, message: 'end of life' }, 'llama-3.1-8b-instant');
assert.equal(healthOf('elsewhere', 'llama-3.1-8b-instant').available, false);

// A different model at the same provider is untouched — the evidence is about the model.
assert.equal(healthOf('groq2', 'llama-3.3-70b').available, true);

console.log('✓ model health: behaviour beats configuration, and a model failing everywhere is learned once');
