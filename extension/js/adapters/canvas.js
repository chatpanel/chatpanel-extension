// The existing canvas adapters, as plugins.
//
// Excalidraw, draw.io and tldraw were three entries in a hardcoded array inside a
// 1,200-line module. Their BEHAVIOUR is fine and stays exactly where it is — what changes
// is how they are found: declared and registered like any other plugin, so the page
// provider asks a registry instead of importing a list.
//
// LAZY ON PURPOSE. Matching uses page-match.js (a 3 KB rule table) and the capability probe
// the host already ran, so recognising a page never pulls the heavy module. Only when an
// adapter is actually SELECTED does its implementation load — which is the same reason
// canvas-adapters.js was dynamic-imported before, and would be undone by a registry that
// eagerly imported every plugin to ask what it matches.

import { defineAdapter } from '../events/adapters.js';
import { SITE_RULES, hostMatchesRule } from '../page-match.js';

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/** Load the real adapter object once, by id. */
async function impl(adapterId) {
  const { CANVAS_ADAPTERS } = await import('../canvas-adapters.js');
  return CANVAS_ADAPTERS.find((a) => a.id === adapterId) || null;
}

/**
 * Wrap one legacy adapter. Its match is EITHER the shared rule table (a known host) or the
 * capability probe (a self-hosted or embedded instance) — the same two routes
 * detectCanvasAdapter used, kept because the second is what makes this work on pages nobody
 * enumerated.
 */
function fromLegacy({ id, capability }) {
  const rule = SITE_RULES.find((r) => r.adapterId === id);
  return defineAdapter({
    id,
    label: rule?.label || id,
    priority: 5,          // below a purpose-built adapter, above nothing
    matches: (url, caps = {}) => (
      (!!capability && caps[capability] === true)
      || (!!rule && hostMatchesRule(rule, hostOf(url)))
    ),
    // Specs and guidance need the heavy module, so they are only reached once this adapter
    // has been chosen.
    toolSpecs: () => [],  // filled by resolve() below — the sync contract cannot await
    guidance: () => '',
    async execute(name, input, ctx) {
      const a = await impl(id);
      if (!a || !a.handles?.(name)) return null;
      return a.insert(ctx.tabId, input, { cdp: !!ctx.cdp });
    },
  });
}

export const CANVAS_PLUGINS = [
  fromLegacy({ id: 'excalidraw', capability: 'excalidraw' }),
  fromLegacy({ id: 'drawio', capability: 'drawio' }),
  fromLegacy({ id: 'tldraw', capability: 'tldraw' }),
];

/**
 * The specs and guidance for a selected legacy adapter.
 *
 * Separate from the contract because `toolSpecs()` is synchronous by design — a registry
 * that had to await every plugin just to list what it offers would be a slower registry for
 * one legacy case. The host calls this only for the adapter it already chose.
 */
export async function legacyDetails(adapterId) {
  const a = await impl(adapterId);
  if (!a) return null;
  return { specs: a.toolSpecs?.() || [], guidance: a.systemGuidance?.() || '' };
}
