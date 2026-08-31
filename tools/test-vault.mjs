// The vault as this client stores it: where the key is allowed to live, when it stops
// living there, and what a granted widget can and cannot get out of it.
import assert from 'node:assert/strict';

const local = new Map();
const sessionStore = new Map();
const area = (map) => ({
  async get(key) { return map.has(key) ? { [key]: map.get(key) } : {}; },
  async set(values) { Object.entries(values).forEach(([k, v]) => map.set(k, v)); },
  async remove(key) { map.delete(key); },
});
globalThis.chrome = { storage: { local: area(local), session: area(sessionStore) } };

const vault = await import('../extension/js/vault.js');

const PASS = 'correct horse battery staple';

// ── creation and unlock ────────────────────────────────────────────────────
{
  assert.deepEqual(await vault.vaultStatus(), { exists: false, locked: true, entries: 0 });
  await vault.createVault(PASS);
  const st = await vault.vaultStatus();
  assert.equal(st.exists, true);
  assert.equal(st.locked, false, 'creating it unlocks it — nobody wants to type it twice');
  await assert.rejects(() => vault.createVault(PASS), (e) => e.code === 'EXISTS');
}

// ── the key is never written to disk ───────────────────────────────────────
{
  // This is the whole design: a copied profile yields ciphertext, a salt, and no way to use
  // them. chrome.storage.session is cleared when the browser closes and is not in the profile.
  const onDisk = JSON.stringify([...local.entries()]);
  assert.ok(!onDisk.includes(PASS));
  assert.ok(!onDisk.includes('jwk'), 'the derived key must not be in local storage');
  assert.ok(JSON.stringify([...sessionStore.entries()]).includes('jwk'), 'it lives in session storage only');
}

// ── entries ────────────────────────────────────────────────────────────────
let id;
{
  const meta = await vault.addEntry({ title: 'Chatpanel', note: 'is just amazing', secret: 'hunter2' });
  id = meta.id;
  assert.equal(meta.title, 'Chatpanel');
  assert.equal(meta.hasSecret, true);
  assert.equal(meta.secret, undefined, 'metadata must never carry the secret');

  const list = await vault.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].secret, undefined);

  const full = await vault.revealEntry(id);
  assert.equal(full.secret, 'hunter2');
  assert.equal(full.note, 'is just amazing');

  // Nothing about the entry — its title included — is readable on disk.
  const onDisk = JSON.stringify([...local.entries()]);
  for (const leak of ['Chatpanel', 'is just amazing', 'hunter2']) {
    assert.ok(!onDisk.includes(leak), `"${leak}" is readable in stored data`);
  }
}

// ── locking ────────────────────────────────────────────────────────────────
{
  await vault.lock();
  assert.equal((await vault.vaultStatus()).locked, true);
  // A locked vault admits to a count and refuses everything else — including writes and
  // deletes, not just reads.
  assert.equal((await vault.vaultStatus()).entries, 1);
  await assert.rejects(() => vault.listEntries(), (e) => e.code === 'LOCKED');
  await assert.rejects(() => vault.revealEntry(id), (e) => e.code === 'LOCKED');
  await assert.rejects(() => vault.addEntry({ title: 'x' }), (e) => e.code === 'LOCKED');
  await assert.rejects(() => vault.removeEntry(id), (e) => e.code === 'LOCKED');

  await assert.rejects(() => vault.unlock('wrong passphrase'), (e) => e.code === 'BAD_KEY');
  assert.equal((await vault.vaultStatus()).locked, true, 'a failed unlock leaves it locked');

  await vault.unlock(PASS);
  assert.equal((await vault.revealEntry(id)).secret, 'hunter2', 'and the data survived the lock');
}

// ── auto-lock runs from the last use ───────────────────────────────────────
{
  await vault.setLockTimeout(50);
  const s = sessionStore.get('chatpanel:vaultKey');
  sessionStore.set('chatpanel:vaultKey', { ...s, unlockedAt: Date.now() - 10_000, lastUsedAt: Date.now() - 10_000 });
  assert.equal((await vault.vaultStatus()).locked, true, 'an idle vault locks itself');
  await assert.rejects(() => vault.listEntries(), (e) => e.code === 'LOCKED');
  await vault.setLockTimeout(15 * 60_000);
  await vault.unlock(PASS);
}

// ── what a granted widget can do ───────────────────────────────────────────
{
  let asked = null;
  const caps = vault.vaultCapabilities({ confirm: async (q) => { asked = q; return false; } });
  assert.deepEqual(Object.keys(caps).sort(), [...vault.VAULT_CAPABILITY_IDS].sort());

  // Adding and listing need no confirmation: neither hands back anything the user did not
  // already type into that widget.
  const added = await caps['vault.add']({ title: 'From a widget', secret: 's3cret' });
  assert.equal(added.hasSecret, true);
  const listed = await caps['vault.list']({});
  assert.ok(listed.every((e) => e.secret === undefined), 'listing must stay metadata');

  // Revealing does. A refused confirm means the widget gets an error, not a secret.
  await assert.rejects(() => caps['vault.reveal']({ id: added.id }), (e) => e.code === 'REFUSED');
  assert.match(asked.body, /From a widget/, 'and the user is told WHICH entry is being asked for');

  await assert.rejects(() => caps['vault.remove']({ id: added.id }), (e) => e.code === 'REFUSED');
  assert.equal((await vault.listEntries()).length, 2, 'a refused delete deletes nothing');

  // Allowed, it works — the gate is the user's answer, not the widget's request.
  const yes = vault.vaultCapabilities({ confirm: async () => true });
  assert.equal((await yes['vault.reveal']({ id: added.id })).secret, 's3cret');
  assert.equal(await yes['vault.remove']({ id: added.id }), true);
  assert.equal((await vault.listEntries()).length, 1);
}

// ── backup ─────────────────────────────────────────────────────────────────
{
  const blob = await vault.exportVault();
  assert.ok(blob.kdf.salt && blob.verifier, 'a backup carries what is needed to unlock it later');
  assert.ok(!JSON.stringify(blob).includes('hunter2'), 'and nothing that can be read without the passphrase');

  // Restoring over a DIFFERENT vault in merge mode must not happen: two vaults have
  // different salts, so their entries cannot be merged, and overwriting a vault whose
  // passphrase the user remembers is unrecoverable.
  assert.equal(await vault.importVault({ kdf: { salt: 'other' }, entries: {} }, { mode: 'merge' }), false);
  assert.equal((await vault.listEntries()).length, 1, 'the local vault is untouched');

  assert.equal(await vault.importVault(blob, { mode: 'replace' }), true);
  assert.equal((await vault.vaultStatus()).locked, true, 'a restored vault starts locked');
  await vault.unlock(PASS);
  assert.equal((await vault.listEntries())[0].title, 'Chatpanel');
}

console.log('vault tests passed');
