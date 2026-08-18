// A turn is armed from what was SAID, not from what happens to be installed.
//
// Every turn used to carry the same equipment: "hi" reached the model with a history
// dispatcher, an MCP dispatcher and ~1,200 tokens of rulebook explaining how to use them.
// That is not only waste — a turn that CARRIES tools requires a model that can CALL them,
// so a greeting eliminated every model without the capability and then paid a CLI agent two
// seconds to spawn a process in order to wave back.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = {};
globalThis.chrome = {
  storage: {
    local: { get: async (k) => ({ [k]: mem[k] }), set: async (o) => { Object.assign(mem, o); } },
    onChanged: { addListener: () => {} },
  },
};

const { buildTurnTools } = await import('../extension/js/turn-tools.js');
const { toolNeedFor } = await import('../extension/js/events/tool-need.js');

// A provider the side panel would pass in — proof that even surface-supplied tools are
// dropped for a turn that cannot use them.
const page = { specs: [{ name: 'page', description: 'act on the page' }], execute: async () => 'ok' };

const settings = {
  ui: { historyTools: true },
  mcpServers: [{ id: 's', name: 'Wiki', url: 'https://example.com/mcp', enabled: true }],
};
const agent = { id: 'a', kind: 'endpoint', model: 'gpt-5.5', baseUrl: 'https://api.example.com/v1' };

test('a greeting is armed with nothing at all', async () => {
  const built = await buildTurnTools({
    resolvedAgent: agent, settings, userText: 'hi', extraProviders: [page],
  });
  assert.equal(built, undefined, 'a greeting was armed with tools');
});

test('a real request is still armed — the default is open', async () => {
  // THE FAILURE THIS MUST NEVER HAVE. Withhold the history tools from a question about the
  // user's own data and the model answers "I cannot access your meetings" — wrong, and the
  // exact thing the tool system prompt exists to prevent.
  const built = await buildTurnTools({
    resolvedAgent: agent, settings, userText: 'what did we decide in the standup', extraProviders: [page],
  });
  assert.ok(built?.specs?.length, 'a question about the user\'s own data was armed with nothing');
});

test('explicit intent is never second-guessed', async () => {
  // The /history hint, MCP mode 'on', a running skill — the user or a skill already answered
  // this question, and a heuristic must not overrule a stated intent.
  const built = await buildTurnTools({
    resolvedAgent: agent, settings, userText: 'hi', history: { enabled: true }, extraProviders: [page],
  });
  assert.ok(built?.specs?.length, 'an explicit request for tools was gated away');

  const onMode = await buildTurnTools({
    resolvedAgent: agent, settings, userText: 'hi', mcpMode: 'on', extraProviders: [page],
  });
  assert.ok(onMode?.specs?.length);
});

test('an attachment is never a greeting', async () => {
  const built = await buildTurnTools({
    resolvedAgent: agent, settings, userText: 'thanks',
    attachments: [{ kind: 'text', text: 'the quarterly report' }], extraProviders: [page],
  });
  assert.ok(built?.specs?.length);
});

test('the gate is the shared rule, not a second copy of it', async () => {
  // The gateway and the bridge arm turns too. A second definition of "asks for nothing"
  // living in the extension would drift from the one the router reads, and the one nobody is
  // watching is the one that goes wrong.
  assert.equal(toolNeedFor({ request: { text: 'hi' } }).tools, false);
  assert.equal(toolNeedFor({ request: { text: 'find the migration notes' } }).tools, true);
});

console.log('✓ turn tools: a greeting arms nothing, everything else stays armed');
