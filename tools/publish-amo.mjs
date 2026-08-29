// Publish the packaged Firefox add-on to addons.mozilla.org (AMO).
//
//   node tools/publish-amo.mjs
//   npm run publish:amo
//
// Uploads dist/chatpanel-firefox.zip — built by tools/build-firefox.mjs from the SAME
// extension/ source tree as the Chrome/Edge zip — creates a new listed version, and
// attaches dist/chatpanel-firefox-sources.zip, which AMO requires because the package
// contains generated bundles (js/vendor/codemirror.js, js/vendor/web-llm.js).
//
// Uses the AMO add-on submission API v5 with JWT auth:
//   https://addons-server.readthedocs.io/en/latest/topics/api/addons.html
// No npm dependency: the JWT is 30 lines of node:crypto, and Node 20 has fetch,
// FormData and Blob built in. That keeps the release path working off-VPN.
//
// Required env (GitHub Actions secrets in CI, or a local .env):
//   AMO_JWT_ISSUER    "JWT issuer" from addons.mozilla.org → Manage API Keys
//   AMO_JWT_SECRET    "JWT secret" from the same page
// Optional:
//   AMO_ADDON_ID      the add-on's guid (default: the gecko id in the manifest)
//   AMO_PACKAGE       path to the zip   (default dist/chatpanel-firefox.zip)
//   AMO_SOURCE        path to sources   (default dist/chatpanel-firefox-sources.zip)
//   AMO_CHANNEL       "listed" (default) or "unlisted" for a self-hosted signed build
//   AMO_RELEASE_NOTES release notes shown on the listing
//   AMO_SKIP_PUBLISH  if set, validate the upload only — do NOT create the version
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChromeManifest, toFirefoxManifest } from './firefox-manifest.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://addons.mozilla.org/api/v5';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(root, '.env'))) {
  process.loadEnvFile(path.join(root, '.env'));
}

const ISSUER = process.env.AMO_JWT_ISSUER;
const SECRET = process.env.AMO_JWT_SECRET;
const CHANNEL = process.env.AMO_CHANNEL === 'unlisted' ? 'unlisted' : 'listed';
const pkg = process.env.AMO_PACKAGE || path.join(root, 'dist', 'chatpanel-firefox.zip');
const sourcePkg = process.env.AMO_SOURCE || path.join(root, 'dist', 'chatpanel-firefox-sources.zip');
const skipPublish = !!process.env.AMO_SKIP_PUBLISH;

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// AMO wants a short-lived HS256 JWT per request; it rejects anything with a lifetime
// over 5 minutes, and reuses of a jti. Mint a fresh one for every call.
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: ISSUER, jti: randomUUID(), iat: now, exp: now + 240 }));
  const sig = b64url(createHmac('sha256', SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
const auth = () => ({ Authorization: `JWT ${token()}` });

async function asBlob(file, type = 'application/zip') {
  return new Blob([await readFile(file)], { type });
}

const missing = [['AMO_JWT_ISSUER', ISSUER], ['AMO_JWT_SECRET', SECRET]].filter(([, v]) => !v);
if (missing.length) {
  die(
    `Missing required env: ${missing.map(([k]) => k).join(', ')}. ` +
      'Create them at addons.mozilla.org → Tools → Manage API Keys and set them as secrets.',
  );
}
if (!existsSync(pkg)) die(`Package not found: ${pkg}. Run "npm run package:firefox" first.`);

async function main() {
  const manifest = toFirefoxManifest(readChromeManifest());
  const version = manifest.version;
  const addonId = process.env.AMO_ADDON_ID || manifest.browser_specific_settings.gecko.id;

  console.log(`\nAMO publish — v${version}`);
  console.log(`  package: ${path.relative(root, pkg)}`);
  console.log(`  add-on:  ${addonId}`);
  console.log(`  channel: ${CHANNEL}\n`);

  // 1. Upload the package and let AMO's linter validate it.
  console.log('Uploading package…');
  const form = new FormData();
  form.set('upload', await asBlob(pkg), path.basename(pkg));
  form.set('channel', CHANNEL);
  const up = await fetch(`${API}/addons/upload/`, { method: 'POST', headers: auth(), body: form });
  const upBody = await up.text();
  if (!up.ok) die(`Upload rejected (HTTP ${up.status}): ${upBody}`);
  const { uuid } = JSON.parse(upBody);
  if (!uuid) die(`Upload accepted but no uuid was returned: ${upBody}`);

  // 2. Poll validation. AMO's linter reports manifest problems here — this is where a
  //    bad permission or an unsupported key shows up, before anything is created.
  let validation = null;
  for (let i = 0; i < 90; i++) {
    const res = await fetch(`${API}/addons/upload/${uuid}/`, { headers: auth() });
    const body = await res.text();
    if (!res.ok) die(`Validation check failed (HTTP ${res.status}): ${body}`);
    validation = JSON.parse(body);
    if (validation.processed) break;
    process.stdout.write(`  … validating (${i + 1}/90)\r`);
    await sleep(4000);
  }
  if (!validation?.processed) die('AMO did not finish validating the upload after 6 minutes.');
  const results = validation.validation || {};
  if (results.messages?.length) {
    for (const m of results.messages) {
      const icon = m.type === 'error' ? '✗' : m.type === 'warning' ? '⚠' : 'ℹ';
      console.log(`  ${icon} [${m.type}] ${m.message}${m.description ? ` — ${[].concat(m.description).join(' ')}` : ''}`);
    }
  }
  if (!validation.valid) die(`AMO validation failed (${results.errors ?? '?'} error(s)). See the messages above.`);
  console.log(`\n✓ Package uploaded and validated (${results.warnings ?? 0} warning(s)).`);

  if (skipPublish) {
    console.log('AMO_SKIP_PUBLISH set — validated but NO version was created.');
    return;
  }

  // 3. Create the version, attaching the source archive. AMO requires source whenever
  //    the package contains generated or third-party bundled code, and rejects the
  //    version at review time if it is missing — so it goes up with the version, not
  //    as a manual follow-up someone forgets.
  console.log('Creating version…');
  const vForm = new FormData();
  vForm.set('upload', uuid);
  if (existsSync(sourcePkg)) {
    vForm.set('source', await asBlob(sourcePkg), path.basename(sourcePkg));
    console.log(`  source:  ${path.relative(root, sourcePkg)}`);
  } else {
    console.log('  ⚠ no sources zip found — AMO will ask for it during review.');
  }
  if (process.env.AMO_RELEASE_NOTES) {
    vForm.set('release_notes', JSON.stringify({ 'en-US': process.env.AMO_RELEASE_NOTES }));
  }
  const ver = await fetch(`${API}/addons/addon/${encodeURIComponent(addonId)}/versions/`, {
    method: 'POST', headers: auth(), body: vForm,
  });
  const verBody = await ver.text();
  if (!ver.ok) {
    // The usual causes: the add-on guid does not exist yet (the FIRST listed version
    // must be created once through the AMO web UI), or this version already exists.
    die(
      `Version creation rejected (HTTP ${ver.status}): ${verBody}\n` +
        '  If this is the first ever submission, create the listing once at ' +
        'https://addons.mozilla.org/developers/addon/submit/distribution — after that this script owns every release.',
    );
  }
  console.log(`\n✓ Submitted v${version} to addons.mozilla.org for review (${CHANNEL}).`);
}

main().catch((e) => die(e?.stack || String(e)));
