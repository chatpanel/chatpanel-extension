// Offscreen builder for the auto-backup (see offscreen.html for the why).
//
// The service worker asks us to build the backup; we do the export + optional
// encryption HERE (a real document with createObjectURL + more memory headroom
// than a SW), then return a blob: URL + the content hash. The large bytes never
// cross the message boundary — only the small URL/hash do. The SW downloads the
// blob URL and tells us to revoke it when the download settles.
//
// SECURITY: same data as the manual export (secrets, decrypted transcripts). It
// stays on-device — a blob: URL is in-memory and extension-scoped; nothing is
// sent anywhere. The SW re-checks Pro before asking us to build.

import { exportAllData, exportDataArchive } from './js/store.js';
import { encryptBackup } from './js/crypto-backup.js';

const urls = new Map(); // url -> revoke, so we can free memory on request

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function build(passphrase) {
  const data = await exportAllData();
  if (!data.count && !data.meetingsCount) return { empty: true };
  const hash = await sha256Hex(JSON.stringify(data));
  let blob, ext;
  if (passphrase) {
    // compress-then-encrypt happens inside encryptBackup; one JSON envelope out.
    const envelope = await encryptBackup(data, passphrase);
    blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
    ext = 'encrypted.json';
  } else {
    ({ blob } = await exportDataArchive(data)); // already deflate-compressed .zip
    ext = 'zip';
  }
  const url = URL.createObjectURL(blob);
  urls.set(url, true);
  return { ok: true, url, ext, hash, count: data.count, meetingsCount: data.meetingsCount, bytes: blob.size };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'cp-backup-build') {
    build(msg.passphrase || '')
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true; // async response
  }
  if (msg?.type === 'cp-backup-revoke') {
    if (msg.url && urls.has(msg.url)) {
      try {
        URL.revokeObjectURL(msg.url);
      } catch {
        /* already gone */
      }
      urls.delete(msg.url);
    }
    sendResponse?.({ ok: true });
    return false;
  }
  return false;
});
