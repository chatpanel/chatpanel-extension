import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

const order = [
  'btn-attach',
  'btn-skills',
  'btn-mcp',
  'btn-history-context',
  'btn-pageact',
  'composer-tools-spacer',
  'btn-assist',
  'btn-send',
  'btn-stop',
].map((id) => html.indexOf(id));

assert.equal(order.every((i) => i >= 0), true, 'Composer should include all expected tool controls.');
assert.deepEqual(
  [...order].sort((a, b) => a - b),
  order,
  'Improve prompt should live on the right side next to Send, after the spacer.',
);

console.log('composer tool order tests passed');
