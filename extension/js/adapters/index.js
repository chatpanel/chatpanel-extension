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
import { declarePlugins, enabledOnly } from '../plugins.js';

let registry = null;

export async function adapterRegistry() {
  if (registry) return registry;
  registry = createAdapterRegistry();
  const { sheetsAdapter } = await import('./sheets.js');
  registry.add(sheetsAdapter);
  // The three canvas adapters, registered rather than listed. Their behaviour is unchanged
  // and still lives in canvas-adapters.js; only discovery moved. Matching is lazy, so
  // asking "does anything handle this page" never loads a 1,200-line module.
  const { CANVAS_PLUGINS } = await import('./canvas.js');
  for (const a of CANVAS_PLUGINS) registry.add(a);
  // Declared so the Plugins page can list them; the toggle is honoured in adapterFor.
  await declarePlugins(registry.list().map((a) => ({
    id: a.id, kind: 'adapter', label: a.label, description: 'Drives this app through its own data format instead of pointer automation.',
  })));
  return registry;
}

/** The adapter for a page, or null. */
export async function adapterFor(url, caps = {}) {
  const reg = await adapterRegistry();
  const hit = reg.for(url, caps);
  if (!hit) return null;
  // Admission control: the registry decides what MATCHES, the manifest decides what may
  // RUN. Keeping those separate is what lets a user disable one adapter without the
  // registry needing to know a user exists.
  return (await enabledOnly([hit]))[0] || null;
}

/**
 * What a selected adapter offers.
 *
 * The legacy canvas adapters keep their specs and guidance in the heavy module, which the
 * synchronous `toolSpecs()` on the contract cannot await. Rather than make every plugin
 * async to accommodate one legacy shape, the host asks here — and only for the adapter it
 * has already chosen, so nothing heavy loads for a page with no adapter at all.
 */
export async function adapterDetails(adapter) {
  if (!adapter) return { specs: [], guidance: '' };
  const own = { specs: adapter.toolSpecs() || [], guidance: adapter.guidance() || '' };
  if (own.specs.length) return own;
  try {
    const { legacyDetails } = await import('./canvas.js');
    return (await legacyDetails(adapter.id)) || own;
  } catch {
    return own;
  }
}
