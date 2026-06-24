import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

assert.match(html, /id="agent-model"/, 'Top bar should expose the selected model beside the agent dropdown.');
assert.match(js, /function agentModelLabel/, 'Sidepanel should centralize selected model label formatting.');
assert.match(js, /\$\('agent-model'\)\.textContent = modelLabel/, 'renderAgentName should update the selected model label.');
assert.match(js, /\$\('agent-model'\)\.classList\.toggle\('hidden', !modelLabel\)/, 'Model label should hide when no model is configured.');
assert.match(css, /\.agent-model\s*\{[^}]*text-overflow:\s*ellipsis/s, 'Selected model label should truncate long model ids.');
assert.match(css, /\.agent-model\s*\{[^}]*min-width:\s*0/s, 'Selected model label should be allowed to shrink in the top bar.');
assert.match(css, /\.agent-model\s*\{[^}]*font-size:\s*10\.5px/s, 'Selected model label should stay visually secondary.');
assert.match(css, /\.agent-model\s*\{[^}]*max-width:\s*min\(32vw,\s*360px\)/s, 'Selected model label should not consume too much header width.');

console.log('sidepanel agent header tests passed');
