#!/usr/bin/env node
// Single source of truth for the event-log and capability contracts.
//
// The contracts live in the `chatpanel-events` package. The extension is
// browser-loaded ES modules (no bundler), so the files must physically sit in
// extension/js/events/ — this script COPIES them from the package so they're
// generated, never hand-edited. Edit contracts in chatpanel-events, then run
// `npm run sync:events` (also runs automatically before `npm run package`).
//
//   node tools/sync-events.mjs           refresh extension/js/events from the package
//   node tools/sync-events.mjs --check   verify they match (CI drift guard); exit 1 if not
//
// A SUBDIRECTORY, unlike the flat pii vendoring, because these names are generic:
// `store.js` would collide with the extension's own js/store.js, and `index.js`
// with anything. The package's internal imports are relative, so they resolve
// unchanged inside the folder.
//
// These files are generated — do NOT edit them in extension/js/events/.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'index.js', 'event.js', 'ref.js', 'order.js', 'upcast.js',
  'capability.js', 'invariants.js', 'store.js', 'registry.js', 'harness.js',
];

function pkgDir() {
  return [
    join(ROOT, 'node_modules', '@chatpanel', 'events'),
    join(ROOT, '..', 'chatpanel-events'),
  ].find((d) => existsSync(join(d, 'event.js')));
}

const check = process.argv.includes('--check');
const src = pkgDir();

if (!src) {
  const msg = 'chatpanel-events not found (install it or check out ../chatpanel-events).';
  if (check) { console.error(`sync-events --check: ${msg}`); process.exit(1); }
  console.warn(`sync-events: ${msg} Leaving extension/js/events as-is.`);
  process.exit(0);
}

const outDir = join(ROOT, 'extension', 'js', 'events');
if (!check) mkdirSync(outDir, { recursive: true });

// Stamped so opening one of these in an editor is unambiguous: this is a build output,
// and edits here are silently reverted by the next sync (and caught by --check).
const banner = (f) => `// GENERATED — do not edit.\n`
  + `// Source of truth: chatpanel-events/${f} (npm @chatpanel/events).\n`
  + `// Edit there, then run: npm run sync:events\n`
  + `//\n`
  + `// Vendored because the extension loads raw ES modules with no bundler. The gateway\n`
  + `// and bridge take the same package as an npm dependency instead; a future mobile or\n`
  + `// desktop client takes it the same way, or speaks the wire contract if it is native.\n\n`;

let drift = false;
for (const f of FILES) {
  const want = banner(f) + readFileSync(join(src, f), 'utf8');
  const to = join(outDir, f);
  const have = existsSync(to) ? readFileSync(to, 'utf8') : null;
  if (want === have) continue;
  if (check) { console.error(`sync-events --check: ${f} differs from chatpanel-events`); drift = true; continue; }
  writeFileSync(to, want);
  console.log(`sync-events: updated extension/js/events/${f}`);
}

if (check && drift) process.exit(1);
if (check) console.log('sync-events --check: extension/js/events matches chatpanel-events ✓');
