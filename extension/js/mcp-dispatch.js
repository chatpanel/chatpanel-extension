// PROGRESSIVE DISCLOSURE for MCP servers — one registered tool instead of dozens.
//
// MCP is the largest resident cost by far: every connected server contributes a full JSON
// schema per tool plus an inventory block, and the shared MCP rulebook (~600 tokens of
// citation policy, argument-forming rules and fallback etiquette) is added once on top.
// On a setup with a few servers that is thousands of tokens on every turn — including
// turns that never touch a server.
//
// The existing defence was a relevance cap that DROPS tools beyond it. That is a real
// loss of capability, silently: a tool the model needed but that ranked low simply was
// not there. A dispatcher keeps every tool reachable and pays only for the menu, so the
// cap stops being a capability decision and becomes a menu-length decision.
//
// PRIVACY: these tools call third parties, so the provider stays flagged `remote`. The
// harness uses that flag to keep PII off remote tools under "redact remote" — a
// dispatcher that dropped it would quietly convert redacted tools into unredacted ones.
// That is the one property here worth a test of its own.

import { makeDispatchProvider } from './group-dispatch.js';

// Deliberately NOT `mcp_*`. buildToolset adds the ~600-token shared MCP rulebook whenever
// a spec name matches /^mcp[_-]/, so a dispatcher called `mcp_call` would collapse the
// per-server schemas and then re-admit the rulebook it was meant to defer. The rulebook
// travels with `describe` instead, and remoteness is carried by the provider's `remote`
// flag rather than inferred from the name — which is where it should have come from
// anyway.
export const MCP_TOOL_NAME = 'mcp';

const DESCRIPTION =
  'Call a tool on a connected MCP server (the user\'s own integrations). Pass an `action` '
  + 'and put that action\'s own arguments inside `args`, e.g. '
  + '{"action":"mcp_jira__search","args":{"query":"ATLAS-1"}}. Unsure of an action\'s '
  + 'arguments? {"action":"describe","args":{"tool":"<action>"}} returns its full schema '
  + 'and how to use that server. Match the request\'s domain to the server\'s domain, and '
  + 'do not call these when the page or provided context already answers the question.';

export function mcpDispatchProvider(inner) {
  return makeDispatchProvider({
    name: MCP_TOOL_NAME,
    description: DESCRIPTION,
    // Same lesson as the data and page groups: name the capability, not just the tool.
    resident:
      "You HAVE access to the user's connected MCP servers — their own integrations — "
      + 'through the `mcp` tool. When a request matches a connected server\'s domain, call '
      + 'it rather than saying the integration is unavailable.',
    inner,
    // Load-bearing for redaction, not bookkeeping. See the note above.
    remote: true,
  });
}
