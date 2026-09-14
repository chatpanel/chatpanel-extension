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

const { appointerFor, createRunSync, runTeamHere, engineOfCandidate, foldScm } = await import('../extension/js/team-host.js');

const settings = {
  gatewayUrl: 'http://127.0.0.1:4320',
  endpoints: [
    { id: 'ep-strong', name: 'Strong', kind: 'openai', baseUrl: 'https://example.com/v1', model: 'gpt-5', enabled: true },
    { id: 'ep-cheap', name: 'Cheap', kind: 'openai', baseUrl: 'https://example.com/v1', model: 'gpt-5-mini', enabled: true },
    { id: 'ep-strong2', name: 'Strong too', kind: 'anthropic', baseUrl: 'https://example.com/v1', model: 'claude-opus-5', enabled: true },
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

// The roster's order is the preference: the chat's own target first; a tie goes to it. And an
// exclusion (a model that answered "not deployed") moves the appointment along.
{
  assert.equal(appointerFor(settings, pro)({ id: 'r', prefer: 'strong' }).model, 'ep-strong', 'two strong models: the first configured wins');
  const like = appointerFor(settings, pro, { like: 'ep-strong2' })({ id: 'r', prefer: 'strong' });
  assert.equal(like.model, 'ep-strong2', 'the chat\'s own target is first on the roster');
  const next = appointerFor(settings, pro, { like: 'ep-strong2' })({ id: 'r', prefer: 'strong' }, { exclude: new Set(['ep-strong2']) });
  assert.equal(next.model, 'ep-strong');
  const pinned = appointerFor(settings, pro)({ id: 'r', model: 'ep-strong' }, { exclude: new Set(['ep-strong']) });
  assert.ok(pinned && pinned.model !== 'ep-strong', 'a pinned model that failed gives way to the roster');
}

// The appointment says what the engine is — an endpoint is a model at a destination, an
// installed agent is a harness — why it was chosen, and who else could have been.
{
  const a = appointerFor(settings, pro, { like: 'ep-strong2' })({ id: 'r', prefer: 'strong' });
  assert.deepEqual(a.engine, { kind: 'model', id: 'ep-strong2', model: 'claude-opus-5', label: 'Strong too' });
  assert.ok(a.reasons.includes('the target this chat is using') && a.reasons.some((r) => /strong/.test(r)), JSON.stringify(a.reasons));
  assert.ok(a.alternatives.length >= 1 && !a.alternatives.some((x) => x.id === 'ep-strong2'));
  const pinned = appointerFor(settings, pro)({ id: 'r', model: 'claude-code' });
  assert.deepEqual([pinned.engine, pinned.reasons], [{ kind: 'harness', id: 'claude' }, ['pinned by the role']]);
  assert.deepEqual(engineOfCandidate({ kind: 'bridge', id: 'cc', bridgeAgent: 'claude', model: 'opus' }), { kind: 'harness', id: 'claude', model: 'opus' });
  let scm = foldScm(null, { type: 'scm', phase: 'before', repo: '/r', branch: 'cp/p/j', head: 'a1' });
  scm = foldScm(scm, { type: 'scm', phase: 'after', repo: '/r', branch: 'cp/p/j', head: 'b2', headBefore: 'a1', commits: 2 });
  assert.deepEqual(scm, { repo: '/r', branch: 'cp/p/j', head: 'a1', headAfter: 'b2', commits: 2 });
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
  const streamChat = async ({ agent, messages, tools, onDelta, onEvent }) => {
    calls.push({ system: agent.systemPrompt, user: messages[0].content, tools });
    const text = agent.systemPrompt.includes('researcher')
      ? 'FINDING: the sky is blue [ref: web]\nThe sky is blue.'
      : 'Final: the sky is blue.';
    if (agent.systemPrompt.includes('researcher')) {
      // What a bridge-run harness reports about its checkout, before and after.
      onEvent?.({ type: 'scm', phase: 'before', repo: '/r', branch: 'cp/p/j', head: 'a1' });
      onEvent?.({ type: 'scm', phase: 'after', repo: '/r', branch: 'cp/p/j', head: 'b2', headBefore: 'a1', commits: 1 });
    }
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
  assert.deepEqual(researcher.tools.specs.map((x) => x.name), ['board', 'web_search'], 'a role granted web + mcp gets the board and the host toolset');
  assert.deepEqual(writer.tools.specs.map((x) => x.name), ['board'], 'a role granted none gets the board and nothing else');
  assert.equal(toolsets.length, 1);
  assert.deepEqual(toolsets[0].settings.mcpServers.map((s) => s.id), ['srv-a'], 'mcp:<server> narrows the servers a role can reach');
  assert.equal(toolsets[0].includeWebSearch, true);
  assert.equal(toolsets[0].includeHistory, false);
  assert.ok(seen.includes('run.started') && seen.includes('run.done'));
  assert.deepEqual(store.events.map((e) => e.type).filter((t) => t === 'run.started' || t === 'run.done'), ['run.started', 'run.done'], 'the store receives the run in order');
  assert.equal(result.synced, true);
  const routed = store.events.filter((e) => e.type === 'task.routed');
  assert.equal(routed.length, 2, 'every appointment is on the record');
  assert.ok(routed.every((e) => ['model', 'harness'].includes(e.engine?.kind) && e.reasons.length), JSON.stringify(routed));
  const harness = routed.find((e) => e.engine.kind === 'harness');
  assert.ok(harness && harness.reasons.includes('an installed agent'), 'the balanced role went to Claude Code — a harness, said as one');
  const said = store.events.find((e) => e.type === 'task.scm');
  assert.equal(said.role, 'researcher'); assert.equal(said.commits, 1); assert.equal(said.headAfter, 'b2');
  const fact = store.events.find((e) => e.type === 'task.scored' && e.role === 'researcher');
  assert.equal(fact.scm.branch, 'cp/p/j'); assert.deepEqual(fact.engine, { kind: 'harness', id: 'claude' });
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

// createRunSync: ONE failed append does not end the record. The batch goes back in front,
// the next flush retries it, and the run's end lands — in order — once the store answers
// again. (A run that had finished sat "running" on the board because of a single miss.)
{
  const got = [];
  let fail = 2;
  const flaky = { create: async () => ({ ok: true }), append: async (_id, batch) => { if (fail-- > 0) return { ok: false, error: 'timeout' }; got.push(...batch.map((e) => e.type)); return { ok: true }; }, tail: () => () => {} };
  const sync = createRunSync({ store: flaky, runId: 'r', team: 't', request: 'q' });
  assert.equal(await sync.start(), true);
  sync.push('run.started', {});
  sync.push('task.started', {});
  sync.push('run.done', {}); // flushes at once — fails (1)
  await new Promise((r) => setTimeout(r, 30));
  sync.push('after', {});
  await sync.end(); // retries: fails (2), then lands everything, in order
  assert.deepEqual(got, ['run.started', 'task.started', 'run.done', 'after'], 'every event, in order, after two misses');
  assert.equal(sync.synced, true);
}
// …but a store that never answers is given up on, not retried forever.
{
  let tries = 0;
  const down = { create: async () => ({ ok: true }), append: async () => { tries++; return { ok: false, error: 'down' }; }, tail: () => () => {} };
  const sync = createRunSync({ store: down, runId: 'r', team: 't', request: 'q' });
  await sync.start();
  sync.push('run.done', {});
  await sync.end();
  assert.ok(tries >= 3, 'retried on the way out');
  assert.ok(tries < 20, 'and stopped');
}

console.log('team-host: ok');

// A1: a role that stands for an agent is filled from the pool on the way to a run — the
// agent's prompt, its grants narrowed by the role, its engine mapped to THIS panel's target
// — and a harness role takes its grants and its worktree to the bridge (`agent.run`).
{
  const { resolveTeamHere } = await import('../extension/js/team-host.js');
  const pooled = {
    ...settings,
    agentPool: [
      { id: 'researcher', name: 'Researcher', prompt: 'You are the researcher.', grants: ['web', 'data', 'mcp'], engine: { kind: 'auto', policy: { prefer: 'cheapest-that-clears' } } },
      { id: 'implementer', name: 'Implementer', prompt: 'You are the implementer.', grants: ['shell', 'fs:write', 'scm:read', 'scm:push'], engine: { kind: 'harness', harnessId: 'claude' }, workdir: '/repos/x' },
      { id: 'writer', name: 'Writer', prompt: 'You are the writer.', grants: ['none'], engine: { kind: 'model', providerId: 'ep-strong2', model: 'claude-opus-5' } },
    ],
  };
  const team = { name: 'build', plan: 'fixed', merge: 'concat', roles: [{ id: 'r', agent: 'researcher', grants: ['web'] }, { id: 'i', agent: 'implementer' }, { id: 'w', agent: 'writer' }], budget: { tokens: 50000, ms: 60000 } };
  const resolved = resolveTeamHere(team, pooled, pro, { like: 'ep-strong' });
  assert.equal(resolved.roles[0].prompt, 'You are the researcher.');
  assert.deepEqual(resolved.roles[0].grants, ['web'], 'narrowed by the role');
  assert.equal(resolved.roles[0].prefer, 'cheap');
  assert.equal(resolved.roles[1].model, 'claude-code', 'a harness engine is the installed agent that runs that CLI');
  assert.equal(resolved.roles[2].model, 'ep-strong2', 'a model engine is the endpoint that serves it');
  // The Assistant's engine is the chat's target.
  const asst = resolveTeamHere({ name: 'a', roles: [{ id: 'a', agent: 'assistant' }], budget: { tokens: 1 } }, pooled, pro, { like: 'ep-cheap' });
  assert.equal(asst.roles[0].model, 'ep-cheap');
  assert.throws(() => resolveTeamHere({ name: 'x', roles: [{ id: 'x', agent: 'ghost' }], budget: { tokens: 1 } }, pooled, pro), /not in the pool/);
  // A run: the harness role's streamChat target carries `run` with its grants and worktree.
  const store = fakeStore();
  const targets = [];
  const streamChat = async ({ agent, onDelta }) => { targets.push(agent); onDelta('ok'); return { text: 'ok' }; };
  const result = await runTeamHere({ team, request: 'build it', settings: pooled, license: pro, bridgeUrl: '', bridgeAvailable: false, streamChat, buildTurnTools: async () => ({ specs: [] }), store });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const impl = targets.find((t) => t.systemPrompt.includes('implementer'));
  assert.deepEqual(impl.run.grants, ['shell', 'fs:write', 'scm:read', 'scm:push']);
  assert.deepEqual(impl.run.workspace, { repo: '/repos/x', projectId: 'build', jobId: result.runId });
  const res = targets.find((t) => t.systemPrompt.includes('researcher'));
  assert.equal(res.run, undefined, 'a model role takes nothing to the bridge');
}

// 8. THE REQUEST'S SOURCES NARROW THE ROSTER. A run about an internal page appointed a cloud
//    model, the gate refused it ("Not sent: localhost matches 'localhost'…"), the runner
//    re-appointed the next cloud model, and the installed agent — in reach the whole time —
//    was never asked. The work log then read `mqk41ucyhmz1au → mqqzh4970js34c → …`, ids
//    that name nothing.
{
  const { sourceGuardFor, sourcePolicySettings, sourceUrlsOf } = await import('../extension/js/events/source-gate.js');
  const request = 'Summarise http://localhost:3000/admin/report for the team';
  const guard = sourceGuardFor(sourcePolicySettings({ internalCeiling: 'trusted' }), sourceUrlsOf([{ role: 'user', content: request }]));
  assert.ok(guard, 'localhost is internal by default');
  const within = appointerFor(settings, pro, { guard })({ id: 'r', prefer: 'strong' });
  assert.equal(within.model, 'claude-code', 'the installed agent is the only candidate within reach');
  assert.equal(within.label, 'claude', 'the label, not the id, is what the record shows');
  const device = appointerFor(settings, pro, { guard: sourceGuardFor(sourcePolicySettings({}), sourceUrlsOf([{ role: 'user', content: request }])) })({ id: 'r', prefer: 'strong' });
  assert.equal(device, null, 'a device ceiling with no local model appoints nobody — said plainly, not refused after the fact');
  // A local endpoint IS the device.
  const local = { ...settings, endpoints: [...settings.endpoints, { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'gemma', enabled: true }] };
  assert.equal(appointerFor(local, pro, { guard: sourceGuardFor(sourcePolicySettings({}), ['http://localhost:3000']) })({ id: 'r', prefer: 'strong' }).model, 'ollama');
  // No internal address: the roster is what it was.
  assert.equal(appointerFor(settings, pro, { guard: null })({ id: 'r', prefer: 'strong' }).model, 'ep-strong');
}

console.log('team host: the roster is narrowed by the request\'s reach; the record names models');
