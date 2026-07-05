// A generic tool registry. The provider loop (js/providers.js) consumes a single
// toolset shaped as { specs, execute, system } — historically that was just the
// page-action tools. buildToolset() merges ANY number of providers (page tools,
// each MCP server, future ones) into that same shape, so the loop is unchanged
// and the tools become generic.
//
// A provider is { specs: ToolSpec[], execute(name, input) => string | {text,image},
//   system?: string }. ToolSpec is { name, description, parameters(JSON schema) }.

import { mcpSharedSystem } from './tool-hints.js';

export function buildToolset(providers) {
  const list = (providers || []).filter((p) => p && p.specs?.length);
  if (!list.length) return undefined;

  const specs = [];
  const route = new Map(); // tool name -> the provider.execute that owns it
  // Tools that call a REMOTE server — from a provider flagged remote, or (fallback)
  // whose name matches the mcp_ convention. The harness uses this exact set to keep
  // PII off remote tools under "redact remote" (L3: no longer name-heuristic-only).
  const remoteTools = new Set();
  const REMOTE_NAME_RE = /^mcp[_-]/i;
  for (const p of list) {
    const providerRemote = p.remote === true;
    for (const s of p.specs) {
      if (route.has(s.name)) continue; // first provider to claim a name wins
      specs.push(s);
      route.set(s.name, p.execute);
      if (providerRemote || REMOTE_NAME_RE.test(String(s.name || ''))) remoteTools.add(s.name);
    }
  }
  if (!specs.length) return undefined;

  // Generic MCP rules + citation policy ONCE (not repeated per server), then each
  // provider's server-specific inventory. Cuts thousands of tokens off the prompt
  // when several MCP servers are armed.
  const hasMcp = specs.some((s) => /^mcp[_-]/i.test(String(s?.name || '')));
  const parts = [hasMcp ? mcpSharedSystem() : '', ...list.map((p) => p.system)];
  const system = parts.map((x) => String(x || '').trim()).filter(Boolean).join('\n\n') || undefined;

  return {
    specs,
    system,
    remoteTools,
    async execute(name, input, meta = {}) {
      const fn = route.get(name);
      if (!fn) return JSON.stringify({ error: `Unknown tool: ${name}` });
      return fn(name, input, meta);
    },
  };
}
