// Naming phase 1 (docs/naming-revamp.md): what the Settings tabs are called, and in what order.
//
// "API" is Models, "Agents" (the CLIs) is Harnesses, "Agents" is the directory of the agents
// you define, and Teams stands beside it — the Engines pillar, then the Org pillar. The
// data-tab ids are code and do not move: a stored last-tab, a deep link and the prefs
// sections all keep working. Both clients pin this so a rename on one side cannot drift.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

const tabs = [...html.matchAll(/<button class="tab[^"]*" data-tab="([^"]+)">(?:<span[^>]*><\/span>)?\s*([^<]+)<\/button>/g)].map((m) => [m[1], m[2].trim()]);
assert.deepEqual(tabs.slice(0, 6), [
  ['api', 'Models'], ['agents', 'Harnesses'], ['directory', 'Agents'], ['teams', 'Teams'], ['skills', 'Skills'], ['mcp', 'Tools'],
], `the first six tabs, in pillar order: ${JSON.stringify(tabs.slice(0, 6))}`);
assert.ok(tabs.every(([, label]) => label !== 'API'), 'nothing is called "API" any more');

// Every tab has its panel; the directory panel says what an agent is and points at Teams.
for (const [id] of tabs) assert.ok(html.includes(`data-panel="${id}"`), `panel for ${id}`);
assert.match(html, /data-panel="directory"[\s\S]{0,600}?<strong>engine<\/strong>/, 'the directory explains the engine');
assert.match(html, /data-open-tab="teams"/, 'and points at Teams');

// The old words still land: #models → api, #harnesses → agents. The panel ids are code.
assert.match(js, /models: \{ tab: 'api' \}/);
assert.match(js, /harnesses: \{ tab: 'agents' \}/);
assert.doesNotMatch(js, /data-tab="models"/, 'the api panel id did not move');

// The panel's model menu groups by the same words.
assert.ok(panel.includes("sectionLabel('Models')") && panel.includes("sectionLabel('Harnesses')"), 'the model menu says Models / Harnesses');
assert.ok(!panel.includes("sectionLabel('API')") && !panel.includes("sectionLabel('Agents')"));

// The scheduler's copy is "automation": "job" is a posting on a project's board.
const jobsPanel = readFileSync(new URL('../extension/js/jobs-panel.js', import.meta.url), 'utf8');
for (const m of jobsPanel.matchAll(/onToast\(['"`]([^'"`]+)['"`]/g)) assert.doesNotMatch(m[1].replace(/\$\{[^}]*\}/g, ''), /\bjob\b/i, `toast says "job": ${m[1]}`);

console.log('settings-nav-names: ok');
