// GENERATED — do not edit.
// Source of truth: chatpanel-events/tags.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The tag vocabulary — one filing system across notes, chats and meetings.
//
// A tag typed in the notes editor and a tag typed on the meetings page have to BE the
// same tag, and `tag:design` has to select it from any list. That is a pure input →
// output question about normalization and matching, so it lives here: the extension,
// the gateway's warm index and any future mobile client all have to agree on what "the
// same tag" is, and three normalizers would mean three answers to that.
//
// Design notes:
//   • Normalization is lossy on purpose — case, punctuation and spacing are filing
//     noise. "Design Review", "design-review" and "#DesignReview!" are one tag.
//   • Unicode-aware. Stripping everything outside [a-z0-9-] silently erases a tag
//     written in Japanese, Greek or Hindi — it becomes '' and vanishes. Letters and
//     numbers in ANY script are kept; only separators and punctuation fold to '-'.
//   • Order is the user's, not ours: tags keep insertion order rather than sorting,
//     because the first tag someone adds is usually the one they think in.

export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS = 24;

/**
 * Fold one user-typed value into its canonical tag, or '' when nothing survives.
 * Idempotent: normalizeTag(normalizeTag(x)) === normalizeTag(x).
 */
export function normalizeTag(value) {
  const raw = String(value ?? '').trim().replace(/^#+/, '');
  if (!raw) return '';
  return raw
    .toLowerCase()
    // Any run of things that aren't letters/numbers becomes a single separator.
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
    // The slice can land mid-separator; don't leave a trailing dash behind.
    .replace(/-+$/, '');
}

/** Normalize a list: drop blanks, dedupe (first wins), cap the count. */
export function normalizeTags(list, { max = MAX_TAGS } = {}) {
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const tag = normalizeTag(value);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

export function hasTag(tags, value) {
  const tag = normalizeTag(value);
  return !!tag && normalizeTags(tags).includes(tag);
}

/** Append a tag (no-op when blank, already present, or at the cap). */
export function addTag(tags, value, { max = MAX_TAGS } = {}) {
  const current = normalizeTags(tags, { max });
  const tag = normalizeTag(value);
  if (!tag || current.includes(tag) || current.length >= max) return current;
  return [...current, tag];
}

export function removeTag(tags, value) {
  const tag = normalizeTag(value);
  return normalizeTags(tags).filter((t) => t !== tag);
}

export function toggleTag(tags, value, { max = MAX_TAGS } = {}) {
  return hasTag(tags, value) ? removeTag(tags, value) : addTag(tags, value, { max });
}

/** Set equality, order-insensitive — so a save can skip a write that changes nothing. */
export function sameTags(a, b) {
  const x = normalizeTags(a);
  const y = normalizeTags(b);
  return x.length === y.length && x.every((t) => y.includes(t));
}

/** `#design` — the one display form, so chips read the same on every surface. */
export function formatTag(tag) {
  const t = normalizeTag(tag);
  return t ? `#${t}` : '';
}

// --------------------------------------------------------------------------
// Query language
// --------------------------------------------------------------------------

// One search box, two jobs: free text and tag selection. Rather than a second input
// per page, a query may carry tag terms inline —
//   tag:design            include
//   #design               include (the shorthand people already type)
//   -tag:done / -#done    exclude
//   tag:"deep work"       quoted, folded to deep-work
// …and everything left over is the free-text part the ranker sees. A `#` that is part
// of a word ("C#", "issue #12") is left alone: only a leading, standalone one counts.
const TERM_RE = /(^|\s)(-)?(?:tag:|#)("([^"]*)"|[^\s"]+)/giu;

/**
 * Split a raw query into { include, exclude, text }.
 * `text` is the query with the tag terms removed (whitespace collapsed).
 */
export function parseTagQuery(query) {
  const raw = String(query ?? '');
  const include = [];
  const exclude = [];
  let text = raw.replace(TERM_RE, (match, lead, minus, bare, quoted) => {
    const tag = normalizeTag(quoted !== undefined ? quoted : bare);
    if (!tag) return match; // nothing usable — leave it in the free text
    const bucket = minus ? exclude : include;
    if (!bucket.includes(tag)) bucket.push(tag);
    return lead || '';
  });
  text = text.replace(/\s+/g, ' ').trim();
  return { include, exclude, text };
}

/** True when `query` carries at least one tag term. */
export function hasTagTerms(query) {
  const { include, exclude } = parseTagQuery(query);
  return include.length > 0 || exclude.length > 0;
}

/** Render a filter back into query syntax — the inverse of parseTagQuery. */
export function formatTagQuery({ include = [], exclude = [], text = '' } = {}) {
  return [
    ...normalizeTags(include).map((t) => `tag:${t}`),
    ...normalizeTags(exclude).map((t) => `-tag:${t}`),
    String(text || '').trim(),
  ].filter(Boolean).join(' ');
}

/**
 * Does one record's tags satisfy a filter?
 * Include terms are ANDed (narrowing is what filters are for); `mode:'any'` ORs them.
 * Exclusions always win.
 */
export function matchesTagFilter(tags, { include = [], exclude = [] } = {}, { mode = 'all' } = {}) {
  const own = normalizeTags(tags);
  const wanted = normalizeTags(include);
  const banned = normalizeTags(exclude);
  if (banned.some((t) => own.includes(t))) return false;
  if (!wanted.length) return true;
  return mode === 'any' ? wanted.some((t) => own.includes(t)) : wanted.every((t) => own.includes(t));
}

const defaultGetTags = (entry) => entry?.tags;

/** Filter a list of records by a parsed filter. Order is preserved. */
export function filterByTags(entries, filter, getTags = defaultGetTags, opts) {
  const f = filter || {};
  if (!(f.include?.length || f.exclude?.length)) return [...(entries || [])];
  return (entries || []).filter((e) => matchesTagFilter(getTags(e), f, opts));
}

/**
 * Tag facets for a filter bar: every tag in the corpus with its count, most-used
 * first then alphabetical (so the bar is stable as counts tie). `selected` tags are
 * always included even at count 0, so a filter that empties the list can be undone.
 */
export function tagFacets(entries, getTags = defaultGetTags, { limit = 0, selected = [] } = {}) {
  const counts = new Map();
  for (const entry of entries || []) {
    for (const tag of normalizeTags(getTags(entry))) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  for (const tag of normalizeTags(selected)) if (!counts.has(tag)) counts.set(tag, 0);
  const facets = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const keep = new Set(normalizeTags(selected));
  if (!limit || facets.length <= limit) return facets;
  // Truncation must never hide an active selection — keep those, then fill by rank.
  const picked = facets.filter((f) => keep.has(f.tag));
  for (const f of facets) {
    if (picked.length >= limit) break;
    if (!keep.has(f.tag)) picked.push(f);
  }
  return picked.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Suggest tags a record doesn't have yet, drawn from what's already in use —
 * `existing` facets ranked by count, minus what's on the record. Reusing a tag the
 * user coined beats inventing a synonym for it.
 */
export function suggestExistingTags(facets, tags, { limit = 6 } = {}) {
  const own = new Set(normalizeTags(tags));
  return (facets || [])
    .map((f) => (typeof f === 'string' ? { tag: normalizeTag(f), count: 0 } : f))
    .filter((f) => f.tag && !own.has(f.tag))
    .slice(0, limit)
    .map((f) => f.tag);
}

/**
 * The line a full-text index should carry for tags. Both forms are emitted — `#design`
 * so an exact-text search for what the chip shows hits, and `design` so a plain word
 * query does too.
 */
export function tagsSearchText(tags) {
  const list = normalizeTags(tags);
  if (!list.length) return '';
  return [...list.map((t) => `#${t}`), ...list].join(' ');
}
