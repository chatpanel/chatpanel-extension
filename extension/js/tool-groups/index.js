// The tool groups a turn can offer, registered rather than written out.
//
// buildTurnTools assembled three hardcoded blocks — the user's own data, their MCP servers,
// the page — each the same shape: decide whether it applies, build a provider, collapse it
// behind a dispatcher. A fourth meant editing that shared function, and no other client
// could contribute one at all.
//
// Priorities state what the model sees first, deliberately rather than by line order:
// the page is the thing the user is looking at, their own data comes next, and third-party
// servers last.

import { createToolGroupRegistry } from '../events/tool-groups.js';
import { declarePlugins, pluginManifest } from '../plugins.js';

let registry = null;

export async function toolGroupRegistry() {
  if (registry) return registry;
  registry = createToolGroupRegistry();
  const [{ dataGroup }, { mcpGroup }] = await Promise.all([
    import('./data.js'),
    import('./mcp.js'),
  ]);
  registry.add(dataGroup);
  registry.add(mcpGroup);
  await declarePlugins([dataGroup, mcpGroup].map((g) => ({
    id: g.id, kind: 'tool-group', label: g.label, description: 'A set of tools offered to the model each turn.',
  })));
  return registry;
}

/** Every provider that applies to this turn, in the order the model should see them. */
export async function buildToolGroups(ctx, opts) {
  const [reg, manifest] = await Promise.all([toolGroupRegistry(), pluginManifest()]);
  // Admission is passed IN so the registry checks it before building. Filtering the result
  // instead would still pay the cost — for MCP that cost is connecting to servers.
  return reg.build(ctx, { ...opts, admit: (g) => manifest.isEnabled(g.id) });
}
