// The gateway must arrive knowing about the models you already configured.
//
// Destinations lived only in the gateway's own config, a fresh gateway has none, and nothing
// ever seeded them — so "Test a prompt through the gateway" showed an empty model picker and
// Routing showed a page of unticked boxes. Reported, accurately, as "the gateway doesn't see
// all my models and agents". The models were configured; the gateway had never been told it
// could use them.
//
// The destinations ARE the user's configured APIs and agents. There is no second list to
// curate, so "all of them" is the honest default and the checkboxes exist to take some away.
import assert from 'node:assert/strict';

const { seedDestinations, shouldSeedDestinations } = await import('../extension/js/gateway-dests.js');

const dests = [
  { id: 'my-api', type: 'api' },
  { id: 'openrouter', type: 'api' },
  { id: 'codex', type: 'agent' },
];

// ── Pro: everything the user configured, on ──────────────────────────────────────
assert.deepEqual(
  seedDestinations(dests, { pro: true }).map((d) => d.id),
  ['my-api', 'openrouter', 'codex'],
  'Pro routes to all of them — an empty list is not a choice the user made',
);

// ── Free: exactly the cap, and it is the model they actually chat with ───────────
{
  const seeded = seedDestinations(dests, { pro: false, cap: 1, preferId: 'codex' });
  assert.equal(seeded.length, 1, 'Free routes to one — showing more ticks than the gateway honours is worse');
  assert.equal(seeded[0].id, 'codex', 'and the one should be the active model, not whichever is first');
}
// No preference, or a stale one: fall back to the first rather than to nothing.
assert.equal(seedDestinations(dests, { pro: false, cap: 1 })[0].id, 'my-api');
assert.equal(seedDestinations(dests, { pro: false, cap: 1, preferId: 'deleted' })[0].id, 'my-api');
// A cap above one still respects the preference and still stops at the cap.
{
  const two = seedDestinations(dests, { pro: false, cap: 2, preferId: 'codex' });
  assert.equal(two.length, 2);
  assert.equal(two[0].id, 'codex');
}

// ── nothing configured is nothing to seed ────────────────────────────────────────
assert.deepEqual(seedDestinations([], { pro: true }), []);
assert.deepEqual(seedDestinations(undefined, { pro: true }), []);
assert.deepEqual(seedDestinations([null, undefined], { pro: true }), []);

// ── seeded ONCE. A control that undoes itself is worse than no control. ──────────
assert.equal(
  shouldSeedDestinations({ current: [], seeded: false, available: dests }), true,
  'a gateway that has never been configured must be given the models the user has',
);
assert.equal(
  shouldSeedDestinations({ current: [], seeded: true, available: dests }), false,
  'a user who deliberately turned every destination OFF must find them still off',
);
assert.equal(
  shouldSeedDestinations({ current: [dests[0]], seeded: false, available: dests }), false,
  'a real choice must never be overwritten',
);
assert.equal(
  shouldSeedDestinations({ current: [], seeded: false, available: [] }), false,
  'nothing to seed from is not a seeding opportunity',
);
assert.equal(shouldSeedDestinations({}), false, 'must not throw on an empty call');

// ── and the page must actually do it, once, at the right moment ──────────────────
const { readFileSync } = await import('node:fs');
const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
assert.match(js, /maybeSeedDestinations\(\);/, 'fillGatewayForm must seed after loading the config');
assert.match(js, /gatewayDestsSeeded/, 'the once-only flag must be persisted');
assert.match(
  js, /preferId: settings\.activeAgentId/,
  "Free's single destination should be the model the user actually chats with",
);
assert.match(js, /cap: FREE_LIMITS\.gatewayDestinations/, 'the Free cap must come from the licence, not a literal');

console.log('gateway destinations: ok');
