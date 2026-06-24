import { topTerms } from './meeting-index.js';

export const TOPIC_INDEX_VERSION = 5;

const BAD_TOPICS = new Set([
  'am',
  'because',
  "don't",
  'dont',
  'if',
  'i am',
  "i'm",
  'im',
  "it's",
  'its',
  'need',
  'needs',
  'needed',
  'speaker',
  'assistant',
  'user',
  'meeting',
  'transcript',
  'summary',
  'topic',
  'topics',
  'chat',
  'add',
  'covered',
  'discussed',
  'discussion',
  'decision',
  'decisions',
  'detail',
  'details',
  'different',
  'figure',
  'highlight',
  'highlights',
  'key',
  'mean',
  'moment',
  'moments',
  'more',
  'out',
  'remains',
  'risk',
  'risks',
  'should',
  'scope',
  'think',
  'yeah',
  'access',
  'action',
  'actions',
  'answer',
  'answers',
  'ask',
  'asked',
  'call',
  'calls',
  'command',
  'commands',
  'data',
  'day',
  'days',
  'docs',
  'good',
  'help',
  'know',
  'make',
  'maybe',
  'new',
  'old',
  'password',
  'question',
  'questions',
  'see',
  'team',
  'thing',
  'things',
  'time',
  'today',
  'use',
  'used',
  'using',
  'want',
  'work',
  'worked',
]);

const FALLBACK_STOP = new Set([
  ...BAD_TOPICS,
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'get',
  'go',
  'got',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'in',
  'is',
  'it',
  'just',
  'like',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'our',
  'really',
  'right',
  'said',
  'say',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'too',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const SINGLE_TOPIC_ALLOW = new Set([
  'apex',
  'api',
  'bm25',
  'claude',
  'codex',
  'confluence',
  'cuda',
  'rollout',
  'gemini',
  'gpu',
  'jira',
  'mcp',
  'nvidia',
  'oauth',
  
  'oidc',
  'openrouter',
  'rag',
  'redis',
  'sftp',
]);

const BAD_TOPIC_PHRASES = new Set([
  'covered object',
  'delivery remains',
  'discussion covered',
  'docs gpu',
  'docs should',
  'mechanism more',
  'more details',
  'object storage disaster',
  'recovery interview',
  'should add',
  'storage disaster',
  'storage disaster recovery',
  'think lease',
  'training lease',
  'yeah mean',
  'yeah think',
]);

function compactText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeTopic(value) {
  let s = compactText(value)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/[’‘`]/g, "'")
    .replace(/^["'`]+|["'`.]+$/g, '')
    .toLowerCase();
  s = s.replace(/\b(speaker|assistant|user)\s*[-_#]?\s*\d*\b/g, '').replace(/\s+/g, ' ').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return '';
  if (BAD_TOPICS.has(s)) return '';
  if (BAD_TOPIC_PHRASES.has(s)) return '';
  if (/^\d{1,2}:\d{2}$/.test(s)) return '';
  return s;
}

function topicToken(value) {
  let s = String(value || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—_/]+/g, '-')
    .replace(/^['+.-]+|['+.-]+$/g, '');
  if (s.endsWith("'s")) s = s.slice(0, -2);
  const compact = s.replace(/[-']/g, '');
  if (compact.length < 2 || /^\d+$/.test(compact)) return '';
  if (FALLBACK_STOP.has(s) || FALLBACK_STOP.has(compact)) return '';
  return s.replace(/'/g, '');
}

function fallbackLines(text) {
  return compactText(text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .split(/(?:[.!?;,]|\n|\r)+/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, ''))
    .map((line) => line.replace(/\[[^\]]+\]/g, ' '))
    .map((line) => line.replace(/^\s*(?:title|summary|transcript|chat|meeting|date|platform|topics?|agenda|key moments?|moments?|shared links?|links?|action items?|actions?)\s*:\s*/i, ''))
    .map((line) => line.replace(/^\s*[^:]{1,48}:\s+/, ''))
    .map(compactText)
    .filter(Boolean);
}

function addCandidate(scores, phrase, score) {
  const topic = normalizeTopic(phrase);
  if (!topic) return;
  const words = topic.split(/\s+/).filter(Boolean);
  if (words.length === 1 && !SINGLE_TOPIC_ALLOW.has(words[0])) return;
  if (words.every((word) => FALLBACK_STOP.has(word))) return;
  scores.set(topic, (scores.get(topic) || 0) + score);
}

function fallbackPhraseScores(text) {
  const scores = new Map();
  for (const [lineIndex, line] of fallbackLines(text).entries()) {
    const lineBoost = lineIndex < 3 ? 2 : 1;
    const rawTokens = line.match(/[a-z0-9][a-z0-9'+-]{1,}/gi) || [];
    const runs = [];
    let run = [];
    for (const raw of rawTokens) {
      const token = topicToken(raw);
      if (!token) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      run.push(token);
    }
    if (run.length) runs.push(run);

    for (const tokens of runs) {
      for (let i = 0; i < tokens.length; i += 1) {
        addCandidate(scores, tokens[i], 0.25 * lineBoost);
        for (let size = 2; size <= 4 && i + size <= tokens.length; size += 1) {
          const phrase = tokens.slice(i, i + size);
          if (new Set(phrase).size === 1) continue;
          if (phrase.some((token, j) => j > 0 && token === phrase[j - 1])) continue;
          const sizeScore = size === 2 ? 5 : size === 3 ? 4 : 3;
          const positionBoost = Math.max(0, 1 - (i * 0.1));
          const domainBoost = SINGLE_TOPIC_ALLOW.has(phrase[0]) ? 1 : 0;
          addCandidate(scores, phrase.join(' '), (sizeScore * lineBoost) + positionBoost + domainBoost);
        }
      }
    }
  }
  return scores;
}

function markdownSectionBody(md, predicate) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const raw of lines) {
    const heading = raw.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      inSection = !!predicate(heading[1]);
      continue;
    }
    if (inSection) out.push(raw);
  }
  return out.join('\n').trim();
}

export function parseTopicExtractionResponse(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let candidates = [];
  try {
    const parsed = JSON.parse(unfenced);
    candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.topics) ? parsed.topics : [];
  } catch {
    const lines = unfenced.split(/\r?\n/);
    const bullets = lines.filter((line) => /^\s*[-*+]\s+/.test(line));
    candidates = (bullets.length ? bullets : lines)
      .map((line) => line.replace(/^\s*[-*+]\s*/, '').trim())
      .filter(Boolean);
  }
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    const topic = normalizeTopic(item);
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    out.push(topic);
    if (out.length >= 15) break;
  }
  return out;
}

function topicCandidatesFromText(text) {
  const rawLines = String(text || '').split(/\r?\n/);
  const bullets = rawLines.filter((line) => /^\s*[-*+]\s+/.test(line));
  if (bullets.length) {
    return bullets
      .map((line) => line.replace(/^\s*[-*+]\s*/, '').trim())
      .filter(Boolean);
  }
  const normalized = String(text || '').replace(/[;,]/g, '\n');
  const lines = normalized.split(/\r?\n/);
  return lines
    .map((line) => line.replace(/^\s*[-*+]\s*/, '').trim())
    .filter(Boolean);
}

function cleanInsightTopicText(value) {
  return compactText(value)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[\^\d+\]/g, '')
    .trim();
}

function insightTopicLabelCandidates(value) {
  const text = cleanInsightTopicText(value);
  if (!text) return [];
  const out = [];
  const labelMatch = text.match(/^(.{2,96}?)(?:\s*:\s+|\s+[–—]\s+|\s+-\s+)(.+)$/);
  if (labelMatch) {
    const label = compactText(labelMatch[1]);
    const words = label.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 6 && !/[.!?]/.test(label)) out.push(label);
  }
  out.push(text);
  return [...new Set(out)];
}

function insightTopicItemForGraph(value) {
  const candidates = insightTopicLabelCandidates(value);
  for (const candidate of candidates) {
    const topic = normalizeTopic(candidate);
    if (topic) return topic;
  }
  for (const candidate of candidates) {
    const [topic] = fallbackTopicItems(candidate, 1);
    if (topic) return topic;
  }
  return '';
}

export function insightTopicItemsFromNotes(notes, limit = 10) {
  const body = markdownSectionBody(notes, (heading) => /topic|agenda/i.test(heading));
  if (!body) return [];
  const seen = new Set();
  const out = [];
  for (const item of topicCandidatesFromText(body)) {
    const topic = insightTopicItemForGraph(item);
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    out.push(topic);
    if (out.length >= limit) break;
  }
  return out;
}

export function contentHash(text) {
  const input = compactText(text);
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function fallbackTopicItems(text, limit = 10) {
  const scores = fallbackPhraseScores(text);
  for (const term of topTerms(text, limit * 2)) {
    const token = topicToken(term);
    if (token && SINGLE_TOPIC_ALLOW.has(token)) addCandidate(scores, token, 0.5);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([topic]) => topic)
    .slice(0, limit);
}

export function topicDisplayForSource(existing, fallbackText, limit = 10) {
  if (existing?.version === TOPIC_INDEX_VERSION && existing.items?.length && !existing.fallback) {
    return { items: existing.items.slice(0, limit), fallback: false };
  }
  if (existing?.version === TOPIC_INDEX_VERSION && existing.items?.length && existing.fallback) {
    return { items: existing.items.slice(0, limit), fallback: true };
  }
  return { items: fallbackTopicItems(fallbackText, limit), fallback: true };
}

export function topicDisplayForMeetingSource(existing, notes = '', fallbackText = '', limit = 10) {
  const insightTopics = insightTopicItemsFromNotes(notes, limit);
  if (insightTopics.length) return { items: insightTopics, fallback: false, source: 'insights' };
  if (existing?.version === TOPIC_INDEX_VERSION && existing.items?.length && !existing.fallback) {
    return { items: existing.items.slice(0, limit), fallback: false, source: 'stored' };
  }
  const notesFallback = fallbackTopicItems(notes, limit);
  if (notesFallback.length) return { items: notesFallback, fallback: true, source: 'notes' };
  if (existing?.version === TOPIC_INDEX_VERSION && existing.items?.length && existing.fallback) {
    return { items: existing.items.slice(0, limit), fallback: true, source: 'stored-fallback' };
  }
  return { items: fallbackTopicItems(fallbackText, limit), fallback: true, source: 'transcript' };
}

export function topicItemsForDisplay(existing, fallbackText, limit = 10) {
  return topicDisplayForSource(existing, fallbackText, limit).items;
}

export function topicSourceTextForConversation(conv) {
  const lines = [`TITLE: ${conv?.title || 'Chat'}`, ''];
  for (const m of conv?.messages || []) {
    if (m.pending || m.error || !(m.role === 'user' || m.role === 'assistant')) continue;
    if (!m.content && !m.attachments?.length) continue;
    const role = m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${role}: ${compactText(m.content).slice(0, 6000)}`);
    for (const a of m.attachments || []) {
      if (a.kind === 'image' || !a.text) continue;
      lines.push(`Attachment ${a.title || a.kind || ''}: ${compactText(a.text).slice(0, 3000)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function topicSourceTextForMeeting(rec, notes = '') {
  const insightTopics = insightTopicItemsFromNotes(notes, 15);
  if (insightTopics.length) {
    return [
      `TITLE: ${rec?.title || 'Meeting'}`,
      '',
      'INSIGHT TOPICS:',
      ...insightTopics.map((topic) => `- ${topic}`),
      '',
      'INSIGHTS:',
      compactText(notes).slice(0, 12000),
    ].join('\n').trim();
  }
  const lines = [`TITLE: ${rec?.title || 'Meeting'}`, ''];
  if (notes) lines.push('SUMMARY:', compactText(notes).slice(0, 12000), '');
  lines.push('TRANSCRIPT:');
  for (const s of rec?.segments || []) {
    if (!s?.text) continue;
    lines.push(`${s.speaker || 'Speaker'}: ${compactText(s.text)}`);
  }
  for (const c of rec?.chat || []) {
    if (!c?.text) continue;
    lines.push(`${c.sender || 'Chat'}: ${compactText(c.text)}`);
  }
  return lines.join('\n').trim();
}

export function topicExtractionPrompt({ kind = 'chat', title = '', text = '' } = {}) {
  return [
    `You extract graph traversal topics from a ${kind} transcript.`,
    '',
    'Return only JSON:',
    '{"topics":["topic one","topic two"]}',
    '',
    'Rules:',
    '- 8 to 15 topics.',
    '- Use concise noun phrases, 1 to 4 words each.',
    '- Prefer durable project, product, API, architecture, decision, incident, provider, and workflow concepts.',
    '- Exclude people names, speaker labels, assistant/model names, timestamps, filler, and generic terms.',
    '- Merge near-duplicates into one canonical topic.',
    '- Keep provider/model names only when they are the subject being discussed.',
    '- Topics must be useful as graph nodes for finding related chats or meetings later.',
    '',
    `Title: ${title || '(untitled)'}`,
    '',
    text,
  ].join('\n');
}

export function shouldExtractTopics(existing, { hash, targetId = '', enabled = true } = {}) {
  if (!enabled || !hash) return false;
  if (!existing?.items?.length) return true;
  if (existing.version !== TOPIC_INDEX_VERSION) return true;
  if (existing.hash !== hash) return true;
  return (existing.targetId || '') !== (targetId || '');
}

export function makeTopicIndex({ hash, targetId = '', items = [], fallback = false } = {}) {
  return {
    version: TOPIC_INDEX_VERSION,
    hash,
    targetId,
    items: items.slice(0, 15),
    fallback: !!fallback,
    extractedAt: Date.now(),
  };
}
