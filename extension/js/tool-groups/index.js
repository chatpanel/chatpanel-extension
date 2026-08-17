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
  return registry;
}

/** Every provider that applies to this turn, in the order the model should see them. */
export async function buildToolGroups(ctx, opts) {
  return (await toolGroupRegistry()).build(ctx, opts);
}
