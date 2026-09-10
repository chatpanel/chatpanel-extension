// Persistence for BRIEFS — the derived layer.
//
// Same shape as store-notes.js / store-meetings.js: a lightweight index plus one record
// per brief, encrypted at rest in chrome.storage.local —
//   chatpanel:briefIndex   → [{id,key,kind,name,aliases,state,stats,updatedAt}]
//   chatpanel:brief:<id>    → the full brief { claims, records, … }
//
// The index/body split is what makes the dashboard render from ONE decrypt instead of one
// per subject, exactly as the notes list does. It also means the graph, ⌘K and the source
// registry can rank briefs without decrypting bodies.
//
// WHAT IS DIFFERENT FROM EVERY OTHER STORE HERE: a brief is a PROJECTION, not a record.
// Invariant I-K2 says the whole set is rebuildable from the corpus, so this module owns no
// truth — `rebuildBriefs()` may drop everything and re-derive, and that is a cache clear
// rather than data loss. Nothing else in ChatPanel may be treated that way, so nothing else
// gets a `clearAllBriefs()` that the product calls on purpose.
//
// Derivation itself lives in `@chatpanel/events/knowledge.js`, not here: a mobile client
// and the gateway have to derive the same briefs from the same records, and a second
// implementation would be a second answer. This file is the storage binding and nothing else.

import { encryptJSON, decryptJSON, isEncrypted } from './meeting-crypto.js';
// The MODEL only — never `events/knowledge-derive.js`. This module is on the MV3 service
// worker's graph (warm sync reads stored briefs and sends them to the gateway), and the
// worker never builds one, so derivation lives in js/briefs-build.js which only pages
// import. tools/test-first-paint-budget.mjs is what keeps that from quietly reverting.
import { briefToText, briefTerms } from './events/knowledge.js';
// From subject-name.js, not entity.js: this module is on the service worker's graph and
// needs one constant, where entity.js carries alias resolution and merge suggestion too.
import { DEFAULT_THRESHOLD } from './events/subject-name.js';

const K_INDEX = 'chatpanel:briefIndex';
const K_SETTINGS = 'chatpanel:briefSettings';
export const briefKey = (id) => `chatpanel:brief:${id}`;

/**
 * Provisional until a run of `tools/knowledge-survey.mjs` over real data replaces them —
 * `thresholdSweep()` exists for exactly that. Surfaced as a setting rather than a constant
 * because the right number depends on how dense one person's corpus is, and there is no
 * single answer that suits both a first week and three years.
 */
export const DEFAULT_BRIEF_SETTINGS = Object.freeze({
  enabled: true,
  minRecords: DEFAULT_THRESHOLD.records,
  minMentions: DEFAULT_THRESHOLD.mentions,
  maxBriefs: 300,
  // Who "You" is. Meeting platforms label the local participant that way, so without this
  // the user is a stranger in their own corpus. Read from memory when they have told
  // ChatPanel their name; asked for on the Briefs page otherwise. Never guessed.
  selfName: '',
  shareWithAgents: true, // whether briefs warm-sync out to the gateway's MCP surface
  lastBuiltAt: 0,
});

async function readStoredJSON(key) {
  const got = await chrome.storage.local.get(key);
  const raw = got[key];
  const value = await decryptJSON(raw);
  // Upgrade a legacy plaintext value in place, the same repair store-notes.js does.
  if (raw !== undefined && !isEncrypted(raw) && value != null) {
    try { await chrome.storage.local.set({ [key]: await encryptJSON(value) }); } catch { /* best effort */ }
  }
  return value;
}

export async function getBriefSettings() {
  const stored = await readStoredJSON(K_SETTINGS);
  return { ...DEFAULT_BRIEF_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

export async function saveBriefSettings(patch = {}) {
  const next = { ...(await getBriefSettings()), ...patch };
  await chrome.storage.local.set({ [K_SETTINGS]: await encryptJSON(next) });
  return next;
}

export const MERGES_KEY = 'chatpanel:briefMerges';

/**
 * The user's own identity corrections — `alias -> the name it belongs to`.
 *
 * Stored SEPARATELY from the briefs, and that separation is the point. A brief is a
 * projection that `rebuildBriefs()` may throw away and re-derive (I-K2); a correction the
 * user made is durable data. Keeping the merge here means the correction is an INPUT to the
 * next pass rather than an edit to the last one's output — a rebuild that erased it would
 * teach the user not to make another.
 */
export async function getBriefMerges() {
  const stored = await readStoredJSON(MERGES_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** Record "these two are the same". Returns the full map. */
export async function mergeSubjects(fromName, intoName) {
  const from = String(fromName || '').trim();
  const into = String(intoName || '').trim();
  if (!from || !into || from === into) return getBriefMerges();
  const merges = await getBriefMerges();
  merges[from] = into;
  // Anything already pointing at the name being folded away follows it, so the map stays one
  // hop deep and a later reader never has to walk a chain it did not expect.
  for (const [k, v] of Object.entries(merges)) if (k !== from && v === from) merges[k] = into;
  await chrome.storage.local.set({ [MERGES_KEY]: await encryptJSON(merges) });
  return merges;
}

/** Undo one — a wrong merge must be as easy to take back as it was to make. */
export async function unmergeSubject(fromName) {
  const merges = await getBriefMerges();
  delete merges[String(fromName || '').trim()];
  await chrome.storage.local.set({ [MERGES_KEY]: await encryptJSON(merges) });
  return merges;
}

/**
 * Set by the service worker on any corpus write, cleared by a rebuild.
 *
 * A boolean rather than a count: the honest question a reader has is "is what I am looking
 * at still current", and answering it must not cost a decrypt of the whole corpus just to
 * render a page that might not need rebuilding at all.
 */
export const STALE_KEY = 'chatpanel:briefsStale';

export async function briefsAreStale() {
  try { return !!(await chrome.storage.local.get(STALE_KEY))[STALE_KEY]; } catch { return false; }
}

export async function clearStale() {
  try { await chrome.storage.local.remove(STALE_KEY); } catch { /* best effort */ }
}

export async function getBriefIndex() {
  const idx = await readStoredJSON(K_INDEX);
  return Array.isArray(idx) ? idx : [];
}

export async function getBrief(id) {
  return (await readStoredJSON(briefKey(id))) || null;
}

/** The index row — everything a list, the graph and ⌘K need without a body decrypt. */
function indexEntry(brief) {
  return {
    id: brief.id,
    key: brief.key,
    kind: brief.kind,
    name: brief.subject.name,
    aliases: brief.subject.aliases,
    state: brief.state,
    cls: brief.cls,
    claims: brief.claims.length,
    terms: briefTerms(brief),
    stats: brief.stats,
    updatedAt: brief.updatedAt,
  };
}

/** Every brief as a searchable source row. Used by brief-source.js and by warm sync. */
export async function loadBriefRecords() {
  const out = [];
  for (const entry of await getBriefIndex()) {
    const brief = await getBrief(entry.id);
    if (!brief) continue;
    out.push({ entry, brief, text: briefToText(brief) });
  }
  return out;
}

/**
 * Replace the stored set wholesale. Called only by js/briefs-build.js — the write half of a
 * rebuild, kept here so every chrome.storage key this module owns is written in one file.
 */
export async function writeBriefs(briefs, { now = Date.now() } = {}) {
  const previous = await getBriefIndex();
  const keep = new Set(briefs.map((b) => b.id));
  // Drop the bodies of briefs the corpus no longer earns BEFORE writing the new ones, so a
  // rebuild that shrinks the set does not leave orphaned records behind — the quiet leak
  // widgets-store.js and jobs.js each had to fix once.
  const stale = previous.filter((e) => !keep.has(e.id)).map((e) => briefKey(e.id));
  if (stale.length) await chrome.storage.local.remove(stale);

  const writes = {};
  for (const b of briefs) writes[briefKey(b.id)] = await encryptJSON(b);
  writes[K_INDEX] = await encryptJSON(
    briefs.map(indexEntry).sort((a, b) => (b.stats.records - a.stats.records) || a.name.localeCompare(b.name)),
  );
  await chrome.storage.local.set(writes);
  await saveBriefSettings({ lastBuiltAt: now });
  await clearStale();
  return { briefs: briefs.length, removed: stale.length };
}

/** I-K2 in one call: safe by construction, because rebuildBriefs() can recreate all of it. */
export async function clearAllBriefs() {
  const index = await getBriefIndex();
  await chrome.storage.local.remove([...index.map((e) => briefKey(e.id)), K_INDEX]);
  return index.length;
}
