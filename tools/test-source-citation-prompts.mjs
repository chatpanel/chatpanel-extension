import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const toolHints = readFileSync(new URL('../extension/js/tool-hints.js', import.meta.url), 'utf8');

assert.match(toolHints, /export function sourceCitationSystem/, 'Tool hints should export one reusable source citation policy.');
assert.match(sidepanel, /sourceCitationSystem/, 'Sidepanel should inject the source citation policy into answer turns.');
assert.match(
  sidepanel,
  /systemWithSummary\(resolved\.systemPrompt,\s*conv\)[\s\S]*sourceCitationSystem\(\)/,
  'Normal chat streams should include the citation policy with the system prompt.',
);
assert.doesNotMatch(
  sidepanel,
  /systemWithSummary\(resolved\.systemPrompt,\s*conv\)[\s\S]*tools\?\.system[\s\S]*sourceCitationSystem\(\)/,
  'Sidepanel should not pre-merge tool guidance because providers append tools.system once.',
);
assert.match(
  sidepanel,
  /runWatchStream[\s\S]*sourceCitationSystem\(\)/,
  'Watch/page answer streams should include the citation policy.',
);

console.log('source citation prompt tests passed');
