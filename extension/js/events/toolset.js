// GENERATED — do not edit.
// Source of truth: chatpanel-events/toolset.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A generic tool registry — ANY number of tool providers merged into the one shape a model
// loop consumes: `{ specs, execute, system }`.
//
// A provider is `{ specs: ToolSpec[], execute(name, input, meta) => string | {text, note,
// image}, system?: string, remote?: boolean, serial?: boolean, traits?: Map, reach?: [] }`.
// ToolSpec is `{ name, description, parameters (JSON schema), annotations? }`.
//
// This lived in the extension for as long as the extension was the only client with a tool
// loop. The desktop grew one, and the second copy of "first provider to claim a name wins"
// would have been the second place that rule could quietly differ. Everything here is
// input → output; the one platform-flavoured thing — the shared MCP guidance a client
// prepends when any `mcp_*` tool is present — is INJECTED, so this file carries no prompt
// text of its own and stays off the extension's first-paint budget by exactly the bytes
// the old copy cost.

const REMOTE_NAME_RE = /^mcp[_-]/i;

/**
 * @param providers  the tool providers, in the order the model should read them
 * @param mcpSystem  the shared MCP rules — a string, or a function returning one, consulted
 *                   only when an `mcp_*` tool is present so a turn without MCP pays nothing
 * @returns the merged toolset, or `undefined` when no provider brought a tool
 */
export function buildToolset(providers, { mcpSystem = '' } = {}) {
  const list = (providers || []).filter((p) => p && p.specs?.length);
  if (!list.length) return undefined;

  const specs = [];
  const route = new Map(); // tool name -> the provider.execute that owns it
  // Tools that call a REMOTE server — from a provider flagged remote, or (fallback) whose
  // name matches the mcp_ convention. The PII harness uses this exact set to keep private
  // data off remote tools under "redact remote".
  const remoteTools = new Set();
  // What each HIDDEN tool does — a dispatcher's own index of the tools behind it
  // (tool-traits.js). Top-level specs carry `annotations` and are classified at run time.
  const traits = new Map();
  // Tools that must run one at a time even when read-only: page tools share ONE tab.
  const serialTools = new Set();
  // The tools a dispatcher hides, and which dispatcher: a recipe step names the real tool.
  const reach = [];
  const hiddenVia = new Map();
  for (const p of list) {
    const providerRemote = p.remote === true;
    if (p.traits instanceof Map) for (const [k, v] of p.traits) if (!traits.has(k)) traits.set(k, v);
    if (Array.isArray(p.reach) && p.specs.length === 1) {
      for (const h of p.reach) if (h?.name && !hiddenVia.has(h.name)) { hiddenVia.set(h.name, p.specs[0].name); reach.push(h); }
    }
    for (const s of p.specs) {
      if (route.has(s.name)) continue; // first provider to claim a name wins
      specs.push(s);
      route.set(s.name, p.execute);
      if (providerRemote || REMOTE_NAME_RE.test(String(s.name || ''))) remoteTools.add(s.name);
      if (p.serial === true) serialTools.add(s.name);
    }
  }
  if (!specs.length) return undefined;

  // Generic MCP rules ONCE (not repeated per server), then each provider's own inventory.
  const hasMcp = specs.some((s) => REMOTE_NAME_RE.test(String(s?.name || '')));
  const shared = hasMcp ? String((typeof mcpSystem === 'function' ? mcpSystem() : mcpSystem) || '') : '';
  const parts = [shared, ...list.map((p) => p.system)];
  const system = parts.map((x) => String(x || '').trim()).filter(Boolean).join('\n\n') || undefined;
  // WHICH blurb costs what — one total for the whole preamble is visible but unattributable,
  // and a number nobody can attribute is a number nobody can reduce.
  const systemParts = {};
  if (shared.trim()) systemParts.mcp = Math.round(shared.length / 4);
  for (const p of list) {
    const t = Math.round(String(p.system || '').trim().length / 4);
    // Named by the dispatcher tool it owns — 'page', 'find', 'mcp' — which is what the
    // reader sees in the tools list and can act on.
    if (t) systemParts[p.id || p.specs[0]?.name || 'group'] = t;
  }

  return {
    specs,
    system,
    systemParts,
    remoteTools,
    traits,
    serialTools,
    reach,
    hiddenVia,
    async execute(name, input, meta = {}) {
      const fn = route.get(name);
      if (!fn) return JSON.stringify({ error: `Unknown tool: ${name}` });
      return fn(name, input, meta);
    },
  };
}
