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

import { getLicense, can } from './license.js';

const K_STATE = 'chatpanel:autoBackup';
export const BACKUP_ALARM = 'chatpanel-auto-backup';
const FOLDER = 'ChatPanel Backups';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `passphrase` (optional) encrypts the on-disk files. It's stored here because
// the backup runs unattended in the service worker — documented as a tradeoff in
// the UI. It protects the file once it leaves the machine, not against someone
// who already has full extension-storage access.
const DEFAULT_STATE = { enabled: false, passphrase: '', lastAt: 0, lastHash: '', lastError: '', count: 0, meetingsCount: 0, lastBytes: 0 };

export async function getBackupState() {
  const got = await chrome.storage.local.get(K_STATE);
  return { ...DEFAULT_STATE, ...(got[K_STATE] && typeof got[K_STATE] === 'object' ? got[K_STATE] : {}) };
}

async function patchBackupState(patch) {
  const next = { ...(await getBackupState()), ...patch };
  await chrome.storage.local.set({ [K_STATE]: next });
  return next;
}

// Build the backup in an offscreen document — it has URL.createObjectURL (a
// service worker doesn't) and more memory headroom, so we download a blob: URL
// instead of a huge base64 data: URL that fails past ~tens of MB. Idempotent.
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
    const state = await getBackupState();

    // Build the file in the offscreen document: it does the export + optional
    // compress-then-encrypt and returns a blob: URL + content hash. The large
    // bytes stay over there; only the small URL/hash cross back.
    await ensureOffscreen();
    const built = await chrome.runtime.sendMessage({ type: 'cp-backup-build', passphrase: state.passphrase });
    if (!built) return { ok: false, reason: 'no-offscreen' };
    if (built.empty) return { ok: false, reason: 'empty' };
    if (built.error) {
      await patchBackupState({ lastError: built.error });
      return { ok: false, reason: 'error', error: built.error };
    }

    // "Incremental": skip rewriting an unchanged snapshot on the scheduled path.
    if (!force && built.hash === state.lastHash) {
      chrome.runtime.sendMessage({ type: 'cp-backup-revoke', url: built.url }).catch(() => {});
      await chrome.offscreen.closeDocument?.().catch(() => {});
      return { ok: true, skipped: true, count: built.count, meetingsCount: built.meetingsCount };
    }

    // Fixed, non-interpolated path under the user's Downloads dir. Weekday name
    // gives an automatic 7-file rolling window via conflictAction:'overwrite'.
    const slot = `chatpanel-backup-${WEEKDAYS[new Date().getDay()]}`;
    const downloadId = await chrome.downloads.download({
      url: built.url,
      filename: `${FOLDER}/${slot}.${built.ext}`,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    releaseAfterDownload(downloadId, built.url); // revoke + close offscreen when it settles

    // Remove any backups in the OTHER format so a plaintext .zip can't linger on
    // disk after the user turns encryption on (and vice versa). chrome.downloads
    // can only delete files it wrote itself — which our daily backups are.
    await deleteOtherFormat(built.ext === 'zip' ? 'encrypted\\.json' : 'zip');

    await patchBackupState({
      lastAt: Date.now(),
      lastHash: built.hash,
      lastError: '',
      count: built.count,
      meetingsCount: built.meetingsCount,
      lastBytes: built.bytes || 0,
    });
    return { ok: true, count: built.count, meetingsCount: built.meetingsCount, bytes: built.bytes };
  } catch (e) {
    await patchBackupState({ lastError: String(e?.message || e) });
    return { ok: false, reason: 'error', error: String(e?.message || e) };
  }
}

// Create or clear the daily alarm to match the saved preference. Idempotent —
// safe to call on install, on startup, and whenever the toggle flips.
export async function syncBackupAlarm() {
  const { enabled } = await getBackupState();
  if (enabled) {
    chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: 1440, delayInMinutes: 1440 });
  } else {
    await chrome.alarms.clear(BACKUP_ALARM);
  }
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
