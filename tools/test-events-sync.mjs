// Drift guard for the vendored event contracts.
//
// CI does no install, so the committed copies under extension/js/events are the source
// of truth there and `--check` would fail for the wrong reason. This runs the check only
// when the package is actually resolvable — locally, and anywhere it is installed — and
// skips loudly otherwise, so a real divergence is caught by whoever edits the package.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const available = [
  join(ROOT, 'node_modules', '@chatpanel', 'events'),
  join(ROOT, '..', 'chatpanel-events'),
].some((d) => existsSync(join(d, 'event.js')));

if (!available) {
  console.log('  (skipped — chatpanel-events not checked out; committed copies are source of truth here)');
} else {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'sync-events.mjs'), '--check'], { stdio: 'inherit' });
  console.log('✓ vendored event contracts match chatpanel-events');
}
