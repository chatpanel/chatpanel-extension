import { bm25Search, buildGraph, buildIndex, tokenize, topTerms } from './meeting-index.js';

const DEFAULT_CHUNK_CHARS = 1800;
const DEFAULT_OVERLAP_CHARS = 220;
const QUERY_INTENT_STOP = new Set((
  'chat chats history source sources search result results local previous prior past ' +
  'meeting meetings meet meets call calls transcript transcripts recording recordings ' +
  'conversation conversations discuss discussed discussing find show list had have'
).split(/\s+/));

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeMode(mode) {
  return String(mode || '').toLowerCase() === 'exact' ? 'exact' : 'best';
}

function normalizeField(field) {
  const f = String(field || '').toLowerCase();
  if (f === 'title' || f === 'name') return 'title';
  if (f === 'content' || f === 'body' || f === 'text' || f === 'transcript') return 'content';
  return 'all';
}

function scopedSources(sources, scope, includeMeetings) {
  const wanted = scope === 'meetings' || scope === 'chats' ? scope : 'all';
  return (sources || []).filter((s) => {
    if (!includeMeetings && s.type === 'meeting') return false;
    if (wanted === 'meetings') return s.type === 'meeting';
    if (wanted === 'chats') return s.type === 'chat';
    return s.type === 'chat' || s.type === 'meeting';
  });
}

export function chunkHistorySource(source, { maxChunkChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS } = {}) {
  const text = cleanText(source?.text);
  if (!source?.id || !source?.type || !text) return [];
  const size = clampInt(maxChunkChars, DEFAULT_CHUNK_CHARS, 400, 8000);
  const overlap = clampInt(overlapChars, DEFAULT_OVERLAP_CHARS, 0, Math.floor(size / 2));
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(size * 0.6)) end = boundary;
    }
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        id: `${source.id}#${index}`,
        sourceId: source.id,
        chunk: index,
        type: source.type,
        title: source.title || (source.type === 'meeting' ? 'Meeting' : 'Chat'),
        date: source.date || 0,
        text: chunkText,
        url: source.url || '',
        meta: source.meta || {},
      });
      index += 1;
    }
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function buildHistoryChunks(sources, options = {}) {
  return (sources || []).flatMap((s) => chunkHistorySource(s, options));
}

function sourceForSearchField(source, field) {
  if (normalizeField(field) === 'content' && source && source.contentText != null) {
    return { ...source, text: source.contentText };
  }
  return source;
}

function chunksForSearch(sources, options = {}, field = 'all') {
  return (sources || []).flatMap((s) => chunkHistorySource(sourceForSearchField(s, field), options));
}

function isDirectMeetingText(text) {
  return /\b(?:1\s*[:x]\s*1|1\s*[-\s]*(?:on|to)\s*[-\s]*1|one\s*[-\s]*on\s*[-\s]*one|one\s*[-\s]*to\s*[-\s]*one)\b/i
    .test(String(text || ''));
}

function queryProfile(query) {
  const terms = [...new Set(tokenize(query).filter((t) => !QUERY_INTENT_STOP.has(t)))];
  return { terms, directMeeting: isDirectMeetingText(query) };
}

function termsInText(terms, text) {
  const haystack = String(text || '').toLowerCase();
  let hits = 0;
  for (const term of terms || []) if (haystack.includes(term)) hits += 1;
  return hits;
}

// How hard a query term found in a chunk's TITLE / PARTICIPANTS counts.
const TITLE_TERM_W = 16;
const PEOPLE_TERM_W = 12;

// Rarity weight for a query term, read from the BM25 idf map. Rare terms — the
// distinctive subject of a query (names, specific nouns) — dominate; ubiquitous
// filler ("out", "the", a name that recurs in every meeting) is damped toward
// zero. Floor keeps a real-but-common term meaningful; cap stops any single term
// from dwarfing multi-term title coverage.
function termWeight(term, idf) {
  const v = idf?.get(term);
  if (v == null) return 1.5; // not in the indexed corpus at all → treat as distinctive
  if (v <= 0.15) return 0.15; // present in nearly every doc → filler
  return Math.min(v, 3);
}

// Reward a chunk whose TITLE or PARTICIPANTS cover the query's distinctive terms.
// This is what makes a query like "alex jordan sync notes" surface the
// "Alex / Jordan 1:1" meeting (both names in the title + people) as #1 instead of
// burying it under long transcripts that merely repeat common words. People
// aren't in the BM25 doc text, so this is the only place participant matches are
// scored. Skipped for content-field search (there the caller explicitly wants
// body text, not titles).
function subjectBoost(chunk, qTerms, idf, field) {
  if (!chunk || field === 'content' || !qTerms?.length) return 0;
  const title = String(chunk.title || '').toLowerCase();
  const people = Array.isArray(chunk.meta?.people) ? chunk.meta.people.join(' ').toLowerCase() : '';
  let score = 0;
  for (const t of qTerms) {
    const w = termWeight(t, idf);
    if (title.includes(t)) score += w * TITLE_TERM_W;
    if (people && people.includes(t)) score += w * PEOPLE_TERM_W;
  }
  return score;
}

function meetingIntentBoost(chunk, profile, field) {
  if (!chunk || chunk.type !== 'meeting' || field === 'content') return 0;
  const terms = profile?.terms || [];
  if (!terms.length && !profile?.directMeeting) return 0;
  const title = String(chunk.title || '');
  const people = Array.isArray(chunk.meta?.people) ? chunk.meta.people : [];
  const peopleText = people.join(' ');
  const titleHits = termsInText(terms, title);
  const peopleHits = termsInText(terms, peopleText);
  let score = (titleHits * 45) + (peopleHits * 28);

  if (profile?.directMeeting) {
    if (isDirectMeetingText(title)) score += 80;
    if (titleHits) score += 35;
    if (peopleHits) score += 25;
    if (peopleHits && people.length > 0 && people.length <= 2) score += 70;
  }
  return score;
}

function diversifyResults(results, limit) {
  const sorted = (results || [])
    .filter((r) => r?.sourceId)
    .sort((a, b) => b.score - a.score || (b.date || 0) - (a.date || 0));
  const bestScore = sorted[0]?.score || 0;
  const diverseFloor = bestScore > 0 ? bestScore * 0.5 : 0;
  const firstBySource = [];
  const extraChunks = [];
  const weakSources = [];
  const seen = new Set();
  for (const r of sorted) {
    if (!seen.has(r.sourceId)) {
      seen.add(r.sourceId);
      if (r.score >= diverseFloor) firstBySource.push(r);
      else weakSources.push(r);
    } else {
      extraChunks.push(r);
    }
  }
  return [...firstBySource, ...extraChunks, ...weakSources]
    .slice(0, limit)
    .map((r, rank) => ({ ...r, rank: rank + 1 }));
}

export function searchHistorySources(sources, query, options = {}) {
  const limit = clampInt(options.limit, 8, 1, 30);
  const scoped = scopedSources(sources, options.scope || 'all', options.includeMeetings !== false);
  const mode = normalizeMode(options.mode);
  const field = normalizeField(options.field);
  const q = cleanText(query);
  if (!q) return [];

  if (mode === 'exact') {
    return exactSearch(scoped, q, { ...options, field, limit });
  }

  const chunks = chunksForSearch(scoped, options, field);
  const docs = field === 'title'
    ? firstChunksBySource(scoped, options).map((c) => ({ id: c.id, text: c.title }))
    : chunks.map((c) => ({ id: c.id, text: field === 'content' ? c.text : `${c.title}\n${c.text}` }));
  const byId = new Map(chunks.map((c) => [c.id, c]));
  for (const c of firstChunksBySource(scoped, options)) byId.set(c.id, c);
  const qLower = q.toLowerCase();
  const qTerms = tokenize(qLower);
  const profile = queryProfile(q);
  const idx = buildIndex(docs);
  const ranked = bm25Search(idx, q)
    .map((r) => {
      const chunk = byId.get(r.id);
      let score = r.score;
      const titleLower = String(chunk?.title || '').toLowerCase();
      if (field !== 'content') {
        if (titleLower === qLower) score += 80;
        else if (titleLower.includes(qLower)) score += 50;
      }
      // IDF-weighted title/participant coverage — the dominant signal so a meeting
      // whose title + people match the query's distinctive terms wins over long
      // transcripts that only repeat common words.
      score += subjectBoost(chunk, qTerms, idx.idf, field);
      score += meetingIntentBoost(chunk, profile, field);
      return { ...chunk, score };
    });
  return diversifyResults(ranked, limit);
}

function firstChunksBySource(sources, options = {}) {
  return (sources || [])
    .map((s) => chunkHistorySource(s, options)[0])
    .filter(Boolean);
}

function exactSearch(sources, query, options = {}) {
  const field = normalizeField(options.field);
  const qLower = query.toLowerCase();
  const out = [];

  if (field === 'title') {
    for (const source of sources || []) {
      const title = cleanText(source?.title).toLowerCase();
      if (!title.includes(qLower)) continue;
      const chunk = chunkHistorySource(source, options)[0];
      if (chunk) out.push({ ...chunk, score: title === qLower ? 1000 : 800 });
    }
  } else if (field === 'content') {
    for (const chunk of chunksForSearch(sources, options, 'content')) {
      if (cleanText(chunk.text).toLowerCase().includes(qLower)) out.push({ ...chunk, score: 500 });
    }
  } else {
    for (const source of sources || []) {
      const title = cleanText(source?.title).toLowerCase();
      if (title.includes(qLower)) {
        const chunk = chunkHistorySource(source, options)[0];
        if (chunk) out.push({ ...chunk, score: title === qLower ? 1000 : 800 });
        continue;
      }
      for (const chunk of chunkHistorySource(source, options)) {
        if (cleanText(chunk.text).toLowerCase().includes(qLower)) out.push({ ...chunk, score: 500 });
      }
    }
  }

  return diversifyResults(out, options.limit);
}

function topicText(source) {
  return String(source?.text || '')
    .split(/\r?\n/)
    .map((line) => {
      let s = line.trim();
      if (!s) return '';
      if (/^(agent|date|platform)\s*:/i.test(s)) return '';
      if (/^(chat|meeting|summary|transcript)\s*:/i.test(s)) return s.replace(/^[^:]+:\s*/i, '');
      s = s.replace(/^---\s*[^-]+---$/i, '');
      s = s.replace(/^\[[^\]]+\]\s*[^:]{1,60}:\s*/i, '');
      s = s.replace(/^(user|assistant|system|you|speaker(?:\s*[-_#]?\s*\d+)?|[A-Z][\w .'’-]{0,40})\s*:\s*/i, '');
      s = s.replace(/^attached\s*:\s*/i, '');
      return s;
    })
    .join('\n');
}

function graphTerms(source) {
  if (Array.isArray(source?.meta?.terms) && source.meta.terms.length) return source.meta.terms;
  return topTerms(`${source?.title || ''}\n${topicText(source)}`, 10);
}

function relatedReason(r) {
  const people = r.sharedPeople || [];
  const topics = r.sharedTopics || [];
  const titleTerms = r.sharedTitleTerms || [];
  const parts = [];
  if (people.length) parts.push(`shares ${people.join(', ')}`);
  if (topics.length) parts.push(`shared topics: ${topics.join(', ')}`);
  if (titleTerms.length) parts.push(`similar title: ${titleTerms.join(', ')}`);
  return parts.join(' · ') || `relationship score ${r.weight || 0}`;
}

export function relatedHistorySources(sources, sourceId, options = {}) {
  const limit = clampInt(options.limit, 8, 1, 30);
  const scoped = scopedSources(sources, options.scope || 'all', options.includeMeetings !== false);
  const byId = new Map(scoped.map((s) => [s.id, s]));
  if (!byId.has(sourceId)) return [];
  const graph = buildGraph(scoped.map((s) => ({
    id: s.id,
    title: s.title || s.id,
    platform: s.meta?.platform || s.type,
    startedAt: s.date || 0,
    people: [],
    terms: graphTerms(s),
  })));
  return graph.relatedMeetings(sourceId, { limit }).map((r) => {
    const source = byId.get(r.id);
    const shared = r.sharedPeople || [];
    return {
      sourceId: r.id,
      type: source?.type || '',
      title: source?.title || r.id,
      date: source?.date || 0,
      url: source?.url || '',
      weight: r.weight,
      shared,
      reason: relatedReason(r),
    };
  });
}

export function formatHistoryResults(results, { query = '', maxChars = 12000 } = {}) {
  const cap = clampInt(maxChars, 12000, 1000, 50000);
  const lines = [
    `History search results for: ${query || '(no query)'}`,
    'Use these sources as retrieved local history. Cite labels inline with <sup>[1]</sup>, add a bottom "Sources" list with labels/links/IDs, and ask if excerpts are insufficient.',
    '',
  ];
  let used = lines.join('\n').length;
  for (const r of results || []) {
    const label = `[${r.sourceId}#${r.chunk}] ${r.title || r.sourceId}`;
    const when = r.date ? ` · ${new Date(r.date).toLocaleString()}` : '';
    const score = Number.isFinite(r.score) ? ` · score ${r.score.toFixed(2)}` : '';
    const open = r.url ? ` · Open: [Open in ChatPanel](${r.url})` : '';
    const head = `${label}${when}${score}${open}`;
    const bodyBudget = cap <= 1200
      ? Math.min(120, Math.max(80, cap - used - head.length - 80))
      : Math.max(240, cap - used - head.length - 80);
    const text = r.text.length > bodyBudget ? `${r.text.slice(0, bodyBudget).trim()}...` : r.text;
    const block = `${head}\n${text}\n`;
    if (used + block.length > cap && lines.length > 3) break;
    lines.push(block);
    used += block.length;
    if (used >= cap) break;
  }
  if ((results || []).length === 0) lines.push('No matching local history sources were found.');
  return lines.join('\n').trim();
}

export function buildHistoryRagAttachment(query, results, options = {}) {
  const count = new Set((results || []).map((r) => r.sourceId)).size;
  const text = formatHistoryResults(results, { query, maxChars: options.maxChars });
  return {
    id: `history_rag_${Date.now()}`,
    kind: 'history-rag',
    title: `History search · ${count} source${count === 1 ? '' : 's'}`,
    text,
    chars: text.length,
  };
}

export function getHistorySource(sources, sourceId, { maxChars = 20000 } = {}) {
  const source = (sources || []).find((s) => s.id === sourceId);
  if (!source) return { sourceId, found: false, text: '' };
  const cap = clampInt(maxChars, 20000, 1000, 100000);
  const full = cleanText(source.text);
  const truncated = full.length > cap;
  const text = truncated ? `${full.slice(0, cap).trim()}...` : full;
  return {
    sourceId,
    type: source.type,
    title: source.title || sourceId,
    date: source.date || 0,
    url: source.url || '',
    found: true,
    truncated,
    text,
  };
}
