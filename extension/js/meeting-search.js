import { bm25Search, buildIndex } from './meeting-index.js';
import { parseTagQuery, filterByTags, tagsSearchText } from './events/tags.js';

function meetingTime(entry = {}) {
  return entry.endedAt || entry.startedAt || 0;
}

export function meetingSearchText(entry = {}, detail = {}) {
  const rec = detail.rec || {};
  const notes = detail.notes || '';
  const transcript = (rec.segments || []).map((s) => `${s.speaker || ''}: ${s.text || ''}`).join('\n');
  const chat = (rec.chat || []).map((c) => `${c.sender || ''} to ${c.receiver || ''}: ${c.text || ''}`).join('\n');
  const participants = (rec.participants || []).map((p) => `${p.name || ''} ${p.role || ''}`).join('\n');
  return [
    entry.title || '',
    rec.title || '',
    entry.meetingKey || '',
    tagsSearchText(entry.tags?.length ? entry.tags : rec.tags),
    notes,
    transcript,
    chat,
    participants,
  ].filter(Boolean).join('\n');
}

export function rankMeetingEntries(entries = [], query = '', detailsById = new Map(), { mode = 'smart' } = {}) {
  const byRecency = (a, b) => meetingTime(b) - meetingTime(a);
  // Tag terms narrow; the rest of the query ranks within what's left. See
  // rankConversationEntries — the two lists behave identically on purpose.
  const { include, exclude, text } = parseTagQuery(query);
  const tagged = (include.length || exclude.length)
    ? filterByTags(entries, { include, exclude }, (e) => (e.tags?.length ? e.tags : detailsById.get(e.id)?.rec?.tags))
    : entries;
  const q = String(text || '').trim();
  if (!q) return [...tagged].sort(byRecency);
  const qLower = q.toLowerCase();

  const docs = tagged.map((entry) => ({
    id: entry.id,
    entry,
    text: meetingSearchText(entry, detailsById.get(entry.id) || {}),
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
