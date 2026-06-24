import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      async set(values) {
        Object.entries(values).forEach(([key, value]) => storage.set(key, value));
      },
    },
    onChanged: { addListener() {} },
  },
};

const {
  defaultSkills,
  getSettings,
  normalizeSkillForSave,
  resetSkillsToDefaults,
} = await import('../extension/js/store.js');

assert.deepEqual(
  normalizeSkillForSave({ id: 'x', mcpMode: 'none', mcpServerIds: ['jira'] }).mcpServerIds,
  [],
  'No MCP tools should clear stale selected server ids when saved.',
);
assert.deepEqual(
  normalizeSkillForSave({ id: 'x', mcpMode: 'default', mcpServerIds: ['jira'] }).mcpServerIds,
  [],
  'All enabled MCP tools should not retain a stale selected-server subset.',
);
assert.deepEqual(
  normalizeSkillForSave({ id: 'x', mcpMode: 'selected', mcpServerIds: ['jira', '', 'jira', 'github'] }).mcpServerIds,
  ['jira', 'github'],
  'Selected MCP servers should persist a unique non-empty ordered list.',
);

storage.set('chatpanel:settings', {
  version: 6,
  skills: [
    { id: 'summarize', name: 'Summarize', command: 'summarize', builtin: true, mcpMode: 'default', mcpServerIds: [] },
    { id: 'custom', name: 'Custom', command: 'custom', mcpMode: 'selected', mcpServerIds: ['jira'] },
  ],
});

const current = await getSettings();
assert.equal(
  current.skills.find((skill) => skill.id === 'summarize')?.mcpMode,
  'default',
  'Current-version built-in skills should preserve an explicit user choice of All enabled MCP tools.',
);

const reset = await resetSkillsToDefaults();
assert.deepEqual(
  reset.skills.map((skill) => [skill.id, skill.mcpMode, skill.mcpServerIds]),
  defaultSkills().map((skill) => [skill.id, skill.mcpMode, skill.mcpServerIds || []]),
  'Reset should replace saved skills with shipped default skills.',
);
assert.deepEqual(
  storage.get('chatpanel:settings').skills.map((skill) => skill.id),
  defaultSkills().map((skill) => skill.id),
  'Reset should persist the default skill set to chrome.storage.local.',
);

const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
assert.match(html, /id="reset-skills"/, 'Skills panel should expose a reset button.');
assert.match(js, /resetSkillsToDefaults/, 'Settings page should call the store reset helper.');
assert.match(js, /draftMcpServerIds/, 'Skill MCP checkbox edits should stay as local draft state until Save.');
assert.doesNotMatch(
  js,
  /input\.onchange = \(\) => \{\s*skill\.mcpServerIds/s,
  'Skill MCP checkbox changes should not mutate saved settings before Save.',
);

console.log('skills reset tests passed');
