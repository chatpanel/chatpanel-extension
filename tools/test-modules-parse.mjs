// Every shipped module must parse.
//
// This exists because a duplicate `const` declaration in settings.js took out the ENTIRE
// settings page — every tab, every control — and 127 test files were green while it did.
// Nothing here loaded a page, so nothing noticed that the page could not be parsed.
//
// A syntax error is the cheapest possible bug to catch and the most expensive to ship: the
// module never evaluates, so there is no partial failure and no error visible anywhere
// except the console of whoever happened to open devtools. Parsing is not a substitute for
// a real smoke test, but it is the floor, and this repo did not have one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');

// Everything the manifest or an HTML page can load, plus the modules they import. Walking
// the tree is deliberate: a new file is covered the moment it exists, with nothing to
// remember to add here.
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsFiles(full, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = jsFiles(EXT);
assert.ok(files.length > 50, `expected the extension tree, found ${files.length} files`);

const broken = [];
for (const file of files) {
  try {
    // --check parses without executing, so a module with side effects (a service worker,
    // a page entry point) is safe to check.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 3).join(' | ');
    broken.push(`${relative(ROOT, file)}: ${msg}`);
  }
}

assert.deepEqual(broken, [], `these modules do not parse:\n  ${broken.join('\n  ')}`);
console.log(`✓ all ${files.length} extension modules parse`);
