import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  enabledSkills,
  filterMcpServersForSkill,
  isSkillEnabled,
  skillRunFromSkill,
  skillToolSystem,
} from '../extension/js/skill-runtime.js';

const servers = [
  { id: 'filesystem', name: 'Filesystem', enabled: true, tools: [{ name: 'read_file', description: 'Read a file' }] },
  { id: 'github', name: 'GitHub', enabled: true, tools: [{ name: 'search_issues' }, { name: 'create_issue' }] },
  { id: 'off', name: 'Disabled', enabled: false, tools: [{ name: 'disabled_tool' }] },
];

const chatSkill = skillRunFromSkill(
  { id: 'research', historyContext: 'chats', mcpMode: 'selected', mcpServerIds: ['github', 'off'] },
  { includeMeetings: true },
);
assert.deepEqual(chatSkill.history, { enabled: true, scope: 'chats', includeMeetings: false, requested: 'chats' });
assert.deepEqual(filterMcpServersForSkill(servers, chatSkill).map((s) => s.id), ['github']);
assert.match(skillToolSystem(chatSkill, servers), /chat history/);
assert.match(skillToolSystem(chatSkill, servers), /GitHub/);
assert.match(skillToolSystem(chatSkill, servers), /search_issues/);
assert.match(skillToolSystem(chatSkill, servers), /<sup>\[1\]<\/sup>/);
assert.match(skillToolSystem(chatSkill, servers), /Sources/);
assert.doesNotMatch(skillToolSystem(chatSkill, servers), /Disabled/);

const meetingBlocked = skillRunFromSkill(
  { id: 'meeting-research', historyContext: 'meetings', mcpMode: 'none' },
  { includeMeetings: false },
);
assert.deepEqual(meetingBlocked.history, {
  enabled: false,
  scope: 'meetings',
  includeMeetings: false,
  requested: 'meetings',
  blocked: 'meetings',
});
assert.deepEqual(filterMcpServersForSkill(servers, meetingBlocked), []);
assert.match(skillToolSystem(meetingBlocked, servers), /MCP tools are disabled/);

const allHistory = skillRunFromSkill(
  { id: 'deep-research', historyContext: 'all', mcpMode: 'default' },
  { includeMeetings: true },
);
assert.deepEqual(allHistory.history, { enabled: true, scope: 'all', includeMeetings: true, requested: 'all' });
assert.deepEqual(filterMcpServersForSkill(servers, allHistory).map((s) => s.id), ['filesystem', 'github']);

const legacyMissingMcpMode = skillRunFromSkill({ id: 'legacy-skill' }, { includeMeetings: true });
assert.equal(legacyMissingMcpMode.mcp.mode, 'none', 'Skills without an MCP mode should default to no MCP tools.');
assert.deepEqual(filterMcpServersForSkill(servers, legacyMissingMcpMode), []);
assert.match(skillToolSystem(legacyMissingMcpMode, servers), /MCP tools are disabled/);

// A skill can be switched OFF instead of deleted. Absence of the flag means
// enabled, so skills saved before the flag existed keep working.
assert.equal(isSkillEnabled({ id: 'legacy' }), true, 'A skill without the flag should count as enabled.');
assert.equal(isSkillEnabled({ id: 'on', enabled: true }), true);
assert.equal(isSkillEnabled({ id: 'off', enabled: false }), false);
assert.equal(isSkillEnabled(null), false, 'A missing skill is never enabled.');
assert.deepEqual(
  enabledSkills([{ id: 'a' }, { id: 'b', enabled: false }, { id: 'c', enabled: true }, null]).map((s) => s.id),
  ['a', 'c'],
);
assert.deepEqual(enabledSkills(undefined), [], 'A missing skill list should filter to nothing, not throw.');

// "Off" has to mean off on EVERY surface, or a disabled skill still fires from
// whichever list forgot to check.
const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
for (const [label, snippet] of [
  ['slash-command match', "enabledSkills(state.settings.skills).find("],
  ['skills menu', 'for (const skill of enabledSkills(state.settings.skills)) {'],
  ['meeting monitors', 'return enabledSkills(state.settings?.skills).filter((s) => s.meeting && s.prompt);'],
  ['slash autocomplete', 'skills: enabledSkills(state.settings.skills),'],
]) {
  assert.ok(sidepanel.includes(snippet), `The ${label} should skip disabled skills.`);
}
const notes = readFileSync(new URL('../extension/notes.js', import.meta.url), 'utf8');
assert.match(notes, /enabledSkills\(s\.skills\)/, 'The Notes # picker should skip disabled skills.');
assert.match(notes, /findSkillByName\(deps\.enabledSkills\(settings\.skills\), name\)/, 'A #mention should not resolve a disabled skill.');

console.log('skill runtime tests passed');
