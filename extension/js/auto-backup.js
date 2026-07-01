// Automatic daily backup to disk (Pro, opt-in).
//
// Why this exists: chrome.storage.local and the meeting IndexedDB are scoped to
// the *extension ID*. A manual reinstall (unpacked, or a sideload) can change
// that ID and orphan all of the user's data — chats, meetings, settings. The fix
// is to keep a copy *outside* extension storage. We write the same full portable
// .zip the manual "Export all data" produces into Downloads/ChatPanel Backups/,
// rotating by weekday so the last 7 days survive without the user ever confirming
// a save. After a reinstall the user restores it with Settings → Restore.
//
// SECURITY: this file contains secrets (API keys, MCP auth, OAuth tokens) exactly
// like the manual export. It is therefore strictly Pro + opt-in, the entitlement
// is re-checked on every scheduled run (fail-closed), and we only ever write to a
// fixed, non-interpolated path under the user's own Downloads dir. Nothing is
// uploaded — chrome.downloads writes to the local disk only.

import { exportAllData, exportDataArchive } from './store.js';
import { getLicense, can } from './license.js';
import { encryptBackup } from './crypto-backup.js';

const K_STATE = 'chatpanel:autoBackup';
export const BACKUP_ALARM = 'chatpanel-auto-backup';
const FOLDER = 'ChatPanel Backups';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `passphrase` (optional) encrypts the on-disk files. It's stored here because
// the backup runs unattended in the service worker — documented as a tradeoff in
// the UI. It protects the file once it leaves the machine, not against someone
// who already has full extension-storage access.
const DEFAULT_STATE = { enabled: false, passphrase: '', lastAt: 0, lastHash: '', lastError: '', count: 0, meetingsCount: 0, lastBytes: 0, hour: null };

export async function getBackupState() {
  const got = await chrome.storage.local.get(K_STATE);
  return { ...DEFAULT_STATE, ...(got[K_STATE] && typeof got[K_STATE] === 'object' ? got[K_STATE] : {}) };
}

async function patchBackupState(patch) {
  const next = { ...(await getBackupState()), ...patch };
  await chrome.storage.local.set({ [K_STATE]: next });
  return next;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Binary → base64 for the zip path (the encrypted path is already a JSON string
// and crosses to the offscreen doc as text — no base64 needed there).
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// The SW does the export + compress + encrypt (it has chrome.storage; an offscreen
// document does NOT). The offscreen doc's ONLY job is URL.createObjectURL, which a
// service worker lacks — so we hand it the (already-compressed) payload and get a
// blob: URL back, sidestepping the base64 data: URL size ceiling. Idempotent.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Build the backup file as a blob URL (service workers cannot create object URLs).',
    });
  } catch (e) {
    // Racing creators can throw "already exists" — tolerate it.
    if (!String(e?.message || e).includes('Only a single offscreen')) throw e;
  }
}

// Revoke the blob URL once the download settles, then close the offscreen doc so
// its memory (the whole backup Blob) is freed. Best-effort.
function releaseAfterDownload(downloadId, url) {
  const onChanged = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    const s = delta.state.current;
    if (s !== 'complete' && s !== 'interrupted') return;
    chrome.downloads.onChanged.removeListener(onChanged);
    chrome.runtime.sendMessage({ type: 'cp-backup-revoke', url }).catch(() => {});
    chrome.offscreen.closeDocument?.().catch(() => {});
  };
  chrome.downloads.onChanged.addListener(onChanged);
}

// Delete our own backup files in the OTHER format (regex fragment for the
// extension) across every weekday slot — so switching encryption on doesn't leave
// stale plaintext .zip copies behind (and vice versa). Matched by basename so it
// works regardless of OS path separator, and scoped tightly to our own file
// naming. removeFile deletes from disk; erase clears the download-history entry.
// Best-effort: never let cleanup fail a backup.
async function deleteOtherFormat(extRegex) {
  try {
    const items = await chrome.downloads.search({ filenameRegex: `chatpanel-backup-[A-Za-z]+\\.${extRegex}$` });
    for (const it of items) {
      await chrome.downloads.removeFile(it.id).catch(() => {});
      await chrome.downloads.erase({ id: it.id }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

// Run one backup. `force` writes even when nothing changed (the "Back up now"
// button / the toggle-on confirmation); the scheduled path skips an unchanged
// snapshot so an idle week doesn't rewrite the same file daily ("incremental":
// write only on change). Returns a small status object; never throws.
export async function runAutoBackup({ force = false } = {}) {
  try {
    const license = await getLicense();
    if (!can(license, 'autoBackup')) {
      await patchBackupState({ lastError: 'Auto-backup is a Pro feature.' });
      return { ok: false, reason: 'not-pro' };
    }
    // Export + hash in the SW (it has chrome.storage; the offscreen doc doesn't).
    const data = await exportAllData();
    if (!data.count && !data.meetingsCount) return { ok: false, reason: 'empty' };
    const hash = await sha256Hex(JSON.stringify(data));
    const state = await getBackupState();

    // "Incremental": skip rewriting an unchanged snapshot on the scheduled path.
    if (!force && hash === state.lastHash) {
      return { ok: true, skipped: true, count: data.count, meetingsCount: data.meetingsCount };
    }

    // Build the payload here (compress-then-encrypt, or the deflate .zip). The
    // encrypted envelope is already a JSON string so it crosses to the offscreen
    // doc as `text` (no base64); the binary .zip crosses as base64.
    let payload, ext;
    if (state.passphrase) {
      const envelope = await encryptBackup(data, state.passphrase);
      payload = { text: JSON.stringify(envelope), mime: 'application/json' };
      ext = 'encrypted.json';
    } else {
      const { blob } = await exportDataArchive(data);
      payload = { b64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mime: 'application/zip' };
      ext = 'zip';
    }

    // Fixed, non-interpolated path under the user's Downloads dir. Weekday name
    // gives an automatic 7-file rolling window via conflictAction:'overwrite'.
    const slot = `chatpanel-backup-${WEEKDAYS[new Date().getDay()]}`;
    const filename = `${FOLDER}/${slot}.${ext}`;

    // Primary: an offscreen document turns the payload into a blob: URL (no data:
    // URL size ceiling). Fallback: a data: URL built right here — reliable now
    // that compression keeps payloads small. Either way the same file lands.
    let bytes = 0;
    let downloaded = false;
    try {
      await ensureOffscreen();
      const built = await chrome.runtime.sendMessage({ type: 'cp-blob-url', ...payload });
      if (built?.url) {
        bytes = built.bytes || 0;
        const downloadId = await chrome.downloads.download({ url: built.url, filename, conflictAction: 'overwrite', saveAs: false });
        releaseAfterDownload(downloadId, built.url); // revoke + close offscreen when it settles
        downloaded = true;
      }
    } catch {
      /* fall through to the data: URL path */
    }
    if (!downloaded) {
      const b64 = payload.b64 || bytesToBase64(new TextEncoder().encode(payload.text));
      bytes = Math.floor((b64.length * 3) / 4);
      await chrome.downloads.download({ url: `data:${payload.mime};base64,${b64}`, filename, conflictAction: 'overwrite', saveAs: false });
    }

    // Remove any backups in the OTHER format so a plaintext .zip can't linger on
    // disk after the user turns encryption on (and vice versa). chrome.downloads
    // can only delete files it wrote itself — which our daily backups are.
    await deleteOtherFormat(ext === 'zip' ? 'encrypted\\.json' : 'zip');

    await patchBackupState({
      lastAt: Date.now(),
      lastHash: hash,
      lastError: '',
      count: data.count,
      meetingsCount: data.meetingsCount,
      lastBytes: bytes,
    });
    return { ok: true, count: data.count, meetingsCount: data.meetingsCount, bytes };
  } catch (e) {
    await patchBackupState({ lastError: String(e?.message || e) });
    return { ok: false, reason: 'error', error: String(e?.message || e) };
  }
}

// Minutes until the next local occurrence of `hour`:00 (0–23). Used to pin the
// daily backup to a time of day instead of "24h after it was armed".
function minutesUntilHour(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.max(1, Math.round((next - now) / 60000));
}

// Create or clear the daily alarm to match the saved preference. Idempotent —
// safe to call on install, on startup, and whenever the toggle/time flips.
// `hour` null → the old "~24h after arming" cadence; 0–23 → daily at that local
// hour. periodInMinutes:1440 keeps it daily; the delay sets the FIRST fire (it
// can drift up to an hour across DST — acceptable for a backup).
export async function syncBackupAlarm() {
  const { enabled, hour } = await getBackupState();
  if (!enabled) {
    await chrome.alarms.clear(BACKUP_ALARM);
    return;
  }
  const delayInMinutes = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? minutesUntilHour(hour) : 1440;
  chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: 1440, delayInMinutes });
}

// Persist the daily backup time. `hour` 0–23 pins it to that local hour; null (or
// '') restores the "~24h" cadence. Re-arms the alarm immediately.
export async function setAutoBackupHour(hour) {
  const h = hour === null || hour === '' || hour === undefined ? null : Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
  await patchBackupState({ hour: h });
  await syncBackupAlarm();
  return { ok: true, hour: h };
}

// Persist the optional disk-encryption passphrase. Empty string disables
// encryption (future backups go out as plain .zip).
export async function setAutoBackupPassphrase(passphrase) {
  await patchBackupState({ passphrase: String(passphrase || '') });
}

// Toggle handler for the settings UI. Turning it on runs an immediate first
// backup so the user sees it work; turning it off clears the schedule.
export async function setAutoBackupEnabled(enabled) {
  await patchBackupState({ enabled: !!enabled });
  await syncBackupAlarm();
  if (enabled) return await runAutoBackup({ force: true });
  return { ok: true };
}
