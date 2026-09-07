import assert from 'node:assert/strict';

import {
  SWARM_ROLES, swarmCandidates, roleAgent, roleAgents, getRouter,
} from '../extension/js/notes-swarm-router.js';

// swarmOverrides() reads localStorage; the pin cases below drive it through this.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(String(k), String(v)),
  removeItem: (k) => store.delete(String(k)),
};
const PIN_KEY = 'chatpanel.notes.cowriter.roles';
const pin = (roles) => (roles ? store.set(PIN_KEY, JSON.stringify(roles)) : store.delete(PIN_KEY));

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

// THE MODEL THE USER PICKED IN THE PANEL LEADS.
//
// This used to go straight to appoint(), which ranks by inferred model TIER and knows
// nothing about the panel's selection — so the Editor was appointed to whichever model
// classified 'cheap' even though the user was chatting with another one. On a machine where
// that cheap model could not be reached, the only lever the user had was to DISABLE it,
// which is how this was reported. Tier routing is kept, as an OPT-IN pin (below).
pin(null);
const editor = await roleAgent(yes, settings, license, 'editor');
assert.equal(editor.label, 'GPT', 'an unpinned role must run on the panel\'s active model');
assert.equal(editor.mode, 'api');
assert.equal(editor.resolved.resolved, true); // resolveTarget ran

const writer = await roleAgent(yes, settings, license, 'writer');
assert.equal(writer.label, 'GPT', 'every unpinned role follows the active model');

// …and a PINNED role still gets exactly what it was pinned to, tier and mode included.
pin({ editor: 'ep-haiku', writer: 'ag-claude' });
assert.equal((await roleAgent(yes, settings, license, 'editor')).label, 'Haiku');
const pinnedWriter = await roleAgent(yes, settings, license, 'writer');
assert.equal(pinnedWriter.mode, 'subagent', 'the bridge Claude still routes as a native subagent');

// ROTATION. Every role hands back an ordered list so a model that will not answer can be
// stepped past — "at least it should rotate to the model that is working".
pin(null);
const chain = await roleAgents(yes, settings, license, 'editor');
assert.ok(chain.length > 1, 'a role must offer somewhere to fall back to');
assert.equal(chain[0].label, 'GPT', 'the active model is still first');
assert.deepEqual(
  [...new Set(chain.map((c) => c.label))], chain.map((c) => c.label),
  'a rotation must not try the same model twice',
);
// A CLI the bridge says is missing sorts BEHIND one it can see — never default to what we
// ship just because it is in the list.
const withBridge = {
  ...settings,
  activeAgentId: 'ep-gpt',
  agents: [
    { id: 'ag-claude', name: 'Claude CLI', kind: 'bridge', bridgeAgent: 'claude', model: 'claude' },
    { id: 'ag-codex', name: 'Codex CLI', kind: 'bridge', bridgeAgent: 'codex', model: 'codex' },
  ],
};
const health = [{ id: 'codex', available: true }, { id: 'claude', available: false }];
const ranked = (await roleAgents(yes, withBridge, license, 'editor', { bridgeAgents: health }))
  .map((c) => c.label);
assert.ok(
  ranked.indexOf('Codex CLI') < ranked.indexOf('Claude CLI'),
  `an installed CLI must be tried before a missing one — got ${ranked.join(' → ')}`,
);

pin(null);

// No usable model anywhere → null (never a silent bad appointment).
assert.equal(await roleAgent(no, settings, license, 'editor'), null);
assert.deepEqual(await roleAgents(no, settings, license, 'editor'), []);

// Role prefs are declared for every swarm member.
assert.deepEqual(Object.keys(SWARM_ROLES).sort(), ['editor', 'factcheck', 'researcher', 'writer']);

// getRouter lazy-loads the pure router once and caches it.
assert.equal(await getRouter(), await getRouter());

console.log('notes-swarm-router tests passed');
