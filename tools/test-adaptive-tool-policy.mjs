import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adaptiveToolRetryHint,
  createAdaptiveToolPolicy,
  isInvalidToolParametersResult,
} from '../extension/js/adaptive-tool-policy.js';

test('detects MCP invalid-parameter results from JSON and text errors', () => {
  assert.equal(isInvalidToolParametersResult('{"error":"MCP error -32602: Invalid request parameters"}'), true);
  assert.equal(isInvalidToolParametersResult('error: MCP error -32602: Invalid request parameters'), true);
  assert.equal(isInvalidToolParametersResult({ text: '{"error":"tool_error","message":"MCP error -32602: Invalid request parameters"}' }), true);
  assert.equal(isInvalidToolParametersResult('{"error":"MCP error -32000: timeout"}'), false);
});

test('adaptive policy hides tools with invalid parameters for the rest of the turn', () => {
  const policy = createAdaptiveToolPolicy();
  const specs = [
    { function: { name: 'mcp_central_jira_confluence__confluence_search' } },
    { function: { name: 'mcp_hacker_news__hn_top_stories' } },
  ];

  assert.deepEqual(policy.filterOpenAITools(specs).map((s) => s.function.name), [
    'mcp_central_jira_confluence__confluence_search',
    'mcp_hacker_news__hn_top_stories',
  ]);

  policy.recordResult('mcp_central_jira_confluence__confluence_search', '{"error":"MCP error -32602: Invalid request parameters"}');

  assert.deepEqual(policy.filterOpenAITools(specs).map((s) => s.function.name), [
    'mcp_hacker_news__hn_top_stories',
  ]);
  assert.equal(policy.isSuppressed('mcp_central_jira_confluence__confluence_search'), true);
});

test('adaptive retry hint gives domain-specific recovery guidance', () => {
  const hint = adaptiveToolRetryHint('mcp_central_jira_confluence__confluence_search');
  assert.match(hint, /Do not retry/);
  assert.match(hint, /Hacker News/i);
  assert.match(hint, /Confluence/i);
});
