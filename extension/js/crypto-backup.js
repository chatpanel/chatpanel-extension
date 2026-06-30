// Optional passphrase encryption for backups.
//
// Plain backups (the .zip) contain secrets — API keys, MCP auth, OAuth tokens,
// and decrypted meeting transcripts. When the user sets a passphrase we wrap the
// backup in an AES-GCM envelope keyed by PBKDF2(passphrase), so the file on disk
// (or synced to a cloud Downloads folder) is useless without the password.
//
// WebCrypto only — works in both the options page and the background service
// worker. We store NOTHING: a forgotten passphrase means the file is
// unrecoverable, by design. No passphrase → callers keep the existing plaintext
// format. Forward-compatible: the envelope records its own KDF params so we can
// raise the iteration count later without breaking old files.

export const ENCRYPTED_TYPE = 'chatpanel-backup-encrypted';
const KDF_ITERATIONS = 250000; // PBKDF2-SHA256; ~tens of ms, fine for a manual action

function toB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function fromB64(str) {
  const bin = atob(String(str || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedBackup(obj) {
  return !!obj && typeof obj === 'object' && obj.type === ENCRYPTED_TYPE;
}

// Encrypt a backup data object → a JSON-serializable envelope. Each call uses a
// fresh random salt + IV (never reused), so identical data encrypts differently.
export async function encryptBackup(dataObj, passphrase) {
  if (!passphrase) throw new Error('A passphrase is required to encrypt a backup.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(dataObj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return {
    type: ENCRYPTED_TYPE,
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toB64(salt) },
    cipher: 'AES-GCM',
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

// Decrypt an envelope → the original data object. Throws a friendly error on a
// wrong passphrase or a tampered file (AES-GCM auth-tag mismatch catches both).
export async function decryptBackup(envelope, passphrase) {
  if (!isEncryptedBackup(envelope)) throw new Error('That isn’t an encrypted ChatPanel backup.');
  if (!passphrase) throw new Error('This backup is encrypted — enter its password to restore it.');
  const key = await deriveKey(passphrase, fromB64(envelope.kdf?.salt), envelope.kdf?.iterations || KDF_ITERATIONS);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct));
  } catch {
    throw new Error('Wrong password, or the backup file is corrupted.');
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}
