import assert from 'node:assert/strict';
import {
  buildGoogleDriveAuthorizationUrl,
  connectGoogleDrive,
  getGoogleDriveConnection,
  uploadEncryptedBackupToDrive,
  downloadGoogleDriveBackup,
} from '../extension/js/drive-backup.js';

const auth = new URL(buildGoogleDriveAuthorizationUrl({
  redirectUri: 'https://example.chromiumapp.org/oauth/google-drive',
  state: 'state',
  codeChallenge: 'challenge',
}));
assert.equal(auth.origin, 'https://api.chatpanel.net');
assert.equal(auth.pathname, '/oauth/google/authorize');
assert.equal(auth.searchParams.get('return_uri'), 'https://example.chromiumapp.org/oauth/google-drive');
assert.equal(auth.searchParams.get('code_challenge'), 'challenge');

const local = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return { [key]: local[key] }; },
      async set(values) { Object.assign(local, values); },
      async remove(key) { delete local[key]; },
    },
  },
};
const identityApi = {
  getRedirectURL: () => 'https://icemacffhbgnfoofclgdbcdmnlkkklem.chromiumapp.org/oauth/google-drive',
  async launchWebAuthFlow({ url }) {
    const request = new URL(url);
    const callback = new URL(this.getRedirectURL());
    callback.searchParams.set('state', request.searchParams.get('state'));
    callback.searchParams.set('broker_ticket', 'opaque-encrypted-ticket');
    return callback.href;
  },
};
await connectGoogleDrive({
  identityApi,
  fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://api.chatpanel.net/oauth/google/token');
    const body = JSON.parse(options.body);
    assert.equal(body.ticket, 'opaque-encrypted-ticket');
    assert.ok(body.code_verifier);
    return Response.json({ access_token: 'broker-access', refresh_token: 'broker-refresh', expires_in: 3600 });
  },
});
assert.equal((await getGoogleDriveConnection()).connected, true);

const blob = new Blob(['{\"type\":\"chatpanel-backup-encrypted\",\"ct\":\"ciphertext\"}'], { type: 'application/json' });
const calls = [];
const fetchImpl = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).startsWith('https://upload.example/session')) {
    assert.equal(opts.method, 'PUT');
    assert.equal(opts.body, blob, 'encrypted Blob should stream directly to Drive');
    return new Response(JSON.stringify({ id: 'backup123', name: 'chatpanel-backup-Fri.encrypted.json', size: String(blob.size) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (String(url).includes('/upload/drive/v3/files/backup123')) {
    assert.equal(opts.method, 'PATCH', 'weekday slot should update instead of accumulating files');
    return new Response('', { status: 200, headers: { Location: 'https://upload.example/session' } });
  }
  if (String(url).includes('/drive/v3/files?')) {
    const q = new URL(String(url)).searchParams.get('q') || '';
    if (q.includes('application/vnd.google-apps.folder')) {
      return Response.json({ files: [{ id: 'folder123', name: 'ChatPanel Backups' }] });
    }
    return Response.json({ files: [{ id: 'backup123', name: 'chatpanel-backup-Fri.encrypted.json' }] });
  }
  throw new Error(`Unexpected request: ${url}`);
};
const uploaded = await uploadEncryptedBackupToDrive(blob, {
  filename: 'chatpanel-backup-Fri.encrypted.json', accessToken: 'token', fetchImpl,
});
assert.equal(uploaded.id, 'backup123');
assert.equal(calls.some((c) => c.url.startsWith('data:')), false, 'Drive-only transport must not create a download data URL');

const downloaded = await downloadGoogleDriveBackup('backup123', {
  accessToken: 'token',
  fetchImpl: async (url, opts) => {
    assert.match(String(url), /files\/backup123\?alt=media$/);
    assert.equal(opts.headers.Authorization, 'Bearer token');
    return Response.json({ type: 'chatpanel-backup-encrypted', ct: 'ciphertext' });
  },
});
assert.equal(downloaded.type, 'chatpanel-backup-encrypted');
console.log('Google Drive backup transport tests passed');
