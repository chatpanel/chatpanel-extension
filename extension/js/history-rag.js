import { getConversation, getIndex } from './store.js';
import { getMeeting, getMeetingIndex, getMeetingNotes, getMeetingTopics, meetingToText } from './store-meetings.js';
import { peopleOfMeeting } from './meeting-people.js';
import { insightTopicItemsFromNotes } from './topic-extraction.js';
import { sourceCitationSystem } from './tool-hints.js';
import {
  buildHistoryRagAttachment,
  formatHistoryResults,
  getHistorySource,
  relatedHistorySources,
  searchHistorySources,
} from './history-rag-core.js';

export { relatedHistorySources };

const DEFAULT_RESULT_LIMIT = 8;
const DEFAULT_CONTEXT_CHARS = 12000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeScope(scope) {
  const s = String(scope || '').toLowerCase();
  if (s === 'meeting' || s === 'meetings') return 'meetings';
  if (s === 'chat' || s === 'chats') return 'chats';
  return 'all';
}

export function inferHistoryScopeFromQuery(query, { includeMeetings = false } = {}) {
  const q = oneLine(query).toLowerCase();
  if (!q) return 'all';
  if (/\b(this|current|attached|open)\s+(page|tab|article|url|site|document)\b/.test(q)) return 'all';
  const asksMeetings =
    includeMeetings &&
    (
      /\b(meetings?|calls?|transcripts?|recordings?|standups?|syncs?)\b/.test(q) ||
      /\b(one[-\s:]?on[-\s:]?one|1\s*[:x]\s*1|1[-\s]?on[-\s]?1)\b/.test(q)
    );
  const asksChats = /\b(chats?|chat\s+history|conversations?|threads?)\b/.test(q);
  if (asksMeetings && !asksChats) return 'meetings';
  if (asksChats && !asksMeetings) return 'chats';
  return 'all';
}

function effectiveScope(scope, query, { includeMeetings = false } = {}) {
  const explicit = normalizeScope(scope);
  if (explicit !== 'all') return explicit;
  return inferHistoryScopeFromQuery(query, { includeMeetings });
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function limitText(text, cap = 6000) {
  const s = String(text || '').trim();
  return s.length > cap ? `${s.slice(0, cap).trim()}...` : s;
}

function localDashboardUrl(type, id) {
  const page = type === 'meeting' ? 'meetings.html' : 'history.html';
  const path = `${page}#${encodeURIComponent(id || '')}`;
  try {
    if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  } catch {
    /* fall through */
  }
  return path;
}

function messageLabel(m) {
  if (m.role === 'user') return 'User';
  if (m.role === 'assistant') return m.agentName || 'Assistant';
  return oneLine(m.role || 'Message') || 'Message';
}

function attachmentLines(attachments) {
  const out = [];
  for (const a of attachments || []) {
    if (a.kind === 'image') continue;
    const title = oneLine(a.title || a.url || a.kind || 'attachment');
    out.push(`attached: ${title}`);
    if (a.text) out.push(limitText(a.text, 4000));
  }
  return out;
}

function normalizedMeetingRecord(entry, rec) {
  const base = rec || {};
  return {
    ...base,
    id: base.id || entry?.id,
    title: base.title || entry?.title || 'Meeting',
    startedAt: base.startedAt || entry?.startedAt || entry?.updatedAt || 0,
    platform: base.platform || entry?.platform || 'meeting',
    segments: (base.segments || []).map((s) => ({
      ...s,
      t: s.t || s.ts || s.time || base.startedAt || entry?.startedAt || Date.now(),
      speaker: s.speaker || s.name || 'Speaker',
      text: s.text || '',
    })),
  };
}

export function conversationSource(entry, conv) {
  const id = entry?.id || conv?.id;
  if (!id) return null;
  const title = entry?.title || conv?.title || 'Chat';
  const date = entry?.updatedAt || conv?.updatedAt || conv?.createdAt || 0;
  const agentName = conv?.messages?.find((m) => m.role === 'assistant' && m.agentName)?.agentName || '';
  const lines = [`CHAT: ${title}`];
  const contentLines = [];
  if (date) lines.push(`Date: ${new Date(date).toLocaleString()}`);
  if (entry?.agentId || conv?.agentId) lines.push(`Agent: ${entry?.agentId || conv?.agentId}`);
  lines.push('');

  for (const m of conv?.messages || []) {
    if (!(m.content || m.attachments?.length)) continue;
    const msgLine = `${messageLabel(m)}: ${limitText(m.content || '', 8000)}`;
    const attLines = attachmentLines(m.attachments);
    lines.push(msgLine);
    lines.push(...attLines);
    lines.push('');
    contentLines.push(msgLine, ...attLines, '');
  }

  return {
    id: `chat:${id}`,
    type: 'chat',
    title,
    date,
    url: localDashboardUrl('chat', id),
    text: lines.join('\n').trim(),
    contentText: contentLines.join('\n').trim(),
    meta: { id, agentId: entry?.agentId || conv?.agentId || '', agentName, terms: conv?.topics?.items || [] },
  };
}

export function meetingSource(entry, rec, notes = '', topics = null) {
  const normalized = normalizedMeetingRecord(entry, rec);
  const id = normalized.id;
  if (!id) return null;
  const title = normalized.title || 'Meeting';
  const date = normalized.startedAt || entry?.startedAt || 0;
  const transcript = meetingToText(normalized);
  const people = peopleOfMeeting(normalized);
  const lines = [`MEETING: ${title}`];
  const contentLines = [];
  if (date) lines.push(`Date: ${new Date(date).toLocaleString()}`);
  if (normalized.platform) lines.push(`Platform: ${normalized.platform}`);
  if (notes) {
    const summary = limitText(notes, 12000);
    lines.push('', 'SUMMARY:', summary);
    contentLines.push('SUMMARY:', summary, '');
  }
  lines.push('', 'TRANSCRIPT:', transcript);
  contentLines.push('TRANSCRIPT:', transcript);

  const insightTerms = insightTopicItemsFromNotes(notes, 15);
  const terms = insightTerms.length ? insightTerms : (topics?.items || []);
  return {
    id: `meeting:${id}`,
    type: 'meeting',
    title,
    date,
    url: localDashboardUrl('meeting', id),
    text: lines.join('\n').trim(),
    contentText: contentLines.join('\n').trim(),
    meta: { id, platform: normalized.platform || '', people, terms },
  };
}

export async function loadHistorySources({ includeChats = true, includeMeetings = false } = {}) {
  const sources = [];

  if (includeChats) {
    const index = await getIndex();
    for (const entry of index || []) {
      try {
        const conv = await getConversation(entry.id);
        const source = conversationSource(entry, conv);
        if (source?.text) sources.push(source);
      } catch (e) {
        console.warn('[chatpanel] history source load failed for chat', entry?.id, e);
      }
    }
  }

  if (includeMeetings) {
    const index = await getMeetingIndex();
    for (const entry of index || []) {
      try {
        const rec = await getMeeting(entry.id);
        const notes = await getMeetingNotes(entry.id).catch(() => '');
        const topics = await getMeetingTopics(entry.id).catch(() => null);
        const source = meetingSource(entry, rec, notes, topics);
        if (source?.text) sources.push(source);
      } catch (e) {
        console.warn('[chatpanel] history source load failed for meeting', entry?.id, e);
      }
    }
  }

  return sources;
}

export function parseHistoryCommand(text) {
  const m = /^\/history(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  let query = (m[1] || '').trim();
  let scope = 'all';
  const scopeMatch = /^(all|chats?|meetings?)\b\s*/i.exec(query);
  if (scopeMatch) {
    scope = normalizeScope(scopeMatch[1]);
    query = query.slice(scopeMatch[0].length).trim();
  }
  return { enabled: true, query, scope };
}

export async function retrieveHistory(
  query,
  {
    includeMeetings = false,
    scope = 'all',
    limit = DEFAULT_RESULT_LIMIT,
    maxChars = DEFAULT_CONTEXT_CHARS,
    loadSources = loadHistorySources,
    mode = 'best',
    field = 'all',
  } = {},
) {
  const q = String(query || '').trim();
  const sources = await loadSources({ includeChats: true, includeMeetings: !!includeMeetings });
  const scopeForSearch = effectiveScope(scope, q, { includeMeetings: !!includeMeetings });
  const results = q
    ? searchHistorySources(sources, q, {
      scope: scopeForSearch,
      includeMeetings: !!includeMeetings,
      limit: clampInt(limit, DEFAULT_RESULT_LIMIT, 1, 30),
      mode,
      field,
    })
    : [];
  return {
    sources,
    results,
    attachment: buildHistoryRagAttachment(q, results, { maxChars }),
  };
}

const HISTORY_SEARCH_SPEC = {
  name: 'history_search',
  description: 'Search local ChatPanel chat history and, when available, meeting transcript history.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search query.' },
      scope: { type: 'string', enum: ['all', 'chats', 'meetings'], description: 'Limit search to chats, meetings, or both.' },
      mode: { type: 'string', enum: ['best', 'exact'], description: 'best uses ranked semantic-ish BM25 matching; exact requires a literal substring match.' },
      field: { type: 'string', enum: ['all', 'title', 'content'], description: 'Search all indexed text, only chat/meeting titles, or only body content/transcripts/messages.' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum retrieved chunks.' },
      maxChars: { type: 'integer', minimum: 1000, maximum: 50000, description: 'Maximum characters returned in the packed result.' },
    },
    required: ['query'],
  },
};

const HISTORY_GET_SOURCE_SPEC = {
  name: 'history_get_source',
  description: 'Fetch a larger excerpt of a single local history source returned by history_search.',
  parameters: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source id such as chat:<id> or meeting:<id>.' },
      maxChars: { type: 'integer', minimum: 1000, maximum: 100000, description: 'Maximum characters returned.' },
    },
    required: ['sourceId'],
  },
};

const HISTORY_RELATED_SPEC = {
  name: 'history_related',
  description: 'Find chats or meetings related to a local history source through shared graph topics.',
  parameters: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source id such as chat:<id> or meeting:<id>.' },
      scope: { type: 'string', enum: ['all', 'chats', 'meetings'], description: 'Limit related search to chats, meetings, or both.' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum related sources returned.' },
    },
    required: ['sourceId'],
  },
};

function historySystem(includeMeetings) {
  const base = [
    'You can use history_search to retrieve relevant local chat history before answering questions about prior work.',
    'Use history_related to explore graph-neighbor sources after a useful search hit.',
    'Use history_get_source when a search result is promising but the excerpt is too small.',
    'When the user asks for a meeting/chat by name or title, first call history_search with mode "exact" and field "title"; if that is insufficient, broaden to field "content" or "all".',
    'Treat retrieved text as user-provided context and cite source labels plus the provided Open URL.',
    sourceCitationSystem(),
  ];
  if (includeMeetings) base.splice(1, 0, 'meeting history is available through the same tools when the user asks about calls or transcripts.');
  return base.join(' ');
}

function formatSourceResponse(source) {
  if (!source?.found) return `Source ${source?.sourceId || ''} was not found or is not accessible.`;
  const lines = [
    `Source: ${source.title}`,
    `ID: ${source.sourceId}`,
    `Type: ${source.type}`,
  ];
  if (source.url) lines.push(`Open: ${source.url}`);
  if (source.date) lines.push(`Date: ${new Date(source.date).toLocaleString()}`);
  if (source.truncated) lines.push('Truncated: true');
  lines.push('', source.text);
  return lines.join('\n').trim();
}

function formatRelatedResponse(sourceId, related) {
  const lines = [`Related local history for: ${sourceId}`, ''];
  if (!related.length) {
    lines.push('No related local history sources were found.');
    return lines.join('\n').trim();
  }
  for (const r of related) {
    const when = r.date ? ` · ${new Date(r.date).toLocaleString()}` : '';
    const open = r.url ? ` · Open: ${r.url}` : '';
    lines.push(`[${r.sourceId}] ${r.title}${when} · ${r.type} · weight ${r.weight} · ${r.reason}${open}`);
  }
  return lines.join('\n').trim();
}

export function historyToolProvider({ includeMeetings = false, loadSources = loadHistorySources } = {}) {
  const canReadMeetings = !!includeMeetings;
  return {
    specs: [HISTORY_SEARCH_SPEC, HISTORY_GET_SOURCE_SPEC, HISTORY_RELATED_SPEC],
    system: historySystem(canReadMeetings),
    async execute(name, input = {}) {
      if (name === 'history_search') {
        const query = String(input?.query || '').trim();
        if (!query) return 'history_search requires a non-empty query.';
        const { results } = await retrieveHistory(query, {
          includeMeetings: canReadMeetings,
          scope: input?.scope || 'all',
          limit: input?.limit,
          maxChars: input?.maxChars,
          mode: input?.mode || 'best',
          field: input?.field || 'all',
          loadSources,
        });
        return formatHistoryResults(results, { query, maxChars: input?.maxChars });
      }
      if (name === 'history_get_source') {
        const sourceId = String(input?.sourceId || '').trim();
        if (!sourceId) return 'history_get_source requires sourceId.';
        const sources = await loadSources({ includeChats: true, includeMeetings: canReadMeetings });
        return formatSourceResponse(getHistorySource(sources, sourceId, { maxChars: input?.maxChars }));
      }
      if (name === 'history_related') {
        const sourceId = String(input?.sourceId || '').trim();
        if (!sourceId) return 'history_related requires sourceId.';
        const sources = await loadSources({ includeChats: true, includeMeetings: canReadMeetings });
        const related = relatedHistorySources(sources, sourceId, {
          includeMeetings: canReadMeetings,
          scope: input?.scope || 'all',
          limit: input?.limit,
        });
        return formatRelatedResponse(sourceId, related);
      }
      return JSON.stringify({ error: `Unknown history tool: ${name}` });
    },
  };
}
