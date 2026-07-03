// Durable, meeting-scoped persistence for LIVE MONITORS — the standing meeting
// "goals"/questions the scribe re-answers as a call progresses.
//
// Monitors are edited live from `conv.monitors` on the active conversation (that
// stays the panel's working state), but their generated INSIGHTS must outlive the
// conversation: survive a chat switch or an extension restart, be surfaceable on the
// meeting itself (drawer tab + summary), be searchable, and be restorable after an
// accidental close. So the side panel MIRRORS every change here, keyed by meeting —
//   chatpanel:meetingMonitors:<meetingId> → { v, updatedAt, items:[MonitorRecord] }
// encrypted at rest with the same key as the rest of the meeting data.
//
// A MonitorRecord is the panel monitor minus the transient `pending` flag, plus a
// lifecycle (closed/minimized) and an answer `history` so an insight isn't lost when
// the next tick overwrites it.

import { encryptJSON, decryptJSON, isEncrypted } from './meeting-crypto.js';

export const MONITORS_SCHEMA_VERSION = 1;

export const monitorsKey = (id) => `chatpanel:meetingMonitors:${id}`;

// Keep only the last N answers per monitor so a long meeting can't balloon storage.
const MAX_HISTORY = 20;

// Read + transparently migrate any legacy plaintext blob to encrypted (mirrors
// store-meetings.js readStoredJSON so behaviour is identical across stores).
async function readStoredJSON(key) {
  const got = await chrome.storage.local.get(key);
  const raw = got[key];
  const value = await decryptJSON(raw);
  if (raw !== undefined && !isEncrypted(raw) && value != null) {
    try {
      await chrome.storage.local.set({ [key]: await encryptJSON(value) });
    } catch {
      // Reads must keep working even if a best-effort legacy repair fails.
    }
  }
  return value;
}

function normalize(blob) {
  const items = Array.isArray(blob?.items) ? blob.items : [];
  return items.filter((m) => m && m.id);
}

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------

// All monitor records saved for a meeting (both active and closed), newest first.
export async function getMeetingMonitors(id) {
  if (!id) return [];
  return normalize(await readStoredJSON(monitorsKey(id)));
}

// --------------------------------------------------------------------------
// Write
// --------------------------------------------------------------------------

export async function saveMeetingMonitors(id, items) {
  if (!id) return;
  const clean = (Array.isArray(items) ? items : [])
    .filter((m) => m && m.id)
    .map((m) => ({ ...m, history: Array.isArray(m.history) ? m.history.slice(-MAX_HISTORY) : [] }));
  await chrome.storage.local.set({
    [monitorsKey(id)]: await encryptJSON({ v: MONITORS_SCHEMA_VERSION, updatedAt: Date.now(), items: clean }),
  });
}

// Insert or update one monitor record (matched by id). Merges so callers can pass a
// partial patch (e.g. just `{ id, minimized:true }`) without clobbering the insight.
// Appends to `history` when a new non-empty answer differs from the last one.
export async function upsertMeetingMonitor(id, rec) {
  if (!id || !rec?.id) return;
  const items = await getMeetingMonitors(id);
  const i = items.findIndex((m) => m.id === rec.id);
  const prev = i >= 0 ? items[i] : null;
  const now = Date.now();
  const merged = {
    kind: 'qa', prompt: '', skillId: '', title: '', icon: '',
    answer: '', history: [], minimized: false, paused: false, everyMin: 0, closed: false, closedAt: null,
    ...(prev || {}),
    ...rec,
    meetingId: id,
    createdAt: prev?.createdAt || rec.createdAt || now,
    updatedAt: now,
  };
  // Snapshot a fresh answer into history so re-runs don't erase earlier insight.
  const nextAnswer = typeof rec.answer === 'string' ? rec.answer.trim() : (merged.answer || '');
  const lastHist = merged.history[merged.history.length - 1]?.answer;
  if (nextAnswer && nextAnswer !== lastHist) {
    merged.history = [...merged.history, { ts: now, answer: nextAnswer }].slice(-MAX_HISTORY);
  }
  if (i >= 0) items[i] = merged; else items.unshift(merged);
  await saveMeetingMonitors(id, items);
}

// Mark a monitor closed (kept for restore) or reopen it. No-op if unknown.
export async function setMonitorClosed(id, monId, closed) {
  if (!id || !monId) return;
  const items = await getMeetingMonitors(id);
  const m = items.find((x) => x.id === monId);
  if (!m) return;
  m.closed = !!closed;
  m.closedAt = closed ? Date.now() : null;
  m.updatedAt = Date.now();
  await saveMeetingMonitors(id, items);
}

// Permanently forget one monitor (used by explicit purge, not the normal close path).
export async function removeMeetingMonitor(id, monId) {
  if (!id || !monId) return;
  const items = (await getMeetingMonitors(id)).filter((m) => m.id !== monId);
  await saveMeetingMonitors(id, items);
}

// --------------------------------------------------------------------------
// Search fold-in — a compact text blob of each monitor's question + latest insight,
// appended to the meeting's indexed document so ⌘K finds monitor content by
// question, answer, meeting, and (via topics) subject.
// --------------------------------------------------------------------------
export function monitorsSearchText(items = []) {
  const lines = [];
  for (const m of items) {
    const label = (m.title || m.prompt || (m.kind === 'tldr' ? 'Running TL;DR' : 'Monitor')).trim();
    const answer = (m.answer || m.history?.[m.history.length - 1]?.answer || '').trim();
    if (!label && !answer) continue;
    lines.push(`Q: ${label}${answer ? `\nA: ${answer}` : ''}`);
  }
  return lines.length ? `LIVE MONITORS:\n${lines.join('\n\n')}` : '';
}
