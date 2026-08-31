// WARM-tier sync: pushes local sources as archive-preserving upserts and fails safe.
// Uses injected loadSources + fetch so it is hermetic.
import assert from 'node:assert/strict';
import { syncHistoryToGateway, resetWarmSyncBaseline, chunkHistoryUpserts } from '../extension/js/warm-sync.js';

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

// 2) Next sync with one browser source gone preserves the gateway archive.
{
  const sources = [{ id: 'chat:1', type: 'chat', title: 'Roadmap', text: 'privacy gateway roadmap v2' }];
  const cap = {};
  const r = await syncHistoryToGateway(GW, { loadSources: async () => sources, fetchImpl: mockFetch(cap) });
  assert.equal(r.sent, 1);
  assert.equal(r.removed, 0, 'missing browser records are not tombstoned');
  assert.deepEqual(cap.body.removes, []);
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

// 4) A gateway error fails safe (ok:false).
{
  resetWarmSyncBaseline();
  await syncHistoryToGateway(GW, {
    loadSources: async () => [{ id: 'chat:1', text: 'hi' }],
    fetchImpl: mockFetch({}),
  });
  const failRes = await syncHistoryToGateway(GW, {
    loadSources: async () => [{ id: 'chat:2', text: 'yo' }],
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(failRes.ok, false);
  const cap = {};
  await syncHistoryToGateway(GW, { loadSources: async () => [{ id: 'chat:2', text: 'yo' }], fetchImpl: mockFetch(cap) });
  assert.deepEqual(cap.body.removes, [], 'archive-preserving sync never deletes records');
}

assert.ok(chunkHistoryUpserts(Array.from({ length: 6 }, (_, i) => ({ id: String(i), text: 'x'.repeat(80) })), 220).length > 1, 'large corpora are chunked');

// 5) No gateway URL / no fetch → skipped, never throws.
{
  assert.equal((await syncHistoryToGateway('', {})).skipped, true);
  assert.equal((await syncHistoryToGateway(GW, { fetchImpl: null })).skipped, true);
}

// 6) INCREMENTAL with a watermark: only changed/new go up; vanished ones come out.
function memStorage(init = {}) {
  const m = { ...init };
  return { async get(k) { return m[k] || {}; }, async set(k, v) { m[k] = v; } };
}
{
  const store = memStorage();
  const v1 = [
    { id: 'chat:1', type: 'chat', title: 'A', text: 'hello' },
    { id: 'meeting:2', type: 'meeting', title: 'B', text: 'world' },
  ];
  let cap = {};
  let r = await syncHistoryToGateway(GW, { loadSources: async () => v1, fetchImpl: mockFetch(cap), storage: store });
  assert.equal(r.sent, 2, 'first sync seeds the watermark with everything');

  // chat:1 changes, meeting:2 unchanged, note:3 is new → only the two deltas go up.
  const v2 = [
    { id: 'chat:1', type: 'chat', title: 'A', text: 'hello there' },
    { id: 'meeting:2', type: 'meeting', title: 'B', text: 'world' },
    { id: 'note:3', type: 'note', title: 'C', text: 'fresh' },
  ];
  cap = {};
  r = await syncHistoryToGateway(GW, { loadSources: async () => v2, fetchImpl: mockFetch(cap), storage: store });
  assert.equal(r.sent, 2, 'only changed + new are pushed (not the whole corpus)');
  assert.deepEqual(cap.body.upserts.map((u) => u.id).sort(), ['chat:1', 'note:3']);
  assert.deepEqual(cap.body.removes, []);

  // meeting:2 deleted in the browser → propagated as a remove (hot==warm).
  const v3 = [
    { id: 'chat:1', type: 'chat', title: 'A', text: 'hello there' },
    { id: 'note:3', type: 'note', title: 'C', text: 'fresh' },
  ];
  cap = {};
  r = await syncHistoryToGateway(GW, { loadSources: async () => v3, fetchImpl: mockFetch(cap), storage: store });
  assert.equal(r.removed, 1, 'the deleted record is removed from warm');
  assert.equal(r.sent, 0, 'delete-only sync sends no upserts');
  assert.deepEqual(cap.body.removes, ['meeting:2']);

  // Nothing changed → a true no-op, no request at all.
  cap = {};
  r = await syncHistoryToGateway(GW, { loadSources: async () => v3, fetchImpl: mockFetch(cap), storage: store });
  assert.equal(r.unchanged, true);
  assert.equal(cap.url, undefined, 'no request when nothing changed');

  // force re-pushes everything regardless of the watermark.
  cap = {};
  r = await syncHistoryToGateway(GW, { loadSources: async () => v3, fetchImpl: mockFetch(cap), storage: store, force: true });
  assert.equal(r.sent, 2, 'force ignores the watermark and re-pushes all');
}

console.log('warm-sync tests passed');
