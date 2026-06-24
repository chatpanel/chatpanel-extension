import assert from 'node:assert/strict';

const { formatBytes, localStorageHealth } = await import('../extension/js/storage-health.js');

assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(999), '999 B');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(2_621_440), '2.5 MB');

const health = await localStorageHealth({
  storage: {
    async getBytesInUse(key) {
      assert.equal(key, null);
      return 2_621_440;
    },
  },
  getMeetingIndex: async () => [{ id: 'm1' }, { id: 'm2' }],
});

assert.deepEqual(health, {
  bytes: 2_621_440,
  bytesLabel: '2.5 MB',
  meetings: 2,
});

const fallback = await localStorageHealth({
  storage: {},
  getMeetingIndex: async () => [],
});
assert.deepEqual(fallback, {
  bytes: 0,
  bytesLabel: '0 B',
  meetings: 0,
});

console.log('storage health tests passed');
