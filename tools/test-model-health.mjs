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

// A BROKEN CONNECTION IS THIS PROVIDER'S, NOT THE REQUEST'S.
//
// These used to return null, which makes the turn DIE instead of failing over. An expired
// refresh token is the clearest counter-example: "OAuth token exchange failed: HTTP 400 —
// invalid_grant" says this provider's credentials went stale, and every other model would
// have answered the question fine. A user watched a turn stop dead on exactly that.
assert.equal(classifyFailure({ status: 401 }), 'auth');
assert.equal(classifyFailure({ status: 403 }), 'auth');
assert.equal(
  classifyFailure(new Error('OAuth token exchange failed: HTTP 400 — {"error":"invalid_grant","error_description":"Invalid refresh_token"}')),
  'auth',
  'an expired refresh token ended the turn instead of moving to the next model',
);
// Stood down for HOURS, because unlike a rate limit this does not heal on its own — someone
// has to reconnect the account. That is what stops the chain walking back into it every turn.
markUnhealthy('stale', { status: 401 });
assert.equal(healthOf('stale').available, false);
assert.ok(healthOf('stale').until - Date.now() > 60 * 60_000);

// A plain 400 usually IS a malformed request — but providers reject each other's parameters,
// tool schemas and sampling settings all the time, so the same call one refuses another
// accepts. Failing over costs one attempt; dead-ending costs the user their turn.
assert.equal(classifyFailure({ status: 400 }), 'request');
assert.equal(classifyFailure(new Error('HTTP 400 — unsupported parameter: temperature')), 'request');

// NOTHING ENDS IN LIMBO. Whatever went wrong, there is always a next model to try; the
// terminal error still names the failure once everything has been tried.
for (const st of [400, 401, 403, 404, 410, 422, 429, 500]) {
  assert.ok(classifyFailure({ status: st }), `status ${st} dead-ends the turn`);
}

// EVERYTHING ELSE GETS TRIED ELSEWHERE. A router that gives up on an unrecognised failure is
// a router that gives up — the user asked for the next option, not for a verdict on whose
// fault it was.
assert.equal(classifyFailure({ status: 404, message: 'Not Found' }), 'unknown');
assert.equal(classifyFailure({ status: 422, message: 'Unprocessable' }), 'unknown');
assert.equal(classifyFailure(new Error('socket hang up')), 'unknown');
// A model with no id cannot be recorded against anything — that is the only case left where
// there is nothing to stand down.
assert.equal(markUnhealthy('', { status: 500 }), null);

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

// ── A FAILURE MOVES TO THE NEXT MODEL, IT DOES NOT LEAVE THE TURN IN LIMBO ───
//
// The end-to-end shape of the bug: a provider's refresh token went stale, the failure was
// read as "our request is wrong, every model would refuse it", and the turn stopped dead
// with an OAuth error instead of asking the next model on the chain. Every other model was
// healthy and would have answered.
{
  const { candidatesFrom, routeForTurn } = await import('../extension/js/model-router.js');
  resetHealth();

  const cfg = {
    endpoints: [
      { id: 'stale', name: 'HuggingFace', baseUrl: 'https://huggingface.co/v1', model: 'deepseek-ai/DeepSeek-V4-Flash' },
      { id: 'other', name: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-v4-flash' },
    ],
    agents: [],
  };

  // Healthy to begin with: both are candidates.
  assert.equal(candidatesFrom(cfg).every((m) => m.available), true);

  // The exact error the user saw.
  const err = new Error('OAuth token exchange failed: HTTP 400 — {"error":"invalid_grant","error_description":"Invalid refresh_token"}');
  const marked = markUnhealthy('stale', err, 'deepseek-ai/DeepSeek-V4-Flash');
  assert.ok(marked, 'the turn had nothing to fail over WITH — this is what ended it');
  assert.equal(marked.reason, 'auth');

  // The broken provider drops out of the candidate set…
  const after = Object.fromEntries(candidatesFrom(cfg).map((m) => [m.id, m.available]));
  assert.equal(after.stale, false, 'a provider with stale credentials stayed selectable');

  // …and a re-route lands on a working one rather than throwing.
  const next = await routeForTurn(cfg, undefined, {
    force: true, exclude: ['stale'],
    request: { messages: [{ content: 'what did they do here' }] },
    like: { model: 'deepseek-ai/DeepSeek-V4-Flash', quality: 0.9, capabilities: [], classUsed: 'C', reason: 'auth' },
  });
  assert.ok(next?.target, 'the turn had nowhere to go after a credentials failure');
  assert.equal(next.decision.model.id, 'other');
  resetHealth();
}

console.log('✓ model health: a broken connection fails over and stands the provider down');

// ── a refused connection is a provider that is DOWN ──────────────────────────
// "Failed to fetch" has no status, so it fell to 'unknown': thirty seconds, and still
// available. Auto re-picked the dead local model after half a minute, every time.
{
  const { classifyFailure, markUnhealthy, healthOf, resetHealth } = await import('../extension/js/model-health.js');
  resetHealth();
  assert.equal(classifyFailure(new TypeError('Failed to fetch')), 'unreachable');
  assert.equal(classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:8080')), 'unreachable');
  assert.equal(classifyFailure(new Error('net::ERR_CONNECTION_REFUSED')), 'unreachable');
  assert.equal(classifyFailure(new TypeError('Load failed')), 'unreachable', 'Safari\'s spelling');
  markUnhealthy('dead-local', new TypeError('Failed to fetch'));
  const h = healthOf('dead-local');
  assert.equal(h.available, false, 'a model nobody is listening on is NOT available');
  assert.ok(h.until - Date.now() > 60_000, 'and stays down for minutes, not seconds — it needs a human to start it');
  resetHealth();
}

// ── shared across pages within the session ───────────────────────────────────
// This lived in per-page module memory. The side panel learned a local model was refusing
// connections; briefs.html — a separate page, a separate module instance — started every
// synthesis believing it was fine, dialled it, and only then fell over. Auto consults health
// at route time, so the router was fine; it was being asked by a page that knew nothing.
{
  const store = new Map();
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = globalThis.chrome.storage || {};
  globalThis.chrome.storage.session = {
    async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
    async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); },
  };
  // "Page A" marks a model unhealthy…
  const a = await import('../extension/js/model-health.js?ctx=a');
  a.resetHealth();
  // The shape a browser actually throws for a dead endpoint — no status, no code, just this.
  a.markUnhealthy('ep-local-8080', new TypeError('Failed to fetch'), 'local-llm');
  assert.equal(a.healthOf('ep-local-8080').available, false, 'page A knows');
  assert.ok(store.get('chatpanel:modelHealth')?.health?.length, 'and wrote it to session storage');

  // …and "page B", a fresh module instance, knows it too after hydrating.
  const b = await import('../extension/js/model-health.js?ctx=b');
  await b.healthReady();
  assert.equal(b.healthOf('ep-local-8080').available, false,
    'a fresh page must inherit what the session already learned — otherwise Auto re-dials the dead model on every dashboard');

  // Recovery propagates the same way, so a model that came back is not sidelined elsewhere.
  a.markHealthy('ep-local-8080');
  const c = await import('../extension/js/model-health.js?ctx=c');
  await c.healthReady();
  assert.equal(c.healthOf('ep-local-8080').available, true);

  // No session area (an old runtime, a test): degrades to per-page memory, never throws.
  delete globalThis.chrome.storage.session;
  const d = await import('../extension/js/model-health.js?ctx=d');
  assert.equal(await d.hydrateHealth(), false);
  d.markUnhealthy('x', new Error('boom'));
  console.log('model-health: session-shared ok');
}
