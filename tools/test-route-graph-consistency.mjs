// THE PICTURE MUST NOT CONTRADICT ITSELF.
//
// `routeWith` replaced `model` with the strategy's pick but left `eligible` as the base score
// ranking, so the two disagreed the moment any strategy fired: the drawn list put Claude Code
// first while the chosen model was Codex, sitting third. Everything downstream reads
// `eligible` as "the order this decision put them in" — the graph ranks nodes by it,
// runnersUp slices it — so a stale ordering is the picture lying to the person using it to
// debug the router.
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } };

const { routeForTurn } = await import('../extension/js/model-router.js');

const cfg = {
  agents: [
    { id: 'cc', name: 'Claude Code', kind: 'bridge', model: 'opus' },
    { id: 'cx', name: 'Codex', kind: 'bridge', model: 'gpt-5.6-sol' },
    { id: 'oc', name: 'OpenCode', kind: 'bridge', model: 'openai/gpt-5.5' },
  ],
  endpoints: [{ id: 'hf', name: 'HuggingFace', baseUrl: 'https://huggingface.co/v1', model: 'deepseek-ai/DeepSeek-V4-Flash' }],
  ui: { routing: { models: {
    cc: { providerRank: 1, reach: 'any', costPer1k: 5 },
    cx: { providerRank: 2, costPer1k: 2 },
    oc: { providerRank: 10, costPer1k: 2 },
    hf: { quality: 0.9, costPer1k: 1 },
  } } },
};
// Long enough, and with a fence, to read as genuinely hard — so a STRATEGY decides rather
// than the score. That is the only case where the two orderings could disagree.
const hard = 'refactor this\n```js\nfunction f(){ return 1 }\n```\nand migrate every caller step by step, then analyse what breaks across the codebase';

const routed = await routeForTurn(cfg, undefined, { force: true, capabilities: ['tools'], request: { messages: [{ content: hard }] } });
assert.equal(routed.decision.strategy, 'escalate-on-complexity', 'fixture assumption: a strategy decides this turn');

// The one invariant every consumer assumes.
assert.equal(routed.decision.eligible[0].id, routed.decision.model.id,
  'the ranked list does not start with the model that was actually chosen');

// And the drawn graph agrees with itself: rank 0, the chosen flag, and the chain head are
// all the same model.
const g = routed.graph;
assert.equal(g.nodes[0].id, g.chosen, 'the list is headed by a model that did not win');
assert.equal(g.nodes[0].chosen, true);
assert.equal(g.nodes.find((n) => n.chosen).rank, 0, 'the chosen model is buried in the ranking');
assert.equal(g.chain[0].id, g.chosen, 'the failover chain starts somewhere other than the chosen model');

// Nothing was dropped by the reordering — a strategy narrows and reorders, it does not delete.
assert.equal(routed.decision.eligible.length, 4, 'candidates vanished when the strategy reordered them');
assert.equal(routed.decision.runnersUp.length, 3);

console.log('✓ route graph: the list, the chosen flag and the chain all name the same model');
