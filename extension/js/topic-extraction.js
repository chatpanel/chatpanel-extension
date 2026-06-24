import { topTerms } from './meeting-index.js';

export const TOPIC_INDEX_VERSION = 2;

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
  if (/^\d{1,2}:\d{2}$/.test(s)) return '';
  return s;
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
  return topTerms(text, limit * 2)
    .map(normalizeTopic)
    .filter(Boolean)
    .filter((topic, i, arr) => arr.indexOf(topic) === i)
    .slice(0, limit);
}

export function topicItemsForDisplay(existing, fallbackText, limit = 10) {
  if (existing?.version === TOPIC_INDEX_VERSION && existing.items?.length) {
    return existing.items;
  }
  return fallbackTopicItems(fallbackText, limit);
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
