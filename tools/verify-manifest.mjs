// Edge / cross-browser preflight for the MV3 manifest.
//
//   node tools/verify-manifest.mjs        # report, exit 1 on hard blockers
//   npm run verify:edge
//
// The same zip ships to the Chrome Web Store and the Microsoft Edge Add-ons
// store — Edge is Chromium, so there is no conversion step. This checks that the
// package contains nothing that behaves differently (or breaks) on Edge:
//   • Chrome-only manifest keys that Edge ignores or rejects.
//   • Permissions that draw extra scrutiny during Edge certification.
//   • OAuth redirect URIs hardcoded to the Chrome extension ID, which will NOT
//     match Edge's (different) extension ID at runtime.
// It is advisory. Only genuine blockers set a non-zero exit code.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const manifestPath = path.join(extDir, 'manifest.json');

const errors = [];
const warns = [];
const infos = [];
const oks = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);
const info = (m) => infos.push(m);
const ok = (m) => oks.push(m);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// --- Chrome-only / Chrome-specific manifest keys ---------------------------
// Edge is Chromium, so nearly every MV3 key is shared. These are the exceptions.
const CHROME_ONLY_KEYS = {
  // getAuthToken's Google-account flow. Edge has no chrome.identity.getAuthToken;
  // its presence means sign-in was built the Chrome-only way. Hard blocker.
  oauth2: 'error',
  // Points at the Chrome Web Store update endpoint; must be absent from a store
  // build (both stores inject their own). If present, Edge updates break.
  update_url: 'error',
  // Pins a fixed extension ID for local/dev packing. Store publishing overrides
  // it, so it can't force Chrome and Edge to share an ID — misleading if present.
  key: 'warn',
  // Chrome-only; ignored by Edge. Harmless, informational only.
  minimum_chrome_version: 'info',
  differential_fingerprint: 'warn',
};

for (const [key, level] of Object.entries(CHROME_ONLY_KEYS)) {
  if (!(key in manifest)) continue;
  const msg = `manifest key "${key}" is Chrome-specific`;
  if (level === 'error') err(`${msg} — Edge does not support it; remove or replace before publishing.`);
  else if (level === 'warn') warn(`${msg} — review before publishing to Edge.`);
  else info(`${msg} — Edge ignores it (value "${manifest[key]}"). Harmless, no action needed.`);
}

// --- Side panel: supported on Edge (Chromium 114+) -------------------------
if (manifest.side_panel?.default_path) {
  const p = manifest.side_panel.default_path;
  if (!existsSync(path.join(extDir, p))) err(`side_panel.default_path "${p}" does not exist.`);
  else ok(`side_panel ("${p}") — supported on Edge, works as-is.`);
}

// --- Permissions that trigger extra Edge certification scrutiny -------------
const perms = new Set([...(manifest.permissions || []), ...(manifest.host_permissions || [])]);
const SCRUTINY = {
  debugger: 'The `debugger` permission is broad; Edge reviewers usually ask why. Have a justification ready (see docs/edge-publishing.md).',
  '<all_urls>': 'Broad host access (`<all_urls>`) commonly draws Edge review questions. Justify it in the submission notes.',
};
for (const [perm, note] of Object.entries(SCRUTINY)) {
  if (perms.has(perm)) warn(note);
}

// --- Store metadata sanity (mirrors package-extension.mjs) -----------------
if ((manifest.description || '').length > 132) {
  err(`manifest.description is ${manifest.description.length} chars; store limit is 132.`);
} else {
  ok(`description length ${manifest.description?.length || 0}/132.`);
}
for (const p of Object.values(manifest.icons || {})) {
  if (!existsSync(path.join(extDir, p))) err(`Missing icon referenced by manifest: ${p}`);
}

// --- OAuth redirect URIs hardcoded to the Chrome extension ID ---------------
// chrome.identity.getRedirectURL() returns https://<extension-id>.chromiumapp.org/.
// Edge assigns a DIFFERENT extension ID, so any URI literal that pins the Chrome
// ID will not match at runtime on Edge and that provider's sign-in will fail.
const CHROMIUMAPP_RE = /https:\/\/([a-p]{32})\.chromiumapp\.org[^\s'"`]*/g;
function scanForPinnedRedirects(dir) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      hits.push(...scanForPinnedRedirects(full));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(CHROMIUMAPP_RE)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({ file: path.relative(root, full), line, id: m[1], url: m[0] });
      }
    }
  }
  return hits;
}
const pinned = scanForPinnedRedirects(extDir);
if (pinned.length) {
  for (const h of pinned) {
    warn(
      `${h.file}:${h.line} hardcodes a chromiumapp.org redirect pinned to Chrome ID "${h.id}". ` +
        `On Edge the extension ID differs, so this URI won't match getRedirectURL() — that provider's ` +
        `hosted sign-in will fail on Edge until the Edge redirect URI is allow-listed at the provider.`,
    );
  }
} else {
  ok('No chromiumapp.org redirect URIs are hardcoded to a fixed extension ID.');
}

// --- Hosted Hugging Face redirect allow-list --------------------------------
// oauth.js keeps an allow-list of extension IDs whose redirect URI is registered
// with the hosted HF CIMD client. Each store gets a different ID, so a fresh Edge
// build is not covered until its ID is added here AND to the CIMD document.
const oauthSrc = (() => {
  try {
    return readFileSync(path.join(extDir, 'js', 'oauth.js'), 'utf8');
  } catch {
    return '';
  }
})();
const idBlock = oauthSrc.match(/HUGGINGFACE_PRODUCTION_EXTENSION_IDS\s*=\s*\[([\s\S]*?)\]/);
if (idBlock) {
  const ids = [...idBlock[1].matchAll(/'([a-p]{32})'/g)].map((m) => m[1]);
  if (ids.length <= 1) {
    warn(
      `Hosted Hugging Face sign-in has ${ids.length} registered redirect ID(s) ` +
        `(${ids.join(', ') || 'none'}). To enable it on Edge: after the first Edge upload, read the ` +
        `Edge extension ID from edge://extensions (Developer mode) — NOT the Partner Center Product/Store ` +
        `ID — add it to HUGGINGFACE_PRODUCTION_EXTENSION_IDS in js/oauth.js, and add its redirect URI to ` +
        `the CIMD document's redirect_uris. Until then, Edge users sign in to HF with their own Client ID.`,
    );
  } else {
    ok(`Hosted Hugging Face redirect allow-list has ${ids.length} registered IDs (${ids.join(', ')}).`);
  }
}

// --- Report ----------------------------------------------------------------
const line = (icon, m) => console.log(`  ${icon} ${m}`);
console.log(`\nEdge preflight — manifest v${manifest.version}\n`);
for (const m of oks) line('✓', m);
for (const m of infos) line('ℹ', m);
for (const m of warns) line('⚠', m);
for (const m of errors) line('✗', m);
console.log(
  `\n${errors.length} blocker(s), ${warns.length} warning(s), ${infos.length} note(s).` +
    (errors.length ? ' Fix blockers before publishing to Edge.\n' : ' No hard blockers — safe to upload the existing zip to Edge.\n'),
);
process.exit(errors.length ? 1 : 0);
