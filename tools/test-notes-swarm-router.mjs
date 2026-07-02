import assert from 'node:assert/strict';

import {
  SWARM_ROLES, swarmCandidates, roleAgent, getRouter,
} from '../extension/js/notes-swarm-router.js';

// Fake the injected deps (providers/store/license) — the bridge holds no state, so a
// couple of plain fakes exercise the whole appointment path against the REAL router.
const settings = {
  activeAgentId: 'ep-gpt',
  endpoints: [
    { id: 'ep-gpt', name: 'GPT', kind: 'openai', model: 'gpt-4o' },        // balanced
    { id: 'ep-haiku', name: 'Haiku', kind: 'openai', model: 'claude-haiku' }, // cheap
  ],
  agents: [
    { id: 'ag-claude', name: 'Claude CLI', kind: 'bridge', bridgeAgent: 'claude', model: 'claude' }, // subagent-capable
  ],
};
const yes = { canUseAgent: () => true, getTarget: (s, id) => [...s.endpoints, ...s.agents].find((x) => x.id === id) || null, resolveTarget: (t) => ({ ...t, resolved: true }) };
const no = { ...yes, canUseAgent: () => false };
const license = {};

// candidates: every configured endpoint + agent, normalized.
const cands = swarmCandidates(yes, settings, license);
assert.deepEqual(cands.map((c) => c.id).sort(), ['ag-claude', 'ep-gpt', 'ep-haiku']);
assert.equal(cands.find((c) => c.id === 'ag-claude').kind, 'bridge');
assert.ok(cands.every((c) => c.usable === true));

// Editor prefers 'cheap' → the Haiku endpoint, as a plain API call.
const editor = await roleAgent(yes, settings, license, 'editor');
assert.equal(editor.label, 'Haiku');
assert.equal(editor.mode, 'api');
assert.equal(editor.resolved.resolved, true); // resolveTarget ran

// Writer prefers 'strong'; the bridge Claude routes as a native subagent.
const writer = await roleAgent(yes, settings, license, 'writer');
assert.equal(writer.mode, 'subagent');

// No usable model anywhere → null (never a silent bad appointment).
assert.equal(await roleAgent(no, settings, license, 'editor'), null);

// Role prefs are declared for every swarm member.
assert.deepEqual(Object.keys(SWARM_ROLES).sort(), ['editor', 'factcheck', 'researcher', 'writer']);

// getRouter lazy-loads the pure router once and caches it.
assert.equal(await getRouter(), await getRouter());

console.log('notes-swarm-router tests passed');
