#!/usr/bin/env node
// Mint a Chrome Web Store refresh token for the release workflow.
//
// The publish step in .github/workflows/extension-release.yml authenticates with
// CHROME_CLIENT_ID + CHROME_CLIENT_SECRET + CHROME_REFRESH_TOKEN. The first two are
// stable; the third is what breaks, and when it does the whole release stops. This
// script mints a new one.
//
// A refresh token is bound to the OAuth client that issued it, so whenever the client
// changes, all THREE secrets have to move together — a fresh token paired with a stale
// CHROME_CLIENT_ID fails as invalid_grant and reads like a bad token.
//
// Why the grant dies:
//   invalid_grant / "Token has been expired or revoked"
//     • the OAuth client was DELETED — deleting a client revokes every token it issued
//     • the account's password changed, or access was revoked at myaccount.google.com
//     • the consent screen is in "Testing", where refresh tokens expire after 7 days
//   invalid_client
//     • CHROME_CLIENT_ID / CHROME_CLIENT_SECRET do not match the OAuth client
//
// Usage:
//   node tools/get-chrome-token.mjs --json ~/Downloads/client_secret_*.json
//   CHROME_CLIENT_ID=… CHROME_CLIENT_SECRET=… node tools/get-chrome-token.mjs
//
// Then, so the three stay consistent:
//   gh secret set CHROME_CLIENT_ID     -R <owner>/<repo>   # client_id
//   gh secret set CHROME_CLIENT_SECRET -R <owner>/<repo>   # client_secret
//   gh secret set CHROME_REFRESH_TOKEN -R <owner>/<repo> < chrome-refresh-token.txt
//
// The OAuth client must be type "Desktop app": that is what makes a loopback redirect
// legal without registering a port. Google switched off the out-of-band copy-paste flow
// in 2022, so loopback is the only supported path for a CLI.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };

let clientId = process.env.CHROME_CLIENT_ID;
let clientSecret = process.env.CHROME_CLIENT_SECRET;

const jsonPath = argOf('--json');
if (jsonPath) {
  // The credentials file Google hands you is { installed: {...} } for a Desktop client
  // and { web: {...} } otherwise; read whichever key is present so a mistyped type
  // still produces a clear error later rather than a crash here.
  const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const kind = Object.keys(doc)[0];
  if (kind !== 'installed') {
    console.error(`⚠ ${jsonPath} is a "${kind}" client, not a Desktop app.`);
    console.error('  Loopback redirects need a Desktop app client, or register the port explicitly.');
  }
  clientId = doc[kind].client_id;
  clientSecret = doc[kind].client_secret;
}

if (!clientId || !clientSecret) {
  console.error('Missing credentials.\n');
  console.error('  node tools/get-chrome-token.mjs --json <client_secret_*.json>');
  console.error('  …or set CHROME_CLIENT_ID and CHROME_CLIENT_SECRET.\n');
  console.error('Create the client at: Google Cloud console → APIs & Services →');
  console.error('Credentials → Create credentials → OAuth client ID → Desktop app.');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8910);
const REDIRECT = `http://localhost:${PORT}`;
const OUT = argOf('--out') || 'chrome-refresh-token.txt';
const TIMEOUT_MS = 3 * 60_000;

const authUrl = 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: 'https://www.googleapis.com/auth/chromewebstore',
  access_type: 'offline', // ask for a refresh token at all
  prompt: 'consent',      // and force a NEW one — without this Google returns only an
                          // access token when the client was authorised before, which
                          // looks like success and yields nothing usable.
}).toString();

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<body style="font:16px system-ui;padding:3rem">
      <h2>${err ? `❌ ${err}` : '✅ Authorised'}</h2>
      <p>${err ? 'Check the terminal.' : 'Close this tab and return to the terminal.'}</p>
    </body>`);
    finish(err ? () => reject(new Error(err)) : () => resolve(url.searchParams.get('code')));
  });

  // The timer must be cleared on success, not just left to fire: an un-cleared timeout
  // keeps the event loop alive and the process hangs for three minutes AFTER the token
  // has already been minted.
  const timer = setTimeout(() => finish(() => reject(new Error('timed out — no response in 3 minutes'))), TIMEOUT_MS);
  const finish = (settle) => { clearTimeout(timer); server.close(); settle(); };

  server.listen(PORT, () => {
    console.log(`\nListening on ${REDIRECT}`);
    console.log('\nOpening your browser — sign in as the Web Store listing owner and click Allow.');
    console.log('If it does not open, paste this:\n');
    console.log(`${authUrl}\n`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [authUrl], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  });
});

console.log('Got the authorisation code — exchanging it…');

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\n✗ Token exchange failed (HTTP ${res.status}): ${body.error || 'unknown'}`);
  if (body.error_description) console.error(`  ${body.error_description}`);
  process.exit(1);
}
if (!body.refresh_token) {
  console.error('\n✗ Google returned no refresh_token (only an access token).');
  console.error('  Revoke the app at https://myaccount.google.com/permissions and rerun.');
  process.exit(1);
}

// Written to a 0600 file rather than stdout: this is routinely run inside a terminal
// that is being recorded, and a printed refresh token is a leaked refresh token.
writeFileSync(OUT, body.refresh_token, { mode: 0o600 });
console.log(`\n✅ Refresh token written to ${OUT} (0600).`);
console.log(`   scope: ${body.scope || '(none reported)'}`);
console.log('\nSet all three secrets together, then delete the file:\n');
console.log('  gh secret set CHROME_CLIENT_ID     -R <owner>/<repo>');
console.log('  gh secret set CHROME_CLIENT_SECRET -R <owner>/<repo>');
console.log(`  gh secret set CHROME_REFRESH_TOKEN -R <owner>/<repo> < ${OUT}`);
console.log(`  rm -P ${OUT}\n`);
