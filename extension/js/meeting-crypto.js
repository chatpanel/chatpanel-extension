// At-rest encryption for stored meeting transcripts.
//
// SCOPE — read this before trusting it. chrome.storage.local is already private to
// this extension: no website and no other extension can read it. What this adds is
// *at-rest obfuscation* — transcripts are AES-GCM ciphertext on disk, so they're
// not readable as plaintext if the Chrome profile is copied, backed up, or synced,
// and they're not greppable by other local tools.
//
// It is NOT protection against an attacker who can read this extension's full
// storage, because the key lives in chrome.storage.local alongside the data. For
// that threat you'd need a key derived from a user passphrase and never written to
// disk (kept only in chrome.storage.session) — a deliberate UX cost we can add as
// an opt-in later. For meeting notes, obfuscation-at-rest is the sensible default.

const K_KEY = 'chatpanel:meetingKey'; // raw AES-GCM key (base64), generated once
const B64_CHUNK = 0x8000;
let _keyPromise = null;

function toB64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function fromB64(s) {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function getKey() {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    const got = await chrome.storage.local.get(K_KEY);
    if (got[K_KEY]) {
      return crypto.subtle.importKey('raw', fromB64(got[K_KEY]), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const raw = await crypto.subtle.exportKey('raw', key);
    await chrome.storage.local.set({ [K_KEY]: toB64(raw) });
    return key;
  })();
  return _keyPromise;
}

// True if a stored value is one of our encryption envelopes (vs legacy plaintext).
export function isEncrypted(v) {
  return !!v && typeof v === 'object' && v.__enc === 1 && typeof v.ct === 'string';
}

// Encrypt any JSON-serialisable value into a storable envelope.
export async function encryptJSON(obj) {
  try {
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { __enc: 1, iv: toB64(iv), ct: toB64(ct) };
  } catch (e) {
    // Never lose data to a crypto hiccup — fall back to storing plaintext.
    console.warn('[chatpanel] meeting encrypt failed, storing plaintext:', e);
    return obj;
  }
}

// Decrypt an envelope back to its value. Passes plaintext (legacy/fallback) through
// untouched, so reads tolerate a mix of encrypted and unencrypted records.
export async function decryptJSON(value) {
  if (!isEncrypted(value)) return value;
  try {
    const key = await getKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(value.iv) },
      key,
      fromB64(value.ct),
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    console.warn('[chatpanel] meeting decrypt failed:', e);
    return null;
  }
}
