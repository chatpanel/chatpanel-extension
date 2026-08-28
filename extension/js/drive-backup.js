// Google Drive transport for encrypted ChatPanel backups.
//
// Security boundary: callers hand this module an already-encrypted Blob. This
// module never sees plaintext backup data or the backup password, never writes a
// temporary local file, and stores Drive OAuth credentials separately from the
// portable backup. The narrow drive.file scope limits ChatPanel to files it
// created or the user explicitly opened with it.

import { sealJSON, openJSON } from './secret-crypto.js';
import { createOAuthState } from './oauth.js';

const K_DRIVE_AUTH = 'chatpanel:googleDriveAuth';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const OAUTH_BROKER = 'https://api.chatpanel.net/oauth/google';
const AUTH_TRANSPORT = 'broker-v1';
const FOLDER_NAME = 'ChatPanel Backups';
const EXPIRY_SKEW_MS = 60_000;
const LEGACY_BACKUP_RE = /^chatpanel-backup-(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\.encrypted\.json$/;
const DEVICE_BACKUP_RE = /^chatpanel-backup-([a-z0-9]{12,16})-(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\.encrypted\.json$/;
const WEEKDAY_NAMES = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

function browserIdentity(explicit) {
  const api = explicit || globalThis.browser?.identity || globalThis.chrome?.identity;
  if (!api?.getRedirectURL) throw new Error('Browser identity API is unavailable.');
  return api;
}

export function googleDriveRedirectUri(identityApi) {
  return browserIdentity(identityApi).getRedirectURL('oauth/google-drive');
}

export function buildGoogleDriveAuthorizationUrl({ redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    return_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
  });
  return `${OAUTH_BROKER}/authorize?${params}`;
}

async function loadAuth() {
  const got = await chrome.storage.local.get(K_DRIVE_AUTH);
  return (await openJSON(got[K_DRIVE_AUTH])) || null;
}

async function saveAuth(auth) {
  if (!auth) {
    await chrome.storage.local.remove(K_DRIVE_AUTH);
    return;
  }
  await chrome.storage.local.set({ [K_DRIVE_AUTH]: await sealJSON(auth) });
}

async function responseError(res, prefix) {
  const text = await res.text().catch(() => '');
  let message = text;
  try { message = JSON.parse(text)?.error?.message || text; } catch { /* raw response */ }
  throw new Error(`${prefix}: HTTP ${res.status}${message ? ` — ${String(message).slice(0, 300)}` : ''}`);
}

async function exchangeBroker(path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${OAUTH_BROKER}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return responseError(res, 'Google Drive authorization failed');
  const json = await res.json();
  if (!json.access_token) throw new Error('Google Drive authorization did not return an access token.');
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || '',
    token_type: json.token_type || 'Bearer',
    expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0,
  };
}

export async function connectGoogleDrive({ fetchImpl = fetch, identityApi } = {}) {
  const identity = browserIdentity(identityApi);
  if (!identity.launchWebAuthFlow) throw new Error('Browser identity API is unavailable.');
  const redirectUri = googleDriveRedirectUri(identity);
  const pkce = await createOAuthState();
  const url = buildGoogleDriveAuthorizationUrl({
    redirectUri, state: pkce.state, codeChallenge: pkce.challenge,
  });
  const redirected = await identity.launchWebAuthFlow({ url, interactive: true });
  const result = new URL(redirected);
  if (result.searchParams.get('state') !== pkce.state) throw new Error('Google Drive authorization state mismatch.');
  if (result.searchParams.get('error')) throw new Error('Google Drive authorization was cancelled or denied.');
  const ticket = result.searchParams.get('broker_ticket');
  if (!ticket) throw new Error('Google Drive authorization did not return a secure exchange ticket.');
  const token = await exchangeBroker('token', {
    ticket,
    code_verifier: pkce.verifier,
  }, fetchImpl);
  await saveAuth({ ...token, transport: AUTH_TRANSPORT });
  return { connected: true };
}

export async function getGoogleDriveConnection() {
  const auth = await loadAuth();
  return {
    connected: !!auth?.access_token && auth.transport === AUTH_TRANSPORT,
    canRefresh: !!auth?.refresh_token && auth.transport === AUTH_TRANSPORT,
    reconnectRequired: !!auth?.access_token && auth.transport !== AUTH_TRANSPORT,
  };
}

export async function disconnectGoogleDrive({ fetchImpl = fetch } = {}) {
  const auth = await loadAuth();
  const token = auth?.refresh_token || auth?.access_token;
  if (token) {
    await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {});
  }
  await saveAuth(null);
}

async function getAccessToken(fetchImpl = fetch) {
  const auth = await loadAuth();
  if (!auth?.access_token) throw new Error('Connect Google Drive in ChatPanel Settings first.');
  if (auth.transport !== AUTH_TRANSPORT) throw new Error('Reconnect Google Drive once to enable reliable scheduled backups.');
  if (!auth.expires_at || Date.now() < auth.expires_at - EXPIRY_SKEW_MS) return auth.access_token;
  if (!auth.refresh_token) throw new Error('Google Drive authorization expired. Reconnect Google Drive in Settings.');
  const refreshed = await exchangeBroker('refresh', {
    refresh_token: auth.refresh_token,
  }, fetchImpl);
  const next = { ...auth, ...refreshed, refresh_token: refreshed.refresh_token || auth.refresh_token };
  await saveAuth(next);
  return next.access_token;
}

function driveHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra };
}

function qLiteral(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function listFiles(token, q, fetchImpl = fetch) {
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    pageSize: '100',
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,size,appProperties)',
  });
  const res = await fetchImpl(`${DRIVE_API}/files?${params}`, { headers: driveHeaders(token) });
  if (!res.ok) return responseError(res, 'Google Drive list failed');
  return (await res.json()).files || [];
}

async function ensureBackupFolder(token, fetchImpl = fetch) {
  const q = `name = ${qLiteral(FOLDER_NAME)} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const existing = (await listFiles(token, q, fetchImpl))[0];
  if (existing) return existing.id;
  const res = await fetchImpl(`${DRIVE_API}/files?fields=id,name`, {
    method: 'POST',
    headers: driveHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { chatpanelBackupFolder: '1' },
    }),
  });
  if (!res.ok) return responseError(res, 'Google Drive folder creation failed');
  return (await res.json()).id;
}

export async function listGoogleDriveBackups({ accessToken = '', fetchImpl = fetch } = {}) {
  const token = accessToken || await getAccessToken(fetchImpl);
  const q = `name = ${qLiteral(FOLDER_NAME)} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const folder = (await listFiles(token, q, fetchImpl))[0];
  if (!folder) return [];
  return listFiles(
    token,
    `${qLiteral(folder.id)} in parents and trashed = false and appProperties has { key='chatpanelBackup' and value='1' }`,
    fetchImpl,
  );
}

export function googleDriveBackupDevice(file) {
  const props = file?.appProperties || {};
  const match = DEVICE_BACKUP_RE.exec(String(file?.name || ''));
  const id = String(props.backupDeviceId || match?.[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  if (!id) return {
    id: 'legacy',
    name: LEGACY_BACKUP_RE.test(String(file?.name || '')) ? 'Legacy backups' : 'Unlabelled backups',
    legacy: true,
  };
  const cleanName = String(props.backupDeviceName || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  return { id, name: cleanName || `Device ${id.slice(-6)}`, legacy: false };
}

export function latestGoogleDriveBackupsByDevice(files = []) {
  const latest = new Map();
  for (const file of files) {
    const device = googleDriveBackupDevice(file);
    const existing = latest.get(device.id);
    const modified = Date.parse(file?.modifiedTime || '') || 0;
    const existingModified = Date.parse(existing?.modifiedTime || '') || 0;
    if (!existing || modified > existingModified) latest.set(device.id, file);
  }
  return [...latest.values()].sort((a, b) => (Date.parse(b?.modifiedTime || '') || 0) - (Date.parse(a?.modifiedTime || '') || 0));
}

export async function uploadEncryptedBackupToDrive(blob, {
  filename, deviceId = '', deviceName = '', weekday = '', accessToken = '', fetchImpl = fetch,
} = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('Encrypted backup payload is empty.');
  const match = DEVICE_BACKUP_RE.exec(filename || '');
  if (!match) {
    throw new Error('Invalid ChatPanel backup filename.');
  }
  const normalizedDeviceId = String(deviceId || match[1]).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  if (normalizedDeviceId !== match[1]) throw new Error('Backup device identity does not match its filename.');
  const normalizedWeekday = WEEKDAY_NAMES.has(weekday) ? weekday : match[2];
  const normalizedDeviceName = String(deviceName || `Device ${normalizedDeviceId.slice(-6)}`)
    .replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  const token = accessToken || await getAccessToken(fetchImpl);
  const folderId = await ensureBackupFolder(token, fetchImpl);
  const files = await listFiles(token, `${qLiteral(folderId)} in parents and name = ${qLiteral(filename)} and trashed = false`, fetchImpl);
  const existing = files[0];
  const fields = encodeURIComponent('id,name,modifiedTime,size');
  const initUrl = existing
    ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${fields}`
    : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=${fields}`;
  const metadata = {
    name: filename,
    mimeType: 'application/json',
    appProperties: {
      chatpanelBackup: '1',
      encrypted: '1',
      format: 'chatpanel-backup-encrypted',
      backupSchema: 'device-v1',
      backupDeviceId: normalizedDeviceId,
      backupDeviceName: normalizedDeviceName,
      backupDay: normalizedWeekday,
    },
    ...(!existing ? { parents: [folderId] } : {}),
  };
  const init = await fetchImpl(initUrl, {
    method: existing ? 'PATCH' : 'POST',
    headers: driveHeaders(token, {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/json',
      'X-Upload-Content-Length': String(blob.size),
    }),
    body: JSON.stringify(metadata),
  });
  if (!init.ok) return responseError(init, 'Google Drive upload initialization failed');
  const sessionUrl = init.headers.get('Location');
  if (!sessionUrl) throw new Error('Google Drive did not return a resumable upload URL.');
  // The encrypted/compressed Blob goes directly from memory to Drive. No local
  // temp file, Cache API entry, IndexedDB value, or Downloads item is created.
  const uploaded = await fetchImpl(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: blob,
  });
  if (!uploaded.ok) return responseError(uploaded, 'Google Drive upload failed');
  return uploaded.json();
}

export async function downloadGoogleDriveBackup(fileId, {
  accessToken = '', fetchImpl = fetch,
} = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(fileId || ''))) throw new Error('Invalid Google Drive backup ID.');
  const token = accessToken || await getAccessToken(fetchImpl);
  const res = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: driveHeaders(token),
  });
  if (!res.ok) return responseError(res, 'Google Drive download failed');
  return res.json();
}
