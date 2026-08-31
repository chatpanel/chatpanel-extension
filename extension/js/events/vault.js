// GENERATED — do not edit.
// Source of truth: chatpanel-events/vault.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The vault — secrets that survive a copied disk.
//
// ChatPanel already encrypts two things at rest (meeting transcripts, stored API keys), and
// both of those modules say the same thing in their own comments: the key sits in storage
// beside the data, so it is obfuscation, not protection, and the real answer is "a key
// derived from a user passphrase and never written to disk". This is that answer.
//
// WHAT IS DIFFERENT HERE, and why it justifies a third crypto path rather than a fourth
// caller of the second one:
//
//   • The key is derived from a passphrase and lives ONLY in session memory. Disk holds
//     ciphertext, the KDF parameters, and a verifier — nothing that yields the key.
//   • It FAILS CLOSED. The other two deliberately fail open: a crypto hiccup must never lose
//     someone's API key, so they fall back to plaintext. A vault that quietly writes
//     plaintext when something goes wrong is not a vault, so every failure here is an error
//     the caller has to handle.
//   • EVERYTHING is encrypted, titles included. A list of entry names is a list of the
//     accounts someone has — "Chatpanel", "bank", "ex-employer" — which is most of what an
//     attacker wanted. So a locked vault can say how many entries it holds and nothing else,
//     and search runs over decrypted entries in memory, after unlocking.
//
// Pure and portable: the crypto is WebCrypto, which the browser, Node and a mobile runtime
// all have, and `subtle`/`random`/`now` are injected so this is testable and replayable. The
// envelope is versioned and self-describing — a vault written by the extension today must
// open in a phone app in two years, and the iteration count must be raisable without
// stranding anyone's data.

export class VaultError extends Error {
  constructor(code, message) { super(message); this.name = 'VaultError'; this.code = code; }
}

export const VAULT_VERSION = 1;

// PBKDF2-SHA256. Higher than the backup envelope's 250k because a vault is a standing
// target rather than a file someone chose to export, and unlocking is a once-per-session
// cost a person is already waiting through. The parameters travel WITH the vault, so this
// number can rise later without breaking anything already written.
export const KDF_ITERATIONS = 310_000;
export const KDF_HASH = 'SHA-256';

export const MAX_TITLE_CHARS = 200;
export const MAX_NOTE_CHARS = 20_000;
export const MAX_SECRET_CHARS = 8_000;
export const MAX_ENTRIES = 2_000;

// What the verifier proves: that the passphrase derives the same key as last time. It is a
// constant sealed under the key, so a wrong passphrase fails the AES-GCM tag check and is
// TOLD APART from an empty vault — "wrong passphrase" and "nothing here" must never look
// alike to a user staring at an empty list.
const VERIFIER_PLAINTEXT = 'chatpanel-vault-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

const B64_CHUNK = 0x8000;
export function toB64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += B64_CHUNK) binary += String.fromCharCode(...view.subarray(i, i + B64_CHUNK));
  return btoa(binary);
}
export function fromB64(s) {
  const binary = atob(String(s || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function subtleOf(subtle) {
  const s = subtle || globalThis.crypto?.subtle;
  if (!s) throw new VaultError('NO_CRYPTO', 'WebCrypto is unavailable in this runtime');
  return s;
}
function randomOf(random) {
  const r = random || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  return r;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const str = (v) => typeof v === 'string';

/**
 * An entry is a title, an optional note, and an optional secret. The secret is not special
 * to the crypto — everything is sealed together — it is special to the UI, which must not
 * put it on screen without being asked.
 */
export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new VaultError('SHAPE', 'entry must be an object');
  if (!str(entry.title) || !entry.title.trim()) throw new VaultError('SHAPE', 'entry.title required');
  if (entry.title.length > MAX_TITLE_CHARS) throw new VaultError('SHAPE', `entry.title exceeds ${MAX_TITLE_CHARS} chars`);
  if (entry.note != null && (!str(entry.note) || entry.note.length > MAX_NOTE_CHARS)) {
    throw new VaultError('SHAPE', `entry.note must be a string under ${MAX_NOTE_CHARS} chars`);
  }
  if (entry.secret != null && (!str(entry.secret) || entry.secret.length > MAX_SECRET_CHARS)) {
    throw new VaultError('SHAPE', `entry.secret must be a string under ${MAX_SECRET_CHARS} chars`);
  }
  return entry;
}

/**
 * What may be shown, logged or handed to a widget WITHOUT revealing anything.
 *
 * `hasSecret` rather than the secret, and never the note: a note is where people put the
 * answers to their security questions. This is the shape every list, search result and log
 * line uses, so there is one definition of "safe to show" instead of one per caller.
 */
export function entryMeta(entry) {
  return {
    id: entry.id,
    title: entry.title,
    hasSecret: !!entry.secret,
    updatedAt: entry.updatedAt || 0,
    createdAt: entry.createdAt || 0,
  };
}

/** Search decrypted entries. Titles and notes match; secrets are never searched. */
export function searchEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  // Searching secret material would leak it through timing and through "1 result" on a page
  // that never shows the secret — and nobody searches for a password they already have.
  return entries.filter((e) => `${e.title || ''}\n${e.note || ''}`.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Keys, sealing, opening
// ---------------------------------------------------------------------------

export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS, { subtle } = {}) {
  const s = subtleOf(subtle);
  if (!str(passphrase) || !passphrase) throw new VaultError('NO_PASSPHRASE', 'a passphrase is required');
  const base = await s.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF_HASH },
    base,
    { name: 'AES-GCM', length: 256 },
    // Extractable, because the host has to hand this key to session storage to survive the
    // panel being closed and reopened. It never touches disk — see the client's session-only
    // storage — and a non-extractable key would force a re-prompt on every panel open, which
    // is the kind of friction that makes people choose a weaker passphrase.
    true,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key, plaintextString, { subtle, random } = {}) {
  const s = subtleOf(subtle);
  const iv = randomOf(random)(12); // fresh per seal — an IV reused under one key breaks GCM
  const ct = await s.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintextString));
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function open(key, sealed, { subtle } = {}) {
  const s = subtleOf(subtle);
  if (!sealed?.iv || !sealed?.ct) throw new VaultError('CORRUPT', 'sealed value is missing its iv or ciphertext');
  try {
    const out = await s.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv) }, key, fromB64(sealed.ct));
    return dec.decode(out);
  } catch {
    // AES-GCM authenticates: this is either the wrong key or tampered bytes, and the caller
    // cannot tell which. Both mean "do not trust what came back", which is the only thing
    // the caller needs to act on.
    throw new VaultError('BAD_KEY', 'wrong passphrase, or the data has been altered');
  }
}

/** A brand-new, empty vault. Returns what is safe to write to disk. */
export async function createVault(passphrase, { subtle, random, now = () => Date.now() } = {}) {
  const salt = randomOf(random)(16);
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS, { subtle });
  const verifier = await seal(key, VERIFIER_PLAINTEXT, { subtle, random });
  return {
    vault: {
      version: VAULT_VERSION,
      kdf: { name: 'PBKDF2', hash: KDF_HASH, iterations: KDF_ITERATIONS, salt: toB64(salt) },
      verifier,
      entries: {},
      createdAt: now(),
    },
    key,
  };
}

/**
 * Derive the key and PROVE it is the right one before the caller stores it.
 *
 * Without the proof, a typo would be discovered later, one entry at a time, as
 * "corrupt data" — and a user would reasonably conclude their vault was destroyed.
 */
export async function unlockVault(vault, passphrase, { subtle } = {}) {
  if (!vault?.kdf?.salt) throw new VaultError('NO_VAULT', 'no vault has been created yet');
  if (vault.version > VAULT_VERSION) {
    // Forward-compat is a promise in one direction only. Opening a newer vault with older
    // rules risks writing back something the newer client cannot read.
    throw new VaultError('TOO_NEW', 'this vault was written by a newer version of ChatPanel');
  }
  const key = await deriveKey(passphrase, fromB64(vault.kdf.salt), vault.kdf.iterations || KDF_ITERATIONS, { subtle });
  await open(key, vault.verifier, { subtle }); // throws BAD_KEY on a wrong passphrase
  return key;
}

/** Seal one entry. The whole entry, titles included — see the note at the top. */
export async function sealEntry(key, entry, { subtle, random, now = () => Date.now() } = {}) {
  validateEntry(entry);
  const at = now();
  const full = { ...entry, updatedAt: at, createdAt: entry.createdAt || at };
  const sealed = await seal(key, JSON.stringify(full), { subtle, random });
  // updatedAt is deliberately OUTSIDE the ciphertext as well: a list has to sort without
  // unlocking, and "something changed at 14:02" is not a secret worth the cost of hiding.
  return { id: entry.id, updatedAt: at, ...sealed };
}

export async function openEntry(key, record, { subtle } = {}) {
  const json = await open(key, record, { subtle });
  try {
    const entry = JSON.parse(json);
    return { ...entry, id: record.id ?? entry.id };
  } catch {
    throw new VaultError('CORRUPT', 'entry could not be read');
  }
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export const DEFAULT_LOCK_MS = 15 * 60_000;

/**
 * Auto-lock is measured from the last USE, not from the unlock: a vault someone is actively
 * working in should not lock under their hands, and one they walked away from should.
 */
export function isLocked({ unlockedAt = 0, lastUsedAt = 0, now = Date.now(), timeoutMs = DEFAULT_LOCK_MS } = {}) {
  if (!unlockedAt) return true;
  if (!timeoutMs) return false; // 0 = stay unlocked until the session ends or the user locks
  return now - Math.max(unlockedAt, lastUsedAt) >= timeoutMs;
}

/** How many entries a locked vault may admit to holding. A count is not a secret; names are. */
export function lockedSummary(vault) {
  return { exists: !!vault?.kdf, entries: Object.keys(vault?.entries || {}).length, locked: true };
}

export function canAddEntry(vault) {
  return Object.keys(vault?.entries || {}).length < MAX_ENTRIES;
}
