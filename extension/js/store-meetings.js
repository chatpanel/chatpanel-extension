// Persistence layer for captured meetings.
//
// Mirrors the conversation model in store.js: a lightweight index plus one
// record per meeting, all in chrome.storage.local —
//   chatpanel:meetingIndex   → [{id,platform,title,startedAt,endedAt,status,lines}]
//   chatpanel:meeting:<id>    → the full meeting record (schema below)
//
// IMPORTANT — single writer: the CONTENT SCRIPT (content/meeting-core.js) is the
// only thing that *writes* meeting records while a meeting is live. This module is
// the reader/manager used by the side panel + history UI (list, open, delete,
// prune, export). The key strings below are duplicated verbatim in meeting-core.js;
// keep them in sync. The meeting↔conversation link lives on the CONVERSATION
// (conv.meetingId), so this record stays purely capture data and never races.

import { encryptJSON, decryptJSON } from './meeting-crypto.js';

export const MEETING_SCHEMA_VERSION = 1;

const K_MINDEX = 'chatpanel:meetingIndex';
export const meetingKey = (id) => `chatpanel:meeting:${id}`;
// The AI scribe summary is stored under a SEPARATE key the side panel owns, so it
// never races the content-script's single-writer ownership of the meeting record.
const notesKey = (id) => `chatpanel:meetingNotes:${id}`;

// Size ceilings so one long meeting can't balloon storage. Transcripts are kept as
// a rolling tail: when a record exceeds these, the OLDEST segments are dropped
// (the recent conversation is what live summaries need; full history is export-time
// concern, not always-resident). ~200k chars ≈ 50k words ≈ a very long meeting.
const MAX_TRANSCRIPT_CHARS = 200_000;
const MAX_SEGMENTS = 4000;

// Supported platforms and how to recognise / label a tab. The capture adapters
// in content/ implement the matching DOM scraping; this is the panel-side mirror
// used to decide whether the active tab is a meeting and which platform it is.
// Only Zoom is fully implemented today — the rest are stubs.
export const PLATFORMS = {
  zoom: { label: 'Zoom', match: /:\/\/[^/]*\.zoom\.us\/wc\//, ready: true },
  meet: { label: 'Google Meet', match: /:\/\/meet\.google\.com\/[a-z]/, ready: true },
  teams: { label: 'Microsoft Teams', match: /:\/\/([^/]*\.)?teams\.(microsoft|live)\.com\//, ready: true },
  webex: { label: 'Webex', match: /:\/\/[^/]*\.webex\.com\/(meet|wbxmjs|webappng|meeting|cisco)/, ready: true },
};

// Return the platform key for a URL, or null if it isn't a known meeting page.
export function meetingPlatform(url = '') {
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (p.match.test(url)) return key;
  }
  return null;
}

// --------------------------------------------------------------------------
// Write (single path) — called from the background worker, which is the only
// writer. Records and the index are encrypted at rest (see meeting-crypto.js).
// --------------------------------------------------------------------------

// Trim a record to the size ceilings, keeping the most-recent tail. Flags
// `truncatedHead` so a reader/summary knows earlier lines were dropped.
function capRecord(rec) {
  let segs = Array.isArray(rec.segments) ? rec.segments : [];
  let truncated = false;
  if (segs.length > MAX_SEGMENTS) {
    segs = segs.slice(-MAX_SEGMENTS);
    truncated = true;
  }
  let total = 0;
  const kept = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    total += (segs[i].text || '').length;
    if (total > MAX_TRANSCRIPT_CHARS && kept.length) {
      truncated = true;
      break;
    }
    kept.unshift(segs[i]);
  }
  return { ...rec, segments: kept, truncatedHead: truncated || !!rec.truncatedHead };
}

async function saveIndex(index) {
  await chrome.storage.local.set({ [K_MINDEX]: await encryptJSON(index) });
}

// Persist (or update) one meeting record + its index entry, capped and encrypted.
export async function persistMeeting(rec) {
  if (!rec?.id) return;
  const capped = capRecord(rec);
  await chrome.storage.local.set({ [meetingKey(capped.id)]: await encryptJSON(capped) });
  const index = await getMeetingIndex();
  const entry = {
    id: capped.id,
    platform: capped.platform,
    title: capped.title,
    startedAt: capped.startedAt,
    endedAt: capped.endedAt,
    status: capped.status,
    lines: capped.segments.length,
    persistedAt: Date.now(), // last heartbeat — lets the side panel detect zombies
  };
  const i = index.findIndex((e) => e.id === capped.id);
  if (i >= 0) index[i] = entry;
  else index.unshift(entry);
  await saveIndex(index);
}

// Force a meeting to 'ended' (used to clean up a "zombie" live meeting whose tab/
// content script is gone, so it stops showing as recording). Safe only when no
// content script is still writing it — the side panel calls this on stale records.
export async function markMeetingEnded(id) {
  const index = await getMeetingIndex();
  const e = index.find((x) => x.id === id);
  let changed = false;
  if (e && e.status !== 'ended') {
    e.status = 'ended';
    e.endedAt = e.endedAt || Date.now();
    changed = true;
  }
  if (changed) await saveIndex(index);
  const rec = await getMeeting(id);
  if (rec && rec.status !== 'ended') {
    rec.status = 'ended';
    rec.endedAt = rec.endedAt || Date.now();
    await chrome.storage.local.set({ [meetingKey(id)]: await encryptJSON(rec) });
  }
}

// --------------------------------------------------------------------------
// Read / manage
// --------------------------------------------------------------------------

export async function getMeetingIndex() {
  const got = await chrome.storage.local.get(K_MINDEX);
  const idx = await decryptJSON(got[K_MINDEX]);
  return Array.isArray(idx) ? idx : [];
}

export async function getMeeting(id) {
  const got = await chrome.storage.local.get(meetingKey(id));
  return (await decryptJSON(got[meetingKey(id)])) || null;
}

export async function deleteMeeting(id) {
  await chrome.storage.local.remove([meetingKey(id), notesKey(id)]);
  const index = (await getMeetingIndex()).filter((e) => e.id !== id);
  await saveIndex(index);
}

export async function clearAllMeetings() {
  const index = await getMeetingIndex();
  await chrome.storage.local.remove(index.flatMap((e) => [meetingKey(e.id), notesKey(e.id)]));
  await saveIndex([]);
}

// The AI scribe summary (markdown) for a meeting — saved by the side panel as the
// live notes refresh, so reopening a past meeting shows the last summary.
export async function saveMeetingNotes(id, text) {
  if (!id) return;
  await chrome.storage.local.set({ [notesKey(id)]: await encryptJSON(String(text || '')) });
}
export async function getMeetingNotes(id) {
  const got = await chrome.storage.local.get(notesKey(id));
  const v = await decryptJSON(got[notesKey(id)]);
  return typeof v === 'string' ? v : '';
}

// Keep storage bounded: drop the oldest ended meetings beyond `keep`, and any
// older than `maxAgeDays`. Live meetings are never pruned. Call opportunistically
// (e.g. on side-panel open) so a long history of transcripts can't accumulate
// unbounded even with unlimitedStorage.
export async function pruneMeetings({ keep = 50, maxAgeDays = 60 } = {}) {
  const index = await getMeetingIndex();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const ended = index.filter((e) => e.status === 'ended');
  const live = index.filter((e) => e.status !== 'ended');
  ended.sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
  const kept = [];
  const drop = [];
  ended.forEach((e, i) => {
    if (i < keep && (e.endedAt || e.startedAt || 0) >= cutoff) kept.push(e);
    else drop.push(e);
  });
  if (!drop.length) return 0;
  await chrome.storage.local.remove(drop.map((e) => meetingKey(e.id)));
  await saveIndex([...live, ...kept]);
  return drop.length;
}

// --------------------------------------------------------------------------
// Formatting (shared shape the model sees, and Markdown export)
// --------------------------------------------------------------------------

// Render a meeting record as plain text suitable for attaching as model context.
// `sinceTs` keeps only segments at/after a timestamp — used for a rolling
// "last N minutes" window so the live-summary prompt stays bounded.
export function meetingToText(rec, { sinceTs = 0 } = {}) {
  if (!rec) return '';
  const L = [`--- Meeting Transcript (${PLATFORMS[rec.platform]?.label || rec.platform}) ---`, ''];
  const segs = (rec.segments || []).filter((s) => !sinceTs || s.t >= sinceTs);
  if (segs.length) {
    for (const s of segs) {
      L.push(`[${new Date(s.t).toLocaleTimeString()}] ${s.speaker}: ${s.text}`);
    }
  } else {
    L.push('(no transcript captured yet — is live captioning turned on?)');
  }
  const chat = (rec.chat || []).filter((c) => !sinceTs || c.t >= sinceTs);
  if (chat.length) {
    L.push('', '--- Chat ---', '');
    for (const c of chat) {
      L.push(`[${new Date(c.t).toLocaleTimeString()}] ${c.sender} to ${c.receiver}: ${c.text}`);
    }
  }
  if (rec.participants?.length) {
    L.push('', '--- Participants ---', '');
    L.push(...rec.participants.map((p) => `${p.initials || '?'} - ${p.name}${p.role ? ` (${p.role})` : ''}`));
  }
  return L.join('\n');
}

export function meetingToMarkdown(rec) {
  const L = [
    `# ${rec.title || 'Meeting'}`,
    '',
    `_${PLATFORMS[rec.platform]?.label || rec.platform} · ${new Date(rec.startedAt).toLocaleString()}_`,
    '',
    '## Transcript',
    '',
  ];
  for (const s of rec.segments || []) {
    L.push(`**${s.speaker}** _(${new Date(s.t).toLocaleTimeString()})_: ${s.text}`, '');
  }
  return L.join('\n');
}
