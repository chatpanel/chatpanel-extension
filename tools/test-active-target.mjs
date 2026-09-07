// Which model a feature runs on must be the one the user chose — or nothing.
//
// getTarget() substitutes when a lookup misses, which is right for a picker that must always
// show something and wrong everywhere else. Its fallback used to reach for the first BRIDGE
// agent, and the first built-in bridge agent is `claude-code`. So deleting the endpoint you
// were chatting with (the zero-setup WebLLM one, say) left `activeAgentId` naming nothing,
// and every consumer took the substitute for a choice: prompt-assist, inline autocomplete,
// scheduled-job skill runs and the meeting scribe all silently moved to Claude Code — on a
// machine where Claude Code was not installed, so all four failed on every attempt.
//
// Three things are asserted here, and each was a separate half of that bug:
//   1. findTarget() never substitutes,
//   2. getTarget()'s fallback prefers a configured endpoint over a CLI that may not exist,
//   3. repairActiveAgentId() heals a dangling id, so the substitute is never reached at all.
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { onChanged: { addListener() {} } } };

const {
  getTarget, findTarget, repairActiveAgentId, ROUTER_TARGET_ID, defaultSettings,
} = await import('../extension/js/store.js');

// The shape this user was in: chatting with the built-in WebLLM endpoint, then deleted it.
const orphaned = {
  activeAgentId: 'in-browser',
  endpoints: [
    { id: 'my-api', name: 'My API', kind: 'openai', baseUrl: 'https://example.com/v1', model: 'some-model' },
  ],
  agents: [
    { id: 'claude-code', name: 'Claude Code', kind: 'bridge', bridgeAgent: 'claude' },
    { id: 'codex', name: 'Codex', kind: 'bridge', bridgeAgent: 'codex' },
  ],
};

// 1. findTarget answers honestly.
assert.equal(findTarget(orphaned, 'in-browser'), null, 'a deleted id must resolve to nothing');
assert.equal(findTarget(orphaned, 'my-api')?.id, 'my-api');
assert.equal(findTarget(orphaned, 'codex')?.id, 'codex');
assert.equal(findTarget(orphaned, ''), null);
assert.equal(findTarget(undefined, 'my-api'), null, 'must not throw on absent settings');

// 2. THE REGRESSION. A miss must not land on the first bridge CLI.
const fallback = getTarget(orphaned, 'in-browser');
assert.notEqual(
  fallback.id, 'claude-code',
  'a dangling id fell back to Claude Code — this is "everything runs on Claude by default"',
);
assert.equal(fallback.id, 'my-api', 'a configured endpoint with a model is the best guess');

// A disabled target was switched off deliberately and is never the fallback.
assert.equal(
  getTarget({
    endpoints: [{ id: 'off', kind: 'openai', model: 'm', enabled: false }, { id: 'on', kind: 'openai', model: 'm' }],
    agents: [],
  }, 'gone').id,
  'on',
);
// An endpoint with no model chosen cannot answer, so a usable CLI beats it.
assert.equal(
  getTarget({
    endpoints: [{ id: 'no-model', kind: 'openai', model: '' }],
    agents: [{ id: 'codex', kind: 'bridge', bridgeAgent: 'codex' }],
  }, 'gone').id,
  'codex',
);
// …but an endpoint with no model is still better than nothing.
assert.equal(getTarget({ endpoints: [{ id: 'no-model', kind: 'openai', model: '' }], agents: [] }, 'gone').id, 'no-model');
assert.equal(getTarget({ endpoints: [], agents: [] }, 'gone'), null);
assert.equal(getTarget(undefined, 'gone'), null, 'must not throw on absent settings');
// An id that DOES resolve is always returned unchanged — the fallback is a last resort.
assert.equal(getTarget(orphaned, 'codex').id, 'codex');

// 3. The repair, which is what stops the fallback ever being consulted.
assert.equal(repairActiveAgentId(orphaned), 'my-api', 'a dangling active id must be healed');
assert.equal(
  repairActiveAgentId({ ...orphaned, activeAgentId: 'codex' }), 'codex',
  'a live id must be left exactly alone',
);
// Auto is a real choice that is deliberately not a stored model. Healing it would silently
// turn "let ChatPanel pick" into one fixed model on every settings read.
assert.equal(
  repairActiveAgentId({ ...orphaned, activeAgentId: ROUTER_TARGET_ID }), ROUTER_TARGET_ID,
  'the router target must survive the repair',
);
assert.equal(repairActiveAgentId({ endpoints: [], agents: [] }), '', 'nothing configured → no claim');

// Idempotent: a repaired id repairs to itself.
const once = repairActiveAgentId(orphaned);
assert.equal(repairActiveAgentId({ ...orphaned, activeAgentId: once }), once);

// The shipped defaults must be self-consistent — the active id names something real.
const d = defaultSettings();
assert.ok(findTarget(d, d.activeAgentId), 'the fresh-install default target must exist');
assert.equal(repairActiveAgentId(d), d.activeAgentId, 'a fresh install must need no repair');

console.log('active target: ok');
