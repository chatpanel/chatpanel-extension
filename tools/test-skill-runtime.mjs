import assert from 'node:assert/strict';

import {
  filterMcpServersForSkill,
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

console.log('skill runtime tests passed');
