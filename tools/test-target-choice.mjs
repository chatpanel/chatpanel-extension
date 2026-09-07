// Never default to what we ship. Default to what the user chose, then to what works.
//
// The reported machine: no local models, no API model configured, no Claude Code installed —
// only Codex. ChatPanel ships a `claude-code` agent as the first built-in, so every list this
// product builds started with a CLI that was not there, and four features independently
// picked it: the panel's free-slot repair, the Notes swarm (which appoints by model TIER and
// ignored the panel's selection outright), suggestions and the meeting scribe. The user's
// only lever was to DISABLE their other cards until the right one won.
//
// This is the one ordering they all share now, so the machine above is a fixture rather than
// four separate bug reports.
import assert from 'node:assert/strict';

const { orderTargets, bestTarget, reachability, noTargetReason, targetKey, reconcileAutoEnable } =
  await import('../extension/js/target-choice.js');

const ids = (list) => list.map((t) => t.id);

// ── the reported machine ─────────────────────────────────────────────────────────
const machine = {
  activeAgentId: 'ag-codex',
  endpoints: [
    // Shipped built-ins, both unusable: no model chosen on either.
    { id: 'in-browser', name: 'WebLLM', kind: 'webllm', model: '' },
    { id: 'local-ollama', name: 'Ollama', kind: 'openai', model: '' },
  ],
  agents: [
    { id: 'claude-code', name: 'Claude Code', kind: 'bridge', bridgeAgent: 'claude' },
    { id: 'ag-codex', name: 'Codex', kind: 'bridge', bridgeAgent: 'codex' },
  ],
};
// What /health says: Codex is there, Claude is not.
const health = [{ id: 'codex', available: true }, { id: 'claude', available: false }];

{
  const order = orderTargets(machine, { bridgeAgents: health });
  assert.equal(order[0].id, 'ag-codex', 'the model the user selected must lead');
  assert.ok(!ids(order).includes('in-browser'), 'an endpoint with no model cannot answer');
  assert.ok(!ids(order).includes('local-ollama'), 'an endpoint with no model cannot answer');
  assert.ok(
    ids(order).indexOf('ag-codex') < ids(order).indexOf('claude-code'),
    'a CLI that is installed must be tried before one that is not',
  );
  assert.equal(bestTarget(machine, { bridgeAgents: health }).id, 'ag-codex');
}

// THE REGRESSION, stated directly: with nothing selected, we must still not land on the
// thing we ship just because it is first in the array.
{
  const nothingPicked = { ...machine, activeAgentId: '' };
  assert.equal(
    bestTarget(nothingPicked, { bridgeAgents: health }).id, 'ag-codex',
    'an unselected user must land on the agent that EXISTS, not the first built-in',
  );
}

// ── the ordering rules, one at a time ────────────────────────────────────────────
const mixed = {
  activeAgentId: 'ep-b',
  endpoints: [
    { id: 'ep-a', name: 'A', kind: 'openai', model: 'm1' },
    { id: 'ep-b', name: 'B', kind: 'openai', model: 'm2' },
    { id: 'ep-off', name: 'Off', kind: 'openai', model: 'm3', enabled: false },
  ],
  agents: [{ id: 'ag', name: 'CLI', kind: 'bridge', bridgeAgent: 'codex' }],
};

// An explicit per-feature setting outranks even the active model.
assert.equal(orderTargets(mixed, { prefer: 'ep-a' })[0].id, 'ep-a');
assert.equal(orderTargets(mixed, {})[0].id, 'ep-b', 'otherwise the active model leads');
// A prefer that no longer exists is simply ignored — never a reason to return nothing.
assert.equal(orderTargets(mixed, { prefer: 'deleted' })[0].id, 'ep-b');
// Disabled means disabled, everywhere.
assert.ok(!ids(orderTargets(mixed, {})).includes('ep-off'));
// A CLI is real cost — it goes last among things that work.
assert.equal(ids(orderTargets(mixed, {})).at(-1), 'ag');
assert.ok(!ids(orderTargets(mixed, { includeBridge: false })).includes('ag'));
// No duplicates, however many rules name the same target.
{
  const order = orderTargets(mixed, { prefer: 'ep-b' });
  assert.deepEqual([...new Set(ids(order))], ids(order));
}

// ── the licence gate: Free is one API provider and one CLI — the user's pick ─────
{
  // Free with Codex as the unlocked CLI slot: Claude Code must not appear at all.
  const canUseAgent = (_l, _s, t) => t.id === 'ag-codex' || t.id === 'ep-a';
  const order = orderTargets({ ...machine, endpoints: mixed.endpoints }, { canUseAgent, bridgeAgents: health });
  assert.deepEqual(ids(order), ['ag-codex', 'ep-a'], 'only the unlocked slots, best first');
  assert.equal(orderTargets(machine, { canUseAgent: () => false }).length, 0);
}

// ── reachability is THREE-valued: unpolled is not the same as missing ────────────
assert.equal(reachability({ kind: 'openai', model: 'm' }, health), undefined, 'endpoints are not in /health');
assert.equal(reachability({ kind: 'bridge', bridgeAgent: 'codex' }, health), true);
assert.equal(reachability({ kind: 'bridge', bridgeAgent: 'claude' }, health), false);
assert.equal(reachability({ kind: 'bridge', bridgeAgent: 'codex' }, null), undefined, 'unpolled ≠ missing');
assert.equal(reachability({ kind: 'bridge', bridgeAgent: 'custom' }, health), undefined, 'BYO CLIs are not enumerable');
// Before the bridge is polled, CLI agents are still offered — a fresh panel must not look empty.
assert.equal(orderTargets(machine, { bridgeAgents: null }).length, 2);

// ── the explanation names the next thing to do ───────────────────────────────────
assert.match(noTargetReason({ endpoints: [], agents: [] }), /add an endpoint or agent/i);
assert.match(
  noTargetReason(machine, { bridgeAgents: health }), /Load models|Pick a model/i,
  'the truth is "your endpoint has no model", not "no model configured"',
);
assert.match(
  noTargetReason({ ...machine, endpoints: [] }, { bridgeAgents: health.map((h) => ({ ...h, available: false })) }),
  /not found on this machine/i,
);
assert.match(noTargetReason(machine, { canUseAgent: () => false }), /plan|upgrade/i);

// Identity: same model in the same place is the same candidate (shared with the fallback chain).
assert.equal(targetKey({ kind: 'openai', id: 'a', model: 'm', baseUrl: 'u' }), 'openai:a:m:u');
assert.notEqual(targetKey({ kind: 'openai', id: 'a', model: 'm' }), targetKey({ kind: 'openai', id: 'a', model: 'n' }));

// Absent settings must degrade, not throw — this runs on a cold panel.
assert.deepEqual(orderTargets(undefined, {}), []);
assert.equal(bestTarget(undefined, {}), null);

// ── discovery gating: ship nothing enabled that is not actually here ──────────────
//
// ChatPanel ships nine bridge CLIs and a machine has one. All nine used to arrive switched
// ON, so the picker advertised eight agents that could not answer and every fallback landed
// on the first of them. They now ship OFF with `autoEnable: true` — "no human has an opinion
// about me yet, follow the bridge" — and this is what follows it.
{
  const shipped = [
    { id: 'claude-code', kind: 'bridge', bridgeAgent: 'claude', builtin: true, enabled: false, autoEnable: true },
    { id: 'codex', kind: 'bridge', bridgeAgent: 'codex', builtin: true, enabled: false, autoEnable: true },
    { id: 'pi', kind: 'bridge', bridgeAgent: 'pi', builtin: true, enabled: false, autoEnable: true },
  ];
  const found = [{ id: 'codex', available: true }, { id: 'claude', available: false }];

  const { changed, agents } = reconcileAutoEnable(shipped, found);
  assert.equal(changed, true);
  const on = agents.filter((a) => a.enabled !== false).map((a) => a.id);
  assert.deepEqual(on, ['codex'], 'only the CLI that is actually installed may be enabled');

  // Idempotent: running it again against the same answer must not churn settings.
  assert.equal(reconcileAutoEnable(agents, found).changed, false, 'a no-op must not write settings');

  // THE GUARD THAT MATTERS. An unreachable bridge reports nothing, and treating that as
  // "nothing is installed" would empty the picker of every agent the user has.
  assert.equal(reconcileAutoEnable(agents, null).changed, false, 'an unpolled bridge must move nothing');
  assert.equal(reconcileAutoEnable(agents, undefined).changed, false);

  // A DECISION IS PERMANENT. Once the user flips the switch, autoEnable is gone and the
  // bridge no longer gets a vote — in either direction.
  const decided = [
    { id: 'claude-code', kind: 'bridge', bridgeAgent: 'claude', enabled: true },   // kept on, though missing
    { id: 'codex', kind: 'bridge', bridgeAgent: 'codex', enabled: false },         // kept off, though present
  ];
  assert.equal(reconcileAutoEnable(decided, found).changed, false, 'a hand-set switch is never revised');

  // A bring-your-own CLI is a user-defined command /health cannot enumerate. Absence of
  // evidence is not evidence of absence, so it is never switched off for being unlisted.
  const byo = [{ id: 'mine', kind: 'bridge', bridgeAgent: 'custom', enabled: true, autoEnable: true }];
  assert.equal(reconcileAutoEnable(byo, found).changed, false, 'a BYO CLI is not enumerable');

  // Endpoints are not the bridge's business.
  const eps = [{ id: 'ep', kind: 'openai', model: 'm', enabled: true, autoEnable: true }];
  assert.equal(reconcileAutoEnable(eps, found).changed, false);

  // Degrades rather than throws — this runs off a network reply.
  assert.deepEqual(reconcileAutoEnable(undefined, found).agents, []);
  assert.equal(reconcileAutoEnable([null], found).changed, false);
}

// And the shipped defaults must actually BE off, or the gate above guards nothing.
{
  globalThis.chrome = globalThis.chrome || { storage: { onChanged: { addListener() {} } } };
  const { defaultSettings } = await import('../extension/js/store.js');
  const d = defaultSettings();
  const cli = d.agents.filter((a) => a.kind === 'bridge');
  assert.ok(cli.length >= 8, 'the built-in CLI list is the thing under test');
  assert.deepEqual(
    cli.filter((a) => a.enabled !== false).map((a) => a.id), [],
    'no CLI agent may ship enabled — a fresh install must not advertise agents it has not found',
  );
  assert.ok(cli.every((a) => a.autoEnable === true), 'every shipped CLI must follow the bridge');
  // …and a fresh install must still be able to chat, or this trade is a regression.
  assert.ok(
    bestTarget(d, {}), 'a fresh install with no bridge must still have something to talk to',
  );
  assert.equal(bestTarget(d, {}).kind, 'webllm', 'the zero-setup in-browser model');
}

console.log('discovery gating: ok');
