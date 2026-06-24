import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);

assert.equal(pkg.scripts?.test, 'node tools/run-tests.mjs', '`npm test` should run the full extension test suite.');
assert.equal(pkg.scripts?.['test:all'], 'node tools/run-tests.mjs', '`npm run test:all` should alias the full extension test suite.');
assert.ok(existsSync(ciPath), 'CI workflow should exist.');

const ci = readFileSync(ciPath, 'utf8');
assert.match(ci, /\bpull_request\b/, 'CI should run on pull requests.');
assert.match(ci, /\bpush\b/, 'CI should run on pushes.');
assert.match(ci, /npm test/, 'CI should run the full test suite.');
assert.match(ci, /npm run package/, 'CI should package the extension after tests.');

console.log('test suite wiring tests passed');
