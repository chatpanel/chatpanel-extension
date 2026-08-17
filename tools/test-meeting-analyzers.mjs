import assert from 'node:assert/strict';

// A shared fake storage so both "contexts" (settings and the panel) see one truth.
const store = {}; const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: v, oldValue: store[k] }; store[k] = v; }
        listeners.forEach((fn) => fn(changes, 'local'));
      },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};

const { MEETING_ANALYZERS, analyzerRegistry, dueAnalyzers } = await import('../extension/js/meeting-analyzers-builtin.js');
const { pluginManifest } = await import('../extension/js/plugins.js');

await analyzerRegistry();
const manifest = await pluginManifest();

// Every analyzer is DECLARED to the manifest, or the Plugins page cannot offer it — a
// capability with no entry is one the user has no way to switch off.
const ids = MEETING_ANALYZERS.map((a) => a.id);
for (const id of ids) {
  assert.ok(manifest.list().some((e) => e.id === id), `${id} is not declared to the manifest`);
}

// Ids are namespaced. A bare `summary` would collide with any future plugin of that name,
// and a collision silently disables the wrong thing.
assert.ok(ids.every((id) => id.startsWith('meeting:')), 'an analyzer id is not namespaced');

// ── due-ness, which is what actually gates the work ─────────────────────────
const busy = { now: 1e9, transcriptChars: 5000, lastRunAt: {} };
assert.deepEqual((await dueAnalyzers(busy)).map((a) => a.id).sort(), ['meeting:monitors', 'meeting:summary']);

// A DISABLED analyzer is never due — so it costs no model call, rather than running and
// having its result discarded.
manifest.setEnabled('meeting:summary', false);
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual((await dueAnalyzers(busy)).map((a) => a.id), ['meeting:monitors'],
  'a switched-off analyzer was still due');

// ...and comes straight back when re-enabled, with no reload.
manifest.setEnabled('meeting:summary', true);
assert.ok((await dueAnalyzers(busy)).some((a) => a.id === 'meeting:summary'));

// A short transcript is not worth a model call: an empty transcript summarised is a
// paragraph of apology.
assert.deepEqual(await dueAnalyzers({ now: 1e9, transcriptChars: 10 }), []);

// The end-of-meeting analyzer does not run on the periodic tick, and vice versa.
assert.deepEqual((await dueAnalyzers({ ...busy, cadence: 'on-end' })).map((a) => a.id), ['meeting:insights']);

// An analyzer that just ran waits for its interval rather than every tick.
const justRan = { now: 1e9, transcriptChars: 5000, lastRunAt: { 'meeting:summary': 1e9 - 1000, 'meeting:monitors': 1e9 - 1000 } };
assert.deepEqual(await dueAnalyzers(justRan), []);

// Each declares what it produces, so the host knows where the result goes without the
// analyzer knowing about storage.
assert.deepEqual(MEETING_ANALYZERS.map((a) => a.produces).sort(), ['answer', 'sections', 'summary']);

console.log('✓ meeting analyzers: declared, gated by the manifest, due only when they should be');
