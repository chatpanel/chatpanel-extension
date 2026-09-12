// GENERATED — do not edit.
// Source of truth: chatpanel-events/client-prefs.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// CLIENT PREFERENCES THAT EVERY CLIENT SHARES — which settings travel between the extension
// and the desktop, how they are cut out of the extension's settings tree and put back, and
// how two copies that were both edited are reconciled.
//
// The extension keeps its settings in chrome.storage, which nothing on the machine can read.
// The desktop and the extension DO share one address: the gateway. So the shareable settings
// live there as a document of SECTIONS, each stamped with when it was last written, and both
// clients push the sections they change and take the sections the other wrote more recently.
// Per-section last-writer-wins, not per-key: a section is one thing a person edits on one
// screen (the MCP server list, the search engines), and merging two edits of one list by key
// would invent a list neither of them made.
//
// WHAT DOES NOT TRAVEL, ON PURPOSE. Endpoints and their keys (the gateway's destinations are
// the desktop's copy of that idea, and a key should not be copied by a sync), tokens, the
// active agent (per surface), theme and layout (per window), anything about a browser tab.
//
// Pure: `now` is injected, and nothing here knows a storage API or a network.

/** The sections, and where each lives in the extension's settings tree. */
export const PREF_SECTIONS = Object.freeze([
  { id: 'mcpServers', label: 'MCP tool servers', path: ['mcpServers'], kind: 'array' },
  { id: 'skills', label: 'Skills', path: ['skills'], kind: 'array' },
  { id: 'skillDirs', label: 'Skill folders', path: ['ui', 'skillDirs'], kind: 'array' },
  { id: 'recipes', label: 'Recipes', path: ['recipes'], kind: 'array' },
  { id: 'webSearch', label: 'Web search', path: ['ui', 'webSearch'], kind: 'object' },
  { id: 'tools', label: 'Tools', path: null, kind: 'object', keys: ['mcpToolsMode', 'maxToolsPerTurn', 'historyTools', 'historyContextMode', 'dataDispatch', 'toolResultMaxChars'] },
  { id: 'suggestions', label: 'Smart suggestions', path: ['ui', 'suggestions'], kind: 'object' },
  { id: 'topics', label: 'Topic extraction', path: ['ui', 'topicExtraction'], kind: 'object' },
  { id: 'voice', label: 'Voice', path: ['ui', 'voice'], kind: 'object' },
  { id: 'watch', label: 'Watch', path: ['ui', 'watch'], kind: 'object' },
  { id: 'meetings', label: 'Meetings', path: null, kind: 'object', keys: ['meetingWindowMin', 'liveNotesIntervalMin', 'alertSound'] },
  { id: 'redaction', label: 'Redaction (client-side)', path: ['ui', 'piiRedaction'], kind: 'object' },
]);

export const PREF_SECTION_IDS = Object.freeze(PREF_SECTIONS.map((s) => s.id));

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function getPath(obj, path) {
  let cur = obj;
  for (const k of path) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

/** One section's value, read out of the extension's settings tree. `undefined` when absent. */
export function sectionValue(settings, id) {
  const spec = PREF_SECTIONS.find((s) => s.id === id);
  if (!spec || !settings) return undefined;
  if (spec.path) return clone(getPath(settings, spec.path));
  const ui = settings.ui || {};
  const out = {};
  let any = false;
  for (const k of spec.keys) if (ui[k] !== undefined) { out[k] = clone(ui[k]); any = true; }
  return any ? out : undefined;
}

/** Every section present in the settings tree: `{ id: value }`. */
export function pickSections(settings) {
  const out = {};
  for (const s of PREF_SECTIONS) {
    const v = sectionValue(settings, s.id);
    if (v !== undefined) out[s.id] = v;
  }
  return out;
}

/** The settings tree with these section values put back. Returns a new object. */
export function applySections(settings, sections) {
  const next = clone(settings || {}) || {};
  for (const [id, value] of Object.entries(sections || {})) {
    const spec = PREF_SECTIONS.find((s) => s.id === id);
    if (!spec || value === undefined) continue;
    if (spec.path) { setPath(next, spec.path, clone(value)); continue; }
    if (!next.ui || typeof next.ui !== 'object') next.ui = {};
    for (const k of spec.keys) if (value && value[k] !== undefined) next.ui[k] = clone(value[k]);
  }
  return next;
}

/** A stable fingerprint of a value — key order does not count as a change. */
export function sectionHash(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  try { return JSON.stringify(sort(value)); } catch { return String(value); }
}

/**
 * Reconcile two stamped copies: `{ id: { value, updatedAt } }` each.
 *
 * The newer stamp wins per section; equal stamps keep `local` (nothing to do). Returns the
 * merged document plus which sections each side contributed, so a client knows what to
 * write locally (`fromRemote`) and what to push (`fromLocal`).
 */
export function mergeStamped(local = {}, remote = {}) {
  const merged = {};
  const fromRemote = [];
  const fromLocal = [];
  const ids = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const id of ids) {
    const l = local?.[id]; const r = remote?.[id];
    const lt = Number(l?.updatedAt) || 0; const rt = Number(r?.updatedAt) || 0;
    if (r && (!l || rt > lt)) { merged[id] = { value: clone(r.value), updatedAt: rt }; if (l ? sectionHash(l.value) !== sectionHash(r.value) : true) fromRemote.push(id); continue; }
    if (l) { merged[id] = { value: clone(l.value), updatedAt: lt }; if (!r || lt > rt) fromLocal.push(id); }
  }
  return { merged, fromRemote, fromLocal };
}

/**
 * What a client should PUSH: sections whose value differs from what it last pushed. Each is
 * stamped `now`, so the other side sees them as newer than its own copy.
 */
export function changedSections(sections, lastPushed = {}, { now = Date.now() } = {}) {
  const out = {};
  for (const [id, value] of Object.entries(sections || {})) {
    if (!PREF_SECTION_IDS.includes(id)) continue;
    const prev = lastPushed?.[id];
    if (prev && prev.hash === sectionHash(value)) continue;
    out[id] = { value: clone(value), updatedAt: now };
  }
  return out;
}
