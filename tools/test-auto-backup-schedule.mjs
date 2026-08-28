import assert from 'node:assert/strict';

const localStore = {};
const sessionStore = {};
let lastAlarm = null;
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return { [key]: localStore[key] }; },
      async set(values) { Object.assign(localStore, values); },
    },
    session: {
      async get(key) { return { [key]: sessionStore[key] }; },
      async set(values) { Object.assign(sessionStore, values); },
      async remove(key) { delete sessionStore[key]; },
    },
  },
  downloads: { async search() { return []; }, onChanged: { addListener() {}, removeListener() {} } },
  alarms: { async clear() {}, create(name, options) { lastAlarm = { name, options }; } },
};

const {
  backupDayKey, stableBackupJson, scheduledBackupDue, coalesceBackupRun,
  normalizeBackupDestination, backupDestinationIncludes, setAutoBackupPassphrase,
  getBackupState, setAutoBackupEnabled,
} = await import('../extension/js/auto-backup.js');
const at = (iso) => new Date(iso);
assert.equal(backupDayKey(at('2026-08-28T20:00:00')), '2026-08-28');
assert.equal(stableBackupJson({ exportedAt: 1, conversations: [1] }), stableBackupJson({ exportedAt: 999, conversations: [1] }));
assert.notEqual(stableBackupJson({ exportedAt: 1, conversations: [1] }), stableBackupJson({ exportedAt: 1, conversations: [1, 2] }));
const base = { enabled: true, passphrase: 'set', hour: 20, lastAt: 0, lastDay: '' };
assert.equal(scheduledBackupDue(base, at('2026-08-28T19:59:59')), false);
assert.equal(scheduledBackupDue(base, at('2026-08-28T20:00:00')), true);
assert.equal(scheduledBackupDue({ ...base, lastDay: '2026-08-28' }, at('2026-08-28T23:00:00')), false);
assert.equal(scheduledBackupDue({ ...base, passphrase: '' }, at('2026-08-28T21:00:00')), false);
assert.equal(scheduledBackupDue({ ...base, hour: 0 }, at('2026-08-28T00:00:00')), true, 'midnight is a valid preferred hour');
assert.equal(normalizeBackupDestination('drive'), 'drive');
assert.equal(normalizeBackupDestination('anything-else'), 'local');
assert.equal(backupDestinationIncludes('both', 'drive'), true);
assert.equal(backupDestinationIncludes('drive', 'local'), false);

let release;
let starts = 0;
const gate = new Promise((resolve) => { release = resolve; });
const first = coalesceBackupRun(async () => { starts++; return gate; });
const racing = coalesceBackupRun(async () => { starts++; return 'duplicate'; });
await Promise.resolve();
assert.equal(starts, 1, 'racing startup/alarm triggers share one writer');
release('complete');
assert.deepEqual(await Promise.all([first, racing]), ['complete', 'complete']);
assert.equal(await coalesceBackupRun(async () => { starts++; return 'next-day'; }), 'next-day');
assert.equal(starts, 2, 'lock releases after completion');

await setAutoBackupPassphrase('portable-test-password');
assert.equal(localStore['chatpanel:autoBackup'].passphrase, undefined, 'backup password must never persist in plaintext');
assert.equal(localStore['chatpanel:autoBackup'].encryptedPassphrase?.__enc, 1, 'unattended password should persist only as ciphertext');
delete sessionStore['chatpanel:autoBackupPassphrase'];
assert.equal((await getBackupState()).passphrase, 'portable-test-password', 'device-wrapped password should unlock after a browser restart');
await setAutoBackupEnabled(true);
assert.equal(lastAlarm.name, 'chatpanel-auto-backup');
assert.ok(Number.isFinite(lastAlarm.options.when), 'daily schedule should use an exact wall-clock alarm');
assert.equal(lastAlarm.options.periodInMinutes, undefined, 'one-shot alarm avoids DST drift');
console.log('auto-backup schedule tests passed');
