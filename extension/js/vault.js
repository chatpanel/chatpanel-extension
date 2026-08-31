// The vault, as this client stores and locks it.
//
// The crypto and the rules live in @chatpanel/events (js/events/vault.js) so a phone opens
// the same vault. What is here is the three things bound to a browser extension: where the
// ciphertext sits, where the key is allowed to sit, and when it stops sitting there.
//
// WHERE THE KEY LIVES IS THE WHOLE DESIGN. chrome.storage.session is cleared when the
// browser closes and is never written to the profile on disk, so a copied or synced profile
// yields ciphertext, a salt, and no way to use them. That is exactly the tier
// meeting-crypto.js and secret-crypto.js each described as "we could add later" — and the
// reason they are still right not to use it: losing an API key to a forgotten passphrase
// would be a disaster, while a vault the user chose to lock is doing its job.
//
// A FORGOTTEN PASSPHRASE IS UNRECOVERABLE. Said here because it is a product decision, not
// an oversight: any recovery path we could build would be a second way in, and a second way
// in is the thing a vault exists to not have.

import {
  createVault as buildVault, unlockVault, sealEntry, openEntry, entryMeta, searchEntries,
  isLocked, lockedSummary, canAddEntry, validateEntry, DEFAULT_LOCK_MS, VaultError,
} from './events/vault.js';

const VAULT_KEY = 'chatpanel:vault';       // local  — ciphertext, KDF params, verifier
const SESSION_KEY = 'chatpanel:vaultKey';  // session — the derived key, for this session only
const LOCK_PREF = 'chatpanel:vaultLockMs';

let cachedKey = null; // the CryptoKey for this page; the JWK in session is what survives it

async function readVault() {
  try {
    const got = await chrome.storage.local.get(VAULT_KEY);
    return got?.[VAULT_KEY] || null;
  } catch {
    return null;
  }
}
const writeVault = (v) => chrome.storage.local.set({ [VAULT_KEY]: v });

async function session() {
  try {
    const got = await chrome.storage.session.get(SESSION_KEY);
    return got?.[SESSION_KEY] || null;
  } catch {
    return null; // no session storage (an older engine) → the vault simply stays locked
  }
}
const setSession = (v) => chrome.storage.session.set({ [SESSION_KEY]: v }).catch(() => {});
const clearSession = () => chrome.storage.session.remove(SESSION_KEY).catch(() => {});

async function lockTimeoutMs() {
  try {
    const got = await chrome.storage.local.get(LOCK_PREF);
    const v = got?.[LOCK_PREF];
    return Number.isFinite(v) ? v : DEFAULT_LOCK_MS;
  } catch {
    return DEFAULT_LOCK_MS;
  }
}

export async function setLockTimeout(ms) {
  await chrome.storage.local.set({ [LOCK_PREF]: Math.max(0, Number(ms) || 0) });
}

/**
 * The key for right now, or null.
 *
 * Auto-lock is enforced HERE rather than on a timer: a timer that fails to fire leaves a
 * vault unlocked, while a check that fails to run cannot hand anything out. The clock runs
 * from the last USE, so a vault someone is working in does not lock under their hands.
 */
async function activeKey({ touch = true } = {}) {
  const s = await session();
  if (!s?.jwk) { cachedKey = null; return null; }
  const timeoutMs = await lockTimeoutMs();
  if (isLocked({ unlockedAt: s.unlockedAt, lastUsedAt: s.lastUsedAt, now: Date.now(), timeoutMs })) {
    await lock();
    return null;
  }
  if (!cachedKey) {
    cachedKey = await crypto.subtle.importKey('jwk', s.jwk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  if (touch) await setSession({ ...s, lastUsedAt: Date.now() });
  return cachedKey;
}

async function requireKey() {
  const key = await activeKey();
  if (!key) throw new VaultError('LOCKED', 'the vault is locked');
  return key;
}

/** Safe to call at any time, locked or not — it reveals only whether and how many. */
export async function vaultStatus() {
  const vault = await readVault();
  if (!vault?.kdf) return { exists: false, locked: true, entries: 0 };
  const key = await activeKey({ touch: false });
  return { ...lockedSummary(vault), locked: !key };
}

/** First run. Throws if one already exists — creating a second would strand the first. */
export async function createVault(passphrase) {
  if ((await readVault())?.kdf) throw new VaultError('EXISTS', 'a vault already exists on this device');
  const { vault, key } = await buildVault(passphrase);
  await writeVault(vault);
  await keepUnlocked(key);
  return vaultStatus();
}

async function keepUnlocked(key) {
  cachedKey = key;
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const at = Date.now();
  await setSession({ jwk, unlockedAt: at, lastUsedAt: at });
}

export async function unlock(passphrase) {
  const vault = await readVault();
  if (!vault?.kdf) throw new VaultError('NO_VAULT', 'no vault has been created yet');
  const key = await unlockVault(vault, passphrase); // throws BAD_KEY on the wrong passphrase
  await keepUnlocked(key);
  return vaultStatus();
}

export async function lock() {
  cachedKey = null;
  await clearSession();
  return { locked: true };
}

/** Metadata for every entry, newest first. Requires an unlocked vault, by construction. */
export async function listEntries(query = '') {
  const key = await requireKey();
  const vault = await readVault();
  const out = [];
  for (const rec of Object.values(vault?.entries || {})) {
    try {
      out.push(await openEntry(key, rec));
    } catch {
      // One unreadable entry must not take the list down — the others are still the user's.
      out.push({ id: rec.id, title: '⚠ unreadable entry', corrupt: true, updatedAt: rec.updatedAt || 0 });
    }
  }
  return searchEntries(out, query)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(entryMeta);
}

export async function addEntry({ title, note = '', secret = '' }) {
  const key = await requireKey();
  const vault = await readVault();
  if (!canAddEntry(vault)) throw new VaultError('FULL', 'this vault is full');
  validateEntry({ title, note, secret });
  const id = `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const rec = await sealEntry(key, { id, title, note, secret });
  vault.entries[id] = rec;
  await writeVault(vault);
  return entryMeta({ id, title, note, secret, updatedAt: rec.updatedAt, createdAt: rec.updatedAt });
}

export async function updateEntry(id, patch = {}) {
  const key = await requireKey();
  const vault = await readVault();
  const rec = vault?.entries?.[id];
  if (!rec) throw new VaultError('NOT_FOUND', 'no such entry');
  const current = await openEntry(key, rec);
  const next = { ...current, ...patch, id };
  validateEntry(next);
  vault.entries[id] = await sealEntry(key, next);
  await writeVault(vault);
  return entryMeta(next);
}

/**
 * The one call that hands back a secret. Everything else in this module deals in metadata,
 * so there is exactly one place to audit and exactly one place for a caller to gate.
 */
export async function revealEntry(id) {
  const key = await requireKey();
  const vault = await readVault();
  const rec = vault?.entries?.[id];
  if (!rec) throw new VaultError('NOT_FOUND', 'no such entry');
  return openEntry(key, rec);
}

export async function removeEntry(id) {
  await requireKey(); // deleting is a write, and a locked vault accepts no writes
  const vault = await readVault();
  if (!vault?.entries?.[id]) return false;
  delete vault.entries[id];
  await writeVault(vault);
  return true;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * The vault as it sits on disk: ciphertext, salt and verifier, and nothing else.
 *
 * Safe to put in a backup EXACTLY BECAUSE it is useless without the passphrase — which is
 * also why the session key is not here. Restoring on another machine gives you a vault that
 * opens with the same passphrase and with nothing else.
 */
export async function exportVault() {
  return readVault();
}

export async function importVault(blob, { mode = 'merge' } = {}) {
  if (!blob?.kdf?.salt) return false;
  const existing = await readVault();
  // Two vaults have different salts, so their entries are encrypted under different keys and
  // cannot be merged into one. Keeping the local one is the safe half of that choice: the
  // backup is still on disk, and overwriting a vault whose passphrase the user remembers
  // with one whose passphrase they may not is unrecoverable.
  if (existing?.kdf && mode !== 'replace') return false;
  await writeVault(blob);
  await lock(); // whatever was unlocked belonged to the vault that is no longer here
  return true;
}

// ---------------------------------------------------------------------------
// The capability a widget can be granted
// ---------------------------------------------------------------------------

/**
 * Widgets are model-built and untrusted, so what they get is deliberately lopsided: they may
 * ADD and they may LIST, because neither reveals anything the user has not already typed
 * into that widget. Revealing and deleting go through a HOST-owned confirm — a dialog the
 * widget cannot draw, cannot pre-answer, and cannot mistake for its own.
 *
 * Without that asymmetry, "keep my passwords" would mean any granted widget can read all of
 * them the moment the vault is unlocked, which is the failure this whole module exists to
 * prevent.
 */
export function vaultCapabilities({ confirm = async () => false, askPassphrase = null } = {}) {
  return {
    'vault.status': () => vaultStatus(),
    // The widget asks for an unlock; the HOST asks for the passphrase. The passphrase never
    // passes through the widget, so a widget that turns out to be malicious still never saw
    // it — it only ever sees whether the vault is now open.
    'vault.unlock': async () => {
      if (!askPassphrase) throw new VaultError('NO_PROMPT', 'this surface cannot ask for a passphrase');
      const st = await vaultStatus();
      if (!st.locked) return st;
      const pass = await askPassphrase({ create: !st.exists });
      if (!pass) throw new VaultError('REFUSED', 'the user did not unlock the vault');
      return st.exists ? unlock(pass) : createVault(pass);
    },
    'vault.lock': () => lock(),
    'vault.list': ({ query = '' } = {}) => listEntries(query),
    'vault.add': ({ title, note, secret } = {}) => addEntry({ title, note, secret }),
    'vault.reveal': async ({ id } = {}) => {
      const meta = (await listEntries()).find((e) => e.id === id);
      const ok = await confirm({
        title: 'Reveal this secret?',
        body: `A widget is asking to read “${meta?.title || id}” from your vault.`,
        confirmLabel: 'Reveal',
      });
      if (!ok) throw new VaultError('REFUSED', 'the user did not allow that');
      return revealEntry(id);
    },
    'vault.remove': async ({ id } = {}) => {
      const meta = (await listEntries()).find((e) => e.id === id);
      const ok = await confirm({
        title: 'Delete this entry?',
        body: `A widget is asking to delete “${meta?.title || id}”. This cannot be undone.`,
        confirmLabel: 'Delete',
      });
      if (!ok) throw new VaultError('REFUSED', 'the user did not allow that');
      return removeEntry(id);
    },
  };
}

export const VAULT_CAPABILITY_IDS = Object.freeze(['vault.status', 'vault.unlock', 'vault.lock', 'vault.list', 'vault.add', 'vault.reveal', 'vault.remove']);
export { VaultError };
