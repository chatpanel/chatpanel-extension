// Notes UI + co-writer config: localStorage snapshot, chrome.storage mirror for the
// service-worker backup path, and export/import round-trip (merge + replace).
import assert from 'node:assert/strict';

// Mock chrome.storage.local.
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

// Minimal localStorage mock (sync, string values, length/key iteration).
function makeLocalStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    _dump() { return Object.fromEntries(m); },
  };
}

const { exportNotesConfig, importNotesConfig, mirrorNotesConfig } = await import('../extension/js/notes-config.js');

// 1) export reads only the chatpanel.notes.* namespace from localStorage.
{
  globalThis.localStorage = makeLocalStorage({
    'chatpanel.notes.cowriter.roles': '{"writer":"ep1"}',
    'chatpanel.notes.gear': 'focus',
    'chatpanel.notes.railW': '320',
    'chatpanel:license': 'should-not-travel', // different namespace
    'unrelated': 'x',
  });
  const cfg = await exportNotesConfig();
  assert.deepEqual(cfg, {
    'chatpanel.notes.cowriter.roles': '{"writer":"ep1"}',
    'chatpanel.notes.gear': 'focus',
    'chatpanel.notes.railW': '320',
  }, 'only chatpanel.notes.* keys, nothing else');
}

// 2) mirror pushes the live snapshot into chrome.storage.local for the SW path.
{
  await mirrorNotesConfig();
  assert.deepEqual(storage.get('chatpanel:notesConfig'), {
    'chatpanel.notes.cowriter.roles': '{"writer":"ep1"}',
    'chatpanel.notes.gear': 'focus',
    'chatpanel.notes.railW': '320',
  }, 'mirror matches localStorage snapshot');
}

// 3) service-worker path (no localStorage) falls back to the mirror.
{
  delete globalThis.localStorage;
  assert.equal(typeof localStorage, 'undefined');
  const cfg = await exportNotesConfig();
  assert.equal(cfg['chatpanel.notes.gear'], 'focus', 'SW export reads the mirror');
}

// 4) import (merge) writes localStorage + refreshes the mirror; leaves other keys.
{
  globalThis.localStorage = makeLocalStorage({ 'chatpanel.notes.mode': 'live' });
  storage.clear();
  const res = await importNotesConfig({
    'chatpanel.notes.cowriter.roles': '{"editor":"ep2"}',
    'chatpanel.notes.gear': 'ambient',
    'chatpanel:license': 'ignored', // out-of-namespace dropped
    'chatpanel.notes.count': 5,       // non-string dropped
  }, { mode: 'merge' });
  assert.equal(res.imported, 2, 'only the two valid chatpanel.notes.* string entries');
  assert.equal(localStorage.getItem('chatpanel.notes.cowriter.roles'), '{"editor":"ep2"}');
  assert.equal(localStorage.getItem('chatpanel.notes.gear'), 'ambient');
  assert.equal(localStorage.getItem('chatpanel.notes.mode'), 'live', 'merge keeps pre-existing keys');
  const mirror = storage.get('chatpanel:notesConfig');
  assert.equal(mirror['chatpanel.notes.gear'], 'ambient', 'mirror refreshed on import');
}

// 5) import (replace) clears our namespace first but spares other namespaces.
{
  globalThis.localStorage = makeLocalStorage({
    'chatpanel.notes.gear': 'focus',
    'chatpanel.notes.stale': 'gone',
    'chatpanel:license': 'kept',
  });
  await importNotesConfig({ 'chatpanel.notes.gear': 'ambient' }, { mode: 'replace' });
  assert.equal(localStorage.getItem('chatpanel.notes.gear'), 'ambient');
  assert.equal(localStorage.getItem('chatpanel.notes.stale'), null, 'replace cleared other notes keys');
  assert.equal(localStorage.getItem('chatpanel:license'), 'kept', 'replace spares other namespaces');
}

// 6) empty / invalid input is a safe no-op.
{
  assert.deepEqual(await importNotesConfig(null), { imported: 0 });
  assert.deepEqual(await importNotesConfig('nope'), { imported: 0 });
}

console.log('notes-config tests passed');
