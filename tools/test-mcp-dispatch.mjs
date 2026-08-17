import assert from 'node:assert/strict';
import { buildToolset } from '../extension/js/toolset.js';
import { mcpDispatchProvider, MCP_TOOL_NAME } from '../extension/js/mcp-dispatch.js';
import { estimate } from '../extension/js/group-dispatch.js';
import { isLocalToolSpec } from '../extension/js/tool-select.js';

// Two servers, the shape getMcpProviders returns.
const server = (name, tools) => ({
  remote: true,
  specs: tools.map((t) => ({
    name: `mcp_${name}__${t}`,
    description: `[${name}] ${t} — does the ${t} thing for ${name}, with several options and a long description of the kind real servers ship.`,
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'what to look for' }, limit: { type: 'number' } }, required: ['query'] },
  })),
  system: `## ${name}\nUse these for ${name}.`,
  execute: async (n, a) => JSON.stringify({ called: n, args: a }),
});

const inner = buildToolset([
  server('jira', ['search', 'get_issue', 'create_issue']),
  server('cloudflare', ['list_zones', 'get_analytics', 'purge_cache']),
]);
const wrapped = mcpDispatchProvider(inner);

const beforeTok = estimate(inner.specs) + estimate(inner.system);
const afterTok = estimate(wrapped.specs) + estimate(wrapped.system);
console.log(`  mcp tools: ${beforeTok} → ${afterTok} tokens (${Math.round((1 - afterTok / beforeTok) * 100)}% off)`);
assert.ok(afterTok < beforeTok / 2, `expected a large cut, got ${beforeTok} → ${afterTok}`);
assert.equal(wrapped.specs.length, 1);

// PRIVACY — the one property here worth its own test. The harness keeps PII off remote
// tools under "redact remote"; a dispatcher that lost the flag would quietly turn
// redacted tools into unredacted ones.
assert.equal(wrapped.remote, true, 'the dispatcher is not flagged remote — redaction would stop applying');
const outer = buildToolset([wrapped]);
assert.ok(outer.remoteTools.has(MCP_TOOL_NAME), 'the dispatcher is missing from remoteTools');

// The ~600-token shared MCP rulebook must NOT come back through the outer toolset. It is
// admitted by a name matching /^mcp[_-]/, which is exactly why this tool is not named
// mcp_call.
assert.ok(!/One or more MCP servers are connected/.test(String(outer.system || '')),
  'the shared MCP rulebook is resident again — the dispatcher name re-admitted it');
assert.ok(estimate(outer.system) < 40, `resident system is still ${estimate(outer.system)} tokens`);

// Every server tool stays reachable — the cap stops being a capability decision.
const actions = wrapped.specs[0].parameters.properties.action.enum;
for (const s of inner.specs) assert.ok(actions.includes(s.name), `${s.name} became unreachable`);

// Routing keeps the real name, so per-server auth, budgets and error handling still apply.
const out = JSON.parse(await wrapped.execute(MCP_TOOL_NAME, { action: 'mcp_jira__search', args: { query: 'ATLAS-1' } }));
assert.equal(out.called, 'mcp_jira__search');
assert.deepEqual(out.args, { query: 'ATLAS-1' });

// describe carries the per-server guidance that is no longer in the prompt.
const desc = JSON.parse(await wrapped.execute(MCP_TOOL_NAME, { action: 'describe', args: { tool: 'mcp_jira__search' } }));
assert.equal(desc.name, 'mcp_jira__search');
assert.ok(/Use these for jira/.test(String(desc.guidance || '')), 'per-server guidance was dropped rather than deferred');

// The dispatcher must survive the outer per-turn cap, or collapsing would lose everything.
assert.equal(isLocalToolSpec(wrapped.specs[0]), true, 'the dispatcher counts as remote and can be culled by the outer cap');

console.log('✓ mcp dispatcher: one resident tool, rulebook deferred, remote flag preserved');
