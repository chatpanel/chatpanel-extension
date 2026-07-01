// WARM query: RRF fusion + gateway search fail-safety.
import assert from 'node:assert/strict';
import { fuseRRF, fuseHistoryResults, searchGateway } from '../extension/js/warm-query.js';

// 1) RRF rewards ids ranked highly across lists; k dampens single-list dominance.
{
  const fused = fuseRRF([['a', 'b', 'c'], ['b', 'a', 'd']], { k: 60 });
  const order = fused.map((x) => x.id);
  assert.deepEqual(order.slice(0, 2).sort(), ['a', 'b'], 'a & b lead (in both lists)');
  assert.ok(order.includes('c') && order.includes('d'), 'single-list ids still present');
  assert.ok(fused[0].score >= fused[fused.length - 1].score, 'sorted desc');
}

// 2) fuseHistoryResults fuses at SOURCE granularity, keeps hot chunk objects,
//    and reorders by the warm co-signal.
{
  const hot = [
    { sourceId: 'chat:1', chunk: 0, title: 'A', text: 'x' },
    { sourceId: 'chat:1', chunk: 1, title: 'A', text: 'y' },
    { sourceId: 'meeting:2', chunk: 0, title: 'B', text: 'z' },
  ];
  const warm = [{ id: 'meeting:2' }]; // warm strongly favors meeting:2 (chat:1 absent)
  const out = fuseHistoryResults(hot, warm, { limit: 8 });
  assert.equal(out[0].sourceId, 'meeting:2', 'warm co-signal lifts meeting:2 to the top');
  // both chunks of chat:1 survive, grouped
  assert.equal(out.filter((r) => r.sourceId === 'chat:1').length, 2);
  assert.ok(Number.isFinite(out[0].score), 'carries a fused score');
}

// 3) No warm hits → hot passes through unchanged (capped).
{
  const hot = [{ sourceId: 'a', chunk: 0 }, { sourceId: 'b', chunk: 0 }];
  assert.deepEqual(fuseHistoryResults(hot, [], { limit: 8 }), hot);
}

// 4) searchGateway fails safe → [] on error, no URL, empty query.
{
  assert.deepEqual(await searchGateway('', 'q', { fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) }), []);
  assert.deepEqual(await searchGateway('http://gw', '', {}), []);
  assert.deepEqual(await searchGateway('http://gw', 'q', { fetchImpl: async () => { throw new Error('down'); } }), []);
  assert.deepEqual(await searchGateway('http://gw', 'q', { fetchImpl: async () => ({ ok: false }) }), []);
  const ok = await searchGateway('http://gw', 'q', { fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ id: 'chat:1', score: 2 }] }) }) });
  assert.deepEqual(ok, [{ id: 'chat:1', score: 2 }]);
}

console.log('warm-query tests passed');
