// EVERY TIE IN THE ROUTER IS SETTLED BY THE ORDER YOU SET.
//
// Order was honoured in one place — the default score path — and ignored in every other,
// so it worked until the router had an opinion and then silently stopped existing. Each of
// the paths below is a separate decision point that can end in a tie, and each of them used
// to break it with something else: a cost guess, a latency estimate, or the alphabet.
//
// The rule throughout: order is a TIE-BREAK, never an override. The axis a decision exists to
// judge always wins first, and only an order the user PINNED counts — one we inferred from a
// URL stays below cost, where a guess belongs.
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } };

const { complexityStrategy, explicitModelStrategy, failoverStrategy, routeForTurn } =
  await import('../extension/js/model-router.js');
const { createModelRouter, defineModel, pinnedOrderOf } = await import('../extension/js/events/router.js');

const twin = (id, over = {}) => defineModel({
  id, label: id, model: 'twin-model', reach: 'any', classUsed: 'A',
  capabilities: ['tools', 'reasoning'], quality: 0.9, costPer1k: 2, latencyMs: 1050,
  providerRank: 1020, orderPinned: false, ...over,
});
const first = (out) => (Array.isArray(out) ? out[0] : out);

// 1 — the deterministic score, when nothing else has an opinion.
{
  const r = createModelRouter({ models: [twin('a'), twin('b', { providerRank: 1, orderPinned: true })] }).route({ prefer: 'latency' });
  assert.equal(r.model.id, 'b', 'a scored tie was broken by something other than the order');
}

// 2 — escalation, among models it rates equally.
{
  const ranked = await complexityStrategy.decide(
    [twin('a', { costPer1k: 1 }), twin('b', { costPer1k: 5, providerRank: 1, orderPinned: true })],
    { signals: { complexity: 'high' } },
  );
  assert.equal(ranked[0].id, 'b', 'escalation broke its own tie on cost instead of the order');
}

// 3 — an explicit "use <model>", when several routes carry that name.
{
  const picked = await explicitModelStrategy.decide(
    [twin('a', { costPer1k: 0 }), twin('b', { providerRank: 1, orderPinned: true })],
    { requestText: 'use twin-model' },
  );
  assert.equal(first(picked).id, 'b', 'the cheapest route to the named model won over the chosen one');
}

// 4 — failover, among equally close replacements.
{
  const ranked = await failoverStrategy.decide(
    [twin('a', { costPer1k: 1 }), twin('b', { costPer1k: 5, providerRank: 1, orderPinned: true })],
    { like: { model: 'gone-model', quality: 0.9, capabilities: [], classUsed: 'A', reason: 'server' } },
  );
  assert.equal(ranked[0].id, 'b', 'failover broke a tie between equal replacements on cost');
}

// 5 — the catch-all, when nothing has an opinion at all.
{
  const r = createModelRouter({ models: [twin('a'), twin('b', { providerRank: 1, orderPinned: true })] }).route({});
  assert.equal(r.model.id, 'b');
  assert.equal(r.strategy, 'declared-default');
}

// ── AND NEVER AS AN OVERRIDE ────────────────────────────────────────────────

// A real difference on the axis being judged still wins — between DIFFERENT models. (Two
// routes to the SAME model are the one case where a pinned order decides outright: only the
// path differs, and Order is exactly the "which path" preference. Asserted below.)
{
  const r = createModelRouter({
    models: [
      twin('fast', { model: 'alpha', latencyMs: 300 }),
      twin('slow', { model: 'beta', latencyMs: 4000, providerRank: 1, orderPinned: true }),
    ],
  }).route({ prefer: 'latency' });
  assert.equal(r.model.id, 'fast', 'the order outranked a real, large latency difference');

  const ranked = await complexityStrategy.decide(
    [twin('strong', { model: 'alpha', quality: 0.95 }), twin('weak', { model: 'beta', quality: 0.5, providerRank: 1, orderPinned: true })],
    { signals: { complexity: 'high' } },
  );
  assert.equal(ranked[0].id, 'strong', 'the order outranked a real quality difference');
}

// THE ONE PLACE ORDER DECIDES OUTRIGHT: two routes to the SAME model. Only the path differs
// — a different bill, a different quota — and Order is precisely the "which path" preference,
// so a guess at cost or latency has no business overruling it.
{
  const r = createModelRouter({
    models: [twin('viaAggregator', { latencyMs: 300 }), twin('direct', { latencyMs: 4000, providerRank: 1, orderPinned: true })],
  }).route({ prefer: 'latency' });
  assert.equal(r.model.id, 'direct', 'a chosen route to the same model lost to a latency guess');
}

// An order we merely INFERRED is a guess and stays below cost.
{
  const guessed = twin('guessed', { costPer1k: 8, providerRank: 1 });   // rank set, orderPinned NOT
  assert.equal(pinnedOrderOf(guessed), Infinity, 'an inferred rank was treated as a stated preference');
  const ranked = await complexityStrategy.decide([twin('cheap', { costPer1k: 1 }), guessed], { signals: { complexity: 'high' } });
  assert.equal(ranked[0].id, 'cheap', 'a guess at provider order outranked a real cost difference');
}

// Privacy is never a tie. A pinned cloud model cannot win a device-only turn.
{
  const local = defineModel({ id: 'local', reach: 'device', capabilities: ['tools'], quality: 0.4, costPer1k: 0, latencyMs: 1500 });
  const pinnedCloud = twin('cloud', { providerRank: 1, orderPinned: true });
  const r = createModelRouter({ models: [local, pinnedCloud] }).route({ reach: 'device' });
  assert.equal(r.model.id, 'local', 'a pinned order reached past a privacy ceiling');
}

// And elimination still eliminates: an unrated model stays out of work that needs a floor,
// however it is ordered. Ties are for the survivors.
{
  const cfg = {
    endpoints: [
      { id: 'unrated', name: 'Unrated', baseUrl: 'https://a/v1', model: 'some-new-thing' },
      { id: 'known', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' },
    ],
    ui: { routing: { models: { unrated: { providerRank: 1 } } } },
  };
  // Complex WITHOUT a code fence: a fence would also require the `coding` capability, which
  // neither model claims, and the router would then relax the whole requirement set — floor
  // included — which is a different behaviour than the one under test.
  const hard = 'plan the migration and analyse the fallout step by step across every caller, '
    + 'listing which call sites change behaviour rather than shape and which of them need a '
    + 'regression test written before the change lands, with the order they should be done in';
  const r = await routeForTurn(cfg, undefined, { force: true, request: { messages: [{ content: hard }] } });
  assert.equal(r.decision.model.id, 'known', 'an unrated model was promoted past a quality floor by its order');
  const node = r.graph.nodes.find((n) => n.id === 'unrated');
  assert.equal(node.eligible, false, 'an unrated model survived a quality floor');
  assert.match(node.why, /quality/);
}

console.log('✓ order settles every tie in the router — and overrides nothing');
