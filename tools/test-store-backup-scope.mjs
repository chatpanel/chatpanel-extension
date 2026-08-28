import assert from 'node:assert/strict';

const storage = new Map();
const pageStorage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, storage.get(k)]).filter(([, value]) => value !== undefined));
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return Object.fromEntries(storage);
      },
      async set(values) { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => storage.delete(key)); },
    },
  },
};
globalThis.localStorage = {
  get length() { return pageStorage.size; },
  key(index) { return [...pageStorage.keys()][index] ?? null; },
  getItem(key) { return pageStorage.has(key) ? pageStorage.get(key) : null; },
  setItem(key, value) { pageStorage.set(String(key), String(value)); },
  removeItem(key) { pageStorage.delete(String(key)); },
};

const { importAllData, getSettings } = await import('../extension/js/store.js');
const { exportOAuthTokens } = await import('../extension/js/oauth.js');
const backup = {
  type: 'chatpanel-backup',
  version: 6,
  conversations: [],
  meetings: [],
  notes: [],
  notesConfig: { 'chatpanel.notes.gear': 'restored-gear' },
  settings: { activeAgentId: 'restored-agent' },
  oauthTokens: { endpoint1: { access_token: 'restored-access-token', token_type: 'Bearer' } },
};

await importAllData(backup, { includeSettings: false, includeOAuthTokens: false });
assert.equal(storage.has('chatpanel:settings'), false, 'history-only restore must not import settings');
assert.equal(storage.has('chatpanel:oauthTokens'), false, 'history-only restore must not import OAuth tokens');
assert.equal(localStorage.getItem('chatpanel.notes.gear'), null, 'history-only restore must not import machine-local Notes configuration');

await importAllData(backup);
assert.equal((await getSettings()).activeAgentId, 'restored-agent', 'manual restore should remain a full portable restore by default');
assert.equal((await exportOAuthTokens()).endpoint1.access_token, 'restored-access-token', 'manual restore should keep importing OAuth tokens by default');
assert.equal(localStorage.getItem('chatpanel.notes.gear'), 'restored-gear', 'manual restore should keep importing Notes configuration by default');

console.log('store backup scope tests passed');
