#!/usr/bin/env node
// Single source of truth for the privacy engine.
//
// The canonical redaction engine lives in the `chatpanel-pii` package. The
// extension is browser-loaded ES modules (no bundler), so the engine files must
// physically sit in extension/js/ — this script COPIES them from the package so
// they're generated, never hand-edited. Edit privacy features in chatpanel-pii,
// then run `npm run sync:pii` (also runs automatically before `npm run package`).
//
//   node tools/sync-pii.mjs           refresh extension/js from the package
//   node tools/sync-pii.mjs --check   verify they match (CI drift guard); exit 1 if not
//
// These files are generated — do NOT edit them in extension/js:
//   pii-redact.js, pii-detect.js

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['pii-redact.js', 'pii-detect.js', 'tool-rank.js', 'tool-harness.js', 'sanitize.js', 'net.js'];

// Resolve the package source: installed dep first, then a sibling checkout.
function pkgDir() {
  const candidates = [
    join(ROOT, 'node_modules', '@chatpanel', 'pii'),
    join(ROOT, '..', 'chatpanel-pii'),
  ];
  return candidates.find((d) => existsSync(join(d, 'pii-redact.js')));
}

const check = process.argv.includes('--check');
const src = pkgDir();

if (!src) {
  const msg = 'chatpanel-pii not found (install it or check out ../chatpanel-pii).';
  if (check) { console.error(`sync-pii --check: ${msg}`); process.exit(1); }
  console.warn(`sync-pii: ${msg} Leaving extension/js engine files as-is.`);
  process.exit(0);
}

let drift = false;
for (const f of FILES) {
  const from = join(src, f);
  const to = join(ROOT, 'extension', 'js', f);
  const want = readFileSync(from, 'utf8');
  const have = existsSync(to) ? readFileSync(to, 'utf8') : null;
  if (want === have) continue;
  if (check) { console.error(`sync-pii --check: ${f} differs from chatpanel-pii`); drift = true; continue; }
  writeFileSync(to, want);
  console.log(`sync-pii: updated extension/js/${f}`);
}

if (check && drift) process.exit(1);
if (check) console.log('sync-pii --check: extension/js engine matches chatpanel-pii ✓');
