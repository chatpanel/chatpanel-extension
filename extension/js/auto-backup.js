// Automatic daily encrypted backup to local disk, Google Drive, or both (Pro).
//
// Why this exists: chrome.storage.local and the meeting IndexedDB are scoped to
// the *extension ID*. A manual reinstall (unpacked, or a sideload) can change
// that ID and orphan all of the user's data — chats, meetings, settings. The fix
// is to keep a copy *outside* extension storage. The user chooses Downloads,
// Google Drive, or both. Each destination rotates seven encrypted weekday files.
//
// SECURITY: this file contains secrets (API keys, MCP auth, OAuth tokens) exactly
// like the manual export. It is therefore strictly Pro + opt-in, the entitlement
// is re-checked on every scheduled run (fail-closed), and we only ever write to a
// fixed, non-interpolated locations. Drive receives only the encrypted Blob.

import { exportAllData, getSettings } from './store.js';
import { getLicense, can, getInstallId } from './license.js';
import { encryptBackup } from './crypto-backup.js';
import { uploadEncryptedBackupToDrive } from './drive-backup.js';
import { isSealed, openJSON, sealJSON } from './secret-crypto.js';

const K_STATE = 'chatpanel:autoBackup';
const K_SESSION_PASSPHRASE = 'chatpanel:autoBackupPassphrase';
export const BACKUP_ALARM = 'chatpanel-auto-backup';
const FOLDER = 'ChatPanel Backups';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let backupRun = null;

const DEFAULT_STATE = {
  enabled: false, lastAt: 0, lastDay: '', lastHash: '', lastError: '',
  lastGatewayError: '', count: 0, meetingsCount: 0, lastBytes: 0, hour: 20,
  gatewayBackupIndex: false, destination: 'local', lastDriveFileId: '',
  deviceId: '', deviceName: '',
};

export function backupDeviceSlot(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length < 12) throw new Error('Could not create a stable backup identity for this device.');
  return normalized.slice(0, 16);
}

export function normalizeBackupDeviceName(value, deviceId = '') {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  if (clean) return clean;
  const suffix = backupDeviceSlot(deviceId).slice(-6);
  return `Device ${suffix}`;
}

export function backupFilenameForDevice(deviceId, value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return `chatpanel-backup-${backupDeviceSlot(deviceId)}-${WEEKDAYS[d.getDay()]}.encrypted.json`;
}

export async function getBackupState() {
  const got = await chrome.storage.local.get(K_STATE);
  const stored = got[K_STATE] && typeof got[K_STATE] === 'object' ? { ...got[K_STATE] } : {};
  let stateChanged = false;
  let sessionPassphrase = '';
  try { sessionPassphrase = (await chrome.storage.session.get(K_SESSION_PASSPHRASE))[K_SESSION_PASSPHRASE] || ''; } catch { /* unavailable */ }
  if (!sessionPassphrase && isSealed(stored.encryptedPassphrase)) {
    const unlocked = await openJSON(stored.encryptedPassphrase);
    if (typeof unlocked === 'string') sessionPassphrase = unlocked;
  }
  // One-time security migration: replace a legacy plaintext persisted password
  // with a device-local AES-GCM envelope. Never retain plaintext on disk.
  if (stored.passphrase) {
    sessionPassphrase ||= String(stored.passphrase);
    try { await chrome.storage.session.set({ [K_SESSION_PASSPHRASE]: sessionPassphrase }); } catch { /* unavailable */ }
    const sealed = await sealJSON(sessionPassphrase);
    if (isSealed(sealed)) stored.encryptedPassphrase = sealed;
    delete stored.passphrase;
    stateChanged = true;
  }
  const priorDeviceId = stored.deviceId;
  try {
    stored.deviceId = backupDeviceSlot(priorDeviceId || await getInstallId());
  } catch {
    stored.deviceId = backupDeviceSlot(await getInstallId());
  }
  const deviceName = normalizeBackupDeviceName(stored.deviceName, stored.deviceId);
  if (stored.deviceName !== deviceName) {
    stored.deviceName = deviceName;
    stateChanged = true;
  }
  if (priorDeviceId !== stored.deviceId) stateChanged = true;
  if (stateChanged) await chrome.storage.local.set({ [K_STATE]: stored });
  const out = { ...DEFAULT_STATE, ...stored, passphrase: sessionPassphrase };
  if (!Number.isInteger(out.hour) || out.hour < 0 || out.hour > 23) out.hour = DEFAULT_STATE.hour;
  out.destination = normalizeBackupDestination(out.destination);
  return out;
}

async function patchBackupState(patch) {
  const next = { ...(await getBackupState()), ...patch };
  const { passphrase, ...persistent } = next;
  await chrome.storage.local.set({ [K_STATE]: persistent });
  if (Object.prototype.hasOwnProperty.call(patch, 'passphrase')) {
    try {
      if (passphrase) await chrome.storage.session.set({ [K_SESSION_PASSPHRASE]: passphrase });
      else await chrome.storage.session.remove(K_SESSION_PASSPHRASE);
    } catch { /* unavailable */ }
  }
  return next;
}

export function normalizeBackupDestination(value) {
  return value === 'drive' || value === 'both' ? value : 'local';
}

export function backupDestinationIncludes(destination, target) {
  const value = normalizeBackupDestination(destination);
  return value === 'both' || value === target;
}

// Connecting Drive is an explicit request to use it. Replace only the untouched
// local default; preserve an existing Drive/Both choice.
export function destinationAfterDriveConnect(destination) {
  const value = normalizeBackupDestination(destination);
  return value === 'local' ? 'drive' : value;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function backupDayKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// exportAllData stamps exportedAt on every call. It is transport metadata, not a
// content change; hashing it made every browser startup look like new data.
export function stableBackupJson(data) {
  return JSON.stringify({ ...data, exportedAt: 0 });
}

export function scheduledBackupDue(state, now = new Date()) {
  if (!state?.enabled || !state.passphrase) return false;
  const hour = Number.isInteger(state.hour) ? state.hour : DEFAULT_STATE.hour;
  if (now.getHours() < hour) return false;
  const lastDay = state.lastDay || (state.lastAt ? backupDayKey(state.lastAt) : '');
  return lastDay !== backupDayKey(now);
}

// Binary → base64 for the encrypted JSON data URL.
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}


// Delete our own backup files in the OTHER format (regex fragment for the
// extension) across every weekday slot — so switching encryption on doesn't leave
// stale plaintext .zip copies behind (and vice versa). Matched by basename so it
// works regardless of OS path separator, and scoped tightly to our own file
// naming. removeFile deletes from disk; erase clears the download-history entry.
// Best-effort: never let cleanup fail a backup.
async function deleteOtherFormat(extRegex) {
  try {
    const items = await chrome.downloads.search({ filenameRegex: `chatpanel-backup-(?:[a-z0-9]{12,16}-)?[A-Za-z]+\\.${extRegex}$` });
    for (const it of items) {
      await chrome.downloads.removeFile(it.id).catch(() => {});
      await chrome.downloads.erase({ id: it.id }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

async function waitForDownload(downloadId, timeoutMs = 10 * 60 * 1000) {
  const current = await chrome.downloads.search({ id: downloadId });
  if (current[0]?.state === 'complete') return current[0];
  if (current[0]?.state === 'interrupted') throw new Error(current[0]?.error || 'Backup download was interrupted.');
  return new Promise((resolve, reject) => {
    let timer;
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') finish(null, delta);
      else if (delta.state.current === 'interrupted') finish(new Error(delta.error?.current || 'Backup download was interrupted.'));
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error('Timed out waiting for the backup file to finish writing.')), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function handOffKeyAndIngest(state) {
  if (!state.gatewayBackupIndex) return '';
  try {
    const settings = await getSettings();
    const base = String(settings.gatewayUrl || settings.ui?.warmSearch?.url || 'http://127.0.0.1:4320').replace(/\/+$/, '');
    const res = await fetch(`${base}/v1/history/key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: state.passphrase }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw new Error(body?.error?.message || body?.error || `gateway ${res.status}`);
    return '';
  } catch (e) {
    return String(e?.message || e);
  }
}

// Coalesce startup, alarm, and manual triggers. Browser startup can deliver a
// persisted alarm at the same moment as catch-up; only one writer may own the
// fixed weekday filename or update the completion marker.
export async function coalesceBackupRun(start) {
  if (backupRun) return backupRun;
  backupRun = Promise.resolve().then(start);
  try { return await backupRun; } finally { backupRun = null; }
}

// Run one backup. `force` is the explicit "Back up now" path. The scheduled path
// is admitted only once per local calendar day by scheduledBackupDue(). Returns a
// small status object and never throws.
export function runAutoBackup(options = {}) {
  return coalesceBackupRun(() => runAutoBackupOnce(options));
}

async function runAutoBackupOnce({ force = false, now = new Date() } = {}) {
  try {
    const license = await getLicense();
    if (!can(license, 'autoBackup')) {
      await patchBackupState({ lastError: 'Auto-backup is a Pro feature.' });
      return { ok: false, reason: 'not-pro' };
    }
    const state = await getBackupState();
    if (!state.passphrase) {
      await patchBackupState({ lastError: 'Set a backup password before running automatic backup.' });
      return { ok: false, reason: 'passphrase-required' };
    }
    if (!force && !scheduledBackupDue(state, now)) return { ok: true, skipped: true, reason: 'not-due' };

    // Export + stable content hash.
    const data = await exportAllData();
    if (!data.count && !data.meetingsCount && !data.notesCount) return { ok: false, reason: 'empty' };
    const hash = await sha256Hex(stableBackupJson(data));

    // Compress then encrypt exactly once. Both destinations receive the identical
    // ciphertext; Drive-only never invokes chrome.downloads or persists locally.
    const envelope = await encryptBackup(data, state.passphrase);
    const text = JSON.stringify(envelope);
    const blob = new Blob([text], { type: 'application/json' });
    const bytes = blob.size;

    // Fixed, non-interpolated path under the user's Downloads dir. Weekday name
    // gives an automatic 7-file rolling window via conflictAction:'overwrite'.
    const basename = backupFilenameForDevice(state.deviceId, now);
    const filename = `${FOLDER}/${basename}`;

    let driveFile = null;
    if (backupDestinationIncludes(state.destination, 'drive')) {
      driveFile = await uploadEncryptedBackupToDrive(blob, {
        filename: basename,
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        weekday: WEEKDAYS[now.getDay()],
      });
    }

    if (backupDestinationIncludes(state.destination, 'local')) {
      // data: URLs write silently with saveAs:false. blob: URLs can trigger Save As.
      const b64 = bytesToBase64(new TextEncoder().encode(text));
      const downloadId = await chrome.downloads.download({
        url: `data:application/json;base64,${b64}`, filename,
        conflictAction: 'overwrite', saveAs: false,
      });
      await waitForDownload(downloadId);
      await deleteOtherFormat('zip');
    }

    const lastGatewayError = backupDestinationIncludes(state.destination, 'local')
      ? await handOffKeyAndIngest(state)
      : '';

    await patchBackupState({
      lastAt: now.getTime(),
      lastDay: backupDayKey(now),
      lastHash: hash,
      lastError: '',
      lastGatewayError,
      count: data.count,
      meetingsCount: data.meetingsCount,
      lastBytes: bytes,
      lastDriveFileId: driveFile?.id || state.lastDriveFileId || '',
    });
    return { ok: true, count: data.count, meetingsCount: data.meetingsCount, bytes, destination: state.destination };
  } catch (e) {
    await patchBackupState({ lastError: String(e?.message || e) });
    return { ok: false, reason: 'error', error: String(e?.message || e) };
  }
}

export async function runScheduledBackupIfDue({ now = new Date() } = {}) {
  const state = await getBackupState();
  if (!scheduledBackupDue(state, now)) return { ok: true, skipped: true, reason: 'not-due' };
  return runAutoBackup({ force: false, now });
}

// Next local occurrence of `hour`:00 (0–23). A one-shot absolute alarm is
// re-armed after every run so daylight-saving changes cannot drift the schedule.
function nextBackupTime(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

// Create or clear the daily alarm to match the saved preference. Idempotent —
// safe to call on install, on startup, and whenever the toggle/time flips.
// A concrete 0–23 local hour is always used. The one-shot alarm is recreated
// after firing, preserving the selected wall-clock hour across DST changes.
export async function syncBackupAlarm() {
  const { enabled, passphrase, hour } = await getBackupState();
  if (!enabled || !passphrase) {
    await chrome.alarms.clear(BACKUP_ALARM);
    return;
  }
  chrome.alarms.create(BACKUP_ALARM, { when: nextBackupTime(hour) });
}

// Persist the daily backup time. `hour` 0–23 pins it to that local hour and re-arms
// the alarm immediately.
export async function setAutoBackupHour(hour) {
  const parsed = parseInt(hour, 10);
  const h = Number.isInteger(parsed) ? Math.max(0, Math.min(23, parsed)) : DEFAULT_STATE.hour;
  await patchBackupState({ hour: h });
  await syncBackupAlarm();
  return { ok: true, hour: h };
}

// Automatic backup fails closed while the passphrase is empty.
export async function setAutoBackupPassphrase(passphrase) {
  const value = String(passphrase || '');
  const encryptedPassphrase = value ? await sealJSON(value) : '';
  if (value && !isSealed(encryptedPassphrase)) {
    throw new Error('Could not securely store the backup password. Automatic backup was not enabled.');
  }
  await patchBackupState({ passphrase: value, encryptedPassphrase, lastError: '' });
  await syncBackupAlarm();
}

export async function setAutoBackupDestination(destination) {
  await patchBackupState({ destination: normalizeBackupDestination(destination), lastError: '' });
}

export async function setBackupDeviceName(name) {
  const state = await getBackupState();
  const deviceName = normalizeBackupDeviceName(name, state.deviceId);
  await patchBackupState({ deviceName });
  return { ok: true, deviceName };
}

export async function setBackupGatewayIndex(enabled) {
  await patchBackupState({ gatewayBackupIndex: !!enabled });
}

// Toggle handler for the settings UI. Turning it on only arms the schedule;
// turning it off clears the schedule.
export async function setAutoBackupEnabled(enabled) {
  const state = await getBackupState();
  if (enabled && !state.passphrase) {
    await patchBackupState({ enabled: false });
    await syncBackupAlarm();
    return { ok: false, reason: 'passphrase-required' };
  }
  await patchBackupState({ enabled: !!enabled });
  await syncBackupAlarm();
  return { ok: true, scheduled: !!enabled };
}
