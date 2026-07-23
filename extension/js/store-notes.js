// Persistence layer for user notes — the third first-class source type alongside
// chats and meetings. Mirrors the conversation/meeting model in store.js /
// store-meetings.js: a lightweight index plus one record per note, encrypted at
// rest in chrome.storage.local —
//   chatpanel:noteIndex   → [{id,title,tags,createdAt,updatedAt,chars}]
//   chatpanel:note:<id>    → the full note record { id,title,body,tags,createdAt,updatedAt }
//
// Notes are plain markdown (portable, greppable). They ride the SAME backup,
// warm-sync, gateway search and MCP as everything else — that's the whole point of
// keeping them in the extension rather than a separate app.

import { encryptJSON, decryptJSON, isEncrypted } from './meeting-crypto.js';
// STATIC, not `await import()` — captureToInbox()/createNote() run in the MV3 service
// worker, where dynamic import() throws TypeError and silently aborts the write (the
// same defect that dropped every meeting). Both are dependency-free leaf modules.
import { getLicense, isPro, FREE_LIMITS } from './license.js';
import { usageCount, bumpUsage } from './usage-counters.js';

// Same id shape as store.js's uid(), inlined so the notes page never pulls in the
// whole store.js module graph (oauth, zip, meetings…) on load — that was the bulk of
// the page's cold start.
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const K_NINDEX = 'chatpanel:noteIndex';
export const noteKey = (id) => `chatpanel:note:${id}`;

// A short preview kept IN the index, so the list renders from one decrypt instead of
// decrypting every note body. Skips the first line (the title).
function snippetOf(body) {
  const b = String(body || '');
  const nl = b.indexOf('\n');
  const rest = nl >= 0 ? b.slice(nl + 1) : '';
  return rest.replace(/[#*_`>~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}

// The [[Title]] links a note contains — kept in the index so backlinks compute
// without decrypting every body.
function extractLinks(body) {
  const out = [];
  const re = /\[\[([^[\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(String(body || '')))) {
    const t = m[1].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function wordCount(body) {
  const s = String(body || '').trim();
  return s ? s.split(/\s+/).length : 0;
}

// First non-empty line becomes the title, stripped of markdown heading/emphasis
// marks. Falls back to "Untitled note".
export function deriveTitle(body) {
  const first = String(body || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const clean = first.replace(/^#{1,6}\s+/, '').replace(/[*_`~>#]+/g, '').trim();
  return (clean || 'Untitled note').slice(0, 120);
}

async function saveIndex(index) {
  await chrome.storage.local.set({ [K_NINDEX]: await encryptJSON(index) });
}

// Decrypt-on-read, with a best-effort repair of any legacy plaintext value (same
// pattern as store-meetings.js). Reads never fail on a repair error.
async function readStoredJSON(key) {
  const got = await chrome.storage.local.get(key);
  const raw = got[key];
  const value = await decryptJSON(raw);
  if (raw !== undefined && !isEncrypted(raw) && value != null) {
    try {
      await chrome.storage.local.set({ [key]: await encryptJSON(value) });
    } catch {
      /* keep working even if the repair write fails */
    }
  }
  return value;
}

export async function getNoteIndex() {
  const idx = await readStoredJSON(K_NINDEX);
  return Array.isArray(idx) ? idx : [];
}

export async function getNote(id) {
  return (await readStoredJSON(noteKey(id))) || null;
}

// Write a record verbatim (no timestamp munging) + refresh its index entry, sorted
// newest-edited first. Encrypted at rest.
async function writeNote(rec) {
  await chrome.storage.local.set({ [noteKey(rec.id)]: await encryptJSON(rec) });
  const entry = {
    id: rec.id,
    title: rec.title,
    snippet: snippetOf(rec.body),
    tags: Array.isArray(rec.tags) ? rec.tags : [],
    links: extractLinks(rec.body),
    // Auto-extracted topics (kept in the index so the graph/dashboard/omni use them
    // without decrypting bodies — same reason tags/links live here). Attached by the
    // background extractor via saveNoteTopics(); mirrored on every full save.
    topics: Array.isArray(rec.topics?.items) ? rec.topics.items : [],
    words: wordCount(rec.body),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    chars: (rec.body || '').length,
  };
  // Drop any existing entry and unshift the fresh one, THEN stable-sort by
  // updatedAt — so the just-written note wins even on a same-millisecond tie.
  const index = (await getNoteIndex()).filter((e) => e.id !== rec.id);
  index.unshift(entry);
  index.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  await saveIndex(index);
  return rec;
}

// Create or update a note. Re-derives the title from the first line when the caller
// doesn't set one, and re-stamps updatedAt (that's what keeps the list sorted).
export async function saveNote(note) {
  if (!note?.id) return null;
  const now = Date.now();
  return writeNote({
    id: note.id,
    title: (note.title || '').trim() || deriveTitle(note.body),
    body: String(note.body || ''),
    tags: Array.isArray(note.tags) ? note.tags : [],
    createdAt: note.createdAt || now,
    updatedAt: now,
    // Provenance ledger: who (human / which agent) wrote each run of the body, and
    // labelled version snapshots to revert to. Carried verbatim when provided.
    ...(Array.isArray(note.attribution) ? { attribution: note.attribution } : {}),
    ...(Array.isArray(note.versions) ? { versions: note.versions } : {}),
    // Auto-extracted topic index { version, hash, items[], fallback, extractedAt }.
    ...(note.topics ? { topics: note.topics } : {}),
  });
}

// Attach a freshly-extracted topic index to a note WITHOUT re-stamping updatedAt or
// re-sorting the list — a background extraction shouldn't jump the note to the top.
// Mirrors store-meetings.js saveMeetingTopics(). Returns the updated record or null.
export async function saveNoteTopics(id, topics) {
  const rec = await getNote(id);
  if (!rec) return null;
  rec.topics = topics;
  await chrome.storage.local.set({ [noteKey(id)]: await encryptJSON(rec) });
  const items = Array.isArray(topics?.items) ? topics.items : [];
  const index = await getNoteIndex();
  const entry = index.find((e) => e.id === id);
  if (entry) { entry.topics = items; await saveIndex(index); }
  return rec;
}

// Free-tier note ceiling. Pro/Team is unlimited. The guard lives at createNote() — the
// single "make a NEW note" factory every path funnels through (UI button, plan-in-note,
// @task note_create) — so there's ONE place to enforce it. saveNote()/writeNote() stay
// ungated so editing existing notes, capture-to-Inbox, and backup restore are never
// blocked (restore must never lose notes). license.js is dynamic-imported so the notes
// first-paint graph stays lean; the cost is paid only when a note is actually created.
export class NoteLimitError extends Error {
  constructor(limit) {
    super(`Free plan is limited to ${limit} notes`);
    this.name = 'NoteLimitError';
    this.limit = limit;
  }
}

// { reached, limit, count } — reached is true when a Free user is at/over the cap;
// Pro/Team never reach it. `count` is the lifetime number of notes ever created,
// seeded from the current index the first time. The UI calls this before createNote()
// to show an upgrade prompt instead of a throw.
export async function noteLimitReached() {
  const limit = FREE_LIMITS.notes;
  const license = await getLicense();
  const count = await usageCount('notesCreated', (await getNoteIndex()).length);
  if (isPro(license)) return { reached: false, limit, count };
  return { reached: count >= limit, limit, count };
}

// Make a fresh note and return its record. Throws NoteLimitError on Free past the cap.
// `attribution`/`versions` let a caller stamp authorship at birth — e.g. an agent that
// creates a note via note_create records ITSELF as the author (a human-made note is seeded
// as "You" on open by normalizeAttribution), so provenance shows who created every note.
export async function createNote({ title = '', body = '', attribution = null, versions = null } = {}) {
  const { reached, limit } = await noteLimitReached();
  if (reached) throw new NoteLimitError(limit);
  const rec = await saveNote({
    id: uid(), title, body, createdAt: Date.now(),
    ...(Array.isArray(attribution) ? { attribution } : {}),
    ...(Array.isArray(versions) ? { versions } : {}),
  });
  // Tick the lifetime counter so the Free cap tracks notes ever created, not the
  // current index length (noteLimitReached seeded it above, so this just adds one).
  await bumpUsage('notesCreated');
  return rec;
}

export async function deleteNote(id) {
  await chrome.storage.local.remove(noteKey(id));
  const index = (await getNoteIndex()).filter((e) => e.id !== id);
  await saveIndex(index);
}

export async function clearAllNotes() {
  const index = await getNoteIndex();
  await chrome.storage.local.remove(index.map((e) => noteKey(e.id)));
  await saveIndex([]);
}

// ── Backup ────────────────────────────────────────────────────────────────────
export async function exportNotes() {
  const index = await getNoteIndex();
  const notes = [];
  for (const e of index) {
    const rec = await getNote(e.id);
    if (rec) notes.push(rec);
  }
  return notes;
}

// Restore notes from a backup. 'merge' (default) adds/updates by id preserving the
// original timestamps; 'replace' clears existing first. Returns { imported, total }.
export async function importNotes(list, { mode = 'merge' } = {}) {
  if (!Array.isArray(list)) return { imported: 0, total: 0 };
  if (mode === 'replace') await clearAllNotes();
  let imported = 0;
  for (const rec of list) {
    if (!rec?.id) continue;
    const now = Date.now();
    await writeNote({
      id: rec.id,
      title: (rec.title || '').trim() || deriveTitle(rec.body),
      body: String(rec.body || ''),
      tags: Array.isArray(rec.tags) ? rec.tags : [],
      createdAt: rec.createdAt || now,
      updatedAt: rec.updatedAt || now,
      // Restore the note's related artifacts verbatim — co-writer/agent provenance,
      // labelled version snapshots, and the auto-extracted topic index. exportNotes()
      // already writes these into the backup; dropping them here loses authorship,
      // revert history, and graph/omni topics on restore.
      ...(Array.isArray(rec.attribution) ? { attribution: rec.attribution } : {}),
      ...(Array.isArray(rec.versions) ? { versions: rec.versions } : {}),
      ...(rec.topics ? { topics: rec.topics } : {}),
    });
    imported++;
  }
  return { imported, total: list.length };
}

// Human-readable markdown for the archive ZIP (notes/*.md). If the body already
// opens with a heading we don't double up the title.
export function noteToMarkdown(note) {
  const body = String(note?.body || '');
  const title = (note?.title || '').trim() || deriveTitle(body);
  return body.trim().startsWith('#') ? body : `# ${title}\n\n${body}`;
}

// ── Capture (highlight → note) ─────────────────────────────────────────────────
// A #:~:text= fragment so clicking the source jumps back to the exact text on the
// page. A short prefix anchor is enough and keeps the URL tidy.
function textFragmentUrl(url, text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!url || !clean) return url || '';
  try {
    return `${url}#:~:text=${encodeURIComponent(clean.length > 60 ? clean.slice(0, 60) : clean)}`;
  } catch {
    return url;
  }
}
function formatClip({ text, sourceUrl, sourceTitle }) {
  const quote = String(text || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
  const href = textFragmentUrl(sourceUrl, text);
  const src = href ? `\n\n— [${sourceTitle || sourceUrl}](${href})` : '';
  return `${quote}${src}`.trim();
}

export const INBOX_NOTE_ID = 'inbox';

// Append a highlighted snippet to the Inbox note (newest on top), creating it if
// needed. Frictionless capture from the web / chats / meetings; triage later.
export async function captureToInbox({ text, sourceUrl = '', sourceTitle = '' }) {
  if (!String(text || '').trim()) return null;
  const clip = formatClip({ text, sourceUrl, sourceTitle });
  const existing = await getNote(INBOX_NOTE_ID);
  const body = existing ? `${clip}\n\n---\n\n${existing.body}` : clip;
  return saveNote({ id: INBOX_NOTE_ID, title: '📥 Inbox', body, tags: existing?.tags?.length ? existing.tags : ['inbox'], createdAt: existing?.createdAt });
}
