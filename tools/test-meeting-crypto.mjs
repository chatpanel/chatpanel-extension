import assert from 'node:assert/strict';

const storage = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map((k) => [k, storage.get(k)]).filter(([, v]) => v !== undefined));
        }
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return {};
      },
      async set(values) {
        Object.entries(values).forEach(([key, value]) => storage.set(key, value));
      },
    },
  },
};

const { encryptJSON, decryptJSON, isEncrypted } = await import('../extension/js/meeting-crypto.js');

const largeMeeting = {
  id: 'mtg_large',
  title: 'Large encrypted meeting',
  segments: Array.from({ length: 1600 }, (_, i) => ({
    ts: i * 3,
    speaker: i % 2 ? 'Alex' : 'Priya',
    text: `Architecture discussion ${i}: ${'context '.repeat(24)}`,
  })),
};

const encrypted = await encryptJSON(largeMeeting);

assert.equal(isEncrypted(encrypted), true, 'Large meeting records should stay encrypted instead of falling back to plaintext.');
assert.equal(typeof encrypted.ct, 'string', 'Encrypted meeting should contain base64 ciphertext.');
assert.ok(encrypted.ct.length > 250000, 'Regression fixture should exercise a large ciphertext payload.');

const decrypted = await decryptJSON(encrypted);
assert.deepEqual(decrypted, largeMeeting, 'Large encrypted meeting should decrypt back to the original JSON.');

console.log('meeting crypto tests passed');
