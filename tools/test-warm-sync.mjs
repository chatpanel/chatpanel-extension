// WARM-tier sync: pushes local sources to the gateway as upserts, tombstones deletes,
// and fails safe. Uses injected loadSources + fetch so it's hermetic.
import assert from 'node:assert/strict';
import { syncHistoryToGateway, resetWarmSyncBaseline } from '../extension/js/warm-sync.js';

const GW = 'http://127.0.0.1:4320';

function mockFetch(captured) {
  return async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    return { ok: true, status: 200, async json() { return { ok: true, size: captured.body.upserts.length }; } };
  };
}

resetWarmSyncBaseline();

// 1) First sync sends every source as an upsert (no removes yet).
{
  const sources = [
    { id: 'chat:1', type: 'chat', title: 'Roadmap', text: 'privacy gateway roadmap' },
    { id: 'meeting:2', type: 'meeting', title: 'Sync', text: 'budget review notes' },
  ];
  const cap = {};
  const r = await syncHistoryToGateway(GW, { loadSources: async () => sources, fetchImpl: mockFetch(cap) });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 2);
  assert.equal(r.removed, 0);
  assert.match(cap.url, /\/v1\/history\/ingest$/);
  assert.deepEqual(cap.body.upserts.map((u) => u.id).sort(), ['chat:1', 'meeting:2']);
  assert.equal(cap.body.upserts[0].text.length > 0, true);
}

// 2) Next sync with one source gone → it's sent as a tombstone (remove).
{
  const sources = [{ id: 'chat:1', type: 'chat', title: 'Roadmap', text: 'privacy gateway roadmap v2' }];
  const cap = {};
  const r = await syncHistoryToGateway(GW, { loadSources: async () => sources, fetchImpl: mockFetch(cap) });
  assert.equal(r.sent, 1);
  assert.equal(r.removed, 1, 'the dropped meeting:2 is tombstoned');
  assert.deepEqual(cap.body.removes, ['meeting:2']);
}

// 3) Sources without text are skipped; empty payload is a no-op success.
{
  resetWarmSyncBaseline();
  const cap = {};
  const r = await syncHistoryToGateway(GW, { loadSources: async () => [{ id: 'chat:x' }], fetchImpl: mockFetch(cap) });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 0);
  assert.equal(cap.url, undefined, 'no request when nothing to send');
}

// 4) A gateway error fails safe (ok:false) and does NOT advance the tombstone baseline.
{
  resetWarmSyncBaseline();
  await syncHistoryToGateway(GW, {
    loadSources: async () => [{ id: 'chat:1', text: 'hi' }],
    fetchImpl: mockFetch({}),
  }); // baseline now { chat:1 }
  const failRes = await syncHistoryToGateway(GW, {
    loadSources: async () => [{ id: 'chat:2', text: 'yo' }],
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(failRes.ok, false);
  // Baseline unchanged → next good sync still knows chat:1 must be tombstoned.
  const cap = {};
  await syncHistoryToGateway(GW, { loadSources: async () => [{ id: 'chat:2', text: 'yo' }], fetchImpl: mockFetch(cap) });
  assert.ok(cap.body.removes.includes('chat:1'), 'failed sync did not lose the pending delete');
}

// 5) No gateway URL / no fetch → skipped, never throws.
{
  assert.equal((await syncHistoryToGateway('', {})).skipped, true);
  assert.equal((await syncHistoryToGateway(GW, { fetchImpl: null })).skipped, true);
}

console.log('warm-sync tests passed');
