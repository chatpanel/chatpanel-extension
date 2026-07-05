// H4: secrets (endpoint API keys, MCP auth headers, OAuth tokens) are encrypted at
// rest in chrome.storage.local — sealed on disk, plaintext in memory and in the
// portable backup, with transparent migration of legacy plaintext.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- minimal chrome.storage.local (Map-backed) + WebCrypto globals -------------
// onChanged fires on set (like real Chrome) so store.js's cache-invalidation works
// and tests stay isolated.
const store = new Map();
const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store.get(k)]).filter(([, v]) => v !== undefined));
        if (typeof key === 'string') return store.has(key) ? { [key]: store.get(key) } : {};
        return {};
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: v }; store.set(k, v); }
        for (const fn of listeners) fn(changes, 'local');
      },
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
  },
  runtime: { id: 'testext', getURL: (p = '') => `chrome-extension://testext/${p}` },
};
const rawSettings = () => store.get('chatpanel:settings');
const rawOAuth = () => store.get('chatpanel:oauthTokens');

const { sealJSON, openJSON, isSealed } = await import('../extension/js/secret-crypto.js');
const { saveSettings, getSettings, defaultSettings } = await import('../extension/js/store.js');

test('secret-crypto: seal→open round-trips; empty passes through; envelope is opaque', async () => {
  const sealed = await sealJSON('sk-secret-123');
  assert.equal(isSealed(sealed), true);
  assert.doesNotMatch(JSON.stringify(sealed), /sk-secret-123/); // not readable on disk
  assert.equal(await openJSON(sealed), 'sk-secret-123');
  assert.equal(await sealJSON(''), '');                 // empty not sealed
  assert.equal(await openJSON('plain-legacy'), 'plain-legacy'); // legacy plaintext passes through
  assert.deepEqual(await openJSON(await sealJSON({ Authorization: 'Bearer x' })), { Authorization: 'Bearer x' });
});

test('store: endpoint apiKey + headers sealed on disk, plaintext from getSettings', async () => {
  store.clear();
  const s = defaultSettings();
  s.endpoints = [{ id: 'e1', kind: 'openai', baseUrl: 'https://api.x/v1', apiKey: 'sk-live-abc', headers: { Authorization: 'Bearer tok' } }];
  await saveSettings(s);

  // on disk: the secret fields are envelopes, NOT the raw values
  const disk = rawSettings().endpoints[0];
  assert.equal(isSealed(disk.apiKey), true, 'apiKey sealed on disk');
  assert.equal(isSealed(disk.headers), true, 'headers sealed on disk');
  assert.doesNotMatch(JSON.stringify(rawSettings()), /sk-live-abc|Bearer tok/, 'no plaintext secret on disk');

  // in memory (fresh read, cache-independent): plaintext restored
  const back = await getSettings();
  assert.equal(back.endpoints[0].apiKey, 'sk-live-abc');
  assert.deepEqual(back.endpoints[0].headers, { Authorization: 'Bearer tok' });
});

test('store: legacy plaintext apiKey on disk still loads (transparent migration)', async () => {
  store.clear();
  const base = defaultSettings();
  base.endpoints = [{ id: 'e1', kind: 'openai', apiKey: 'sk-legacy-plain', baseUrl: 'https://api.x/v1' }];
  await chrome.storage.local.set({ 'chatpanel:settings': base }); // pre-encryption install (fires onChanged → clears cache)
  const back = await getSettings();
  assert.equal(back.endpoints[0].apiKey, 'sk-legacy-plain'); // read tolerates plaintext
});

test('oauth: token entries sealed on disk, plaintext to load/export', async () => {
  store.clear();
  const { setTokens, getTokens, exportOAuthTokens } = await import('../extension/js/oauth.js').then((m) => ({
    // saveTokenStore/loadTokenStore are internal; exercise via the public export hook
    setTokens: null, getTokens: null, exportOAuthTokens: m.exportOAuthTokens,
  }));
  // seed a plaintext token via importOAuthTokens, then confirm it's sealed on disk
  const { importOAuthTokens } = await import('../extension/js/oauth.js');
  await importOAuthTokens({ e1: { access_token: 'at-secret', refresh_token: 'rt-secret', token_type: 'Bearer' } }, { mode: 'replace' });
  assert.equal(isSealed(rawOAuth().e1), true, 'oauth entry sealed on disk');
  assert.doesNotMatch(JSON.stringify(rawOAuth()), /at-secret|rt-secret/, 'no plaintext token on disk');
  const exported = await exportOAuthTokens();
  assert.equal(exported.e1.access_token, 'at-secret'); // backup gets plaintext (portable)
});
