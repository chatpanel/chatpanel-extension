// At-rest encryption for STORED SECRETS — endpoint API keys, MCP auth headers, and
// OAuth tokens.
//
// SCOPE — same honest bound as meeting-crypto.js. chrome.storage.local is already
// private to this extension (no site / other extension can read it). This adds
// *at-rest obfuscation*: secrets are AES-GCM ciphertext on disk, so a copied /
// synced / backed-up Chrome profile — or another local tool grepping the profile —
// doesn't yield plaintext API keys and tokens. It is NOT protection against an
// attacker who can read this extension's full storage, because the key sits in
// chrome.storage.local beside the data. A passphrase-derived key (kept only in
// chrome.storage.session) would raise that bar at a real UX cost — a deliberate
// opt-in we can add later. For now this closes the "keys are plaintext on disk" gap
// without touching the zero-friction "install → chat" onboarding.
//
// Deliberately a SEPARATE key from meeting-crypto.js (chatpanel:secretKey vs
// chatpanel:meetingKey) so the two domains don't couple. Same envelope shape
// ({ __enc:1, iv, ct }) and the same fail-OPEN discipline: a crypto hiccup NEVER
// loses a user's key — it falls back to storing/returning plaintext.

const K_SECRET_KEY = 'chatpanel:secretKey'; // raw AES-GCM key (base64), generated once
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
    const got = await chrome.storage.local.get(K_SECRET_KEY);
    if (got[K_SECRET_KEY]) {
      return crypto.subtle.importKey('raw', fromB64(got[K_SECRET_KEY]), 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await crypto.subtle.exportKey('raw', key);
    await chrome.storage.local.set({ [K_SECRET_KEY]: toB64(raw) });
    return key;
  })();
  return _keyPromise;
}

// True if a stored value is one of our encryption envelopes (vs legacy plaintext).
export function isSealed(v) {
  return !!v && typeof v === 'object' && v.__enc === 1 && typeof v.ct === 'string';
}

// Encrypt any JSON-serialisable value into a storable envelope. Empty/nullish values
// are passed through unchanged (no point sealing an empty key, and it keeps the
// on-disk shape recognisable). Fail-open: never lose a secret to a crypto error.
export async function sealJSON(value) {
  if (value == null || value === '' || (typeof value === 'object' && !isSealed(value) && Object.keys(value).length === 0)) {
    return value;
  }
  if (isSealed(value)) return value; // already sealed — don't double-wrap
  try {
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(value));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { __enc: 1, iv: toB64(iv), ct: toB64(ct) };
  } catch (e) {
    console.warn('[chatpanel] secret encrypt failed, storing plaintext:', e);
    return value;
  }
}

// Decrypt an envelope back to its value. Plaintext (legacy / fail-open) passes
// through untouched, so reads tolerate a mix of sealed and unsealed values — that's
// what makes the migration transparent (old plaintext → sealed on the next write).
// On a genuine decrypt failure returns undefined (caller keeps the field empty)
// rather than throwing — a lost key must not brick settings loading.
export async function openJSON(value) {
  if (!isSealed(value)) return value;
  try {
    const key = await getKey();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(value.iv) }, key, fromB64(value.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    console.error('[chatpanel] secret decrypt failed (key rotated or storage corrupt?):', e);
    return undefined;
  }
}
