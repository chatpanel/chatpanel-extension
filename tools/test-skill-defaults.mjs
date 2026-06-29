import assert from 'node:assert/strict';

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

const { defaultSkills, getSettings } = await import('../extension/js/store.js');

const shipped = defaultSkills();
assert.ok(shipped.length > 0, 'Default skills should be present.');
assert.deepEqual(
  shipped.map((skill) => [skill.id, skill.mcpMode]),
  shipped.map((skill) => [skill.id, 'none']),
  'Every shipped built-in skill should default to No MCP tools.',
);

storage.set('chatpanel:settings', {
  version: 5,
  skills: [
    { id: 'summarize', name: 'Summarize', command: 'summarize', builtin: true, mcpMode: 'default' },
    { id: 'custom', name: 'Custom', command: 'custom', mcpMode: 'selected', mcpServerIds: ['github'] },
  ],
});

const migrated = await getSettings();
assert.equal(
  migrated.skills.find((skill) => skill.id === 'summarize')?.mcpMode,
  'none',
  'Legacy built-in skills saved with the old default should migrate to No MCP tools.',
);
assert.equal(
  migrated.skills.find((skill) => skill.id === 'meeting-notes')?.mcpMode,
  'none',
  'Newer injected built-in skills should also use No MCP tools.',
);
assert.equal(
  migrated.skills.find((skill) => skill.id === 'custom')?.mcpMode,
  'selected',
  'Explicit user MCP selections on custom skills should be preserved.',
);
assert.equal(storage.get('chatpanel:settings').version, 9, 'Skill default migration should be persisted (current schema version).');

console.log('skill defaults tests passed');
