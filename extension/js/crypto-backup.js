// Optional passphrase encryption for backups.
//
// Plain backups (the .zip) contain secrets — API keys, MCP auth, OAuth tokens,
// and decrypted meeting transcripts. When the user sets a passphrase we wrap the
// backup in an AES-GCM envelope keyed by PBKDF2(passphrase), so the file on disk
// (or synced to a cloud Downloads folder) is useless without the password.
//
// WebCrypto only — works in both the options page and the background service
// worker. This module stores nothing; the automatic-backup scheduler may keep a
// device-wrapped copy so it can run unattended. A forgotten passphrase still
// makes a backup file unrecoverable on another machine. Forward-compatible: the envelope records its own KDF params so we can
// raise the iteration count later without breaking old files.

export const ENCRYPTED_TYPE = 'chatpanel-backup-encrypted';
const KDF_ITERATIONS = 250000; // PBKDF2-SHA256; ~tens of ms, fine for a manual action

// Compress-then-encrypt. Ciphertext is indistinguishable from random and won't
// compress, so compression MUST run on the plaintext first. Prefer native Brotli
// for the smallest text-heavy backups, fall back to universally-supported gzip,
// then to no compression. The envelope records the codec so older gzip backups
// keep restoring forever.
function supportsCompression(format) {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') return false;
  try {
    new CompressionStream(format);
    new DecompressionStream(format);
    return true;
  } catch {
    return false;
  }
}

export function bestBackupCompression() {
  if (supportsCompression('brotli')) return 'brotli';
  if (supportsCompression('gzip')) return 'gzip';
  return 'none';
}

async function compress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function decompress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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
  let payload = new TextEncoder().encode(JSON.stringify(dataObj));
  const compression = bestBackupCompression();
  if (compression !== 'none') payload = await compress(payload, compression);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  return {
    type: ENCRYPTED_TYPE,
    version: compression === 'brotli' ? 3 : 2,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toB64(salt) },
    cipher: 'AES-GCM',
    compression,
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
  let payload;
  try {
    payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct)));
  } catch {
    throw new Error('Wrong password, or the backup file is corrupted.');
  }
  // v1 envelopes have no `compression` key. v2 uses gzip; v3 may use Brotli.
  const compression = envelope.compression || 'none';
  if (compression !== 'none') {
    if (!supportsCompression(compression)) {
      throw new Error(`This browser cannot decompress ${compression} ChatPanel backups. Update Chrome and try again.`);
    }
    payload = await decompress(payload, compression);
  }
  return JSON.parse(new TextDecoder().decode(payload));
}
