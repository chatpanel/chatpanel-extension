import assert from 'node:assert/strict';
import { createFallbackChain } from '../extension/js/model-fallback.js';

const chain = (now) => createFallbackChain({ key: (c) => c.id, now });

// The reported bug: one dead model ended the feature. 60 failed turns in a 90-minute
// session, while a working endpoint and a configured CLI agent were never reached.
{
  const tried = [];
  const c = chain(() => 0);
  const res = await c.run(
    [{ id: 'dead-local' }, { id: 'remote' }, { id: 'cli' }],
    async (x) => { tried.push(x.id); if (x.id === 'dead-local') throw new Error('ECONNREFUSED'); return 'ghost text'; },
  );
  assert.deepEqual(tried, ['dead-local', 'remote'], 'the chain stopped at the first failure');
  assert.equal(res.result, 'ghost text');
  assert.equal(res.candidate.id, 'remote');
}

// A failure is remembered, so a stopped local model is not re-dialled on every keystroke.
{
  const tried = [];
  let t = 0;
  const c = chain(() => t);
  const run = () => c.run([{ id: 'dead' }, { id: 'good' }], async (x) => {
    tried.push(x.id); if (x.id === 'dead') throw new Error('nope'); return 'ok';
  });
  await run(); await run(); await run();
  assert.deepEqual(tried, ['dead', 'good', 'good', 'good'], 'the dead candidate was retried every time');

  // ...and forgotten after the cooldown, so starting the model makes it work again with
  // no reload.
  t = 61_000;
  await run();
  assert.deepEqual(tried.slice(-2), ['dead', 'good']);
}

// If EVERY candidate is cooling off, they are tried anyway — last, but tried. A stale memo
// must never be the reason a working model goes unused.
{
  let t = 0;
  const c = chain(() => t);
  await c.run([{ id: 'a' }, { id: 'b' }], async () => { throw new Error('down'); });
  const tried = [];
  const res = await c.run([{ id: 'a' }, { id: 'b' }], async (x) => { tried.push(x.id); return 'back up'; });
  assert.deepEqual(tried, ['a'], 'a fully-cold chain refused to try anything');
  assert.equal(res.result, 'back up');
}

// An empty answer is not a failure: the model replied, it just had nothing to add.
// Marking it failed would take a healthy model out of rotation.
{
  const c = chain(() => 0);
  await c.run([{ id: 'quiet' }], async () => '');
  assert.equal(c.isCold({ id: 'quiet' }), true, 'a model that answered emptily was penalised');
}

// Success clears an earlier failure, so a flaky model recovers immediately.
{
  let t = 0; let fail = true;
  const c = chain(() => t);
  await c.run([{ id: 'flaky' }], async () => { if (fail) throw new Error('x'); return 'ok'; });
  assert.equal(c.isCold({ id: 'flaky' }), false);
  fail = false;
  await c.run([{ id: 'flaky' }], async () => 'ok');
  assert.equal(c.isCold({ id: 'flaky' }), true, 'a recovered model stayed marked as failed');
}

// Nothing configured is still nothing.
assert.deepEqual((await chain(() => 0).run([], async () => 'x')).ok, false);

console.log('✓ model fallback: continues past failures, remembers them briefly, never gets stuck');
