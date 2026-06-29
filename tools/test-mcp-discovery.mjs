import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpProvider } from '../extension/js/mcp-client.js';
import { combineSystemPrompt, sourceCitationSystem, mcpSharedSystem, toolStatus } from '../extension/js/tool-hints.js';

test('mcpProvider exposes an inventory prompt with exact callable tool names', () => {
  const provider = mcpProvider({
    tools: [{
      name: 'search_movies',
      description: 'Search for movies by title or keyword.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    }],
    async callTool() {},
  }, 'Movies');

  // The PER-SERVER block carries only server-specific inventory (name + tools).
  assert.match(provider.system, /MCP server "Movies"/);
  assert.match(provider.system, /mcp_movies__search_movies/);
  assert.match(provider.system, /query\*/);
  // The generic rules / citation policy do NOT repeat per server (de-dup) — they
  // live ONCE in mcpSharedSystem(), emitted by buildToolset.
  assert.doesNotMatch(provider.system, /Prefer relevant MCP tools over web search/, 'generic rules must not repeat per server');
});

test('mcpSharedSystem holds the generic MCP rules + citation policy exactly once', () => {
  const shared = mcpSharedSystem();
  assert.match(shared, /Prefer relevant MCP tools over web search/);
  assert.match(shared, /Do not call MCP tools when the attached page or provided context is enough/);
  assert.match(shared, /Match the user's request domain to the tool's domain/);
  assert.match(shared, /Do not retry the exact same failed tool call/);
  assert.match(shared, /Hacker News requests should use Hacker News tools/);
  assert.match(shared, /<sup>\[1\]<\/sup>/, 'shared block requires superscript citations.');
  assert.match(shared, /Sources/, 'shared block requires a Sources section.');
});

test('mcpProvider returns corrective retry hints for invalid tool parameters', async () => {
  const provider = mcpProvider({
    tools: [{
      name: 'confluence_search',
      description: 'Search Confluence pages.',
      inputSchema: { type: 'object', properties: { cql: { type: 'string' } }, required: ['cql'] },
    }],
    async callTool() {
      throw new Error('MCP error -32602: Invalid request parameters');
    },
  }, 'Central Jira Confluence');

  const result = await provider.execute('mcp_central_jira_confluence__confluence_search', { query: 'top 10 hacker news for today' });
  const json = JSON.parse(result);
  assert.equal(json.error, 'MCP error -32602: Invalid request parameters');
  assert.match(json.retry_hint, /Do not retry/);
  assert.match(json.retry_hint, /Hacker News/);
});

test('toolStatus prefers the upstream MCP error message over generic tool_error', () => {
  const status = toolStatus('{"error":"tool_error","message":"iTunes Search error: 403","retry_hint":"try again"}');
  assert.equal(status, 'error: iTunes Search error: 403');
});

test('toolStatus reads JSON error messages from object text payloads', () => {
  const status = toolStatus({ text: '{"error":"tool_error","message":"iTunes Search error: 429"}' });
  assert.equal(status, 'error: iTunes Search error: 429');
});

test('combineSystemPrompt keeps agent and tool hints in order', () => {
  assert.equal(combineSystemPrompt('agent rules', '', 'tool hints'), 'agent rules\n\ntool hints');
});

test('sourceCitationSystem describes source-backed citation format', () => {
  const policy = sourceCitationSystem();
  assert.match(policy, /<sup>\[1\]<\/sup>/);
  assert.match(policy, /Sources/);
  assert.match(policy, /MCP tools/);
  assert.match(policy, /Do not invent/);
});
