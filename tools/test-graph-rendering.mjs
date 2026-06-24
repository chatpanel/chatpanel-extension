import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const meetingsJs = readFileSync(new URL('../extension/meetings.js', import.meta.url), 'utf8');
const historyJs = readFileSync(new URL('../extension/history.js', import.meta.url), 'utf8');

for (const [name, source] of [
  ['meetings', meetingsJs],
  ['history', historyJs],
]) {
  assert.match(source, /const GRAPH_RENDER_LIMIT\s*=\s*\d+;/, `${name} should define a global graph render limit.`);
  assert.match(source, /slice\(0,\s*GRAPH_RENDER_LIMIT\)/, `${name} should cap the records sent to the global graph.`);
  assert.match(source, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*drawGraph/, `${name} should defer the global graph draw until after the panel paints.`);
  assert.match(source, /showing \$\{[^}]+\.length\} of \$\{[^}]+\.length\}/, `${name} should disclose when only part of the result set is graphed.`);
}

console.log('graph rendering tests passed');
