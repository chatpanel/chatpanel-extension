// Lifetime usage counters: seed-on-first-read, monotonic increment, no reset path.
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

const { usageCount, bumpUsage } = await import('../extension/js/usage-counters.js');

// 1) first read of an unseeded counter with no seed → 0, and it persists.
{
  assert.equal(await usageCount('a'), 0);
  assert.equal(storage.get('chatpanel:usage').a, 0);
}

// 2) first read seeds from the live count; later reads ignore the seed.
{
  assert.equal(await usageCount('b', 5), 5, 'seeded from existing content');
  assert.equal(await usageCount('b', 100), 5, 'seed ignored once seeded');
}

// 3) bump increments and returns the new value; monotonic.
{
  assert.equal(await bumpUsage('b'), 6);
  assert.equal(await bumpUsage('b'), 7);
  assert.equal(await usageCount('b'), 7);
}

// 4) bump seeds a never-seen counter from its seed, then adds one.
{
  assert.equal(await bumpUsage('c', 3), 4, 'seed 3 then +1');
  assert.equal(await usageCount('c'), 4);
}

// 5) counters are independent and share one storage object.
{
  const obj = storage.get('chatpanel:usage');
  assert.deepEqual(obj, { a: 0, b: 7, c: 4 });
}

// 6) a corrupt / non-object value is treated as empty (no throw).
{
  storage.set('chatpanel:usage', 'garbage');
  assert.equal(await usageCount('d', 2), 2);
}

console.log('usage-counters tests passed');
