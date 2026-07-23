// Publish the packaged extension to the Microsoft Edge Add-ons store.
//
//   node tools/publish-edge.mjs
//   npm run publish:edge
//
// Uploads dist/chatpanel-extension.zip — the SAME zip that ships to the Chrome
// Web Store — to the Edge Add-ons draft submission, waits for the upload to
// validate, then submits it for certification. Edge is Chromium and uses the
// identical MV3 package, so there is no separate build. Keep ONE codebase and
// ONE zip; this just pushes it to a second store.
//
// Uses the Microsoft Edge Add-ons Update REST API v1.1 (API-key auth):
//   https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api
//
// Required env (set as GitHub Actions secrets in CI, or a local .env):
//   EDGE_PRODUCT_ID   Partner Center product ID (a GUID) of the published add-on
//   EDGE_CLIENT_ID    Client ID from Partner Center → Publish API
//   EDGE_API_KEY      API key from Partner Center → Publish API
// Optional:
//   EDGE_PACKAGE      path to the zip (default dist/chatpanel-extension.zip)
//   EDGE_NOTES        certification notes shown to Edge reviewers
//   EDGE_SKIP_PUBLISH if set, upload + validate only, do NOT submit for review
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.addons.microsoftedge.microsoft.com';

// Load a local .env for developer runs (EDGE_PRODUCT_ID + credentials). In CI
// these come from GitHub Actions secrets and there is no .env, so this is
// best-effort. Must run before the constants below read process.env.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(root, '.env'))) {
  process.loadEnvFile(path.join(root, '.env'));
}

const PRODUCT_ID = process.env.EDGE_PRODUCT_ID;
const CLIENT_ID = process.env.EDGE_CLIENT_ID;
const API_KEY = process.env.EDGE_API_KEY;
const pkg = process.env.EDGE_PACKAGE || path.join(root, 'dist', 'chatpanel-extension.zip');
const notes =
  process.env.EDGE_NOTES ||
  'Same Manifest V3 package as the Chrome build. Permission justifications ' +
    '(debugger, scripting, <all_urls>) are in docs/web-store-permissions.md.';
const skipPublish = !!process.env.EDGE_SKIP_PUBLISH;

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const missing = [
  ['EDGE_PRODUCT_ID', PRODUCT_ID],
  ['EDGE_CLIENT_ID', CLIENT_ID],
  ['EDGE_API_KEY', API_KEY],
].filter(([, v]) => !v);
if (missing.length) {
  die(
    `Missing required env: ${missing.map(([k]) => k).join(', ')}. ` +
      `Create them at Partner Center → Publish API and set them as secrets.`,
  );
}
if (!existsSync(pkg)) die(`Package not found: ${pkg}. Run "npm run package" first.`);

const authHeaders = { Authorization: `ApiKey ${API_KEY}`, 'X-ClientID': CLIENT_ID };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The operation ID comes back in the Location header. Depending on the edge it
// is either a bare GUID or a full path — take the last non-empty segment.
function operationIdFrom(res) {
  const loc = res.headers.get('location');
  if (!loc) return null;
  return loc.split('/').filter(Boolean).pop().trim();
}

// Poll a status endpoint until it leaves the InProgress state. The status body
// looks like { status: "Succeeded" | "Failed" | "InProgress", message, errors }.
async function poll(kind, url, { tries = 60, everyMs = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: authHeaders });
    const body = await res.text();
    let json = {};
    try {
      json = JSON.parse(body);
    } catch {
      /* non-JSON (e.g. transient 5xx) — treat as still in progress */
    }
    const status = json.status || (res.ok ? 'InProgress' : `HTTP ${res.status}`);
    if (status === 'Succeeded') return json;
    if (status === 'Failed' || res.status >= 400) {
      // Report message AND errors[]: Edge's `message` is often the useless generic
      // "An error occurred while performing the operation", while `errors` carries the
      // actual reason (missing listing metadata, product not yet published, …).
      const detail =
        [json.message, json.errors && JSON.stringify(json.errors)].filter(Boolean).join(' | ') ||
        body ||
        `HTTP ${res.status}`;
      die(`${kind} failed: ${detail}`);
    }
    process.stdout.write(`  … ${kind}: ${status} (${i + 1}/${tries})\r`);
    await sleep(everyMs);
  }
  die(`${kind} did not finish after ${(tries * everyMs) / 1000}s.`);
}

async function main() {
  const version = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'))
    .version;
  console.log(`\nEdge Add-ons publish — v${version}`);
  console.log(`  package: ${path.relative(root, pkg)}`);
  console.log(`  product: ${PRODUCT_ID}\n`);

  // 1. Upload the package to the draft submission.
  console.log('Uploading package…');
  const upload = await fetch(`${API}/v1/products/${PRODUCT_ID}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/zip' },
    body: await readFile(pkg),
  });
  if (upload.status !== 202) {
    die(`Upload rejected (HTTP ${upload.status}): ${await upload.text()}`);
  }
  const uploadOp = operationIdFrom(upload);
  if (!uploadOp) die('Upload accepted but no operation ID was returned in the Location header.');

  // 2. Wait for the upload to validate.
  await poll(
    'upload',
    `${API}/v1/products/${PRODUCT_ID}/submissions/draft/package/operations/${uploadOp}`,
  );
  console.log('\n✓ Package uploaded and validated.');

  if (skipPublish) {
    console.log('EDGE_SKIP_PUBLISH set — draft updated but NOT submitted for review.');
    return;
  }

  // 3. Submit the draft for certification.
  console.log('Submitting for certification…');
  const publish = await fetch(`${API}/v1/products/${PRODUCT_ID}/submissions`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  if (publish.status !== 202) {
    // A 4xx here usually means the draft is unchanged or a prior submission is
    // still in review — surface the body so it's actionable.
    die(`Publish rejected (HTTP ${publish.status}): ${await publish.text()}`);
  }
  const publishOp = operationIdFrom(publish);
  if (!publishOp) die('Publish accepted but no operation ID was returned in the Location header.');

  // 4. Confirm the submission was accepted into review.
  await poll(
    'publish',
    `${API}/v1/products/${PRODUCT_ID}/submissions/operations/${publishOp}`,
  );
  console.log('\n✓ Submitted to Microsoft Edge Add-ons for certification.');
}

main().catch((e) => die(e?.stack || String(e)));
