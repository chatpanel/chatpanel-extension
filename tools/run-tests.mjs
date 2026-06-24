import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolsDir = join(root, 'tools');
const tests = readdirSync(toolsDir)
  .filter((name) => /^test-.+\.mjs$/.test(name))
  .sort();

if (!tests.length) {
  console.error('No tests found under tools/test-*.mjs');
  process.exit(1);
}

for (const test of tests) {
  console.log(`\n▶ ${test}`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(toolsDir, test)], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('close', resolve);
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });
  if (code !== 0) {
    console.error(`\n✕ ${basename(test)} failed`);
    process.exit(code || 1);
  }
}

console.log(`\n✓ ${tests.length} test files passed`);
