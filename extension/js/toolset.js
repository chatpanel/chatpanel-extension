// The generic tool registry — SHARED. `@chatpanel/events/toolset.js` is the implementation;
// this file exists so the extension's imports stay put and so the one thing that is the
// extension's own — the shared MCP guidance it prepends when any `mcp_*` tool is armed —
// is handed in from here rather than known by the package.
//
// The desktop merges its providers through the identical function, which is the point:
// "first provider to claim a name wins", the remote-tool set the harness reads, and the
// hidden-tool index a recipe routes by are one rule each, not one per client.

import { buildToolset as buildSharedToolset } from './events/toolset.js';
import { mcpSharedSystem } from './events/tool-hints.js';

export function buildToolset(providers) {
  return buildSharedToolset(providers, { mcpSystem: mcpSharedSystem });
}
