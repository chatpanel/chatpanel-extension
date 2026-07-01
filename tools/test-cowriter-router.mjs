// Model router: tier classification, appointment by preference, overrides, subagent
// mode, graceful fallback. Pure — portable across extension/gateway/bridge.
import assert from 'node:assert/strict';
import { classifyModel, supportsSubagents, appoint, routeTeam } from '../extension/js/cowriter-router.js';

// 1) tier classification from model ids.
assert.equal(classifyModel('claude-haiku-4-5'), 'cheap');
assert.equal(classifyModel('gpt-4o-mini'), 'cheap');
assert.equal(classifyModel('claude-opus-4-8'), 'strong');
assert.equal(classifyModel('gpt-4-turbo'), 'strong');
assert.equal(classifyModel('claude-sonnet-4-6'), 'balanced');
assert.equal(classifyModel('gpt-4o'), 'balanced');
assert.equal(classifyModel('some-unknown-model'), 'balanced');

// 2) subagent capability = Claude Code / Codex bridge agents.
assert.equal(supportsSubagents({ kind: 'bridge', bridgeAgent: 'claude' }), true);
assert.equal(supportsSubagents({ kind: 'bridge', bridgeAgent: 'codex' }), true);
assert.equal(supportsSubagents({ kind: 'bridge', bridgeAgent: 'pi' }), false);
assert.equal(supportsSubagents({ kind: 'openai', model: 'gpt-4o' }), false);

const candidates = [
  { id: 'hk', name: 'Haiku', kind: 'anthropic', model: 'claude-haiku-4-5' },
  { id: 'op', name: 'Opus', kind: 'anthropic', model: 'claude-opus-4-8' },
  { id: 'so', name: 'Sonnet', kind: 'anthropic', model: 'claude-sonnet-4-6' },
  { id: 'cc', name: 'Claude Code', kind: 'bridge', bridgeAgent: 'claude', model: 'claude' },
];

// 3) appoint by preference — cheap role → cheap model, strong role → strong model.
{
  const editor = appoint({ id: 'editor', prefer: 'cheap' }, candidates);
  assert.equal(editor.id, 'hk', 'editor gets the cheap model');
  const writer = appoint({ id: 'writer', prefer: 'strong' }, candidates);
  assert.equal(writer.id, 'op', 'writer gets the strong model');
  const researcher = appoint({ id: 'researcher', prefer: 'balanced' }, candidates);
  assert.equal(researcher.tier, 'balanced');
}

// 4) override pins a role to a specific agent regardless of preference.
{
  const editor = appoint({ id: 'editor', prefer: 'cheap' }, candidates, { overrides: { editor: 'op' } });
  assert.equal(editor.id, 'op', 'override wins');
}

// 5) execution mode — a bridge Claude Code runs as a subagent; API models as api.
{
  const viaCC = appoint({ id: 'writer', prefer: 'strong' }, candidates, { overrides: { writer: 'cc' } });
  assert.equal(viaCC.mode, 'subagent');
  const op = appoint({ id: 'writer', prefer: 'strong' }, candidates);
  assert.equal(op.mode, 'api');
}

// 6) graceful fallback — no usable candidates → null; unusable/no-model filtered out.
{
  assert.equal(appoint({ id: 'editor', prefer: 'cheap' }, []), null);
  const only = appoint({ id: 'editor', prefer: 'cheap' }, [{ id: 'x', name: 'X', model: 'gpt-4o', usable: false }, { id: 'y', name: 'Y', model: '' }]);
  assert.equal(only, null, 'unusable + model-less are skipped');
}

// 7) routeTeam maps every role.
{
  const team = routeTeam([{ id: 'editor', prefer: 'cheap' }, { id: 'writer', prefer: 'strong' }], candidates);
  assert.equal(team.editor.id, 'hk');
  assert.equal(team.writer.id, 'op');
}

console.log('cowriter-router tests passed');
