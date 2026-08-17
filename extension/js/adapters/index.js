// The adapter plugins, registered rather than listed.
//
// Adding an app used to mean editing a 1,200-line shared module. It now means writing a
// plugin and registering it here — and eventually not here either, once plugins can be
// contributed. The registry is what the page provider asks; nothing imports an adapter by
// name.
//
// Loaded on demand: this module and everything it pulls stay off the panel's first paint,
// which is a release gate.

import { createAdapterRegistry } from '../events/adapters.js';

let registry = null;

export async function adapterRegistry() {
  if (registry) return registry;
  registry = createAdapterRegistry();
  const { sheetsAdapter } = await import('./sheets.js');
  registry.add(sheetsAdapter);
  return registry;
}

/** The adapter for a page, or null. */
export async function adapterFor(url, caps = {}) {
  return (await adapterRegistry()).for(url, caps);
}
