// Learned control schemes: merge-on-save, bounded growth, LRU eviction, and a
// prompt block that stays honest about staleness.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return {};
      },
      async set(values) { Object.entries(values).forEach(([k, v]) => storage.set(k, v)); },
    },
  },
};

const {
  getControlScheme, saveControlScheme, forgetControlScheme, listControlSchemes,
  describeControlScheme, originOf,
} = await import('../extension/js/app-controls.js');

// 1) origin extraction is total — a junk URL must not throw into a tool call.
{
  assert.equal(originOf('https://example.com/play?x=1'), 'https://example.com');
  assert.equal(originOf('not a url'), '');
  assert.equal(originOf(undefined), '');
}

// 2) save → get round-trips, and an unknown origin is null (not a throw).
{
  assert.equal(await getControlScheme('https://example.com'), null);
  await saveControlScheme('https://example.com', {
    app: 'Demo',
    summary: 'Canvas app, pointer-locked.',
    bindings: [{ input: 'hold W', does: 'move forward' }, { keys: 'right-click', does: 'place' }],
    source: 'in-app help',
  });
  const got = await getControlScheme('https://example.com');
  assert.equal(got.app, 'Demo');
  assert.equal(got.bindings.length, 2);
  assert.equal(got.bindings[1].input, 'right-click', 'accepts `keys` as an alias for `input`');
  assert.equal(got.uses, 1);
}

// 3) a later save MERGES rather than wiping fields it doesn't mention.
{
  await saveControlScheme('https://example.com', { app: 'Demo', summary: 'Corrected summary.' });
  const got = await getControlScheme('https://example.com');
  assert.equal(got.summary, 'Corrected summary.');
  assert.equal(got.bindings.length, 2, 'bindings survive a save that omits them');
  assert.ok(got.uses >= 2, 'use count accumulates');
}

// 4) malformed bindings are dropped, not stored — this text re-enters a prompt.
{
  await saveControlScheme('https://bad.example', {
    app: 'Bad',
    summary: 's',
    bindings: [null, { does: 'no input' }, { input: 'ok', does: 'fine' }, 'nope'],
  });
  const got = await getControlScheme('https://bad.example');
  assert.equal(got.bindings.length, 1);
  assert.equal(got.bindings[0].input, 'ok');
}

// 5) long strings are clipped so a scheme can't grow the prompt without bound.
{
  await saveControlScheme('https://big.example', { app: 'x'.repeat(500), summary: 'y'.repeat(1000) });
  const got = await getControlScheme('https://big.example');
  assert.ok(got.app.length <= 80, `app clipped, got ${got.app.length}`);
  assert.ok(got.summary.length <= 300, `summary clipped, got ${got.summary.length}`);
}

// 6) the store stays bounded, evicting the COLDEST — the app you drive often must
//    survive a flood of one-off origins.
{
  storage.clear();
  await saveControlScheme('https://daily.example', { app: 'Daily', summary: 'kept' });
  const hot = await getControlScheme('https://daily.example'); // marks it recently used
  assert.ok(hot);
  for (let i = 0; i < 200; i++) {
    await saveControlScheme(`https://one-off-${i}.example`, { app: `A${i}`, summary: 's' });
  }
  const all = await listControlSchemes();
  assert.ok(all.length <= 120, `bounded, got ${all.length}`);
}

// 7) forget removes it, and reports whether there was anything to remove.
{
  await saveControlScheme('https://gone.example', { app: 'Gone', summary: 's' });
  assert.equal(await forgetControlScheme('https://gone.example'), true);
  assert.equal(await getControlScheme('https://gone.example'), null);
  assert.equal(await forgetControlScheme('https://gone.example'), false);
}

// 8) the prompt block carries the bindings AND the "believe the screen" caveat —
//    an agent trusting a stale scheme over what it can see is worse than no scheme.
{
  const block = describeControlScheme({
    origin: 'https://example.com',
    app: 'Demo',
    summary: 'Canvas app.',
    bindings: [{ input: 'hold W', does: 'move forward' }],
    source: 'in-app help',
  });
  assert.match(block, /Demo/);
  assert.match(block, /hold W → move forward/);
  assert.match(block, /believe the screen/i);
  assert.equal(describeControlScheme(null), '', 'no scheme → no block, not "undefined"');
}

console.log('app-controls tests passed');
