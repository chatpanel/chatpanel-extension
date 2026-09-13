// Agent teams in the panel (F8 T1): the shared runner over THIS client's pieces.
//
// Three claims, each of which is a way the desktop and the panel could silently disagree:
//   1. a role is appointed from the panel's own endpoints and agents, usable ones only, and
//      the card shows the model's name rather than an endpoint id;
//   2. every member's turn is `streamChat` against a resolved target with the role's system
//      prompt, tools narrowed to its grants — a writer granted `none` gets no toolset at all;
//   3. every event reaches the gateway's run store in order, and a stop asked from the OTHER
//      client (the store's `run.stop-requested`) aborts the run here.
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}), set: async () => {} } } };

const { appointerFor, createRunSync, runTeamHere } = await import('../extension/js/team-host.js');

const settings = {
  gatewayUrl: 'http://127.0.0.1:4320',
  endpoints: [
    { id: 'ep-strong', name: 'Strong', kind: 'openai', baseUrl: 'https://example.com/v1', model: 'gpt-5', enabled: true },
    { id: 'ep-cheap', name: 'Cheap', kind: 'openai', baseUrl: 'https://example.com/v1', model: 'gpt-5-mini', enabled: true },
  ],
  agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'bridge', bridgeAgent: 'claude', enabled: true }],
  mcpServers: [{ id: 'srv-a', name: 'A', url: 'http://127.0.0.1:1/mcp' }, { id: 'srv-b', name: 'B', url: 'http://127.0.0.1:2/mcp' }],
};
const pro = { plan: 'pro', status: 'active', exp: Date.now() / 1000 + 3600 };

// 1. Appointment over the panel's roster.
{
  const appoint = appointerFor(settings, pro);
  const a = appoint({ id: 'writer', prefer: 'strong' });
  assert.ok(a && a.model, 'a role gets a model from the panel roster');
  assert.notEqual(a.label, a.model, 'the card shows the model name, not the endpoint id');
  const explicit = appoint({ id: 'x', model: 'ep-cheap' });
  assert.equal(explicit.model, 'ep-cheap');
  assert.equal(explicit.label, 'gpt-5-mini');
  const free = appointerFor(settings, null)({ id: 'writer', prefer: 'strong' });
  // On Free only the designated slots are usable; whatever is appointed must be usable.
  if (free) assert.ok(['ep-strong', 'ep-cheap', 'claude-code'].includes(free.model));
}

// A fake store in the gateway's wire shape.
function fakeStore() {
  const events = [];
  let stopHandler = null;
  return {
    events,
    created: null,
    create: async (run) => ({ ok: true, data: { run } }),
    append: async (id, batch) => { events.push(...batch.map((e) => ({ ...e, id }))); return { ok: true }; },
    stop: async () => ({ ok: true }),
    tail: (id, onEvent) => { stopHandler = onEvent; return () => { stopHandler = null; }; },
    requestStop() { stopHandler?.({ type: 'run.stop-requested' }); },
    get: async () => ({ ok: true }), list: async () => ({ ok: true, data: { runs: [] } }), remove: async () => ({ ok: true }),
  };
}

// 2 + 3. A run, end to end, with a fake model turn.
{
  const store = fakeStore();
  const calls = [];
  const toolsets = [];
  const streamChat = async ({ agent, messages, tools, onDelta }) => {
    calls.push({ system: agent.systemPrompt, user: messages[0].content, tools });
    const text = agent.systemPrompt.includes('researcher')
      ? 'FINDING: the sky is blue [ref: web]\nThe sky is blue.'
      : 'Final: the sky is blue.';
    onDelta(text);
    return { text };
  };
  const buildTurnTools = async (args) => { toolsets.push(args); return { specs: [{ name: 'web_search' }], mcpServers: args.settings.mcpServers }; };
  const team = {
    name: 'research', plan: 'fixed', merge: 'concat', enabled: true,
    roles: [
      { id: 'researcher', prompt: 'You are the researcher.', prefer: 'balanced', grants: ['web', 'mcp:srv-a'] },
      { id: 'writer', prompt: 'You are the writer.', prefer: 'strong', grants: ['none'] },
    ],
    budget: { tokens: 50000, ms: 60000 },
  };
  const seen = [];
  const result = await runTeamHere({
    team, request: 'what colour is the sky?', settings, license: pro, bridgeUrl: '', bridgeAvailable: false,
    streamChat, buildTurnTools, store, emit: (type) => seen.push(type),
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(calls.length, 2, 'one model turn per role');
  const researcher = calls.find((c) => c.system.includes('researcher'));
  const writer = calls.find((c) => c.system.includes('writer'));
  assert.ok(researcher.tools, 'a role granted web + mcp gets a toolset');
  assert.equal(writer.tools, undefined, 'a role granted none gets no toolset');
  assert.equal(toolsets.length, 1);
  assert.deepEqual(toolsets[0].settings.mcpServers.map((s) => s.id), ['srv-a'], 'mcp:<server> narrows the servers a role can reach');
  assert.equal(toolsets[0].includeWebSearch, true);
  assert.equal(toolsets[0].includeHistory, false);
  assert.ok(seen.includes('run.started') && seen.includes('run.done'));
  assert.deepEqual(store.events.map((e) => e.type).filter((t) => t === 'run.started' || t === 'run.done'), ['run.started', 'run.done'], 'the store receives the run in order');
  assert.equal(result.synced, true);
}

// 3. A stop from the other client aborts the run here.
{
  const store = fakeStore();
  let aborted = false;
  const streamChat = ({ signal, onDelta }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    onDelta('working…');
    setTimeout(() => store.requestStop(), 20);
  });
  const team = { name: 't', plan: 'fixed', merge: 'concat', roles: [{ id: 'a', prompt: 'p', grants: ['none'] }], budget: { tokens: 1000, ms: 5000 } };
  const result = await runTeamHere({ team, request: 'go', settings, license: pro, streamChat, buildTurnTools: async () => null, store });
  assert.equal(aborted, true, 'the model turn saw the abort');
  assert.notEqual(result.status, 'completed');
}

// createRunSync: a dead store costs the run nothing.
{
  const dead = { create: async () => ({ ok: false, error: 'down' }), append: async () => { throw new Error('never'); }, tail: () => () => {} };
  const sync = createRunSync({ store: dead, runId: 'r', team: 't', request: 'q' });
  assert.equal(await sync.start(), false);
  sync.push('run.started', {});
  await sync.end();
  assert.equal(sync.synced, false);
}

console.log('team-host: ok');
