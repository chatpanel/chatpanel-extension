// The response shield, bound to this client — the store it keeps, the fence it respects,
// the tools it leaves alone.
//
// The shield itself (@chatpanel/events tool-result.js) is pure: it turns an oversized
// result into a preview plus a retrieval note, and answers `get_result`. What is here is
// only what the extension knows and the package must not: where the store lives (one per
// page, in memory, evicted oldest-first), that MCP output arrives inside an untrusted-data
// fence which must survive the cut with the retrieval note OUTSIDE it, and which tools
// already size their own output (a page read the user asked for arrives whole; the shield
// is for the results nobody asked to be that large).
//
// Deferred: `streamChat` imports this at the point of use, so it costs first paint
// nothing — the shield only exists once a turn is armed with tools.

import { createResultStore, withResultShield, DEFAULT_SHIELD, RESULT_TOOL_NAME } from './events/tool-result.js';

// One store per extension page (side panel, notes, …). Refs are meaningless across pages
// and across a reload, which matches how long a model can still be asking for them.
let store = null;
export function resultStore() {
  if (!store) store = createResultStore();
  return store;
}

// The fence mcp-client.js wraps third-party output in. The shield cuts the BODY and
// re-wraps it, so a truncated result is still marked as data; the note goes after the
// closing fence, because it is our instruction and the fence says to follow none.
const FENCE_OPEN_RE = /^(\[External MCP tool output[^\n]*\]\n⟦EXTERNAL_MCP_OUTPUT⟧\n)([\s\S]*)(\n⟦\/EXTERNAL_MCP_OUTPUT⟧)$/;
export const mcpFenceEnvelope = {
  open(text) {
    const m = FENCE_OPEN_RE.exec(text);
    if (!m) return null;
    const [, head, body, tail] = m;
    return { body, close: (b) => `${head}${b}${tail}` };
  },
};

// Tools that size their own output: the caller chose how much to read, so a second cut
// here would only lose the end of what they asked for. Page/dispatcher actions are seen
// through the `action` argument, the same way every name-based policy in providers.js is.
const SELF_SIZED = new Set(['read_page', 'read_transcript', 'read_canvas', 'history_get_source', 'history_get_meeting', 'skill_open', 'skill_file']);
export function exemptFromShield(name, input) {
  const action = input && typeof input === 'object' && typeof input.action === 'string' ? input.action : '';
  return name === RESULT_TOOL_NAME || SELF_SIZED.has(action || name);
}

/** The limits a user can move (Settings → Tools), else the shared defaults. */
export function shieldLimits(settings) {
  const n = Number(settings?.ui?.toolResultMaxChars);
  return Number.isFinite(n) && n >= 4000 ? { maxChars: Math.min(n, 400_000) } : { maxChars: DEFAULT_SHIELD.maxChars };
}

/** Wrap a turn's toolset. Idempotent — wrapping the wrapped toolset adds nothing. */
export function shieldToolset(toolset, { settings, owner } = {}) {
  if (!toolset || typeof toolset.execute !== 'function') return toolset;
  if (toolset.shieldStore) return toolset;
  return withResultShield(toolset, {
    store: resultStore(),
    owner,
    envelope: mcpFenceEnvelope,
    exempt: exemptFromShield,
    limits: shieldLimits(settings),
  });
}
