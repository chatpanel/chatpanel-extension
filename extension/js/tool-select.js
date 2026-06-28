// Tool selection for a turn — narrow a toolset so one turn doesn't flood the model
// with dozens of MCP tools (which bloats the prompt and slows / confuses it).
//
// The ranking itself (lexical, IDF-weighted, no model call) lives in the shared
// chatpanel-pii package so the extension and the gateway narrow identically. This
// file just adapts it to the extension's { specs, execute, system } toolset shape.

import { rankToolSpecs as rankSpecs, narrowSpecs } from './tool-rank.js';

// Rank tool specs most-relevant first (re-exported for callers/tests).
export const rankToolSpecs = rankSpecs;

// Keep LOCAL tools (page / history — not remote MCP) always; only mcp_* get narrowed.
export const isLocalToolSpec = (s) => !String((s && s.name) || '').startsWith('mcp_');

// Narrow toolset.specs so at most `cap` REMOTE (MCP) tools are advertised — local
// page/history tools are always kept and don't count against the cap. Returns the
// toolset unchanged when there's no cap or the MCP set already fits. The
// execute/route map is preserved — only the specs ADVERTISED to the model are
// trimmed, so this can't break a tool the model legitimately knows about.
export function narrowToolset(toolset, query, { cap = 0, keep = isLocalToolSpec } = {}) {
  const specs = toolset && toolset.specs;
  if (!specs || !cap || cap < 1) return toolset;
  const chosen = narrowSpecs(specs, query, { cap, keep });
  return chosen === specs ? toolset : { ...toolset, specs: chosen };
}
