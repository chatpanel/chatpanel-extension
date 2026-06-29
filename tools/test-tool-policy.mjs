import assert from 'node:assert/strict';

import {
  MCP_TURN_MODES,
  cancelledToolResult,
  isMcpToolName,
  normalizeMcpTurnMode,
  shouldExposeMcpForTurn,
  shouldIncludeMcpTools,
} from '../extension/js/tool-policy.js';

assert.equal(normalizeMcpTurnMode(undefined), MCP_TURN_MODES.AUTO);
assert.equal(normalizeMcpTurnMode('bad'), MCP_TURN_MODES.AUTO);
assert.equal(normalizeMcpTurnMode(MCP_TURN_MODES.OFF), MCP_TURN_MODES.OFF);

assert.equal(
  shouldIncludeMcpTools({ turnMcpMode: MCP_TURN_MODES.AUTO }),
  true,
  'Auto EXPOSES MCP tools (so plain chat can use them) — they are narrowed to the top-K '
  + 'relevant downstream (narrowToolset, DEFAULT_AUTO_TOOL_CAP), so this never floods the model.',
);
assert.equal(
  shouldIncludeMcpTools({ turnMcpMode: MCP_TURN_MODES.AUTO, skillRun: { mcp: { mode: 'none' } } }),
  false,
  'Auto should respect skills that disable MCP.',
);
assert.equal(
  shouldIncludeMcpTools({ turnMcpMode: MCP_TURN_MODES.AUTO, skillRun: { mcp: { mode: 'selected' } } }),
  true,
  'Auto should expose MCP when a skill explicitly selects MCP servers.',
);
assert.equal(
  shouldIncludeMcpTools({ turnMcpMode: MCP_TURN_MODES.AUTO, skillRun: { mcp: { mode: 'default' } } }),
  true,
  'Auto should expose MCP when a skill explicitly uses the default MCP set.',
);
assert.equal(
  shouldIncludeMcpTools({ turnMcpMode: MCP_TURN_MODES.OFF, skillRun: { mcp: { mode: 'default' } } }),
  false,
  'Off should override skill MCP configuration.',
);
assert.equal(
  shouldIncludeMcpTools({ turnMcpMode: MCP_TURN_MODES.ON, skillRun: { mcp: { mode: 'none' } } }),
  true,
  'On should be an explicit user override for this turn.',
);

assert.equal(
  shouldExposeMcpForTurn({
    turnMcpMode: MCP_TURN_MODES.ON,
    userText: 'Summarize the attached page for someone who has not read it.',
    attachments: [{ kind: 'page', title: 'Article', text: 'Long article text' }],
    skillRun: { mcp: { mode: 'none' } },
  }),
  false,
  'Attached-content summary turns should not expose MCP just because global MCP is on.',
);
assert.equal(
  shouldExposeMcpForTurn({
    turnMcpMode: MCP_TURN_MODES.ON,
    userText: [
      'Summarize the attached page(s) for someone who has not read them.',
      'Ground every point strictly in the content.',
      'Output GitHub-flavored Markdown.',
    ].join('\n'),
    attachments: [{ kind: 'page', title: 'Article', text: 'Long article text' }],
    skillRun: { mcp: { mode: 'none' } },
  }),
  false,
  'GitHub-flavored Markdown in a summary prompt should not count as GitHub MCP intent.',
);
assert.equal(
  shouldExposeMcpForTurn({
    turnMcpMode: MCP_TURN_MODES.ON,
    userText: 'Summarize this Confluence page.',
    attachments: [{ kind: 'page', title: 'Confluence Page', text: 'Architecture notes' }],
    skillRun: { mcp: { mode: 'none' } },
  }),
  false,
  'A provider/source name in a self-contained attached-content summary should not expose MCP by itself.',
);
assert.equal(
  shouldExposeMcpForTurn({
    turnMcpMode: MCP_TURN_MODES.ON,
    userText: 'Summarize this page and search Confluence for related architecture notes.',
    attachments: [{ kind: 'page', title: 'Article', text: 'Long article text' }],
    skillRun: { mcp: { mode: 'none' } },
  }),
  true,
  'An explicit MCP-backed lookup request should still expose MCP tools.',
);
assert.equal(
  shouldExposeMcpForTurn({
    turnMcpMode: MCP_TURN_MODES.AUTO,
    userText: 'Summarize this page.',
    attachments: [{ kind: 'page', title: 'Article', text: 'Long article text' }],
    skillRun: { mcp: { mode: 'selected' } },
  }),
  true,
  'A skill that explicitly selected MCP keeps its configured MCP tools.',
);

assert.equal(isMcpToolName('mcp_Central_Jira_Confluence__confluence_search'), true);
assert.equal(isMcpToolName('inspect_page'), false);

const skipped = JSON.parse(cancelledToolResult('mcp_demo__search'));
assert.equal(skipped.skipped, true);
assert.match(skipped.reason, /skipped/i);

console.log('tool policy tests passed');
