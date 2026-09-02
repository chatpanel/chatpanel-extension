import { bm25Search, buildIndex } from './meeting-index.js';
import { parseTagQuery, filterByTags, tagsSearchText, normalizeTags } from './events/tags.js';

function conversationTime(entry = {}) {
  return entry.updatedAt || entry.createdAt || 0;
}

function messageText(message = {}) {
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('\n');
  }
  return String(content || '');
}

export function conversationSearchText(entry = {}, conv = {}) {
  return [
    entry.title || '',
    conv.title || '',
    entry.agentId || conv.agentId || '',
    // Both "#design" and "design" hit — see tagsSearchText.
    tagsSearchText(entry.tags?.length ? entry.tags : conv.tags),
    ...(conv.messages || []).map((message) => `${message.role || ''}: ${messageText(message)}`),
  ].filter(Boolean).join('\n');
}

export function rankConversationEntries(entries = [], query = '', conversationsById = new Map(), { mode = 'smart' } = {}) {
  const byRecency = (a, b) => conversationTime(b) - conversationTime(a);
  // Tag terms (`tag:design`, `#design`, `-tag:done`) are a FILTER, not a ranking signal:
  // they narrow the set, and whatever free text is left ranks within it. A tag-only
  // query is a browse, so it comes back newest-first rather than scored.
  const { include, exclude, text } = parseTagQuery(query);
  const tagged = (include.length || exclude.length)
    ? filterByTags(entries, { include, exclude }, (e) => (e.tags?.length ? e.tags : conversationsById.get(e.id)?.tags))
    : entries;
  const q = String(text || '').trim();
  if (!q) return [...tagged].sort(byRecency);

  const qLower = q.toLowerCase();
  const docs = tagged.map((entry) => ({
    id: entry.id,
    entry,
    text: conversationSearchText(entry, conversationsById.get(entry.id) || {}),
  }));

  if (mode === 'keyword') {
    return docs
      .filter((doc) => doc.text.toLowerCase().includes(qLower))
      .map((doc) => doc.entry)
      .sort(byRecency);
  }

  const bm25 = new Map(bm25Search(buildIndex(docs), q).map((r) => [r.id, r.score]));
  const parts = qLower.split(/\s+/).filter(Boolean);
  return docs
    .map((doc) => {
      const text = doc.text.toLowerCase();
      const title = String(doc.entry.title || '').toLowerCase();
      let score = bm25.get(doc.id) || 0;
      if (text.includes(qLower)) score += 25;
      for (const part of parts) {
        if (part.length < 2) continue;
        if (title.includes(part)) score += 6;
        else if (text.includes(part)) score += 2;
      }
      return { entry: doc.entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || byRecency(a.entry, b.entry))
    .map((r) => r.entry);
}

// The tags present on a set of chats — for the filter bar. The index carries them, so
// this needs no conversation bodies.
export function conversationTags(entries = []) {
  return normalizeTags(entries.flatMap((e) => e.tags || []), { max: Infinity });
}

// Moved to paginate.js — a leaf with no index behind it — and re-exported here so every
// existing importer keeps working. One implementation, two callers.
export { paginateEntries } from './paginate.js';
