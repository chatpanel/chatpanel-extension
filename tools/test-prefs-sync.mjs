// prefs-sync: what travels to the gateway, what comes back, and that one edit never ping-pongs.
import assert from 'node:assert/strict';

const storage = {};
globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: storage[k] }), set: async (o) => { Object.assign(storage, o); } } } };

// A fake gateway: per-section LWW like prefs-store.js, reachable at 4320.
const held = {};
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || 'GET' });
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });
  if (u.endsWith('/admin/token')) return json({ token: 't' });
  if (u.endsWith('/v1/prefs') && (opts.method || 'GET') === 'GET') return json({ ok: true, sections: held });
  if (u.endsWith('/v1/prefs') && opts.method === 'POST') {
    const { sections } = JSON.parse(opts.body);
    const applied = []; const kept = []; const out = {};
    for (const [id, e] of Object.entries(sections)) {
      if (!held[id] || e.updatedAt > held[id].updatedAt) { held[id] = { value: e.value, updatedAt: e.updatedAt, by: 'extension' }; applied.push(id); } else kept.push(id);
      out[id] = held[id];
    }
    return json({ ok: true, applied, kept, sections: out });
  }
  return json({ error: 'nope' }, 404);
};

const { pushPrefs, pullPrefs } = await import('../extension/js/prefs-sync.js');

const settings = { gatewayUrl: 'http://127.0.0.1:4320', mcpServers: [{ id: 'jira' }], endpoints: [{ apiKey: 'sk-secret' }], ui: { webSearch: { enabled: true }, mcpToolsMode: 'auto', theme: 'dark' } };

// 1) first push sends every shareable section, and nothing secret
let r = await pushPrefs(settings);
assert.deepEqual(r.pushed.sort(), ['mcpServers', 'tools', 'webSearch']);
assert.ok(!JSON.stringify(held).includes('sk-secret'), 'endpoint keys never travel');
assert.ok(!JSON.stringify(held).includes('dark'), 'theme is per window');

// 2) a second push with nothing changed sends nothing
calls = [];
r = await pushPrefs(settings);
assert.deepEqual(r.pushed, []);
assert.equal(calls.length, 0, 'no request when nothing changed');

// 3) the desktop writes a newer MCP list; pull takes it and records the stamp
held.mcpServers = { value: [{ id: 'linear' }], updatedAt: Date.now() + 5000, by: 'desktop' };
const pulled = await pullPrefs(settings);
assert.deepEqual(pulled.changed, ['mcpServers']);
assert.deepEqual(pulled.settings.mcpServers, [{ id: 'linear' }]);
assert.equal(pulled.settings.ui.theme, 'dark', 'the rest of the tree is untouched');
assert.deepEqual(settings.mcpServers, [{ id: 'jira' }], 'the input object is not mutated by pull');

// 4) saving what was pulled does NOT push it back (its stamp already matches)
calls = [];
r = await pushPrefs(pulled.settings);
assert.deepEqual(r.pushed, []);
assert.equal(calls.length, 0, 'a pulled section is not echoed back — no ping-pong');

// 5) a local edit that loses to a newer remote copy is replaced in place and reported
held.webSearch = { value: { enabled: false }, updatedAt: Date.now() + 9000, by: 'desktop' };
const local = { ...pulled.settings, ui: { ...pulled.settings.ui, webSearch: { enabled: true, engines: [] } } };
r = await pushPrefs(local);
assert.deepEqual(Object.keys(r.took), ['webSearch']);
assert.deepEqual(local.ui.webSearch, { enabled: false }, 'the newer copy was merged into the settings object');

// 6) no gateway at all: quiet no-ops, settings untouched
globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
assert.deepEqual(await pushPrefs({ ...settings, mcpServers: [{ id: 'x' }] }), { pushed: [], took: {} });
const off = await pullPrefs(settings);
assert.equal(off.settings, settings);

console.log('prefs-sync tests passed');
