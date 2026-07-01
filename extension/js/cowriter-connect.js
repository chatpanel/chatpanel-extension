// Pure topic→document linker for the Connector co-writer. Given a block of text and the
// user's existing document titles, it finds unlinked WHOLE-WORD mentions of those titles
// and returns them as [[wikilink]] candidates. No DOM, no model, no imports — portable
// (extension / gateway / bridge) and fully unit-testable. Token-free by design.
//
// titles: array of strings, or of { title, url } objects.

// The [[wikilink]] targets already present in a block (lowercased set).
export function existingLinks(text = '') {
  return new Set((String(text).match(/\[\[([^\]]+)\]\]/g) || []).map((m) => m.slice(2, -2).toLowerCase()));
}

export function connectorMatches(text = '', titles = [], {
  selfTitle = '', linked = new Set(), dismissed = new Set(), max = 4, minLen = 4,
} = {}) {
  const src = String(text);
  const lower = src.toLowerCase();
  const already = linked instanceof Set ? linked : new Set(linked);
  const skip = dismissed instanceof Set ? dismissed : new Set(dismissed);
  const self = String(selfTitle).toLowerCase();
  const hits = [];
  const seen = new Set();
  for (const raw of titles || []) {
    const title = String(raw?.title ?? raw ?? '').trim();
    const key = title.toLowerCase();
    if (title.length < minLen || key === self || already.has(key) || seen.has(key) || skip.has(`link:${key}`)) continue;
    const idx = lower.indexOf(key);
    if (idx < 0) continue;
    // Whole-token only — don't link a title that's a substring of a larger word.
    const before = lower[idx - 1];
    const after = lower[idx + key.length];
    if ((before && /\w/.test(before)) || (after && /\w/.test(after))) continue;
    seen.add(key);
    hits.push({ title, mention: src.slice(idx, idx + title.length), url: raw?.url });
    if (hits.length >= max) break;
  }
  return hits;
}
