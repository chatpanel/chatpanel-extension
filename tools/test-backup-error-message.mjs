// A persisted error has to say what failed, and when.
//
// The whole of a backup failure used to reach the user as `String(e.message)`, written into
// storage and re-rendered on every Settings load. A browser reports every network failure it
// will not explain as the same four words, so what sat in the Backup card was:
//
//     ✕ Failed to fetch
//
// with nothing to say what was being fetched, whether it happened a minute or a month ago,
// whether an earlier backup still existed, or what to do next. That is the report this file
// exists to keep from recurring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  storage: {
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {} },
    onChanged: { addListener() {} },
  },
};
const { describeBackupError, BACKUP_STEPS } = await import('../extension/js/auto-backup.js');

// ── the reported string, from every step that can produce it ─────────────────────
const netErr = new TypeError('Failed to fetch');
for (const step of Object.keys(BACKUP_STEPS)) {
  const msg = describeBackupError(step, netErr);
  assert.notEqual(msg, 'Failed to fetch', `${step}: the bare browser string must not reach the user`);
  assert.ok(msg.length > 40, `${step}: "${msg}" is not an explanation`);
  assert.ok(
    msg.includes(BACKUP_STEPS[step]),
    `${step}: the message must name what was being done — got "${msg}"`,
  );
}

// The Drive case is the likely one, and it is the one with a real next action: the upload
// is the only step that talks to a third party the user can re-authorize.
{
  const msg = describeBackupError('drive', netErr);
  assert.match(msg, /Google Drive/, 'name the service');
  assert.match(msg, /Connect Google Drive/, 'name the button that fixes it');
  assert.match(msg, /Downloads/, 'and name the way out that needs no network');
}

// A cancelled download is a browser SETTING, not a fault — say which one.
{
  const msg = describeBackupError('download', new Error('USER_CANCELED'));
  assert.match(msg, /Ask where to save/i, 'name the setting that causes it');
}

// A non-network error keeps its detail: the raw text is the useful part there.
{
  const msg = describeBackupError('encrypt', new Error('key derivation failed'));
  assert.match(msg, /key derivation failed/, 'a real message must survive');
  assert.match(msg, /encrypting/, 'and still be attributed to a step');
}

// Never throws on the shapes an exception can actually arrive in.
for (const thrown of [undefined, null, '', 'a bare string', { message: '' }, new Error()]) {
  assert.equal(typeof describeBackupError('drive', thrown), 'string');
  assert.ok(describeBackupError('export', thrown).length > 0);
}
// An unknown step still produces a sentence rather than "undefined".
assert.doesNotMatch(describeBackupError('nonsense', netErr), /undefined/);

// ── what is persisted, and what the page does with it ────────────────────────────
const ab = readFileSync(new URL('../extension/js/auto-backup.js', import.meta.url), 'utf8');
const st = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');

assert.match(ab, /lastErrorStep: '', lastErrorAt: 0,/, 'the step and the time must be part of the state');
assert.ok(
  /catch \(e\) \{[\s\S]{0,600}?describeBackupError\(step, e\)/.test(ab),
  'the catch-all must describe the failure rather than storing the raw exception',
);
assert.doesNotMatch(
  ab, /lastError: String\(e\?\.message \|\| e\)/,
  'the unattributed raw-exception write is the bug — it must not come back',
);
// A success, a new password and a new destination all clear it. A stale error that nothing
// clears is indistinguishable from a live one.
assert.equal(
  (ab.match(/lastErrorStep: ''/g) || []).length >= 4, true,
  'every path that clears lastError must clear the step with it',
);

// The page must show the age, and must not imply the user has no backup at all.
assert.match(st, /const ago = \(ts\) =>/, 'a persisted error needs an age');
assert.match(st, /st\.lastErrorAt/, 'and must actually read it');
assert.match(st, /is still there/, 'an earlier successful backup must be mentioned, not hidden');
assert.match(st, /Back up now/, 'and there must be a stated way to retry');

console.log('backup error message: ok');
