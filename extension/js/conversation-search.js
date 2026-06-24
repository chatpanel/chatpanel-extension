import { bm25Search, buildIndex } from './meeting-index.js';

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
    ...(conv.messages || []).map((message) => `${message.role || ''}: ${messageText(message)}`),
  ].join('\n');
}

export function rankConversationEntries(entries = [], query = '', conversationsById = new Map(), { mode = 'smart' } = {}) {
  const q = String(query || '').trim();
  const byRecency = (a, b) => conversationTime(b) - conversationTime(a);
  if (!q) return [...entries].sort(byRecency);

  const qLower = q.toLowerCase();
  const docs = entries.map((entry) => ({
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

export function paginateEntries(entries = [], { page = 1, pageSize = 25 } = {}) {
  const size = Math.max(1, Number(pageSize) || 25);
  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const startIndex = (currentPage - 1) * size;
  const items = entries.slice(startIndex, startIndex + size);
  return {
    items,
    page: currentPage,
    pageSize: size,
    total,
    totalPages,
    start: total ? startIndex + 1 : 0,
    end: startIndex + items.length,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}
