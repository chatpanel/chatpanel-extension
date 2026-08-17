// GENERATED — do not edit.
// Source of truth: chatpanel-events/sources-retrieval.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

/**
 * SOURCES ARE QUERIED, NOT POURED IN.
 *
 * Attached context used to be flattened into the first message: every attached tab, in full,
 * before the model had said anything. So "hi" on a long page paid for the whole page, and
 * five attached tabs meant five documents in the prompt to answer a question that concerned
 * one paragraph of one of them.
 *
 * The model is instead shown a MANIFEST — what exists, how big it is, where it came from —
 * and pulls what it needs. Three things follow that are not just savings:
 *
 *   - The turn starts small, so a cheap model can handle a greeting on a heavy page.
 *   - What was read is a fact in the log rather than an assumption about the prompt.
 *   - Retrieval takes a QUERY, so a large source returns the relevant part instead of its
 *     first N characters — which is what truncation gives you, and it is rarely the part
 *     that matters.
 *
 * Pure and dependency-free: the extension, the gateway and the bridge all have attached
 * sources, and three implementations of "what did the model actually read" would drift.
 */

const CHUNK_SPLIT = /\n{2,}/;

/** ~4 chars per token — the same estimate the dispatcher budget uses. One rough number beats two. */
export const approxTokens = (s) => Math.ceil(String(s || '').length / 4);

/**
 * A stable, short id for a source. The model has to type this back, so it is derived from the
 * title rather than from a random string: `page-2` is recoverable from a manifest a model
 * half-remembers in a way that `k3f9a1` is not.
 */
export function sourceId(source, index = 0) {
  const base = String(source?.kind || 'src').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'src';
  return `${base}-${index + 1}`;
}

/**
 * Build the manifest the model sees INSTEAD of the content.
 *
 * Deliberately includes the size. A model that can see one source is 300 tokens and another
 * is 40,000 can decide to read the small one whole and query the large one — a decision it
 * cannot make when both are simply "a document".
 */
export function makeSourceStore(sources = []) {
  const entries = (Array.isArray(sources) ? sources : [sources])
    .filter((s) => s && (s.text || s.url))
    .map((s, i) => ({
      id: s.id || sourceId(s, i),
      kind: s.kind || 'context',
      title: s.title || s.url || 'Untitled',
      url: s.url || '',
      text: String(s.text || ''),
      tokens: approxTokens(s.text),
    }));
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    entries,
    get: (id) => byId.get(String(id || '').trim()) || null,
    get tokens() { return entries.reduce((a, e) => a + e.tokens, 0); },
  };
}

/** One line per source: what it is, where it came from, what it would cost to read. */
export function manifestText(store) {
  if (!store?.entries?.length) return '';
  const lines = store.entries.map((e) => `- ${e.id} — ${e.title}${e.url ? ` (${e.url})` : ''} · ~${e.tokens} tokens`);
  return [
    'Attached sources (NOT included below — read them with the `source` tool):',
    ...lines,
  ].join('\n');
}

/**
 * Score a chunk against the query by term overlap.
 *
 * Deliberately not a model call and not an embedding: retrieval that needs a model to decide
 * what to retrieve costs a round trip before the real one, and this runs on every source read.
 * Term overlap is crude and instant, and for "which paragraph of this page mentions X" crude
 * is usually right.
 */
function scoreChunk(chunk, terms) {
  if (!terms.length) return 0;
  const hay = chunk.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!hay.includes(t)) continue;
    // Rarer terms are worth more, approximated by length: 'authentication' discriminates,
    // 'the' does not.
    score += Math.min(3, t.length / 4);
  }
  return score;
}

const STOP = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'what', 'when', 'where', 'which', 'have', 'has', 'was', 'are', 'you', 'your', 'can', 'about', 'into', 'does', 'did', 'how', 'why', 'all', 'any', 'its']);

export function queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Read a source, optionally narrowed by a query.
 *
 * Returns `{ id, title, url, text, truncated, of }`. `truncated` is stated rather than
 * implied: a model handed a silently-cut document answers confidently about the part it was
 * not given, and there is no way for it — or the person reading the answer — to tell.
 */
export function readSource(store, { id, query = '', maxTokens = 2000 } = {}) {
  const entry = store?.get?.(id);
  if (!entry) {
    const known = (store?.entries || []).map((e) => e.id).join(', ');
    return { error: `No attached source '${id}'.${known ? ` Available: ${known}.` : ' Nothing is attached.'}` };
  }
  const budget = Math.max(200, Number(maxTokens) || 2000);
  if (entry.tokens <= budget) {
    return { id: entry.id, title: entry.title, url: entry.url, text: entry.text, truncated: false, of: entry.tokens };
  }
  const terms = queryTerms(query);
  const chunks = entry.text.split(CHUNK_SPLIT).filter((c) => c.trim());
  if (!terms.length) {
    // No query: the head is the honest default — it is the only part we can justify choosing
    // without being told what matters.
    const text = entry.text.slice(0, budget * 4);
    return { id: entry.id, title: entry.title, url: entry.url, text, truncated: true, of: entry.tokens,
      note: `Showing the first ~${approxTokens(text)} of ${entry.tokens} tokens. Pass a query to get the relevant parts instead.` };
  }
  // Keep the ORIGINAL ORDER of whatever is selected. Ranking by score and presenting in score
  // order rearranges a document, and a reordered document reads as a different argument.
  const ranked = chunks
    .map((c, i) => ({ c, i, s: scoreChunk(c, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const picked = [];
  let used = 0;
  for (const x of ranked) {
    const t = approxTokens(x.c);
    if (used + t > budget) continue;
    picked.push(x);
    used += t;
  }
  if (!picked.length) {
    const text = entry.text.slice(0, budget * 4);
    return { id: entry.id, title: entry.title, url: entry.url, text, truncated: true, of: entry.tokens,
      note: `Nothing in this source matched '${query}'. Showing the beginning instead.` };
  }
  picked.sort((a, b) => a.i - b.i);
  const gaps = picked.some((x, n) => n > 0 && x.i !== picked[n - 1].i + 1);
  return {
    id: entry.id,
    title: entry.title,
    url: entry.url,
    text: picked.map((x) => x.c).join(gaps ? '\n\n[…]\n\n' : '\n\n'),
    truncated: true,
    of: entry.tokens,
    note: `${picked.length} of ${chunks.length} sections, matched on '${query}'.`,
  };
}
