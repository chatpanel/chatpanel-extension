// GENERATED — do not edit.
// Source of truth: chatpanel-events/note-links.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Linking one note to another: the `[[` picker's grammar.
//
// Split from `note-mentions.js` for a reason that is not taxonomy. The mention grammar is
// asked a question by a KEYSTROKE handler — "is this line a delegation?" — which cannot await
// a module, so it must already be loaded; the extension's Notes page therefore carries it on
// its first-paint graph. Link picking happens inside an autocomplete popup, which is async by
// nature and can load what it needs when the user types the second bracket.
//
// Keeping them in one file put both on that graph and pushed the extension's Notes first
// paint 1.6 KB over its budget. The guard caught it, and this is the shape that answer takes:
// a module is the unit of loading, so "needed synchronously" and "needed on demand" are not
// allowed to share one.

/**
 * The `[[…` link query under the caret, or null — `{ query, start, end }`, where [start, end)
 * is the text typed AFTER the opening brackets, which is what a pick replaces.
 *
 * Deliberately not a `triggerQueryAt` trigger: `[[` is two characters, the query may contain
 * spaces (page titles do), and it ends at a `]]` rather than at whitespace. A closed link is
 * not a query — once `]]` is typed the user is past it — and neither is one carrying a newline
 * or another bracket, which mean the `[[` above belongs to something else entirely.
 */
export function wikiQueryAt(text, pos, { hasSelection = false } = {}) {
  if (hasSelection) return null;
  const v = String(text ?? '');
  const p = Math.max(0, Math.min(Number.isFinite(pos) ? pos : 0, v.length));
  const upto = v.slice(0, p);
  const open = upto.lastIndexOf('[[');
  if (open < 0) return null;
  const between = upto.slice(open + 2);
  if (/[[\]\n]/.test(between)) return null;
  return { query: between, start: open + 2, end: p };
}

/**
 * Rank link targets for what has been typed.
 *
 * Prefix matches first — someone typing "Roll" means a page whose name STARTS that way, and
 * burying it under a note that mentions "rollback" in the middle of its title is the ranking
 * being clever at the user's expense. Then substring, each group alphabetical so the list is
 * stable between keystrokes.
 *
 * DEDUPED BY TITLE, because a `[[link]]` addresses a title and nothing else: two records
 * called "Atlas" are one destination, and offering the name twice asks the user to choose
 * between two things they cannot tell apart. The first of a title wins, which — given the
 * caller passes its index in its own order — is the one it considers canonical.
 */
export function rankLinkTargets(targets, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  const byTitleSeen = new Set();
  const list = (Array.isArray(targets) ? targets : []).filter((t) => {
    if (!t || !t.title) return false;
    const key = String(t.title).trim().toLowerCase();
    if (byTitleSeen.has(key)) return false;
    byTitleSeen.add(key);
    return true;
  });
  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
  if (!q) return [...list].sort(byTitle).slice(0, limit);
  const starts = [];
  const has = [];
  for (const t of list) {
    const title = String(t.title).toLowerCase();
    if (title.startsWith(q)) starts.push(t);
    else if (title.includes(q)) has.push(t);
  }
  return [...starts.sort(byTitle), ...has.sort(byTitle)].slice(0, limit);
}
