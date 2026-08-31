// A backup is only a backup if restoring it gives you back what you had. Three stores landed
// after v7 — widgets, jobs and the vault — and each would have been silently dropped by a
// restore. This asserts the payload carries them, and that a restore returns them.
import assert from 'node:assert/strict';

const local = new Map();
const sessionStore = new Map();
const area = (map) => ({
  async get(key) {
    if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
    if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => map.has(k)).map((k) => [k, map.get(k)]));
    return Object.fromEntries(map);
  },
  async set(values) { Object.entries(values).forEach(([k, v]) => map.set(k, v)); },
  async remove(key) { (Array.isArray(key) ? key : [key]).forEach((k) => map.delete(k)); },
});
globalThis.chrome = {
  storage: { local: area(local), session: area(sessionStore), onChanged: { addListener() {} } },
  runtime: { id: 'test', getURL: (p) => p, sendMessage: async () => {} },
};

const widgets = await import('../extension/js/widgets-store.js');
const jobs = await import('../extension/js/jobs.js');
const vault = await import('../extension/js/vault.js');
const { timerTrigger } = await import('../extension/js/events/schedule.js');

// Something of each kind, as a user would have it.
await widgets.saveWidget({ id: 'timer-widget', name: 'Pomodoro', html: '<p>hi</p>', requests: ['vault.add'] }, { approved: ['vault.add'] });
await widgets.setWidgetState('timer-widget', { runs: 12 });
await jobs.putJob({
  id: 'j1', name: 'Daily brief', trigger: timerTrigger.id,
  schedule: { kind: 'daily', hour: 8 }, action: { kind: 'skill', skillId: 'sk1' }, createdAt: 1,
});
await jobs.recordRun('j1', 1_700_000_000_000);
await vault.createVault('correct horse battery staple');
await vault.addEntry({ title: 'Chatpanel', note: 'is just amazing', secret: 'hunter2' });

// ── the payload carries all three ──────────────────────────────────────────
const [w, j, v] = await Promise.all([widgets.exportWidgets(), jobs.exportJobs(), vault.exportVault()]);
assert.ok(w.widgets['timer-widget'], 'a kept widget exists nowhere else — no release contains it');
assert.deepEqual(w.state['timer-widget'], { runs: 12 }, 'a habit tracker without its history is a new habit tracker');
assert.ok(j.jobs.j1, 'schedules must survive a restore');
assert.equal(j.runs.j1, 1_700_000_000_000, 'and so must the watermark, or every slot since looks missed');
assert.ok(v.kdf.salt && v.verifier);
assert.ok(!JSON.stringify(v).includes('hunter2'), 'the vault travels as ciphertext');

// ── and a restore puts them back ───────────────────────────────────────────
local.clear();
sessionStore.clear();
assert.equal(await widgets.importWidgets(w, { mode: 'replace' }), 1);
assert.equal(await jobs.importJobs(j, { mode: 'replace' }), 1);
assert.equal(await vault.importVault(v, { mode: 'replace' }), true);

const back = await widgets.getWidget('timer-widget');
assert.equal(back.manifest.name, 'Pomodoro');
assert.deepEqual(back.grants, ['vault.add'], 'a grant is consent this user already gave');
assert.deepEqual(await widgets.getWidgetState('timer-widget'), { runs: 12 });
assert.equal((await jobs.getJob('j1')).name, 'Daily brief');
assert.equal((await jobs.lastRuns()).j1, 1_700_000_000_000);

assert.equal((await vault.vaultStatus()).locked, true, 'a restored vault starts locked');
await vault.unlock('correct horse battery staple');
assert.equal((await vault.revealEntry((await vault.listEntries())[0].id)).secret, 'hunter2',
  'the same passphrase opens it on the new machine — nothing else does');

// ── a widget that edited its own manifest to ask for more gains nothing ────
{
  const tampered = {
    widgets: { evil: { manifest: { id: 'evil', name: 'Evil', html: '<p>x</p>', requests: [] }, grants: ['vault.reveal'] } },
    state: {},
  };
  await widgets.importWidgets(tampered, { mode: 'merge' });
  assert.deepEqual((await widgets.getWidget('evil')).grants, [],
    'grants are intersected with what the manifest asks for, on the way in');
}

// ── a malformed job in a backup must not lose the rest ─────────────────────
{
  const n = await jobs.importJobs({ jobs: { bad: { id: 'bad' }, ok: { id: 'ok', name: 'Fine', trigger: 'meeting:question', action: { kind: 'notify' } } } }, { mode: 'merge' });
  assert.equal(n, 1);
  assert.ok(await jobs.getJob('ok'));
  assert.equal(await jobs.getJob('bad'), null);
}

console.log('backup completeness tests passed');
