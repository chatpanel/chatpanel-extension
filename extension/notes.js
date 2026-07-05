// Notes dashboard — a calm, dependency-free markdown editor over store-notes.js.
// Live preview, autosave, a formatting toolbar and keyboard shortcuts. Designed with
// clean seams for the agent layer to come (autocomplete / suggestions / topic
// extraction / snippet capture) — those hook the same textarea + save path.
//
// FAST LOAD: the list renders from the note INDEX alone (one decrypt) — each index
// entry carries a title + snippet. A full note body is decrypted only when opened.

import {
  getNoteIndex, getNote, createNote, saveNote, deleteNote, noteToMarkdown, saveNoteTopics,
  NoteLimitError,
} from './js/store-notes.js';
import { renderMarkdown } from './js/markdown.js';
import {
  relTime, escapeHtml, highlight, escapeMdText, tagify, snippetOf,
  KIND_ICON, sourceKind, researchSnippet,
  JOB_ICON, compactInput, prettyTools, toolTitle, stepIcon,
  parseAgentMention, salientTerms, topicTerms, researchRelevance,
  parseSkillMention, mergeSkillPrompt, findSkillByName,
} from './js/notes-util.js';
import {
  SWARM_ROLES, SWARM_ROLE_META, swarmOverrides, swarmCandidates, roleAgent, getRouter,
} from './js/notes-swarm-router.js';
import {
  beginRegion, appendRegion, finishRegion, activeRegions, agentReplace,
} from './js/notes-regions.js';
import { icon, iconForEmoji, hydrate } from './js/icons.js';
import {
  HUMAN, blankAttribution, mergeRuns, applyAttribution, attributionSummary, normalizeAttribution,
} from './js/notes-provenance.js';

const $ = (id) => document.getElementById(id);

let list = [];          // index entries: {id,title,snippet,tags,createdAt,updatedAt,chars}
let current = null;     // the full record of the OPEN note (decrypted on demand)
let dirty = false;
let saveTimer = null;

// Pro entitlement + note cap, read ONCE at load from local storage (getLicense() is a
// local storage read + offline JWK verify — it NEVER calls the license server). Cached
// here so the header cap and the New-note gate are decided in-memory, not re-read per
// action; refreshLicense() re-reads only when the entitlement actually changes (storage
// listener). Fail-open (Pro=true) until the async read lands so we never flash a lock or
// wrongly block a paying user; createNote() is the authoritative backstop regardless.
let isProUser = true;
let noteCap = 10;       // FREE_LIMITS.notes, cached from license.js
// Lifetime notes EVER created (Free cap counts these, not the current list — deleting a
// note does NOT free a slot, matching createNote()'s authoritative check). Cached; the
// header shows current(deleted)/cap and the New-note gate uses this, so UI + enforcement
// agree (they diverged before: the header used list.length, so after deletes it showed
// free slots while createNote() silently threw — the "nothing happens" confusion).
let noteCreatedCount = 0;

// ── utilities ─────────────────────────────────────────────────────────────────
// Pure helpers (relTime/escapeHtml/highlight/snippetOf/…) live in js/notes-util.js.
let toastTimer = null;
function toast(msg) {
  const el = $('n-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}
// Toast with an inline action button (mirrors the side panel's toastAction).
function toastAction(text, label, fn, ms = 5000) {
  const el = $('n-toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = `${text}  `;
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = label;
  btn.onclick = (e) => { e.stopPropagation(); el.classList.add('hidden'); fn(); };
  el.append(span, btn);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add('hidden'); el.textContent = ''; }, ms);
}

// Free-tier note cap reached. We DON'T sell from here — upgrading and restoring Pro
// both live on the Account page. Just inform, with a shortcut to open it; the storage
// listener unlocks notes the moment an entitlement lands there.
function noteCapReached(limit) {
  toastAction(
    `You've reached the Free limit of ${limit} notes.`,
    'Account',
    () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#license') }),
    5000,
  );
}

// Read the entitlement + cap ONCE (or when it changes) and repaint the header. No server
// call — getLicense() is local storage + offline verify. Cheap enough to also run on a
// license storage change so an in-session upgrade unlocks notes immediately.
async function refreshLicense() {
  try {
    const { getLicense, isPro, FREE_LIMITS } = await import('./js/license.js');
    noteCap = FREE_LIMITS.notes;
    isProUser = isPro(await getLicense());
  } catch { /* fail-open: leave Pro=true; the store backstop still enforces */ }
  await refreshNoteUsage();
}

// Refresh the cached lifetime notes-created count from the usage counter (seeded from
// the current index the first time). Cheap storage read — call on load and after a
// create; the header then repaints from cache on every list change.
async function refreshNoteUsage() {
  try {
    const { usageCount } = await import('./js/usage-counters.js');
    // Seed from the ACTUAL index length (not a maybe-empty `list` mid-load) so an
    // existing user's notes count as already-created — and it matches the identical
    // seed store-notes.noteLimitReached() uses. usageCount ignores the seed once set.
    const seed = list.length || (await getNoteIndex()).length;
    noteCreatedCount = await usageCount('notesCreated', seed);
  } catch { noteCreatedCount = Math.max(noteCreatedCount, list.length); }
  renderNoteCap();
}

// Header note count / cap. Pro (or empty) → plain "· N"; Free → "· N/10", coloured when
// at the cap so the limit is visible BEFORE the user hits it. Decided from cached state,
// so it repaints instantly on every list change with zero storage/network cost.
function renderNoteCap() {
  const el = $('n-count');
  if (!el) return;
  const current = list.length;
  const created = Math.max(noteCreatedCount, current); // lifetime is always ≥ current
  if (!current && !created) { el.textContent = ''; el.classList.remove('capped'); el.removeAttribute('title'); return; }
  if (isProUser) { el.textContent = `· ${current}`; el.classList.remove('capped'); el.removeAttribute('title'); return; }
  const deleted = Math.max(0, created - current);
  const atCap = created >= noteCap; // the cap is on notes EVER created, not the current list
  // e.g. "· 8(2)/10" — 8 current, 2 deleted, of the 10 lifetime Free cap.
  el.textContent = deleted > 0 ? `· ${current}(${deleted})/${noteCap}` : `· ${current}/${noteCap}`;
  el.classList.toggle('capped', atCap);
  el.title = atCap
    ? `You've created ${created} of ${noteCap} free notes${deleted ? ` (${deleted} deleted — deleting doesn't free a slot)` : ''}. Upgrade to Pro for unlimited.`
    : `${noteCap - created} of ${noteCap} free notes left${deleted ? ` (${deleted} deleted count toward the cap)` : ''}`;
}

// Pre-flight the note cap before creating, from cached state (no storage read on this hot
// path). Uses the LIFETIME created count — so it matches createNote()'s authoritative
// check even after deletes. Returns true (and shows the upsell) when a Free user is at the
// limit, so callers bail: `if (noteCapBlocked()) return;`.
function noteCapBlocked() {
  if (isProUser || noteCreatedCount < noteCap) return false;
  noteCapReached(noteCap);
  return true;
}

// ── list (index-only — no body decrypts) ────────────────────────────────────────
async function reloadIndex() {
  list = await getNoteIndex(); // already newest-first
  invalidateNotesIndex();      // list changed → the BM25 index is stale
}
function updateEntry(rec) {
  // Fold a just-saved record into the in-memory index and move it to the front.
  // Preserve auto-topics: prefer the record's own index, else keep the prior entry's
  // (a body-only save shouldn't blank topics the background extractor already attached).
  const prev = list.find((e) => e.id === rec.id);
  const body = rec.body || '';
  const entry = {
    id: rec.id, title: rec.title, snippet: snippetOf(rec.body),
    tags: rec.tags || [], links: extractBodyLinks(body),
    topics: Array.isArray(rec.topics?.items) ? rec.topics.items : (prev?.topics || []),
    words: body.trim() ? body.trim().split(/\s+/).length : 0,
    createdAt: rec.createdAt, updatedAt: rec.updatedAt, chars: body.length,
  };
  list = [entry, ...list.filter((e) => e.id !== rec.id)];
  invalidateNotesIndex();
}
// The [[Title]] targets a note references — mirrors store-notes.js extractLinks so the
// in-memory index entry carries outgoing links right after a save (before reload).
function extractBodyLinks(body) {
  const out = [];
  const re = /\[\[([^[\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(String(body || '')))) { const t = m[1].trim(); if (t && !out.includes(t)) out.push(t); }
  return out;
}

function renderList(query = '') {
  const raw = query.trim();
  const q = raw.toLowerCase();
  const items = $('n-items');
  let filtered;
  if (!q) {
    filtered = list;
  } else if (nSearchMode === 'best' && nBm25 && _nIdxMod) {
    // Ranked relevance (BM25 over title + tags + preview). Fall back to a forgiving
    // substring pass when the ranker finds nothing (short/rare queries).
    const byId = new Map(list.map((n) => [n.id, n]));
    filtered = _nIdxMod.bm25Search(nBm25, raw).map((r) => byId.get(r.id)).filter(Boolean);
    if (!filtered.length) filtered = list.filter((n) => noteSearchText(n).toLowerCase().includes(q));
  } else {
    filtered = list.filter((n) => noteSearchText(n).toLowerCase().includes(q));
  }
  renderNoteCap();
  $('n-empty-list').classList.toggle('hidden', list.length > 0);
  items.innerHTML = '';
  for (const n of filtered) {
    const el = document.createElement('div');
    const running = noteHasJob(n.id) || planners.has(n.id);
    el.className = 'nitem' + (current && n.id === current.id ? ' active' : '') + (running ? ' running' : '');
    const tags = (n.tags || []).slice(0, 3).map((t) => `<span class="nitem-tag">#${escapeHtml(t)}</span>`).join(' ');
    const runBadge = running ? '<span class="nitem-run" title="An agent is working on this note…" aria-label="Agent working"><span class="nitem-spin"></span></span> ' : '';
    el.innerHTML =
      `<div class="nitem-title">${runBadge}${highlight(n.title || 'Untitled note', q)}</div>` +
      `<div class="nitem-snippet">${highlight(n.snippet || 'Empty note', q)}</div>` +
      `<div class="nitem-meta"><span>${relTime(n.updatedAt)}</span>${tags}</div>`;
    el.onclick = () => openNote(n.id);
    items.appendChild(el);
  }
}

// ── notes list search: Best match (BM25) / Exact text ────────────────────────
// Parity with the Chats/Meetings list search. The BM25 index (meeting-index) is
// lazy-built on the FIRST Best-match query and rebuilt when the list changes — so
// notes first-paint pays nothing (the list renders substring-only until then).
let nSearchMode = 'best';
let _nIdxMod = null;   // lazily-imported meeting-index (BM25 + graph helpers)
let nBm25 = null;      // built on demand; null = stale/needs rebuild
const noteSearchText = (n) => `${n.title || ''}\n${(n.tags || []).join(' ')}\n${n.snippet || ''}`;
function invalidateNotesIndex() { nBm25 = null; }
async function ensureNotesIndexMod() {
  if (!_nIdxMod) _nIdxMod = await import('./js/meeting-index.js');
  return _nIdxMod;
}
async function ensureNotesIndex() {
  if (nBm25) return nBm25;
  const mod = await ensureNotesIndexMod();
  nBm25 = mod.buildIndex(list.map((n) => ({ id: n.id, text: noteSearchText(n) })));
  return nBm25;
}
function onNotesSearch(v) {
  renderList(v);
  // Best mode needs the ranker; build it once, then repaint with ranked order.
  if (nSearchMode === 'best' && v.trim() && !nBm25) {
    ensureNotesIndex().then(() => renderList($('n-search').value)).catch(() => { /* substring stays */ });
  }
}
function setSearchMode(m) {
  nSearchMode = m === 'exact' ? 'exact' : 'best';
  for (const b of $('n-modes').children) b.classList.toggle('active', b.dataset.mode === nSearchMode);
  onNotesSearch($('n-search').value);
}

// ── omni (cross-source) search — lazy-loaded on first open ───────────────────
function openOmni(query = '') {
  import('./js/omni-search.js').then((m) => m.openOmni({
    query,
    currentType: 'note',
    onOpen: (r) => {
      if (r.type === 'note') { openNote(r.sourceId.replace(/^note:/, '')); return; }
      location.assign(r.url); // cross-page hit → navigate to that dashboard + item
    },
  })).catch(() => { /* module load failed — no-op */ });
}

// ── Notes dashboard: a tabbed corpus overview (Graph default + Related) ───────
// Extensible shell — more tabs (Topics, Recent, Action items, Calendar) plug in
// here later. Everything heavy (graph-view, BM25 graph model) is lazy-imported.
let nDashOn = false;
let nDashTab = 'graph';
let _graphMod = null;
const DASH_TABS = ['stats', 'graph', 'related'];
async function openDash() {
  nDashOn = true;
  $('n-graph-toggle').classList.add('active');
  $('n-dash').classList.remove('hidden');
  $('n-blank').classList.add('hidden');
  $('n-editor').classList.add('hidden');
  setDashTab(nDashTab); // sync tab buttons + pane visibility, then render
}
function closeDash() {
  nDashOn = false;
  $('n-graph-toggle').classList.remove('active');
  $('n-dash').classList.add('hidden');
  $('n-blank').classList.toggle('hidden', !!current);
  $('n-editor').classList.toggle('hidden', !current);
}
async function toggleDash() { if (nDashOn) closeDash(); else await openDash(); }
function setDashTab(tab) {
  nDashTab = DASH_TABS.includes(tab) ? tab : 'stats';
  for (const b of $('n-dash').querySelectorAll('.dash-tabs button')) b.classList.toggle('active', b.dataset.dash === nDashTab);
  $('n-dash-stats').classList.toggle('hidden', nDashTab !== 'stats');
  $('n-dash-graph').classList.toggle('hidden', nDashTab !== 'graph');
  $('n-dash-related').classList.toggle('hidden', nDashTab !== 'related');
  renderDash();
}
// Build a cross-note relationship model from the lightweight index (title+tags+
// preview) — no body decrypts, so the dashboard stays cheap.
async function notesGraphModel() {
  const mod = await ensureNotesIndexMod();
  // Edge signal = auto-extracted topics + user tags + salient title terms (was title/tags
  // tokens only). Real topics make the graph reflect what notes are ABOUT, not just shared
  // words. Falls back to title terms for notes not yet topic-extracted.
  const model = list.map((n) => ({
    id: n.id,
    title: n.title || 'Untitled note',
    people: [],
    terms: [...new Set([...(n.topics || []), ...(n.tags || []), ...mod.topTerms(n.title || '', 4)])].slice(0, 12),
  }));
  const g = mod.buildGraph(model);
  const seen = new Set();
  const links = [];
  const degree = new Map();
  const addEdge = (a, b, weight) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ s: a, t: b, weight });
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
  };
  // Explicit [[wikilinks]] are the strongest signal (deliberate connections) — add them
  // first so they always survive; then term/tag/topic overlap fills in the rest.
  const byTitle = new Map(list.map((n) => [(n.title || '').toLowerCase(), n.id]));
  for (const n of list) {
    for (const name of n.links || []) {
      const target = byTitle.get((name || '').toLowerCase());
      if (target) addEdge(n.id, target, 6);
    }
  }
  for (const m of model) {
    for (const rel of g.relatedMeetings(m.id, { limit: 4 })) addEdge(m.id, rel.id, rel.weight);
  }
  return { model, links, degree, g };
}
// Draw model for the GRAPH views: note nodes + TOPIC HUB nodes. A topic shared by ≥2 notes
// becomes its own node that those notes connect to — so the graph shows what notes are ABOUT
// (topic clusters), not just explicit [[wikilinks]]. Notes still link directly via wikilinks;
// topics add the connective tissue the plain note→note graph was missing. Built from the
// lightweight index (topics/tags/links), no body decrypts. Topic node ids are `topic:<lc>`.
function graphWithTopics() {
  const nodes = list.map((n) => ({ id: n.id, label: n.title || 'Untitled note', type: 'note' }));
  const links = [];
  const seen = new Set();
  const addEdge = (s, t) => {
    if (!s || !t || s === t) return;
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ s, t });
  };
  // Explicit [[wikilinks]] — deliberate note↔note connections.
  const byTitle = new Map(list.map((n) => [(n.title || '').toLowerCase(), n.id]));
  for (const n of list) {
    for (const name of n.links || []) {
      const tgt = byTitle.get((name || '').toLowerCase());
      if (tgt) addEdge(n.id, tgt);
    }
  }
  // Topic hubs — group notes by shared auto-extracted topic; keep only topics touching ≥2 notes.
  const topicNotes = new Map(); // lc topic -> { label, ids[] }
  for (const n of list) {
    for (const raw of n.topics || []) {
      const label = String(raw).trim();
      if (!label) continue;
      const key = label.toLowerCase();
      const e = topicNotes.get(key) || { label, ids: [] };
      e.ids.push(n.id);
      topicNotes.set(key, e);
    }
  }
  for (const [key, { label, ids }] of topicNotes) {
    if (ids.length < 2) continue; // a topic on a single note connects nothing — skip the clutter
    const tid = `topic:${key}`;
    nodes.push({ id: tid, label, type: 'topic' });
    for (const nid of ids) addEdge(nid, tid);
  }
  return { nodes, links };
}
// The ego neighbourhood of `noteId` within a { nodes, links } graph: BFS out `hops` levels,
// keeping links whose endpoints are both in-set. Focus node flagged. Topic hubs count as a
// hop, so hops=2 surfaces sibling notes reached THROUGH a shared topic.
function egoSubgraph(full, noteId, hops = 2) {
  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  const adj = new Map();
  for (const l of full.links) {
    if (!adj.has(l.s)) adj.set(l.s, new Set());
    if (!adj.has(l.t)) adj.set(l.t, new Set());
    adj.get(l.s).add(l.t); adj.get(l.t).add(l.s);
  }
  const inSet = new Set([noteId]);
  let frontier = new Set([noteId]);
  for (let h = 0; h < hops; h++) {
    const next = new Set();
    for (const id of frontier) for (const nb of adj.get(id) || []) if (!inSet.has(nb)) { inSet.add(nb); next.add(nb); }
    frontier = next;
  }
  const nodes = [...inSet].map((id) => { const m = byId.get(id); return { id, label: m?.label || 'Untitled note', type: m?.type || 'note', focus: id === noteId }; });
  const links = full.links.filter((l) => inSet.has(l.s) && inSet.has(l.t));
  return { nodes, links };
}
async function renderDash() {
  if (nDashTab === 'stats') { renderNoteStats(); return; }
  if (!list.length) {
    $('n-dash-graph').innerHTML = '<div class="dash-empty">No notes yet — create one to see how they connect.</div>';
    $('n-dash-related').innerHTML = '<div class="dash-empty">No notes yet.</div>';
    return;
  }
  let built;
  try { built = await notesGraphModel(); } catch { $('n-dash-graph').innerHTML = '<div class="dash-empty">Graph unavailable.</div>'; return; }
  if (nDashTab === 'graph') {
    try {
      if (!_graphMod) _graphMod = await import('./js/graph-view.js');
      const { nodes, links } = graphWithTopics();
      const open = (nd) => (nd.type === 'topic' ? openOmni(nd.label) : openNote(nd.id));
      _graphMod.drawGraph($('n-dash-graph'), nodes, links, open, open);
    } catch { $('n-dash-graph').innerHTML = '<div class="dash-empty">Graph unavailable.</div>'; }
  } else {
    // Related tab: the most-connected notes (hubs) with their strongest links.
    const byId = new Map(list.map((n) => [n.id, n]));
    const hubs = [...built.degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const host = $('n-dash-related');
    if (!hubs.length) { host.innerHTML = '<div class="dash-empty">No connections found yet — add tags or write more to link notes.</div>'; return; }
    host.innerHTML = '';
    for (const [id, deg] of hubs) {
      const n = byId.get(id); if (!n) continue;
      const rel = built.g.relatedMeetings(id, { limit: 3 }).map((r) => byId.get(r.id)?.title).filter(Boolean);
      const card = document.createElement('div');
      card.className = 'related-card';
      card.innerHTML =
        `<div class="related-card-title">${escapeHtml(n.title || 'Untitled note')}</div>` +
        `<div class="related-card-meta">${deg} connection${deg === 1 ? '' : 's'}${rel.length ? ' · ' + rel.map((t) => escapeHtml(t)).join(', ') : ''}</div>`;
      card.onclick = () => openNote(id);
      host.appendChild(card);
    }
  }
}

// Corpus stats — computed entirely from the lightweight index (no body decrypts), so
// the Stats tab is instant. Mirrors the per-item metric cards Chats/Meetings show, but
// aggregated across all notes: counts, top topics, top tags, link connectivity.
function renderNoteStats() {
  const host = $('n-dash-stats');
  if (!list.length) { host.innerHTML = '<div class="dash-empty">No notes yet — create one to see your stats.</div>'; return; }
  const byTitle = new Map(list.map((e) => [(e.title || '').toLowerCase(), e]));
  const topicFreq = new Map();
  const tagFreq = new Map();
  let words = 0, tagged = 0, withTopics = 0;
  const inbound = new Map(); // note id → # of notes linking to it
  let linkedNotes = 0;       // notes with ≥1 resolvable outgoing OR inbound link
  for (const e of list) {
    words += e.words || Math.round((e.chars || 0) / 6);
    if ((e.tags || []).length) tagged += 1;
    if ((e.topics || []).length) withTopics += 1;
    for (const t of e.topics || []) topicFreq.set(t, (topicFreq.get(t) || 0) + 1);
    for (const t of e.tags || []) tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
    for (const name of e.links || []) {
      const hit = byTitle.get((name || '').toLowerCase());
      if (hit && hit.id !== e.id) inbound.set(hit.id, (inbound.get(hit.id) || 0) + 1);
    }
  }
  for (const e of list) {
    const outResolves = (e.links || []).some((name) => { const h = byTitle.get((name || '').toLowerCase()); return h && h.id !== e.id; });
    if (outResolves || inbound.get(e.id)) linkedNotes += 1;
  }
  const topTopics = [...topicFreq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  const orphans = list.length - linkedNotes;
  const card = (n, l) => `<div class="metric"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const cards =
    card(list.length, 'Notes') +
    card(words.toLocaleString(), 'Words') +
    card(topicFreq.size, 'Topics') +
    card(tagFreq.size, 'Tags') +
    card(linkedNotes, 'Linked notes') +
    card(orphans, 'Unlinked') +
    card(tagged, 'Tagged') +
    card(withTopics, 'With topics');
  host.innerHTML =
    `<div class="metrics">${cards}</div>` +
    `<div class="stat-cols">` +
    `<div class="stat-col"><div class="stat-col-head">Top topics</div><div id="n-stat-topics" class="chip-cloud"></div></div>` +
    `<div class="stat-col"><div class="stat-col-head">Top tags</div><div id="n-stat-tags" class="chip-cloud"></div></div>` +
    `</div>`;
  const cloud = (elId, entries, empty) => {
    const el = $(elId);
    if (!entries.length) { el.innerHTML = `<span class="stat-empty">${empty}</span>`; return; }
    for (const [term, count] of entries) {
      const b = document.createElement('button');
      b.className = 'topic-chip';
      b.innerHTML = `${escapeHtml(term)} <span class="chip-count">${count}</span>`;
      b.title = `Find "${term}" across notes, chats & meetings`;
      b.onclick = () => openOmni(term);
      el.appendChild(b);
    }
  };
  cloud('n-stat-topics', topTopics, 'Topics appear as you open and edit notes.');
  cloud('n-stat-tags', topTags, 'No tags yet — add tags to group notes.');
}

// ── Related notes/chats/meetings for the OPEN note (Research side pane) ───────
let _relatedFor = null;
async function refreshRelated(noteId, { force = false } = {}) {
  if (!noteId || (!force && _relatedFor === noteId)) return; // already showing this note's related
  _relatedFor = noteId;
  const host = $('n-related-list');
  if (!host) return;
  try {
    if (!_ragMod) _ragMod = await import('./js/history-rag.js');
    const sources = await _ragMod.loadHistorySources({ includeChats: true, includeMeetings: true, includeNotes: true });
    if (_relatedFor !== noteId) return; // a newer note superseded this
    const related = _ragMod.relatedHistorySources(sources, `note:${noteId}`, { limit: 8 }).filter((r) => srcAllowed(r.type));
    setSideBadge('related', related.length);
    host.innerHTML = '';
    if (!related.length) { host.innerHTML = '<div class="research-empty">Nothing related yet — add [[links]], tags or keep writing.</div>'; return; }
    for (const r of related.slice(0, 6)) {
      const kind = r.type === 'meeting' ? 'meetings' : r.type === 'chat' ? 'chat' : 'notes';
      const card = document.createElement('div');
      card.className = 'related-card';
      card.innerHTML =
        `<div class="related-card-title">${icon(kind)} ${escapeHtml(r.title || 'Untitled')}</div>` +
        `<div class="related-card-meta">${escapeHtml(r.reason || '')}</div>`;
      card.onclick = () => {
        if (r.type === 'note') openNote(r.sourceId.replace(/^note:/, ''));
        else if (r.url) location.assign(r.url);
      };
      host.appendChild(card);
    }
  } catch { /* related is best-effort */ }
}

// ── editor ───────────────────────────────────────────────────────────────────
function setMode(mode, persist = true, { focus = true } = {}) {
  const panes = $('n-panes');
  // Leaving Live → pull CM's content back into the textarea (the model) so the classic
  // panes show the latest (onCmChange already mirrors, so this is belt-and-suspenders).
  if (panes.classList.contains('live') && mode !== 'live' && cm && $('n-body').value !== cm.value) $('n-body').value = cm.value;
  panes.classList.remove('write', 'split', 'read', 'live');
  for (const b of $('n-mode').children) b.classList.toggle('active', b.dataset.mode === mode);
  if (persist) localStorage.setItem('chatpanel.notes.mode', mode); // don't clobber the saved default for a transient switch
  if (mode === 'live') {
    panes.classList.add('live');
    ensureCm()
      .then(() => { cmActive = true; _cmRO = null; mirrorToCm(); if (focus) cm.focus(); }) // skip focus when the caller wants the title focused (e.g. a fresh note)
      .catch(() => { toast('Live editor unavailable — using Write'); setMode('write', persist); });
    return;
  }
  cmActive = false;
  panes.classList.add(mode);
  if (mode !== 'write') updatePreview();
  if (mode !== 'read') autoGrow();
}
// Paragraph alignment for the reading view — left / justify / center / right, live &
// persisted, driven by a CSS var on the preview so you can compare what reads best.
const ALIGN_KEY = 'chatpanel.notes.align';
const ALIGNS = ['left', 'justify', 'center', 'right'];
function setAlign(a) {
  const align = ALIGNS.includes(a) ? a : 'justify';
  $('n-preview').style.setProperty('--para-align', align);
  localStorage.setItem(ALIGN_KEY, align);
  const menu = $('n-align-menu');
  if (menu) for (const b of menu.querySelectorAll('button[data-align]')) b.classList.toggle('active', b.dataset.align === align);
}
function updatePreview() {
  const md = $('n-body').value;
  $('n-preview').innerHTML = renderMarkdown(md);
  mirrorToCm(md); // when Live mode is active, keep the CM6 surface in sync with the model
}

// ── Live editor (CodeMirror 6) — Phase 1b ────────────────────────────────────────
// Opt-in "Live" mode swaps the textarea for a CM6 live-preview surface (markdown renders as
// you type). The textarea stays the MODEL and the provenance/autosave path: human edits in
// CM mirror INTO it (attributed to You), and programmatic body changes (note open, AI
// streaming, undo/restore) mirror OUT to CM through updatePreview(). CM6 is lazy-loaded on
// first switch — off the notes first-paint path. Full swarm gestures (@mention, autocomplete,
// ⌘↵ draft) reconnect to CM in Phase 3; today they run in the classic Write view.
let cm = null;          // the live-editor facade (js/editor-cm.js createLiveEditor)
let cmActive = false;   // is Live mode the visible surface right now?
let _cmMod = null;
let _cmSyncing = false; // guard: we're pushing model → CM (ignore the echoed change)
let _cmRO = null;       // last read-only state pushed to CM (avoid churny reconfigures)
async function ensureCm() {
  if (cm) return cm;
  if (!_cmMod) _cmMod = await import('./js/editor-cm.js');
  cm = _cmMod.createLiveEditor({
    parent: $('n-cm'),
    doc: $('n-body').value,
    placeholder: 'Start writing… formatting renders as you type.',
    onChange: onCmChange,
    onSelection: onCmSelection,
    onKey: onCmKey,
    onLink: openEditorLink, // click a rendered [text](url) / [[wikilink]] in Live mode → open it
    onPaste: onEditorPaste, // paste a bare URL → upgrade it to [Title](url) (Live mode)
  });
  return cm;
}
// ── Editor-agnostic accessors ────────────────────────────────────────────────────
// The gesture/autocomplete logic reads the body + cursor through these so it works whether
// the active surface is the textarea (classic) or CM (Live). Writes go through the active
// surface too; in Live, the CM change re-enters onCmChange to run the input pipeline.
const bodyText = () => (cmActive && cm ? cm.value : $('n-body').value);
function bodySel() {
  if (cmActive && cm) { const s = cm.getSelection(); return { start: s.start, end: s.end, head: s.head }; }
  const ta = $('n-body'); return { start: ta.selectionStart, end: ta.selectionEnd, head: ta.selectionStart };
}
const bodyCursor = () => bodySel().head;
const bodyHasSelection = () => { const s = bodySel(); return s.start !== s.end; };
function bodyReplaceRange(text, from, to, cursor = from + text.length) {
  if (cmActive && cm) { cm.replaceRange(text, from, to); cm.setSelection(cursor); } // onCmChange runs the pipeline
  else { const ta = $('n-body'); ta.setRangeText(text, from, to, 'end'); ta.setSelectionRange(cursor, cursor); onBodyInput(); }
}
const bodyFocus = () => (cmActive && cm ? cm.focus() : $('n-body').focus());
// After opening a Live agent region at `regionStart`, drop the caret on a fresh line just
// BELOW the region so the user can keep writing — or @mention another agent — while this
// one streams. The answer fills the region above; because the region's `to` uses assoc -1
// (see notes-regions.js), a newline inserted at the boundary lands OUTSIDE the region and
// agent appends push it (and the caret) down, so it never fights the stream. No-op outside
// Live mode (Source jobs are one-at-a-time and lock the editor).
function parkCaretBelowRegion(regionStart) {
  if (!cmActive || !cm) return;
  cm.replaceRange('\n', regionStart, regionStart); // at region.to → not swallowed, not blocked
  cm.setSelection(regionStart + 1);
  bodyFocus();
}
// A human edit in CM → mirror to the textarea (the model) and run the input pipeline (minus
// the inline ghost-prediction, which is deferred in Live). The (editor-agnostic) autocomplete
// + swarm schedulers read the cursor from CM.
function onCmChange(v, info = {}) {
  if (info.programmatic || _cmSyncing) return; // our own model→CM push, not a user edit
  const ta = $('n-body');
  if (ta.value === v) return;
  const prev = ta.value;
  ta.value = v;
  if (info.agentAuthor) {
    // A streamed AGENT write into its region — attribute the changed span to the agent (not
    // You), keep the ledger + baseline in sync, persist, but DON'T run the user input pipeline
    // (no autocomplete / co-writer / undo checkpoint on agent-authored text).
    if (current) current.attribution = applyAttribution(current.attribution, prev, v, info.agentAuthor, Date.now());
    histPrev = { value: v, start: Math.min(histPrev.start, v.length), end: Math.min(histPrev.end, v.length) };
    updateWordCount();
    renderHistorySummary();
    scheduleSave();
    return;
  }
  recordEdit();                                 // checkpoint + attribution (to You)
  if (ghost) { ghost = null; hideGhostHint(); }
  renderHistorySummary();
  updateWordCount();
  scheduleSave();
  scheduleSuggest();
  scheduleNoteTopics();
  maybeAutocomplete();                           // @/[[/# dropdown, positioned via CM coords
  scheduleCowriter();
  scheduleResearch();
  scheduleLinkify();
}
function onCmSelection() { maybeAutocomplete(); } // moving the caret updates/closes the dropdown
// Route CM key events to the same gestures the textarea has. Return true = handled (CM won't
// also act). Normal typing falls through (return false) to CM.
function onCmKey(e) {
  if (ac.open) {
    if (e.key === 'ArrowDown') { moveAc(1); return true; }
    if (e.key === 'ArrowUp') { moveAc(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { acceptAc(); return true; }
    if (e.key === 'Escape') { closeAc(); return true; }
  }
  // Writer draft streaming: swallow keys (Esc aborts); a directed Enter still submits.
  if (writerAbort) {
    if (e.key === 'Enter' && !e.shiftKey && (currentMention() || currentCommandLine())) { writerAbort.abort(); clearGhost({ remove: true }); }
    else { if (e.key === 'Escape') { writerAbort.abort(); clearGhost({ remove: true }); } return true; }
  }
  // Pending draft-ahead ghost: Tab accepts, Esc rejects, a bare typing/navigation key drops it.
  // A ⌘/Ctrl SHORTCUT (⌘A select-all, ⌘C copy, ⌘S save…) must NOT drop it — otherwise ⌘A to
  // copy the draft silently deletes it (and a ghost is never versioned, so it's gone for good).
  // A real ⌘V paste still drops it via the input path (onCmChange), not here.
  if (ghost) {
    if (e.key === 'Tab') { acceptGhost(); return true; }
    // A deliberate ⌘↵ Writer draft-ahead also accepts on plain Enter (an as-you-type
    // Autocomplete prediction keeps Enter = newline, so it falls through and drops).
    if (e.key === 'Enter' && !e.shiftKey && ghostAuthor.startsWith('Writer')) { acceptGhost(); return true; }
    if (e.key === 'Escape') { clearGhost({ remove: true }); return true; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) { acceptGhost({ keepSelection: true }); return false; } // ⌘C → commit so the copy keeps it (native copy still runs)
    if (!(e.metaKey || e.ctrlKey) && !['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) clearGhost({ remove: true });
  }
  const openJob = current && noteHasJob(current.id);
  // Only a Source/global-lock job blocks starting another (editor is read-only then).
  // Live-mode region jobs are non-blocking and run concurrently — so a second @agent can
  // be invoked while the first still streams (each owns its own region). Gating invoke on
  // `openJob` here was the bug: it swallowed the 2nd Enter until the 1st job finished.
  const blockingJob = current && noteHasBlockingJob(current.id);
  if (e.key === 'Escape' && openJob) { lastJobForNote(current.id)?.abort.abort(); return true; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { draftAhead(); return true; } // draftAhead → runAgentTask on a mention line
  if (e.key === 'Enter' && !e.shiftKey && !blockingJob) {
    const line = currentLine();
    const rm = line.text.match(/^@research\s+(.{2,})$/i);
    if (rm) { bodyReplaceRange('', line.start, line.end, line.start); runResearch({ question: rm[1].trim(), web: true }); return true; }
    const pm = line.text.match(/^\/plan\s+(.{2,})$/i);
    if (pm) { bodyReplaceRange('', line.start, line.end, line.start); planInNewNote(pm[1].trim()); return true; }
    const mention = currentMention();
    if (mention) { runAgentTask(mention); return true; }
    if (currentCommandLine()) { runNoteCommand(); return true; }
  }
  return false;
}
// Push the model (textarea value + readonly) into CM when Live mode is active — for
// programmatic changes: note open, AI streaming paints, undo/restore.
function mirrorToCm(md = $('n-body').value) {
  if (!cmActive || !cm) return;
  _cmSyncing = true;
  try {
    if (cm.value !== md) cm.setValue(md, { programmatic: true });
    const ro = !!$('n-body').readOnly;
    if (_cmRO !== ro) { cm.setReadOnly(ro); _cmRO = ro; }
  } catch { /* never let a mirror error break editing */ }
  finally { _cmSyncing = false; }
}

// ── Assistant sidebar — Team activity / Research / Co-writer / History as tabs ───────
// The panels used to stack at the bottom and eat the document's vertical space; now they
// live in a collapsible right sidebar, one visible tab at a time, with count badges.
const SIDE_TABS = ['activity', 'research', 'related', 'topics', 'graph', 'cowriter', 'history'];
const SIDE_PANE = { activity: 'n-activity', research: 'n-research', related: 'n-related', topics: 'n-topics-pane', graph: 'n-graph-pane', cowriter: 'n-cowriter', history: 'n-history' };
let activeSide = 'activity';
let sideCollapsed = false;
let railCollapsed = false;

function setSideTab(t, { open = true } = {}) {
  if (!SIDE_TABS.includes(t)) t = 'activity';
  activeSide = t;
  localStorage.setItem('chatpanel.notes.sideTab', t);
  if (open) setSideCollapsed(false);
  for (const k of SIDE_TABS) { const el = $(SIDE_PANE[k]); if (el) el.classList.toggle('tab-active', k === t); }
  document.querySelectorAll('#n-side .side-tab').forEach((b) => b.classList.toggle('active', b.dataset.side === t));
  renderSide(t);
}
// Repaint a side pane's contents (panes skip work unless they're the active tab).
function renderSide(t = activeSide) {
  if (t === 'history') renderHistory();
  else if (t === 'activity') renderActivity();
  else if (t === 'research') renderResearch();
  else if (t === 'related') refreshRelated(current?.id, { force: true });
  else if (t === 'topics') renderNoteTopicsPane();
  else if (t === 'graph') renderNoteGraph();
  else if (t === 'cowriter') renderCowriter();   // repaint (also clears the .hidden park) so chips are live
  else refreshSideTabs();
}
function setSideCollapsed(c) {
  sideCollapsed = !!c;
  localStorage.setItem('chatpanel.notes.sideCollapsed', sideCollapsed ? '1' : '0');
  $('n-side')?.classList.toggle('collapsed', sideCollapsed);
  const t = $('n-side-toggle');
  if (t) {
    t.classList.toggle('on', !sideCollapsed);
    t.innerHTML = icon(sideCollapsed ? 'expand-side' : 'collapse-side'); // mirror the list toggle
    t.title = sideCollapsed ? 'Show assistant panel (⌘/)' : 'Hide assistant panel (⌘/)';
  }
  updateBothBtn();
}
// List rail (left) collapse — mirror of the panel toggle. Persisted.
function applyRailCollapsed(c) {
  railCollapsed = !!c;
  localStorage.setItem('chatpanel.notes.railCollapsed', railCollapsed ? '1' : '0');
  $('n-layout')?.classList.toggle('rail-collapsed', railCollapsed);
  const b = $('n-collapse');
  if (b) {
    b.classList.toggle('on', !railCollapsed); // lit when the list is open — mirror the panel toggle
    b.innerHTML = icon(railCollapsed ? 'expand-list' : 'collapse-list');
    b.title = railCollapsed ? 'Show list' : 'Hide list (⌘\\)';
  }
  updateBothBtn();
}
// The one-shot "focus mode" button reflects whether BOTH rails are hidden.
function updateBothBtn() {
  const b = $('n-collapse-both');
  if (!b) return;
  const both = railCollapsed && sideCollapsed;
  b.classList.toggle('on', both);
  b.title = both ? 'Show list & panel (⌘.)' : 'Focus — hide list & panel (⌘.)';
}
function setBothCollapsed(c) { applyRailCollapsed(c); setSideCollapsed(c); }
function setSideBadge(t, n) {
  const el = $(`n-side-badge-${t}`);
  if (!el) return;
  el.textContent = n ? String(n > 99 ? '99+' : n) : '';
  el.classList.toggle('hidden', !n);
}
function refreshSideTabs() {
  setSideBadge('research', researchCards.length);
  setSideBadge('activity', board.log.length);
  setSideBadge('cowriter', cwSuggestions.length + boardSuggestions.length);
}

// Drag-to-resize the list rail and the assistant sidebar (persisted).
function initResizers() {
  const layout = $('n-layout');
  const side = $('n-side');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rw = parseInt(localStorage.getItem('chatpanel.notes.railW') || '', 10);
  if (rw) layout.style.setProperty('--rail-w', `${rw}px`);
  const sw = parseInt(localStorage.getItem('chatpanel.notes.sideW') || '', 10);
  if (sw) side.style.setProperty('--side-w', `${sw}px`);
  const startDrag = (e, onMove) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => onMove(ev);
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  $('n-rail-resizer').addEventListener('mousedown', (e) => startDrag(e, (ev) => {
    const w = clamp(Math.round(ev.clientX - layout.getBoundingClientRect().left), 200, 560);
    layout.style.setProperty('--rail-w', `${w}px`);
    localStorage.setItem('chatpanel.notes.railW', String(w));
  }));
  $('n-side-resizer').addEventListener('mousedown', (e) => startDrag(e, (ev) => {
    const w = clamp(Math.round(side.getBoundingClientRect().right - ev.clientX), 240, 680);
    side.style.setProperty('--side-w', `${w}px`);
    localStorage.setItem('chatpanel.notes.sideW', String(w));
  }));
}
// Toggle the Nth GitHub task item (`- [ ]`↔`- [x]`) in the source when its rendered
// checkbox is clicked in read/split mode. Skips fenced code blocks so the index lines
// up with the renderer's (which never emits checkboxes inside a code fence).
function toggleTaskCheckbox(n) {
  if (!current || noteHasBlockingJob(current.id)) return; // block only under a Source/global-lock job
  const ta = $('n-body');
  const lines = ta.value.split('\n');
  let idx = -1;
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    if (/^```/.test(lines[li])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[li].match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/);
    if (!m) continue;
    if (++idx !== n) continue;
    lines[li] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + m[3];
    ta.value = lines.join('\n');
    current.body = ta.value;
    recordEdit({ discrete: true }); // a checkbox toggle is one undo step
    updatePreview();
    updateWordCount();
    scheduleSave(true);
    return;
  }
}
// Grow the textarea to fit its content so text always flows to the footer (never
// clips), and the page scrolls as a whole rather than nesting a tiny inner scroll.
function autoGrow() {
  const ta = $('n-body');
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}
function updateWordCount() {
  const words = ($('n-body').value.trim().match(/\S+/g) || []).length;
  $('n-words').textContent = words ? `${words} word${words === 1 ? '' : 's'}` : '';
}

// ── Streaming render helpers — smooth + scroll-anchored (shared by every AI write) ──
// AI output streams token-by-token. To avoid flicker, coalesce paints to ONE per animation
// frame; to avoid scroll-fighting, follow the stream's tail ONLY while the user is already
// at the bottom (scroll up to read and it stops chasing you). Same approach as the side
// panel chat. Reused by the delegated-agent job, the Writer, the planner and @commands.
let _streamRaf = 0;
let _followStream = true;
let _lastScrollTop = 0;
let _scrollWired = false;
function editorScroll() { return document.querySelector('.editor-scroll'); }
function wireStreamScroll() {
  const sc = editorScroll();
  if (_scrollWired || !sc) return;
  _scrollWired = true;
  sc.addEventListener('scroll', () => {
    if (sc.scrollTop < _lastScrollTop - 2) _followStream = false;                          // scrolled up → let them read
    else if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 24) _followStream = true;  // back at the bottom → follow again
    _lastScrollTop = sc.scrollTop;
  }, { passive: true });
}
function streamStart() { wireStreamScroll(); _followStream = true; const sc = editorScroll(); if (sc) _lastScrollTop = sc.scrollTop; }
function streamFollow() { const sc = editorScroll(); if (sc && _followStream) { sc.scrollTop = sc.scrollHeight; _lastScrollTop = sc.scrollTop; } }
function streamStop() { if (_streamRaf) { cancelAnimationFrame(_streamRaf); _streamRaf = 0; } }
// Run `paint` at most once per frame; `paint` reads the latest streamed state when it fires.
function scheduleStreamRender(paint) {
  if (_streamRaf) return;
  _streamRaf = requestAnimationFrame(() => { _streamRaf = 0; paint(); });
}

function renderTags(tags) {
  const row = $('n-tags');
  row.innerHTML = '';
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `#${escapeHtml(t)} <button title="Remove tag" data-tag="${escapeHtml(t)}">×</button>`;
    chip.querySelector('button').onclick = () => { current.tags = (current.tags || []).filter((x) => x !== t); renderTags(current.tags); scheduleSave(true); };
    row.appendChild(chip);
  }
  const add = document.createElement('button');
  add.className = 'tag-add';
  add.textContent = '+ tag';
  add.onclick = () => startTagInput(add);
  row.appendChild(add);
}
function startTagInput(addBtn) {
  const input = document.createElement('input');
  input.className = 'tag-input';
  input.placeholder = 'tag then ↵';
  addBtn.replaceWith(input);
  input.focus();
  const commit = () => {
    const val = input.value.trim().replace(/^#/, '').replace(/\s+/g, '-');
    if (val && current && !(current.tags || []).includes(val)) { current.tags = [...(current.tags || []), val]; scheduleSave(true); }
    renderTags(current?.tags || []);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') renderTags(current?.tags || []); };
  input.onblur = commit;
}

async function openNote(id, preloaded = null) {
  // Stop an in-flight inline @agent generation before switching — but a background PLANNER
  // keeps orchestrating (it persists to its own note's store), like the region jobs below.
  if (agentAbort && planners.size === 0) agentAbort.abort();
  if (writerAbort) writerAbort.abort();
  resolvePendingGhost(); // commit a finished Writer draft-ahead into the OLD note (drop ephemeral autocomplete) before flush
  // Jobs are NOT aborted on a note switch — they keep running. A REGION job (Live) streams into
  // the live CM, which can't follow the switch, so it DETACHES: it keeps streaming into a buffer
  // + persists to its note's store, and re-attaches when you come back. A textarea @command job
  // persists its partial output as before.
  const outJobs = current ? jobsForNote(current.id) : [];
  const outTextareaJob = outJobs.find((j) => !j.region);
  const outRegionJobs = outJobs.filter((j) => j.region && !j.done && !j.detached);
  if (outRegionJobs.length) {
    for (const j of outRegionJobs) detachRegionJob(j); // keep working in the background
    await flushSave();
  } else if (outTextareaJob) {
    dirty = false;            // the job owns this note's body — don't flush the transient progress block
    await persistJobBody(outTextareaJob); // snapshot the partial output so a switch/reload loses nothing
  } else {
    await flushSave();
  }
  // Any region still active in CM now is stray — a detached job already dropped its own; an
  // unregistered job's region (opened before its job existed) would otherwise float over / lock
  // the incoming note. Drop them all; the job streams into its detached buffer instead.
  if (cm) for (const r of activeRegions(cm.view.state)) finishRegion(cm.view, r.id);
  current = preloaded || await getNote(id);
  if (!current) return;
  if (nDashOn) closeDash(); // leave the dashboard when a note opens
  $('n-blank').classList.add('hidden');
  $('n-editor').classList.remove('hidden');
  $('n-title').value = current.title || '';
  $('n-body').value = current.body || '';
  histReset(current.body || ''); // undo history is per note — start fresh on switch
  _cmRO = null; mirrorToCm(current.body || ''); // load the note into the live editor if it's active
  // Provenance ledger: adopt the stored one, or seed existing content as authored by
  // You (tracking starts now). Keep it length-consistent with the body.
  const bodyLen = (current.body || '').length;
  current.attribution = normalizeAttribution(current.attribution, bodyLen, current.updatedAt || 0);
  current.versions = Array.isArray(current.versions) ? current.versions : [];
  previewedVersion = -1; $('n-history-preview')?.classList.add('hidden'); // clear stale version preview
  renderHistory();
  renderTags(current.tags || []);
  suggestTags();
  renderNoteTopics();
  renderNoteLinks(current);
  if (!current.topics?.items?.length) scheduleNoteTopics(); // first open of an un-topiced note → extract soon
  clearResearch(); // drop the previous note's research shelf (re-runs on the next typing pause)
  clearCowriterUI(); // drop the previous note's fixes/links (re-computed on the next pause)
  resetSwarmState(); // fresh note → the team starts idle
  lastQuestion = '';
  lastAutoDraft = '';
  lastGoalLen = -1;
  lastFactSentence = '';
  lastTitleChecked = '';
  board.log = [];
  loadIntent(); // this note's saved intent → guides the swarm + shows in the strip
  updatePreview();
  updateWordCount();
  autoGrow();
  $('n-when').textContent = current.updatedAt ? `Edited ${relTime(current.updatedAt)}` : '';
  setStatus('');
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  const inJobs = jobsForNote(current.id);
  const inTextareaJob = inJobs.find((j) => !j.region);
  if (inTextareaJob) attachEditorToJob(inTextareaJob); // re-attach a textarea job's live progress
  else $('n-body').readOnly = planners.has(current.id); // a background planner still owns this note's body
  if (planners.has(current.id)) setStatus('Planning…'); // reflect the background plan on return
  for (const j of inJobs) if (j.region && j.detached && !j.done) reattachRegionJob(j); // resume backgrounded agents live
  renderActivity(); // re-attach this note's persisted command-activity trace (or hide it)
  renderList($('n-search').value);
  refreshRelated(current.id); // related notes/chats/meetings for the Research pane (best-effort, cached)
  renderSide(); // repaint the active side pane (research/related/topics/graph) for the new note
}

function setStatus(text, saved = false) {
  const el = $('n-status');
  el.textContent = text;
  el.classList.toggle('saved', saved);
}

function scheduleSave(immediate = false) {
  dirty = true;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, immediate ? 0 : 600);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (ghost) resolvePendingGhost(); // commit a finished Writer draft-ahead; drop an ephemeral autocomplete
  if (!dirty || !current) return;
  dirty = false;
  current.title = $('n-title').value;
  current.body = $('n-body').value;
  const saved = await saveNote({ id: current.id, title: current.title, body: current.body, tags: current.tags, createdAt: current.createdAt, attribution: current.attribution, versions: current.versions, topics: current.topics });
  Object.assign(current, saved); // pick up derived title + updatedAt (saveNote returns the record incl. topics)
  updateEntry(current);
  renderNoteLinks(current); // outgoing [[links]] may have changed as the body was edited
  $('n-when').textContent = `Edited ${relTime(current.updatedAt)}`;
  setStatus('Saved', true);
  renderList($('n-search').value);
}

// ── toolbar ─────────────────────────────────────────────────────────────────
function surround(before, after = before) {
  const { start: s, end: e } = bodySel();
  const sel = bodyText().slice(s, e) || '';
  bodyReplaceRange(before + sel + after, s, e, sel ? s + (before + sel + after).length : s + before.length);
  bodyFocus();
}
function linePrefix(prefix) {
  const s = bodyCursor();
  const lineStart = bodyText().lastIndexOf('\n', s - 1) + 1;
  bodyReplaceRange(prefix, lineStart, lineStart, s + prefix.length);
  bodyFocus();
}
function applyFmt(fmt) {
  switch (fmt) {
    case 'bold': return surround('**');
    case 'italic': return surround('_');
    case 'code': return surround('`');
    case 'h1': return linePrefix('# ');
    case 'ul': return linePrefix('- ');
    case 'task': return linePrefix('- [ ] ');
    case 'quote': return linePrefix('> ');
    case 'link': {
      const { start: s, end: e } = bodySel();
      const sel = bodyText().slice(s, e) || 'text';
      bodyReplaceRange(`[${sel}](url)`, s, e);
      return bodyFocus();
    }
    default: break;
  }
}

// ── Dictation — speech → text inserted live at the cursor ───────────────────────
// Same capability module as the side panel (js/dictation.js): interim results
// overwrite a tracked region; finals commit and advance it. Dynamic-imported at
// the click site so it never touches the notes page's first paint.
let dict = null;    // active dictation controller, else null
let dictPos = 0;    // where the live transcript region starts in the body
let dictLen = 0;    // length of the uncommitted (interim) text currently inserted

function setDictateRecording(on) {
  const btn = $('n-dictate');
  if (!btn) return;
  btn.classList.toggle('recording', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Stop dictation' : 'Dictate (voice → text)';
  btn.innerHTML = icon(on ? 'stop' : 'mic'); // stop square while recording
}

async function toggleDictate() {
  // Any click while a dictation exists is a STOP (never a restart); flip the
  // button to idle at once even if the SSE 'end' lags on a large model.
  if (dict) {
    if (dict.recording) {
      dict.stop();
      setDictateRecording(false);
      const d = dict;
      setTimeout(() => { if (dict === d) dict = null; }, 6000);
    }
    return;
  }
  if (trans?.recording) { toast('Stop meeting transcription first'); return; }
  const { createDictation, micPermissionState, resolveDictationProvider } = await import('./js/dictation.js');
  // Extension pages can't rely on SpeechRecognition to prompt for the mic —
  // route through the one-time grant page first (grant is per-origin).
  if (await micPermissionState() !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
    toast('Allow the microphone in the new tab, then tap the mic again');
    return;
  }
  // Engine auto-detect: local gateway whisper when running (private), else the
  // browser engine — labeled, since Google processes that audio.
  const settings = await (await import('./js/store.js')).getSettings();
  const gatewayUrl = settings?.gatewayUrl || settings?.ui?.warmSearch?.url || undefined;
  const engine = await resolveDictationProvider({ gatewayUrl });
  if (!engine.provider) { toast('Voice input isn’t supported in this browser'); return; }
  dictPos = bodyCursor();
  dictLen = 0;
  // Separate dictated text from what's already before the cursor.
  if (dictPos > 0 && !/\s$/.test(bodyText().slice(0, dictPos))) {
    bodyReplaceRange(' ', dictPos, dictPos);
    dictPos += 1;
  }
  const dictLang = settings?.ui?.dictation?.lang || undefined; // '' → auto-detect
  let lastPct = -25; // throttle model-download toasts
  dict = createDictation({
    provider: engine.provider,
    gatewayUrl,
    lang: dictLang,
    onStart: () => {
      setDictateRecording(true);
      $('n-dictate').title = `Stop dictation — ${engine.label}`;
      toast(engine.private ? '🎙 Dictating — local, on-device' : '🎙 Dictating — browser engine (audio processed by Google)');
      bodyFocus();
    },
    onStatus: ({ state: st, pct }) => {
      if (st === 'downloading' && typeof pct === 'number' && pct - lastPct >= 25) {
        lastPct = pct;
        toast(`Preparing local dictation — downloading speech model ${pct}%`);
      }
    },
    onInterim: (t) => {
      bodyReplaceRange(t, dictPos, dictPos + dictLen, dictPos + t.length);
      dictLen = t.length;
    },
    onFinal: (t) => {
      const text = t.trim() + ' ';
      bodyReplaceRange(text, dictPos, dictPos + dictLen, dictPos + text.length);
      dictPos += text.length;
      dictLen = 0;
    },
    onEnd: () => { setDictateRecording(false); dict = null; dictLen = 0; bodyFocus(); },
    onError: ({ code, message, fatal }) => {
      if (code === 'not-allowed' || code === 'service-not-allowed') toast('Microphone blocked — allow mic access for this page');
      else if (code === 'network') toast('Voice input needs a network connection');
      else if (code === 'gateway-unreachable') toast('Gateway stopped answering — tap the mic to retry');
      else if (fatal) toast('Voice input error: ' + (message || code));
      if (fatal) { setDictateRecording(false); dict = null; dictLen = 0; }
    },
  });
  dict.start();
}

// ── In-person meeting transcription — diarized, speaker-labelled, into the note ───
// The no-online-meeting path: just people talking near the mic. Room mic → local
// gateway STT with diarization ON → appends "Speaker N: …" lines at the end of the
// note, merging consecutive turns from the same speaker. Requires the gateway
// (diarization is local-only); the browser engine can't tell speakers apart.
let trans = null;            // active controller, else null
let transInterimLen = 0;     // length of the pending interim shown at the doc's END
let transLastSpeaker = null; // to merge consecutive same-speaker turns onto one line
let transStarted = false;    // has the first line been written (controls leading blank line)

function setTranscribing(on) {
  const btn = $('n-transcribe');
  if (!btn) return;
  btn.classList.toggle('recording', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Stop transcribing' : 'Transcribe an in-person meeting (diarized)';
  btn.innerHTML = icon(on ? 'stop' : 'meetings');
}

// The transcript always grows at the CURRENT end of the document, and the pending
// interim is the last `transInterimLen` chars. We recompute the end (and clamp)
// on every write rather than tracking an absolute index — across async STT events
// the doc can change (mode switch, note load, user edit), and a stale index throws
// CodeMirror "Invalid change range". `transAppend` = insert `text` at the end.
function transAppend(text) {
  const end = bodyText().length;                 // live doc length (CM or textarea)
  const from = Math.max(0, end - transInterimLen); // drop the pending interim first
  bodyReplaceRange(text, from, end, from + text.length);
}
function transClearInterim() {
  if (!transInterimLen) return;
  transAppend('');           // replaces the pending interim (from..end) with nothing
  transInterimLen = 0;
}
function transShowInterim(t) {
  const s = String(t || '').trim();
  transAppend(s);            // overwrite the previous interim in place
  transInterimLen = s.length;
}
function transAppendFinal(text, label) {
  transClearInterim();
  const clean = String(text || '').trim();
  if (!clean) return;
  let ins;
  if (label && label === transLastSpeaker) {
    ins = ' ' + clean;                                   // same speaker → continue the line
  } else {
    const lead = transStarted ? '\n\n' : '';
    ins = label ? `${lead}**${label}:** ${clean}` : `${lead}${clean}`;
    transLastSpeaker = label || null;
    transStarted = true;
  }
  transAppend(ins);
}

async function toggleTranscribe() {
  // Any click while transcribing is a STOP (never a restart); flip to idle at once.
  if (trans) {
    if (trans.recording) {
      trans.stop();
      setTranscribing(false);
      const t = trans;
      setTimeout(() => { if (trans === t) trans = null; }, 6000);
    }
    return;
  }
  if (dict?.recording) { toast('Stop dictation first'); return; }
  const { createDictation, micPermissionState, resolveDictationProvider } = await import('./js/dictation.js');
  if (await micPermissionState() !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
    toast('Allow the microphone in the new tab, then click transcribe again');
    return;
  }
  const settings = await (await import('./js/store.js')).getSettings();
  const gatewayUrl = settings?.gatewayUrl || settings?.ui?.warmSearch?.url || undefined;
  const engine = await resolveDictationProvider({ gatewayUrl });
  if (engine.provider !== 'gateway') {
    toast('Diarized transcription needs the local ChatPanel gateway (private, on-device). Start it, then try again.');
    return;
  }
  // Start the transcript at the end of the note, under a header. (transAppend
  // always targets the live doc end, so no absolute index is kept.)
  transInterimLen = 0; transLastSpeaker = null; transStarted = false;
  transAppend(`${bodyText().trim() ? '\n\n' : ''}## Meeting transcript\n\n`);
  const dictLang = settings?.ui?.dictation?.lang || undefined;
  const lastPct = { stt: -25, diarize: -25 }; // per-phase toast throttle
  trans = createDictation({
    provider: 'gateway',
    gatewayUrl,
    lang: dictLang,
    diarize: true, // the whole point — who said what
    onStart: () => { setTranscribing(true); toast('🎙 Transcribing meeting — local, on-device (diarized)'); },
    onStatus: ({ state: st, pct }) => {
      if ((st === 'downloading' || st === 'loading') && typeof pct === 'number' && pct - lastPct.stt >= 25) {
        lastPct.stt = pct; toast(`Preparing local transcription — downloading model ${pct}%`);
      } else if (st === 'diarize' && typeof pct === 'number' && pct - lastPct.diarize >= 25) {
        lastPct.diarize = pct; toast(`Preparing speaker detection — downloading model ${pct}% (labels start once ready)`);
      }
    },
    onInterim: (t) => transShowInterim(t),
    onFinal: (t, info) => transAppendFinal(t, info?.speaker?.label || null),
    onEnd: () => { transClearInterim(); setTranscribing(false); trans = null; },
    onError: ({ code, message, fatal }) => {
      if (code === 'not-allowed' || code === 'service-not-allowed') toast('Microphone blocked — allow mic access for this page');
      else if (code === 'gateway-unreachable') toast('Gateway stopped answering — click transcribe to retry');
      else if (fatal) toast('Transcription error: ' + (message || code));
      if (fatal) { setTranscribing(false); trans = null; }
    },
  });
  trans.start();
}
// ── Undo / redo history ──────────────────────────────────────────────────────────
// The editor rewrites `textarea.value` programmatically all over (streaming @insert,
// co-writer fixes, formatting, checkbox toggle, note switching) — every direct set
// wipes the browser's native undo stack, so ⌘Z did nothing. This is our own history:
// typing coalesces into word/pause-sized steps; anything that bypassed recording is
// captured at undo-time (flush), so ONE keydown hook covers every mutation site.
let undoStack = [];
let redoStack = [];
let histPrev = { value: '', start: 0, end: 0 }; // the value as of the last recorded checkpoint
let histAt = 0;
let histCoalescing = false;
const HIST_MAX = 500;

function histReset(value) {
  undoStack = []; redoStack = [];
  histPrev = { value: value || '', start: 0, end: 0 };
  histAt = 0; histCoalescing = false;
}
// ── Provenance ledger — who (human / which agent) wrote each run, + versions ───────
// The pure attribution engine lives in ./js/notes-provenance.js (imported above);
// here we own the live run-list on `current.attribution` + the undo/version glue.

// Record the pre-change checkpoint if the body changed, AND attribute the changed
// span to `author`. Consecutive single-char typing within 500ms coalesces into one
// undo step; a big delta (paste/insert/format/@insert output) or `discrete` starts a
// fresh step.
function recordEdit({ discrete = false, author = HUMAN } = {}) {
  const ta = $('n-body');
  if (ta.value === histPrev.value) { histPrev.start = ta.selectionStart; histPrev.end = ta.selectionEnd; return; }
  const now = Date.now();
  if (current) current.attribution = applyAttribution(current.attribution, histPrev.value, ta.value, author, now);
  const smallDelta = Math.abs(ta.value.length - histPrev.value.length) <= 2;
  const newStep = discrete || !histCoalescing || (now - histAt > 500) || !smallDelta;
  if (newStep) {
    undoStack.push(histPrev);
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack = [];
  }
  histPrev = { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  histAt = now;
  histCoalescing = !discrete;
}

// A labelled, restorable snapshot of the note (body + its attribution), capped. `body`
// defaults to the live editor value but can be passed explicitly (e.g. a pre-run snapshot
// of the pristine note before an agent inserts its header).
function pushVersion(by, label, body = $('n-body').value) {
  if (!current) return;
  current.versions = Array.isArray(current.versions) ? current.versions : [];
  const last = current.versions[current.versions.length - 1];
  if (last && last.body === body) return; // nothing new since the last snapshot
  // Only keep the live ledger if it still matches THIS body's length (an explicit pre-run
  // body won't); otherwise seed blank so restore stays length-consistent.
  const attribution = (current.attribution && current.attribution.reduce((n, r) => n + (r.len || 0), 0) === body.length)
    ? current.attribution : blankAttribution(body.length);
  current.versions.push({ body, attribution, at: Date.now(), by, label: label || by });
  if (current.versions.length > 40) current.versions.shift();
}

// ── History panel — authorship summary + version snapshots (revert) ───────────────
function authorClass(author) { return author === HUMAN ? 'av-human' : 'av-ai'; }
function renderHistorySummary() {
  if (activeSide !== 'history') return; // only compute when the History tab is showing
  const sum = attributionSummary(current?.attribution || []);
  $('n-history-summary').textContent = sum.total
    ? sum.by.map((b) => `${b.author} ${Math.round((b.chars / sum.total) * 100)}%`).join(' · ')
    : '';
  if ($('n-history-attrib-view').classList.contains('shown')) renderAttribView();
}
// The "who wrote what" view — the note's text, each run tinted + titled by author/time.
function renderAttribView() {
  const el = $('n-history-attrib-view');
  const body = $('n-body').value;
  const runs = normalizeAttribution(current?.attribution, body.length, current?.updatedAt || 0);
  let pos = 0;
  const parts = [];
  for (const r of runs) {
    const seg = body.slice(pos, pos + r.len); pos += r.len;
    parts.push(`<span class="av-seg ${authorClass(r.author)}" title="${escapeHtml(r.author)} · ${escapeHtml(relTime(r.at))}">${escapeHtml(seg)}</span>`);
  }
  el.innerHTML = parts.join('') || '<span class="history-empty">Empty note.</span>';
}
function renderHistory() {
  if (activeSide !== 'history') return; // only render when the History tab is showing
  renderHistorySummary();
  const wrap = $('n-history-versions');
  wrap.innerHTML = '';
  const vers = current?.versions || [];
  if (!vers.length) {
    wrap.innerHTML = '<div class="history-empty">No versions yet. One is captured on each AI action; “＋ Save version” snapshots your current draft. Restore rolls the note back (itself undoable).</div>';
    return;
  }
  for (let i = vers.length - 1; i >= 0; i--) {
    const v = vers[i];
    const row = document.createElement('div');
    row.className = 'hrow' + (i === previewedVersion ? ' active' : '');
    row.title = 'Click to preview this version';
    row.innerHTML =
      `<span class="hrow-by ${authorClass(v.by)}">${escapeHtml(v.label || v.by)}</span>` +
      `<span class="hrow-when">${escapeHtml(relTime(v.at))}</span>` +
      `<span class="hrow-len">${v.body.length} chars</span>` +
      '<button class="hrow-restore">Restore</button>';
    row.querySelector('.hrow-restore').onclick = (e) => { e.stopPropagation(); restoreVersion(i); };
    row.onclick = () => previewVersion(i); // click the row to preview before restoring
    wrap.appendChild(row);
  }
}
let previewedVersion = -1;
// Preview a version's content (read-only) in the History tab before restoring.
function previewVersion(idx) {
  const v = current?.versions?.[idx];
  const el = $('n-history-preview');
  if (!v || !el) return;
  if (previewedVersion === idx) { previewedVersion = -1; el.classList.add('hidden'); renderHistory(); return; } // toggle off
  previewedVersion = idx;
  el.innerHTML =
    `<div class="hpv-head"><span class="hpv-label">${escapeHtml(v.label || v.by)} · ${escapeHtml(relTime(v.at))}</span>`
    + `<button class="hpv-restore">Restore this</button><button class="hpv-close" title="Close preview" aria-label="Close preview">${icon('close')}</button></div>`
    + `<div class="hpv-body md">${renderMarkdown(v.body)}</div>`;
  el.querySelector('.hpv-restore').onclick = () => restoreVersion(idx);
  el.querySelector('.hpv-close').onclick = () => { previewedVersion = -1; el.classList.add('hidden'); renderHistory(); };
  el.classList.remove('hidden');
  renderHistory(); // re-highlight the active row
}
function restoreVersion(idx) {
  if (!current) return;
  if (noteHasJob(current.id)) return toast('A command is running — stop it first (Esc)');
  const v = current.versions?.[idx];
  if (!v) return;
  const ta = $('n-body');
  if (ta.value === v.body) return toast('Already at this version');
  // Snapshot the pre-restore state ONLY if it isn't already recoverable as a version — otherwise
  // flip-flopping between two versions (A→B→A→B) spams identical "Before restore" rows. ⌘Z still
  // reverts the restore regardless (undoStack push below).
  if (!current.versions.some((ver) => ver.body === ta.value)) pushVersion(HUMAN, 'Before restore');
  undoStack.push(histPrev);              // and undoable with ⌘Z
  if (undoStack.length > HIST_MAX) undoStack.shift();
  redoStack = [];
  ta.value = v.body;
  current.body = v.body;
  current.attribution = normalizeAttribution(v.attribution, v.body.length, v.at);
  histPrev = { value: v.body, start: v.body.length, end: v.body.length };
  histCoalescing = false;
  try { ta.setSelectionRange(v.body.length, v.body.length); } catch { /* noop */ }
  autoGrow();
  updateWordCount();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  scheduleSave(true);
  renderHistory();
  toast('Restored');
}
function applyHistState(s) {
  const ta = $('n-body');
  const oldBody = ta.value;
  ta.value = s.value;
  try { ta.setSelectionRange(s.start, s.end); } catch { /* out of range */ }
  histPrev = { value: s.value, start: s.start, end: s.end };
  histCoalescing = false;
  if (current) {
    // Undo/redo is a human action — re-attribute the reverted span to You so the
    // ledger stays length-consistent with the body.
    current.attribution = applyAttribution(current.attribution, oldBody, s.value, HUMAN, Date.now());
    current.body = s.value;
  }
  autoGrow();
  updateWordCount();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  scheduleSave();
  ta.focus();
}
function undoEdit() {
  const ta = $('n-body');
  if (ta.readOnly) return;              // a command is running — leave the body alone
  recordEdit({ discrete: true });        // flush any edit that bypassed recording
  if (!undoStack.length) return;
  redoStack.push({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
  applyHistState(undoStack.pop());
}
function redoEdit() {
  const ta = $('n-body');
  if (ta.readOnly) return;
  if (ta.value !== histPrev.value) { recordEdit({ discrete: true }); return; } // a fresh edit invalidates redo
  if (!redoStack.length) return;
  undoStack.push({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
  applyHistState(redoStack.pop());
}

function onBodyInput() {
  if (ghostApplying) { autoGrow(); return; }     // our own ghost mutation — no autosave / swarm triggers
  recordEdit();                                   // checkpoint for undo + attribution (coalesced while typing)
  if (ghost) { ghost = null; hideGhostHint(); }   // user edited around a pending ghost → drop the stale state
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  renderHistorySummary();                         // live authorship % when the panel is open (cheap; no-op if closed)
  updateWordCount();
  scheduleSave();
  scheduleSuggest();
  scheduleNoteTopics();
  maybeAutocomplete();
  scheduleAutocomplete(); // inline AI ghost prediction on a typing pause (opt-in)
  scheduleCowriter();
  scheduleResearch();
  scheduleLinkify();
}

// ── Auto-linkify bare URLs → [Title](url) ─────────────────────────────────────────────
// A pasted OR typed bare http(s) URL gets its page <title> fetched (locally, via link-title.js —
// no third-party service) and is rewritten to a readable [Title](url) link. Two triggers: an
// explicit PASTE of a URL (immediate, below), and a URL that SETTLES while typing (a terminator
// after it — so we never rewrite one that's still being typed). Model-free / key-free, so it runs
// regardless of the co-writer toggle. Cached + span-revalidated + caret-preserving; if the title
// can't be fetched it just leaves the bare URL (which the Live editor already renders clickable).
const BARE_URL_RE = /^https?:\/\/[^\s<>()[\]]+$/i;               // a whole token that IS just a URL
const URL_SCAN_RE = /https?:\/\/[^\s<>()[\]]+/gi;                // find URLs embedded in the text
const linkifyTried = new Set(); // spans already handled/attempted this session (avoid re-runs/loops)
let linkifyTimer = null;
let _linkTitleMod = null;
let _bridgeUrlForLinks = null;  // cached once — reading settings per keystroke would be wasteful

function scheduleLinkify() { clearTimeout(linkifyTimer); linkifyTimer = setTimeout(() => scanAndLinkify().catch(() => {}), 900); }

async function bridgeUrlForLinks() {
  if (_bridgeUrlForLinks !== null) return _bridgeUrlForLinks;
  // Don't pull the heavy providers module onto the linkify path just to read one URL — the bridge
  // is an OPTIONAL provider (the direct local fetch works without it). If deps are already loaded,
  // read it now; otherwise skip the bridge this time and warm the value in the background.
  if (!_agentDeps) {
    agentDeps().then((d) => d.getSettings()).then((s) => { _bridgeUrlForLinks = s?.bridgeUrl || ''; }).catch(() => {});
    return '';
  }
  try { _bridgeUrlForLinks = (await _agentDeps.getSettings())?.bridgeUrl || ''; } catch { _bridgeUrlForLinks = ''; }
  return _bridgeUrlForLinks;
}

// Replace the bare URL at [from,to) with [Title](url) once the title resolves. Guarded: bails if
// the span no longer holds that exact URL (edited), if it's already a link's address, or if we
// switched notes mid-fetch. Keeps the caret where it was relative to the edit.
async function linkifyUrlSpan(url, from, to, noteId) {
  let mod;
  try { mod = _linkTitleMod || (_linkTitleMod = await import('./js/link-title.js')); } catch { return; }
  const title = await mod.resolveLinkTitle(url, { bridgeUrl: await bridgeUrlForLinks() });
  if (!title || !current || current.id !== noteId) return; // no title, or note switched → keep bare URL
  let text = bodyText();
  if (text.slice(from, to) !== url) {                    // span moved (edits during fetch) → re-find once
    const idx = text.indexOf(url);
    if (idx < 0 || text.slice(idx, idx + url.length) !== url) return;
    from = idx; to = idx + url.length;
  }
  if (text[from - 1] === '(' && text[from - 2] === ']') return; // already the address of a [text](url) link
  const md = `[${title}](${url})`;
  const caret = bodyCursor();
  const newCaret = caret >= to ? caret + (md.length - (to - from)) : (caret > from ? from + md.length : caret);
  bodyReplaceRange(md, from, to, newCaret);
  logActivity('Linker', `titled “${title.slice(0, 48)}”`);
}

// Typing trigger: on a pause, find the first SETTLED bare URL (terminated by whitespace/newline/
// punctuation — not one still being typed at the very end) that isn't already a link, and upgrade it.
async function scanAndLinkify() {
  if (!current || $('n-body').readOnly || ghost || writerAbort) return;
  const text = bodyText();
  const noteId = current.id;
  URL_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = URL_SCAN_RE.exec(text))) {
    let from = m.index, to = from + m[0].length, url = m[0];
    while (to > from && /[.,;:!?'")\]]/.test(text[to - 1])) { to--; url = url.slice(0, -1); } // trim trailing punctuation
    if (!url || (text[from - 1] === '(' && text[from - 2] === ']')) continue; // empty, or already a [text](url) address (literal parens are fine)
    const next = text[to];
    if (next === undefined || !/[\s)\].,;:!?]/.test(next)) continue; // not settled yet (still typing) → wait
    if (linkifyTried.has(url)) continue;
    linkifyTried.add(url);
    linkifyUrlSpan(url, from, to, noteId);
    break; // one per pass; the next input reschedules
  }
}

// Paste trigger: pasting a whole bare URL upgrades it. With a selection, wrap it as the link text
// ([selection](url)); otherwise drop the URL in and fetch its title. Works in both editor modes
// (bodySel / bodyReplaceRange route to the textarea or CM). Returns true when it handled the paste.
function onEditorPaste(e) {
  const url = (e.clipboardData?.getData('text') || '').trim();
  if (!BARE_URL_RE.test(url) || !current) return false;  // not a bare URL → let the normal paste happen
  e.preventDefault();
  const noteId = current.id;
  const { start, end } = bodySel();
  const selText = bodyText().slice(start, end);
  if (selText) { bodyReplaceRange(`[${selText}](${url})`, start, end); return true; } // selection → link text
  linkifyTried.delete(url);                               // a fresh explicit paste — allow a re-try
  bodyReplaceRange(url, start, end, start + url.length);  // show the bare URL immediately…
  linkifyUrlSpan(url, start, start + url.length, noteId); // …then upgrade to [Title](url) when it resolves
  return true;
}

// ── agent beside you: local topic extraction → tag suggestions (no LLM) ──────────
let suggestTimer = null;
let _topicFn = null; // lazily loaded — keeps topic-extraction OFF the page load path
function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(suggestTags, 1400);
}
async function suggestTags() {
  const el = $('n-suggest');
  if (!current) { el.innerHTML = ''; return; }
  if (!_topicFn) {
    try { _topicFn = (await import('./js/topic-extraction.js')).fallbackTopicItems; }
    catch { return; }
    if (!current.topics?.items?.length) renderNoteTopics(); // fn now loaded → show a topic preview
  }
  if (!current) return; // could have changed while importing
  const have = new Set((current.tags || []).map((t) => t.toLowerCase()));
  const picks = [];
  for (const cand of _topicFn($('n-body').value || '', 8)) {
    const tag = tagify(cand);
    if (!tag || tag.length < 3 || have.has(tag)) continue;
    if (picks.some((p) => p.includes(tag) || tag.includes(p))) continue; // drop overlaps
    picks.push(tag);
    if (picks.length >= 4) break;
  }
  el.innerHTML = '';
  if (!picks.length) return;
  const label = document.createElement('span');
  label.className = 'suggest-label';
  label.textContent = 'Suggested';
  el.appendChild(label);
  for (const tag of picks) {
    const b = document.createElement('button');
    b.className = 'suggest-chip';
    b.textContent = `+ ${tag}`;
    b.onclick = () => {
      current.tags = [...(current.tags || []), tag];
      renderTags(current.tags);
      scheduleSave(true);
      suggestTags();
    };
    el.appendChild(b);
  }
}

// ── auto topic extraction (mirrors chats/meetings) ──────────────────────────────
// Each note earns durable topics the same way chats/meetings do: the configured model
// extracts noun-phrase topics (deterministic fallback when no model / it fails), stored
// via saveNoteTopics so the graph, dashboard, omni-search and history RAG can traverse
// notes by concept — not just user tags. Debounced off the typing path; hash-guarded so
// it only runs when the content materially changed. Everything is lazy-imported.
const noteTopicJobs = new Set();
let topicTimer = null;
function scheduleNoteTopics() {
  clearTimeout(topicTimer);
  const id = current?.id;
  topicTimer = setTimeout(() => { if (current?.id === id) maybeExtractNoteTopics(current).catch(() => {}); }, 4000);
}
async function maybeExtractNoteTopics(rec) {
  if (!rec?.id || noteTopicJobs.has(rec.id)) return;
  const te = await import('./js/topic-extraction.js');
  const text = te.topicSourceTextForNote(rec);
  if (!text) return;
  const hash = te.contentHash(text);
  let settings = null, target = null;
  try {
    const deps = await agentDeps();
    settings = await deps.getSettings();
    if (settings?.ui?.topicExtraction?.enabled === false) return;
    const wantId = settings?.ui?.topicExtraction?.targetId || settings?.activeAgentId || '';
    const t = deps.getTarget(settings, wantId);
    target = t ? deps.resolveTarget(t, settings) : null;
  } catch { /* no model available → deterministic fallback below */ }
  const targetId = target?.id || '';
  if (!te.shouldExtractTopics(rec.topics, { hash, targetId, enabled: true })) return;
  noteTopicJobs.add(rec.id);
  try {
    let items = [], fallback = true;
    if (target) {
      let out = '';
      try {
        const deps = await agentDeps();
        await deps.streamChat({
          agent: { ...target, systemPrompt: 'Return only valid JSON. Do not include markdown fences.', temperature: 0.2, maxTokens: 500 },
          messages: [{ role: 'user', content: te.topicExtractionPrompt({ kind: 'note', title: rec.title || 'Note', text }) }],
          settings,
          onDelta: (d) => { out += d; },
          onEvent: () => {},
          usage: { surface: 'note', sourceId: rec.id },
        });
        const parsed = te.parseTopicExtractionResponse(out);
        if (parsed.length) { items = parsed; fallback = false; }
      } catch { /* fall through to deterministic */ }
    }
    if (!items.length) items = te.fallbackTopicItems(text, 10);
    const topics = te.makeTopicIndex({ hash, targetId, items, fallback });
    await saveNoteTopics(rec.id, topics);
    const entry = list.find((e) => e.id === rec.id);
    if (entry) entry.topics = items;
    if (current?.id === rec.id) { current.topics = topics; renderNoteTopics(); }
  } finally {
    noteTopicJobs.delete(rec.id);
  }
}

// ── actions ─────────────────────────────────────────────────────────────────
async function newNote() {
  if (noteCapBlocked()) return; // Free tier: first 10 notes only
  await flushSave();
  let rec;
  try { rec = await createNote({ body: '' }); }
  catch (e) { if (e instanceof NoteLimitError) { noteCapReached(e.limit); return; } throw e; } // backstop: never fail silently
  noteCreatedCount += 1; // lifetime cap tracks notes ever created
  updateEntry(rec);
  await openNote(rec.id, rec);           // finish editor setup before we place the cursor
  setMode('live', false, { focus: false }); // a blank note opens in the live editor (don't change the saved default); don't let CM's async focus steal the title
  const title = $('n-title');
  title.focus();
  title.select(); // select-all the title so you can type over it immediately; Enter → body
}
async function removeCurrent() {
  if (!current) return;
  const { confirmDelete } = await import('./js/confirm-modal.js');
  if (!(await confirmDelete({ title: 'Delete note?', body: `“${current.title || 'this note'}” will be permanently deleted. This can't be undone.`, confirmLabel: 'Delete' }))) return;
  const id = current.id;
  await deleteNote(id);
  list = list.filter((e) => e.id !== id);
  current = null;
  $('n-editor').classList.add('hidden');
  $('n-blank').classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
  renderList($('n-search').value);
  toast('Note deleted');
}
// Auto-extracted topics for the open note — durable, navigable concepts (distinct from
// user tags). Shows stored topics; if none yet (extraction pending), computes a cheap
// deterministic preview so the row is never empty. Click a topic → omni-search it across
// notes, chats and meetings.
function renderNoteTopics() {
  const el = $('n-topics');
  if (!el) return;
  el.innerHTML = '';
  if (!current) return;
  let items = current.topics?.items || [];
  let pending = false;
  if (!items.length) { items = deterministicTopicPreview(current.body || ''); pending = true; }
  if (!items.length) return;
  const label = document.createElement('span');
  label.className = 'topics-label';
  label.textContent = pending ? 'Topics (drafting…)' : 'Topics';
  el.appendChild(label);
  for (const topic of items.slice(0, 10)) {
    const b = document.createElement('button');
    b.className = 'topic-chip';
    b.textContent = topic;
    b.title = `Find "${topic}" across notes, chats & meetings`;
    b.onclick = () => openOmni(topic);
    el.appendChild(b);
  }
}
function deterministicTopicPreview(body) {
  if (!body.trim() || !_topicFn) return []; // _topicFn is loaded lazily by suggestTags()
  try { return _topicFn(body, 6); } catch { return []; }
}

// The link neighbourhood of the open note: OUTGOING [[Title]] links that resolve to a
// real note, plus INBOUND backlinks — both from the lightweight index (no body decrypts).
function renderNoteLinks(note) {
  const el = $('n-backlinks');
  el.innerHTML = '';
  if (!note) return;
  const byTitle = new Map(list.map((e) => [(e.title || '').toLowerCase(), e]));
  const entry = list.find((e) => e.id === note.id);
  const outNames = entry?.links || extractBodyLinks(note.body);
  const seen = new Set();
  const out = [];
  for (const name of outNames) {
    const hit = byTitle.get((name || '').toLowerCase());
    if (hit && hit.id !== note.id && !seen.has(hit.id)) { seen.add(hit.id); out.push(hit); }
  }
  const title = (note.title || '').toLowerCase();
  const inbound = title ? list.filter((e) => e.id !== note.id && (e.links || []).some((l) => l.toLowerCase() === title)) : [];
  const section = (labelText, entries) => {
    if (!entries.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'backlinks-label';
    lbl.textContent = labelText.replace('{n}', entries.length).replace('{s}', entries.length === 1 ? '' : 's');
    el.appendChild(lbl);
    for (const r of entries) {
      const b = document.createElement('button');
      b.className = 'backlink';
      b.innerHTML = `${escapeHtml(r.title || 'Untitled note')} <span class="bl-snip">${escapeHtml(r.snippet || '')}</span>`;
      b.onclick = () => openNote(r.id);
      el.appendChild(b);
    }
  };
  section('→ Links to {n} note{s}', out);
  section('↩ Linked from {n} note{s}', inbound);
}

// Open the ChatPanel side panel (fresh) from the header — no note attached.
async function openPanel() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch { toast('Open the ChatPanel side panel from the toolbar'); }
}

// Hand this note to the side-panel composer as context, then open the panel — the
// same handoff meetings use ("Ask about this meeting").
async function askAboutNote() {
  if (!current) return;
  await flushSave();
  await chrome.storage.local.set({ 'chatpanel:attachNoteId': current.id });
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    chrome.runtime.sendMessage({ type: 'attach-note', id: current.id }).catch(() => {}); // if already open
    toast('Opened ChatPanel — ask away');
  } catch {
    toast('Open the ChatPanel side panel to continue');
  }
}

function copyCurrent() {
  if (!current) return;
  navigator.clipboard.writeText(noteToMarkdown(current)).then(() => toast('Copied as Markdown'), () => toast('Copy failed'));
}
function exportFilename(note) {
  return (note?.title || 'note').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 70) || 'note';
}
function downloadCurrent() {
  if (!current) return;
  const url = URL.createObjectURL(new Blob([noteToMarkdown(current)], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${exportFilename(current)}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// A standalone, print-optimized HTML document for the note — clean typography, page-break
// rules, styled code/tables/quotes — so the browser's "Save as PDF" produces a beautiful,
// selectable-text PDF (no heavy PDF library; CSP-safe — no inline scripts).
function buildPrintHtml(note) {
  const title = escapeHtml((note.title || 'Untitled note').trim());
  const when = note.updatedAt ? escapeHtml(new Date(note.updatedAt).toLocaleString()) : '';
  const css = `@page{margin:22mm 18mm}*{box-sizing:border-box}`
    + `body{margin:0;color:#1a1a1a;background:#fff;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}`
    + `.doc{max-width:720px;margin:0 auto;padding:24px}`
    + `.doc-title{font-size:28px;line-height:1.2;margin:0 0 6px;font-weight:700}`
    + `.doc-meta{color:#888;font-size:12px;margin:0 0 22px;border-bottom:1px solid #e5e5e5;padding-bottom:14px}`
    + `h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em;font-weight:700;page-break-after:avoid}`
    + `h1{font-size:24px}h2{font-size:20px}h3{font-size:17px}h4{font-size:15px}`
    + `p,li{orphans:2;widows:2}a{color:#2352c9;text-decoration:underline;word-break:break-word}`
    + `code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:#f3f4f6;padding:.1em .35em;border-radius:4px}`
    + `pre{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;overflow:auto;page-break-inside:avoid}pre code{background:none;padding:0}`
    + `blockquote{margin:1em 0;padding:.2em 0 .2em 16px;border-left:3px solid #d0d7de;color:#57606a}`
    + `table{border-collapse:collapse;width:100%;margin:1em 0;page-break-inside:avoid}th,td{border:1px solid #d0d7de;padding:7px 10px;text-align:left;font-size:14px}th{background:#f6f8fa;font-weight:600}`
    + `ul,ol{padding-left:1.4em}img{max-width:100%}hr{border:0;border-top:1px solid #e5e5e5;margin:1.6em 0}input[type=checkbox]{margin-right:6px}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head>`
    + `<body><main class="doc md"><h1 class="doc-title">${title}</h1>${when ? `<div class="doc-meta">${when}</div>` : ''}`
    + `${renderMarkdown(note.body || '')}</main></body></html>`;
}
// Render the note into a hidden iframe and open the print dialog → "Save as PDF".
function exportPdf() {
  if (!current) return;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
  document.body.appendChild(iframe);
  let printed = false;
  const print = () => {
    if (printed || !iframe.parentNode) return; printed = true;
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch { toast('Could not open the print dialog'); }
    setTimeout(() => iframe.remove(), 2000);
  };
  iframe.onload = print;
  const d = iframe.contentWindow.document;
  d.open(); d.write(buildPrintHtml(current)); d.close();
  setTimeout(print, 350); // fallback: document.write doesn't always fire onload
  toast('Choose “Save as PDF” in the print dialog');
}

// ── agent actions (LLM) — everything model-related is LAZY-LOADED, so providers.js
//    and the store/license graph never touch the notes page load path ─────────────
let _agentDeps = null;
async function agentDeps() {
  if (_agentDeps) return _agentDeps;
  const [p, s, l, t, sk] = await Promise.all([import('./js/providers.js'), import('./js/store.js'), import('./js/license.js'), import('./js/turn-tools.js'), import('./js/skill-runtime.js')]);
  _agentDeps = {
    // Tag every notes model call with the 'note' surface for token accounting
    // (this is where ambient / swarm / co-writer spend shows up), unless a caller
    // set its own usage context. sourceId = the active note.
    streamChat: (opts = {}) => p.streamChat({ ...opts, usage: opts.usage || { surface: 'note', sourceId: current?.id } }),
    checkBridge: p.checkBridge,
    getSettings: s.getSettings, getTarget: s.getTarget, resolveTarget: s.resolveTarget,
    getLicense: l.getLicense, canUseAgent: l.canUseAgent, can: l.can,
    buildTurnTools: t.buildTurnTools, buildRedaction: t.buildRedaction,
    skillRunFromSkill: sk.skillRunFromSkill,
  };
  return _agentDeps;
}

// The model-router bridge (SWARM_ROLES / swarmCandidates / roleAgent / getRouter) lives
// in js/notes-swarm-router.js — a portable, DI'd primitive with no editor state.

const AGENT_ACTION_LABEL = { continue: 'Continue writing', summarize: 'Summarize', tasks: 'Turn into tasks', improve: 'Improve writing' };
const AGENT_SPECS = {
  continue: { sys: "You are a writing assistant continuing the user's note. Match their voice, tone and markdown style, and continue naturally from where the text stops. Output ONLY the continuation — no preamble, no repeating prior text.", max: 700 },
  summarize: { sys: 'Summarize the text concisely in GitHub-flavored markdown — a few tight bullets or a short paragraph. Output ONLY the summary.', max: 500 },
  tasks: { sys: 'Convert the text into a GitHub-flavored markdown checklist: one actionable item per line as "- [ ] item". Output ONLY the checklist.', max: 700 },
  improve: { sys: 'Rewrite the text to be clearer and more concise while preserving its meaning, tone and markdown formatting. Output ONLY the rewritten text.', max: 1000 },
};

let agentAbort = null;
function setAgentBusy(busy) {
  const btn = $('n-agent');
  btn.classList.toggle('busy', busy);
  btn.innerHTML = busy ? icon('stop') + ' Stop' : icon('assist') + ' Agent';
  $('n-body').readOnly = busy;
  mirrorToCm(); // reflect the read-only state onto the live editor
}
function closeAgentMenu() { $('n-agent-menu').classList.add('hidden'); }

async function runAgentAction(kind) {
  closeAgentMenu();
  if (!current || agentAbort) return;
  const spec = AGENT_SPECS[kind];
  const ta = $('n-body');
  const body = bodyText(); // synced from CM when Live is active
  const { start: s0, end: s1 } = bodySel();
  const sel = body.slice(s0, s1);

  // Frame WHERE the streamed output lands (head + output + tail) per action.
  let target, head, tail;
  if (kind === 'continue') { target = body; head = body + (body && !/\s$/.test(body) ? '\n\n' : ''); tail = ''; }
  else if (kind === 'summarize') { target = sel || body; head = body.replace(/\s+$/, '') + '\n\n## Summary\n\n'; tail = ''; }
  else if (kind === 'tasks') { if (!sel.trim()) return toast('Select some text to turn into tasks'); target = sel; head = body.slice(0, s0); tail = body.slice(s1); }
  else if (kind === 'improve') { target = sel || body; if (sel) { head = body.slice(0, s0); tail = body.slice(s1); } else { head = ''; tail = ''; } }
  if (!target || !target.trim()) return toast('Nothing to work with yet');

  let deps;
  try { deps = await agentDeps(); } catch { return toast('Agent unavailable'); }
  const settings = await deps.getSettings();
  const targetAgent = deps.getTarget(settings, settings.activeAgentId);
  if (!targetAgent) return toast('Set up a model in ChatPanel settings first');
  const license = await deps.getLicense();
  if (!deps.canUseAgent(license, settings, targetAgent)) return toast('That agent needs ChatPanel Pro — pick your free model or upgrade');
  const resolved = deps.resolveTarget(targetAgent, settings);

  const streamNote = current; // guard against the user switching notes mid-stream
  agentAbort = new AbortController();
  setAgentBusy(true);
  setStatus('Thinking…');
  let out = '';
  const render = () => {
    if (current !== streamNote) return;
    ta.value = head + (out || '⏳ thinking…') + tail;
    autoGrow();
    if (!$('n-panes').classList.contains('write')) updatePreview();
    streamFollow();
  };
  streamStart();
  render(); // show the placeholder immediately so it's clear something is happening
  try {
    await deps.streamChat({
      agent: { ...resolved, systemPrompt: spec.sys, maxTokens: spec.max, temperature: 0.5 },
      settings,
      signal: agentAbort.signal,
      messages: [{ role: 'user', content: target }],
      onDelta: (d) => { out += d; scheduleStreamRender(render); }, // one paint per frame — no flicker
    });
  } catch (e) {
    if (agentAbort?.signal.aborted) toast('Stopped');
    else toast(`Agent error: ${e?.message || e}`);
  } finally {
    const aborted = agentAbort?.signal.aborted;
    agentAbort = null;
    setAgentBusy(false);
    streamStop(); // drop any pending frame before the final commit
    if (current === streamNote) {
      const finalBody = out.trim() ? head + out + tail : body; // nothing produced → restore original
      ta.value = finalBody;
      if (out.trim()) {
        // Attribute the produced span to the model (NOT "You") and snapshot a revertible
        // version — the same provenance the @mention path records. Without this the whole
        // note normalizes back to "You", so the history reads "You 100%" for AI-written text.
        const author = targetAgent.name || resolved.model || resolved.bridgeAgent || 'AI';
        recordEdit({ author, discrete: true });
        pushVersion(author, `${AGENT_ACTION_LABEL[kind] || kind} · ${author}`);
      }
      current.body = finalBody;
      autoGrow();
      if (!$('n-panes').classList.contains('write')) updatePreview();
      updateWordCount();
      dirty = true;
      await flushSave();
      if (!aborted) setStatus('Saved', true);
    }
  }
}

// Plan notes whose orchestration is running in the BACKGROUND (survives a note switch,
// like the region jobs). Used for the list spinner + to keep the plan note read-only
// while its swarm owns the body, and to spare the planner from openNote's abort.
const planners = new Set();

// Persist the plan straight to its STORE (by id) — whether or not it's the note on
// screen — so switching away mid-plan never loses progress or the final result. When the
// plan note IS open, also refresh the live editor. `finalize` snapshots a version and
// hands the body back to the user (read-write, undo baseline resynced).
async function persistPlan(plan, topic, tasks, { finalize = false } = {}) {
  const at = Date.now();
  const body = planBody(topic, tasks);
  const rec = current?.id === plan.id ? current : await getNote(plan.id);
  if (!rec) return;
  const attribution = planAttribution(topic, tasks, at); // per-section authorship (Planner/Researcher/Writer)
  let versions = Array.isArray(rec.versions) ? rec.versions : [];
  if (finalize) {
    const last = versions[versions.length - 1];
    if (!last || last.body !== body) versions = [...versions, { body, attribution, at, by: 'Planner', label: 'Plan orchestrated' }].slice(-40);
  }
  const saved = await saveNote({ id: plan.id, title: rec.title, body, tags: rec.tags, createdAt: rec.createdAt, attribution, versions });
  Object.assign(rec, saved, { body, attribution, versions });
  updateEntry(rec);
  renderList($('n-search').value);
  if (current?.id === plan.id) {
    $('n-body').value = body; autoGrow(); updateWordCount();
    if (!$('n-panes').classList.contains('write')) updatePreview();
    mirrorToCm(body);
    if (finalize) { histReset(body); renderHistory(); $('n-body').readOnly = false; }
  }
}

// Plan-in-a-new-note: select some text (or a line) → the agent spins off a NEW note,
// links THIS note to it, drafts a researched plan into it (tools + PII harness + the
// activity widget), and hands it to the swarm (intent set, co-writer on) to keep working.
async function planInNewNote(explicitTopic) {
  closeAgentMenu();
  if (!current || agentAbort) return;
  const ta = $('n-body');
  const { start: s0, end: s1 } = bodySel();
  const topic = (explicitTopic || bodyText().slice(s0, s1) || currentLine().text || current.title || '').trim();
  if (topic.length < 3) return toast('Select the text you want planned, or type /plan <topic>');
  if (noteCapBlocked()) return; // a plan spins up a NEW note — Free tier: first 10 only

  let deps;
  try { deps = await agentDeps(); } catch { return toast('Agent unavailable'); }
  const settings = await deps.getSettings();
  const targetAgent = deps.getTarget(settings, settings.activeAgentId);
  if (!targetAgent) return toast('Set up a model in ChatPanel settings first');
  const license = await deps.getLicense();
  if (!deps.canUseAgent(license, settings, targetAgent)) return toast('That agent needs ChatPanel Pro');
  const resolved = deps.resolveTarget(targetAgent, settings);

  // 1) Create the plan note; 2) replace the selection in THIS note with a link to it.
  const clean = topic.replace(/[#*_`>~[\]]/g, '').replace(/\s+/g, ' ').trim();
  const title = `Plan: ${clean.slice(0, 60)}`;
  let plan;
  try { plan = await createNote({ title, body: '' }); }
  catch (e) { if (e instanceof NoteLimitError) { noteCapReached(e.limit); return; } throw e; } // backstop: never fail silently
  noteCreatedCount += 1;
  bodyReplaceRange(`[[${title}]]`, s0, s1); // replace the selection with a link (classic or CM)
  await flushSave(); // persist the link in the source note before we switch away

  // 3) Open the plan note and set it up for the swarm.
  updateEntry(plan);
  await openNote(plan.id, plan);
  const planNote = current;
  setIntent(`Plan: ${clean}`);
  if (!cwEnabled) setCowriter(true);

  // 4) ORCHESTRATE: decompose the goal → dispatch each sub-task to the right member →
  //    fill its section → check it off. Live, in the activity widget; body untouched
  //    elsewhere. Research tasks do web + history; write tasks use the Writer.
  agentAbort = new AbortController();
  planners.add(plan.id);            // → survives note switches; shows the list working-indicator
  renderList($('n-search').value);
  setAgentBusy(true);
  streamStart();
  const pstatus = (t) => { if (current?.id === plan.id) setStatus(t); }; // only touch the strip while the plan note is on screen
  pstatus('Planning…');
  const act = makeSwarmActivity(plan.id, '🧭 Planner', resolved.model || resolved.bridgeAgent || 'model', false);
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }
  // Live mirror into the editor — only while the plan note is the one on screen (by id, so it
  // still works after you switch away and back). Durable writes go through persistPlan().
  const renderPlan = () => { if (current?.id === plan.id) { ta.value = planBody(topic, planNote.tasks || []); autoGrow(); if (!$('n-panes').classList.contains('write')) updatePreview(); streamFollow(); } };

  try {
    // Phase A — decompose (one model call → JSON sub-tasks, each assigned a role).
    pstatus('Decomposing the goal…');
    const dsys = 'You are a planning orchestrator. Break the goal into 3–6 concrete sub-tasks. For each, pick a role: "research" (needs facts, options, prices, or current info — it will web + history search) or "write" (drafting, structure, synthesis). Return ONLY compact JSON: {"tasks":[{"title":"short title","role":"research|write","prompt":"a focused instruction for this sub-task"}]}';
    let tasks = [];
    try {
      const raw = await deps.streamChat({ agent: { ...resolved, systemPrompt: dsys, maxTokens: 600, temperature: 0.2 }, settings, redaction, signal: agentAbort.signal, messages: [{ role: 'user', content: `Goal:\n${topic}` }], onEvent: act.onEvent });
      tasks = (JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]).tasks || []).slice(0, 6)
        .map((t) => ({ title: String(t.title || 'Task').slice(0, 80), role: t.role === 'research' ? 'research' : 'write', prompt: String(t.prompt || t.title || ''), done: false, working: false, output: '' }));
    } catch { /* fall back below */ }
    if (!tasks.length) tasks = [{ title: clean.slice(0, 60), role: 'write', prompt: topic, done: false, working: false, output: '' }];
    planNote.tasks = tasks;
    renderPlan();

    // Phase B — run each sub-task with its assigned member; check it off when done.
    for (const t of tasks) {
      if (agentAbort?.signal.aborted) break;
      t.working = true;
      pstatus(`${t.role === 'research' ? '🔎 Researching' : '✍️ Writing'}: ${t.title}`);
      logActivity('Planner', `→ ${t.role}: ${t.title.slice(0, 40)}`);
      renderPlan();
      try {
        if (t.role === 'research') t.output = await researchTaskMd(t.prompt, planNote);
        else await writeTaskMd(deps, settings, license, redaction, topic, t, act, renderPlan);
      } catch (e) { if (agentAbort?.signal.aborted) break; t.output = `_error: ${e?.message || e}_`; }
      t.working = false; t.done = true;
      renderPlan();
      await persistPlan(plan, topic, planNote.tasks); // land each finished sub-task in the plan note's store, focused or not
    }
    act.done();
  } catch (e) {
    act.done();
    if (!agentAbort?.signal.aborted) toast(`Planner error: ${e?.message || e}`);
  } finally {
    agentAbort = null;
    setAgentBusy(false);
    streamStop(); // drop any pending frame before the final commit
    if (current?.id === plan.id) setStatus('');
    // The plan note started empty — its body was authored by the swarm. Attribute it per
    // section (Planner scaffold, Researcher/Writer sections) instead of "You", and snapshot a
    // version — so history is honest and the user's own later edits are tinted separately. This
    // lands in the plan note's STORE whether or not it's the note on screen (persistPlan), so
    // switching away mid-plan can't lose the result; when it IS open, the editor + undo baseline
    // are resynced too. Body + ledger are built from the SAME task state so lengths can't drift.
    try { await persistPlan(plan, topic, planNote.tasks || [], { finalize: true }); } catch { /* best-effort */ }
    planners.delete(plan.id);
    renderList($('n-search').value);
    const done = (planNote.tasks || []).filter((t) => t.done).length;
    logActivity('Planner', `plan complete · ${done}/${(planNote.tasks || []).length} sub-tasks`);
    toast(`Plan orchestrated — ${done} sub-tasks done`);
  }
}

// The plan note as LABELED segments — one source of truth for both the rendered body and
// its authorship ledger, so they can't drift. The scaffold (title, live checklist, section
// headings) is the Planner's; each filled section is authored by its member (Researcher
// for research sub-tasks, Writer for the rest).
function planParts(goal, tasks) {
  const done = tasks.filter((t) => t.done).length;
  const checklist = tasks.map((t, i) => `- [${t.done ? 'x' : ' '}] ${i + 1}. ${t.title}${t.working ? ' — _working…_' : ''}`).join('\n');
  const parts = [{ author: 'Planner', text: `# ${goal}\n\n**Plan** — ${done}/${tasks.length} sub-tasks done\n\n${checklist}\n\n---\n\n` }];
  tasks.forEach((t, i) => {
    const who = t.role === 'research' ? 'Researcher' : 'Writer';
    parts.push({ author: 'Planner', text: `## ${i + 1}. ${t.title}\n\n` });
    parts.push({ author: t.output ? who : 'Planner', text: t.output || (t.working ? `_⏳ ${who} working…_` : '_pending_') });
    parts.push({ author: 'Planner', text: i < tasks.length - 1 ? '\n\n' : '\n' });
  });
  return parts;
}
function planBody(goal, tasks) {
  return planParts(goal, tasks).map((p) => p.text).join('');
}
// The authorship run-list matching planBody() exactly (sums to its length by construction).
function planAttribution(goal, tasks, at) {
  return mergeRuns(planParts(goal, tasks).map((p) => ({ len: p.text.length, author: p.author, at })));
}

// A research sub-task — token-free: history + WEB, formatted as cited bullets.
async function researchTaskMd(prompt, note) {
  const lines = [];
  try {
    if (!_ragMod) _ragMod = await import('./js/history-rag.js');
    const { results } = await _ragMod.retrieveHistory(prompt, { includeMeetings: true, limit: 3 });
    for (const r of results.filter((r) => r.sourceId !== `note:${note?.id}`).slice(0, 3)) {
      lines.push(`- ${sourceKind(r.sourceId) === 'note' ? `[[${r.title}]]` : `[${r.title}](${r.url})`} — ${researchSnippet(r.text)}`);
    }
  } catch { /* history best-effort */ }
  try {
    const [ws, lic, store] = await Promise.all([import('./js/web-search.js'), import('./js/license.js'), import('./js/store.js')]);
    const settings = await store.getSettings();
    const license = await lic.getLicense();
    const res = await ws.webSearch(prompt, ws.webSearchOpts(settings, lic.isPro(license)));
    for (const r of (res.results || []).slice(0, 4)) lines.push(`- 🌐 [${r.title || r.url}](${r.url}) — ${researchSnippet(r.text)}`);
  } catch (e) { lines.push(`- _web search unavailable: ${(e?.message || String(e)).slice(0, 80)}_`); }
  return lines.length ? lines.join('\n') : '_No sources found._';
}

// A write sub-task — the Writer (routed) drafts the section, streaming live.
async function writeTaskMd(deps, settings, license, redaction, goal, task, act, renderPlan) {
  const writer = await roleAgent(deps, settings, license, 'writer');
  const resolved = writer?.resolved || deps.resolveTarget(deps.getTarget(settings, settings.activeAgentId), settings);
  const sys = `You are drafting ONE section of a plan for the goal "${goal}". Write the section titled "${task.title}". Instruction: ${task.prompt}. Be concrete and actionable — bullets, - [ ] tasks, or a small table for options. Output ONLY the section's markdown content (no heading, no preamble).`;
  task.output = '';
  await deps.streamChat({
    agent: { ...resolved, systemPrompt: sys, maxTokens: 700, temperature: 0.5 },
    settings, redaction, signal: agentAbort.signal,
    messages: [{ role: 'user', content: task.prompt || task.title }],
    onDelta: (d) => { task.output += d; scheduleStreamRender(renderPlan); }, // one paint per frame
    onEvent: act.onEvent,
  });
}

// ── [[ wiki-link autocomplete (deterministic — links notes / chats / meetings) ────
let _crossTargets = null; // chat + meeting titles, lazy-loaded once (off the load path)
async function linkTargets() {
  const notes = list.map((n) => ({ title: n.title || 'Untitled note', type: 'note', url: `notes.html#${encodeURIComponent(n.id)}` }));
  if (!_crossTargets) {
    try {
      const [store, meet] = await Promise.all([import('./js/store.js'), import('./js/store-meetings.js')]);
      const chats = (await store.getIndex()).map((e) => ({ title: e.title || 'Chat', type: 'chat', url: `history.html#${encodeURIComponent(e.id)}` }));
      const meetings = (await meet.getMeetingIndex()).map((e) => ({ title: e.title || 'Meeting', type: 'meeting', url: `meetings.html#${encodeURIComponent(e.id)}` }));
      _crossTargets = [...chats, ...meetings];
    } catch { _crossTargets = []; }
  }
  return [...notes, ..._crossTargets];
}

const ac = { open: false, mode: 'link', items: [], index: 0, range: null };
function closeAc() { ac.open = false; ac.range = null; $('n-ac').classList.add('hidden'); }

// The [[…]] link query under the cursor, or null.
function currentWikiQuery() {
  if (bodyHasSelection()) return null;
  const pos = bodyCursor();
  const upto = bodyText().slice(0, pos);
  const open = upto.lastIndexOf('[[');
  if (open < 0) return null;
  const between = upto.slice(open + 2);
  if (/[[\]\n]/.test(between)) return null; // closed / not a bare query
  return { query: between, start: open + 2, end: pos };
}

// Pixel position of the caret (mirror-div technique) to anchor the dropdown.
function caretXY(ta) {
  const style = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderWidth', 'boxSizing']) div.style[p] = style[p];
  const rect = ta.getBoundingClientRect();
  Object.assign(div.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflow: 'hidden', width: `${ta.clientWidth}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const span = document.createElement('span');
  span.textContent = '​';
  div.appendChild(span);
  document.body.appendChild(div);
  const x = rect.left + span.offsetLeft;
  const y = rect.top + span.offsetTop - ta.scrollTop + (parseFloat(style.lineHeight) || 20);
  document.body.removeChild(div);
  return { x, y };
}

async function maybeAutocomplete() {
  // [[ document links (deterministic)
  const link = currentWikiQuery();
  if (link) {
    ac.mode = 'link';
    ac.range = link;
    const q = link.query.toLowerCase();
    const all = await linkTargets();
    if (ac.mode !== 'link' || !ac.range) return;
    ac.items = (q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all).slice(0, 8);
    ac.index = 0;
    return renderAc();
  }
  // @ — AI commands AND your configured agents (assign a task to a named agent).
  const at = currentAtQuery();
  if (at) {
    ac.mode = 'cmd';
    ac.range = at;
    const q = at.word.toLowerCase();
    const cmds = NOTE_COMMANDS
      .filter((c) => c.cmd.startsWith(q) || c.label.toLowerCase().startsWith(q))
      .map((c) => ({ cmd: c.cmd, hint: c.hint }));
    const agents = mentionTargets
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((t) => ({ agent: true, name: t.name }));
    ac.items = [...cmds, ...agents].slice(0, 10);
    ac.index = 0;
    return renderAc();
  }
  // # skills — insert a "#[Skill]" mention to scope a command/agent task to a saved skill.
  const hash = currentHashQuery();
  if (hash && mentionSkills.length) {
    const q = hash.word.toLowerCase();
    const items = mentionSkills.filter((s) => !q || s.name.toLowerCase().includes(q)).slice(0, 8);
    if (items.length) {
      ac.mode = 'skill';
      ac.range = hash;
      ac.items = items.map((s) => ({ skill: true, name: s.name }));
      ac.index = 0;
      return renderAc();
    }
  }
  // / command palette (agent actions)
  const slash = currentSlashQuery();
  if (slash) {
    ac.mode = 'slash';
    ac.range = slash;
    const q = slash.word.toLowerCase();
    ac.items = SLASH_ACTIONS.filter((a) => !q || a.key.startsWith(q) || a.label.toLowerCase().includes(q));
    ac.index = 0;
    return renderAc();
  }
  closeAc();
}

function renderAc() {
  const el = $('n-ac');
  if (!ac.range) return closeAc();
  el.innerHTML = '';
  if (!ac.items.length) {
    if (ac.mode === 'cmd' || ac.mode === 'slash' || ac.mode === 'skill') return closeAc();
    el.innerHTML = '<div class="ac-empty">No match — keep typing to name a new link</div>';
  } else {
    ac.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'ac-item' + (i === ac.index ? ' sel' : '');
      if (ac.mode === 'skill') d.innerHTML = `<span class="ac-badge skill-tag">#${escapeHtml(it.name)}</span><span class="ac-title">use this skill for the command/task</span>`;
      else if (ac.mode === 'cmd' && it.agent) d.innerHTML = `<span class="ac-badge agent">@${escapeHtml(it.name)}</span><span class="ac-title">assign a task to this agent</span>`;
      else if (ac.mode === 'cmd') d.innerHTML = `<span class="ac-badge cmd">@${it.cmd}</span><span class="ac-title">${escapeHtml(it.hint)}</span>`;
      else if (ac.mode === 'slash') d.innerHTML = `<span class="ac-badge slash">${iconForEmoji(it.icon) || escapeHtml(it.icon)}</span><span class="ac-title"><b>${escapeHtml(it.label)}</b> — ${escapeHtml(it.hint)}</span>`;
      else d.innerHTML = `<span class="ac-badge ${it.type}">${it.type}</span><span class="ac-title">${escapeHtml(it.title)}</span>`;
      d.onmousedown = (e) => { e.preventDefault(); ac.index = i; acceptAc(); };
      el.appendChild(d);
    });
  }
  let x; let y;
  if (cmActive && cm) { const c = cm.coordsAtCursor(); if (c) { x = c.left; y = c.bottom; } }
  if (x == null) { const p = caretXY($('n-body')); x = p.x; y = p.y; } // classic textarea (mirror-div)
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 372))}px`;
  el.style.top = `${y + 4}px`;
  el.classList.remove('hidden');
  ac.open = true;
}

function moveAc(dir) {
  if (!ac.items.length) return;
  ac.index = (ac.index + dir + ac.items.length) % ac.items.length;
  renderAc();
}
function acceptAc() {
  if (!ac.range) return closeAc();
  const it = ac.items[ac.index];
  const r = ac.range;
  // Replace the typed token (the @/#// sigil sits at start-1) and let bodyReplaceRange run
  // the input pipeline — works in both the classic textarea and the Live CM surface.
  if (ac.mode === 'cmd') {
    if (!it) return closeAc();
    closeAc();
    bodyReplaceRange(it.agent ? `@[${it.name}] ` : `@${it.cmd} `, r.start - 1, r.end);
    return;
  }
  if (ac.mode === 'slash') {
    if (!it) return closeAc();
    closeAc();
    bodyReplaceRange('', r.start - 1, r.end);
    it.run(); // act on its natural target (selection / line / note)
    return;
  }
  if (ac.mode === 'skill') {
    if (!it) return closeAc();
    closeAc();
    bodyReplaceRange(`#[${it.name}] `, r.start - 1, r.end);
    return;
  }
  const title = it ? it.title : r.query; // allow a new (unmatched) link name too
  // Close the wikilink if it isn't already (Live/CM doesn't auto-insert "]]" the way the
  // classic textarea did — without this, accepting left "[[Title" unclosed, so it "did
  // nothing" until you typed "]]" yourself). Caret lands past the "]]".
  const hasClose = bodyText().slice(r.end, r.end + 2) === ']]';
  closeAc();
  bodyReplaceRange(hasClose ? title : `${title}]]`, r.start, r.end, r.start + title.length + 2);
}

// ── @ commands — AI actions that generate/fetch and insert inline ────────────────
// Slice 1: a built-in set. Slice 2 will surface user Skills flagged "available in
// Notes". Commands with tools:true can fetch live data via web search.
const NOTE_COMMANDS = [
  { cmd: 'insert', label: 'Insert', hint: 'generate or fetch, then insert', tools: true, sys: 'You insert content into the user\'s note. Follow the instruction. If it needs current, live, or web data, USE the web_search tool to fetch it — never guess or use stale knowledge. Output ONLY the content to insert as clean GitHub-flavored markdown — no preamble, no closing remarks.' },
  { cmd: 'table', label: 'Table', hint: 'produce a markdown table', tools: true, sys: 'Produce the requested data as a GitHub-flavored markdown table. If it needs live/current data, USE the web_search tool. Output ONLY the table.' },
  { cmd: 'list', label: 'List', hint: 'produce a bullet/task list', tools: true, sys: 'Produce the requested content as a GitHub-flavored markdown list (use - [ ] for actionable tasks). Use web_search for live data. Output ONLY the list.' },
  { cmd: 'summarize', label: 'Summarize', hint: 'summarize a topic', tools: false, sys: 'Summarize the requested topic concisely in markdown. Output ONLY the summary.' },
  { cmd: 'translate', label: 'Translate', hint: 'translate to a language', tools: false, sys: 'Translate the requested text to the requested language, preserving markdown. Output ONLY the translation.' },
];
// Matches @command anywhere on the line (not just at the start) so it works mid-note.
const NOTE_CMD_RE = new RegExp(`@(${NOTE_COMMANDS.map((c) => c.cmd).join('|')})\\b[ \\t]*(.*)$`, 'i');

// The @word being typed at the cursor (start of line or after whitespace), or null.
function currentAtQuery() {
  if (bodyHasSelection()) return null;
  const v = bodyText(); const pos = bodyCursor();
  const line = v.slice(v.lastIndexOf('\n', pos - 1) + 1, pos);
  const m = line.match(/(?:^|\s)@(\w*)$/);
  if (!m) return null;
  return { word: m[1], start: pos - m[1].length, end: pos };
}

// ── "/" command palette — agent actions on the note / selection ───────────────────
// Each acts on its natural target (selection, current line, or note) so the SAME
// content can go inline OR into a new note depending on which you pick.
const SLASH_ACTIONS = [
  { key: 'plan', icon: '🧭', label: 'Plan in a new note', hint: 'spin this into a linked plan note the swarm works', run: () => planInNewNote() },
  { key: 'continue', icon: '✍️', label: 'Continue writing', hint: 'draft inline from here', run: () => runAgentAction('continue') },
  { key: 'research', icon: '🔎', label: 'Research this', hint: 'find related notes, chats & the web', run: () => runResearch({ web: true }) },
  { key: 'tasks', icon: '☑️', label: 'Turn into tasks', hint: 'selection → checklist', run: () => runAgentAction('tasks') },
  { key: 'summarize', icon: '📋', label: 'Summarize', hint: 'a tight summary', run: () => runAgentAction('summarize') },
  { key: 'improve', icon: '✨', label: 'Improve writing', hint: 'rewrite clearer', run: () => runAgentAction('improve') },
];
// The "/word" being typed at the cursor (line-start or after whitespace), or null.
function currentSlashQuery() {
  if (bodyHasSelection()) return null;
  const v = bodyText(); const pos = bodyCursor();
  const line = v.slice(v.lastIndexOf('\n', pos - 1) + 1, pos);
  const m = line.match(/(?:^|\s)\/(\w*)$/);
  if (!m) return null;
  return { word: m[1], start: pos - m[1].length, end: pos };
}
// The "#word" being typed (line-start or after whitespace) — the skill picker. Won't
// fire on a markdown heading ("# " has a space, breaking \w*).
function currentHashQuery() {
  if (bodyHasSelection()) return null;
  const v = bodyText(); const pos = bodyCursor();
  const line = v.slice(v.lastIndexOf('\n', pos - 1) + 1, pos);
  const m = line.match(/(?:^|\s)#(\w*)$/);
  if (!m) return null;
  return { word: m[1], start: pos - m[1].length, end: pos };
}

// The runnable "@command instruction" on the cursor's line, or null.
function currentCommandLine() {
  const v = bodyText(); const pos = bodyCursor();
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  let end = v.indexOf('\n', pos);
  if (end < 0) end = v.length;
  const line = v.slice(lineStart, end);
  const m = line.match(NOTE_CMD_RE);
  if (!m) return null;
  const spec = NOTE_COMMANDS.find((c) => c.cmd === m[1].toLowerCase());
  const instruction = (m[2] || '').trim();
  if (!spec || !instruction) return null;
  return { spec, instruction, start: lineStart + m.index, end }; // replace from the @ to line end
}

// An "@[Agent Name] task" mention on the cursor's line, or null — the bracket form lets
// agent names contain spaces, and the instruction may sit BEFORE or AFTER the token
// ("Update the plan @[Agent]" works, not just "@[Agent] update the plan"). Runs the
// named agent on the task (runAgentTask); the WHOLE line is replaced by the Q&A.
function currentMention() {
  const v = bodyText(); const pos = bodyCursor();
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  let end = v.indexOf('\n', pos);
  if (end < 0) end = v.length;
  const { name, task } = parseAgentMention(v.slice(lineStart, end));
  if (!name || !task) return null;
  return { name, task, start: lineStart, end };
}

// ── @insert / @command background jobs ──────────────────────────────────────────
// An @command (e.g. `@insert …`) runs as a BACKGROUND job keyed by note id — it is
// NOT tied to the open editor. Switching notes no longer kills it: the job keeps
// streaming, persists its result to the note store on completion (so it lands even
// if you never reopen the note), and RE-ATTACHES its live progress to the editor
// whenever its note is opened. Each job streams a rich activity trace (model, tool
// calls, partial output) so it's always obvious what's happening.
const noteJobs = new Map(); // noteId -> job
let _jobStarting = false; // synchronous single-flight lock: a job is being set up (before it
// registers in noteJobs). Without it, rapid Enter presses each pass the noteJobs guard during
// the async model/bridge/tool setup and spawn DUPLICATE jobs (the "rewritten again and again").
let _jobSeq = 0; // unique id per job → its CM region id (for the multi-agent editor)
// noteJobs is keyed per-JOB (a note can have several concurrent region jobs). Helpers:
const jobsForNote = (id) => { const out = []; for (const j of noteJobs.values()) if (j.noteId === id) out.push(j); return out; };
const noteHasJob = (id) => jobsForNote(id).some(Boolean);                    // any job running on the note
const noteHasBlockingJob = (id) => jobsForNote(id).some((j) => !j.region);   // a Source/global-lock job (blocks new starts + editing)
const lastJobForNote = (id) => { const j = jobsForNote(id); return j[j.length - 1] || null; };

// What the note's body should hold once the job is finished (or dropped): the
// produced output, or — if it errored before producing anything — the original
// command line, so the user can retry rather than losing their instruction.
function jobFinalMid(job) {
  if (job.error && !job.out.trim()) return job.commandText; // nothing produced → restore the command
  return (job.answerPrefix || '') + job.out;                 // @mention keeps the question (prefix) above the answer
}

// What shows IN the note while a command runs: just the streaming output as it
// arrives, or a single-line placeholder before the first token. The full tool trace
// (model, armed tools, each call + its result) lives in the persistent activity
// panel below the editor — not stuffed into the note body.
function jobProgressText(job) {
  if (job.done) return jobFinalMid(job);
  const pre = job.answerPrefix || '';
  if (job.out) return pre + job.out;
  const icon = JOB_ICON[job.status] || '⏳';
  return `${pre}${icon} @${job.cmd} — ${job.statusText}`;
}

// Mirror a running job into the editor — ONLY when its note is the open one. Keyed
// by note id (not object identity), so reopening the same note re-attaches even
// though getNote() returns a fresh record.
let _jobRaf = null;
function renderJob(job) {
  if (current?.id !== job.noteId) return;
  const ta = $('n-body');
  ta.value = job.head + jobProgressText(job) + job.tail;
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  streamFollow(); // stick to the tail only while the user is already at the bottom
}
function scheduleJobRender(job) {
  if (current?.id !== job.noteId || _jobRaf) return;
  _jobRaf = requestAnimationFrame(() => { _jobRaf = null; renderJob(job); });
}

// Re-attach the editor to an already-running textarea job (from openNote).
function attachEditorToJob(job) {
  $('n-body').readOnly = true;
  renderJob(job);
}

// ── Background region jobs — survive a note switch ────────────────────────────────
// A region job streams into the LIVE CM surface, which can't follow a note switch. So when
// you leave its note it DETACHES: it keeps streaming into an in-memory buffer + persists to
// the note's store. When you come back it RE-ATTACHES: the buffer is re-opened as a live
// region and streaming continues on-screen. The note list shows a working indicator meanwhile.
async function persistDetachedBody(job) {
  const rec = current?.id === job.noteId ? current : await getNote(job.noteId);
  if (!rec) return;
  const body = job.detachedDoc ?? (job.head + (job.answerPrefix || '') + job.out + job.tail);
  const saved = await saveNote({ id: rec.id, title: rec.title, body, tags: rec.tags, createdAt: rec.createdAt, attribution: rec.attribution, versions: rec.versions });
  Object.assign(rec, saved, { body });
  updateEntry(rec);
  renderList($('n-search').value);
}
function scheduleDetachedSave(job) {
  clearTimeout(job._saveTimer);
  job._saveTimer = setTimeout(() => persistDetachedBody(job).catch(() => {}), 400);
}
// Append a streamed token to a detached (backgrounded) job's buffer at the answer's end.
function appendDetached(job, d) {
  if (job.detachedDoc == null) {
    const before = job.head + (job.answerPrefix || '');
    job.detachedDoc = before + job.out + job.tail; // job.out already includes d
    job.detachedAt = before.length + job.out.length;
    job.detached = true;
  } else {
    job.detachedDoc = job.detachedDoc.slice(0, job.detachedAt) + d + job.detachedDoc.slice(job.detachedAt);
    job.detachedAt += d.length;
  }
  scheduleDetachedSave(job);
}
// Leaving the job's note: snapshot the live doc + the region's end, drop the widget, keep running.
function detachRegionJob(job) {
  if (!cm) return;
  const r = activeRegions(cm.view.state).find((x) => x.id === job.regionId);
  job.detachedDoc = cm.value;
  job.detachedAt = r ? r.to : ((job.regionFrom || 0) + job.out.length);
  job.detached = true;
  finishRegion(cm.view, job.regionId); // remove the animated widget from this (about-to-switch) CM
}
// Returning to the job's note: the store (now in CM) holds the streamed-so-far body; re-open
// the region over the answer span so streaming shows live again.
function reattachRegionJob(job) {
  if (!cm) return;
  const from = Math.max(0, Math.min(job.regionFrom || 0, cm.value.length));
  const to = Math.max(from, Math.min(job.detachedAt ?? (from + job.out.length), cm.value.length));
  beginRegion(cm.view, job.regionId, job.modelLabel, from, to);
  job.detached = false;
}

// ── Command activity panel — the persistent tool-call trace (per note) ────────────
// "Which tools ran and what they returned" lives HERE, not in the note body, and
// SURVIVES completion + note switches — so a wrong result (e.g. the wrong meeting)
// stays inspectable. Mirrors the chat panel's tool cards. Keyed by note id; the live
// job IS the activity while running, and its final state persists after.
const noteActivity = new Map();       // noteId -> activity (the job, live or finished)
const activityCollapsed = new Set();  // noteIds the user has collapsed

let _actRaf = null;
function scheduleActivityRender() {
  if (_actRaf) return;
  _actRaf = requestAnimationFrame(() => { _actRaf = null; renderActivity(); });
}
// One emoji per team member / actor, so the timeline reads at a glance.
function activityIcon(who) {
  const w = String(who || '').toLowerCase();
  if (w.startsWith('editor')) return '✍️';
  if (w.startsWith('research')) return '🔎';
  if (w.startsWith('writer')) return '✨';
  if (w.startsWith('fact')) return '⚠️';
  if (w.startsWith('connector')) return '🔗';
  if (w.startsWith('planner')) return '🧭';
  if (w.startsWith('autocomplete')) return '⌨️';
  return '🤖'; // an @command / @mention agent
}
// The unified Team-activity panel: a TIMELINE of every AI action + completion (ambient
// roles AND directed @commands / @mentions), plus the tool-call DETAIL (args + results)
// of the most recent tool-using run. Persistent per note; the single place to see what
// the AI is doing and has done.
function renderActivity() {
  const panel = $('n-activity');
  if (!panel) return;
  refreshSideTabs();
  const a = current && noteActivity.get(current.id);
  const log = board.log;
  const running = a && !a.done;
  const statusEl = $('n-activity-status');
  statusEl.classList.toggle('running', !!running);
  statusEl.textContent = running ? (a.statusText || 'working…') : `${log.length} action${log.length === 1 ? '' : 's'}`;
  $('n-activity-pii').classList.toggle('hidden', !(a && a.redacted));

  // Timeline — every AI action + completion.
  const tl = $('n-activity-timeline');
  tl.innerHTML = log.length
    ? log.map((e) =>
        `<div class="tlrow"><span class="tlrow-ico">${(g => iconForEmoji(g) || escapeHtml(g))(activityIcon(e.who))}</span>`
        + `<span class="tlrow-who">${escapeHtml(e.who)}</span>`
        + `<span class="tlrow-what">${escapeHtml(e.what)}${e.n > 1 ? ` ×${e.n}` : ''}</span>`
        + `<span class="tlrow-when">${escapeHtml(relTime(e.at))}</span></div>`).join('')
    : (a ? '' : '<div class="activity-armed">No actions yet — the team logs here as it proofreads, researches, drafts and runs your @commands.</div>');

  // Detail — the tool-call trace of the most recent tool-using run.
  const detail = $('n-activity-detail');
  const wrap = $('n-activity-cards');
  wrap.innerHTML = '';
  if (a && (a.steps.length || a.tools?.length)) {
    detail.classList.remove('hidden');
    detail.textContent = `${a.label || `@${a.cmd}`}${a.modelLabel ? ` · ${a.modelLabel}` : ''} · `
      + (a.done ? (a.error ? `error: ${a.error}` : `${a.steps.length} tool call${a.steps.length === 1 ? '' : 's'}`) : (a.statusText || 'working…'));
    $('n-activity-armed').textContent = a.tools?.length ? `armed: ${prettyTools(a.tools)}` : '';
    if (!a.steps.length) {
      const empty = document.createElement('div');
      empty.className = 'activity-armed';
      empty.textContent = running ? 'Waiting for the model to call a tool…' : 'No tools were called — answered from the model’s own knowledge.';
      wrap.appendChild(empty);
    }
    for (const s of a.steps) {
      const state = s.status === 'error' ? 'err' : (s.done ? 'ok' : 'run');
      const mark = s.status === 'error' ? '✗' : (s.done ? '✓' : '…');
      const arg = s.input != null ? compactInput(s.input, 240) : '';
      const res = s.result != null ? String(s.result) : '';
      const card = document.createElement('div');
      card.className = `acard ${state}`;
      card.innerHTML =
        `<div class="acard-top"><span class="acard-ico">${(g => iconForEmoji(g) || escapeHtml(g))(stepIcon(s))}</span>` +
        `<span class="acard-name">${escapeHtml(toolTitle(s.tool))}</span>` +
        `<span class="acard-mark">${mark}</span></div>` +
        (arg ? `<div class="acard-arg"><code>${escapeHtml(arg)}</code></div>` : '') +
        (res ? `<details class="acard-res"><summary>result (${res.length} chars)</summary><pre>${escapeHtml(res.slice(0, 4000))}${res.length > 4000 ? '\n…(truncated)' : ''}</pre></details>` : '');
      wrap.appendChild(card);
    }
  } else {
    detail.classList.add('hidden');
    $('n-activity-armed').textContent = '';
  }
}
// Reveal the Team-activity tab (from the footer status strip / on a new job).
function revealActivity() { setSideTab('activity'); }
// The activity panel only earns its space when a command armed tools; a plain
// summarize/translate (no tools) leaves it hidden.
function recordActivity(job) { if (job.tools.length || job.steps.length) noteActivity.set(job.noteId, job); }

// Stream a swarm member's live agent activity (tool calls / subagents / reasoning) into
// the SAME collapsible activity widget the @commands use — never into the note body, so
// nothing the user wants to keep gets overwritten. The trace is created lazily on the
// first tool/subagent event, so a plain API model (no tools) shows no widget at all.
// Handles both shapes: API tools ({phase:'start'|'done', callId, input, result}) and a
// bridge agent's own tools ({name, summary} with no phase — a single completed step).
function makeSwarmActivity(noteId, label, modelLabel, redacted) {
  const ctx = { trace: null };
  const ensure = () => {
    if (!ctx.trace) {
      ctx.trace = { kind: 'cowriter', label, cmd: label, modelLabel, tools: [], steps: [], done: false, statusText: 'working…', redacted, error: null };
      noteActivity.set(noteId, ctx.trace);
      if (current?.id === noteId) activityCollapsed.delete(noteId); // reveal it while working
    }
    return ctx.trace;
  };
  ctx.onEvent = (ev) => {
    if (!ev) return;
    if (ev.type === 'tool') {
      const t = ensure();
      if (ev.phase === 'done') {
        const step = ev.callId ? t.steps.find((s) => s.callId === ev.callId) : t.steps[t.steps.length - 1];
        if (step) { step.done = true; step.status = ev.status; step.result = ev.result; }
        t.statusText = 'working…';
      } else {
        t.statusText = /search/i.test(ev.name || '') ? 'searching…' : `${toolTitle(ev.name)}…`;
        t.steps.push({ tool: ev.name, input: ev.input ?? ev.summary, callId: ev.callId, done: ev.phase !== 'start', status: ev.status, result: ev.result });
      }
      scheduleActivityRender();
    } else if (ev.type === 'reasoning') { ensure().statusText = 'thinking…'; scheduleActivityRender(); }
    else if (ev.type === 'status' && ev.text) { ensure().statusText = String(ev.text).slice(0, 60); scheduleActivityRender(); }
  };
  ctx.done = (err) => { if (ctx.trace) { ctx.trace.done = true; ctx.trace.error = err || null; if (current?.id === noteId) scheduleActivityRender(); } };
  return ctx;
}

// Persist a job's current body to the store — id-keyed, so it works whether or not
// the note is open. On completion the result lands even for a note you never reopen.
async function persistJobBody(job) {
  const rec = current?.id === job.noteId ? current : await getNote(job.noteId);
  if (!rec) return;
  const body = job.head + jobFinalMid(job) + job.tail;
  const saved = await saveNote({ id: rec.id, title: rec.title, body, tags: rec.tags, createdAt: rec.createdAt, attribution: rec.attribution, versions: rec.versions });
  Object.assign(rec, saved, { body });
  updateEntry(rec);
  renderList($('n-search').value);
}

// The note itself (minus the command line) as grounding context, so an instruction
// like "action items for this meeting" resolves against what's ACTUALLY in the note —
// a linked meeting's #id, a date, a [[wikilink]] — instead of the model free-searching
// history and grabbing the wrong one. Capped to bound tokens; redacted by the harness.
function noteCommandContext(head, tail) {
  const body = `${head}\n${tail}`.replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return '';
  const MAX = 4000;
  const clipped = body.length > MAX ? `${body.slice(0, MAX)}\n…(note truncated)` : body;
  const title = (current?.title || '').trim();
  return `The note I'm editing${title ? ` (title: "${title}")` : ''} is below. Resolve any reference in my instruction — "this meeting", a date, a name, a [[wikilink]] or a URL (a meeting link's #id identifies that exact meeting) — against THIS note, not a guess. If a tool lets you fetch something referenced here by id, use that id.\n\n"""\n${clipped}\n"""`;
}

// The OTHER configured agents that are participating in THIS note — detected by their
// `**Name:**` answer headers or `@[Name]` mentions in the body. Lets an @mentioned agent
// know it's co-writing a SHARED note with named siblings (not working solo), so it can
// answer "who else is working here?" correctly instead of "only I am active".
function noteCollaborators(body, settings, selfName) {
  const lc = String(body || '').toLowerCase();
  const self = String(selfName || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const t of [...(settings.endpoints || []), ...(settings.agents || [])]) {
    const name = (t.name || '').trim();
    const key = name.toLowerCase();
    if (!name || key === self || seen.has(key)) continue;
    if (lc.includes(`**${key}:**`) || lc.includes(`@[${key}]`)) { seen.add(key); out.push(name); }
  }
  return out;
}

async function runNoteCommand() {
  const ctx = currentCommandLine();
  if (!ctx || !current || noteHasBlockingJob(current.id)) return false; // a Source/global-lock job is running
  const useRegion = cmActive && !!cm;
  if (!useRegion) { if (_jobStarting) return false; _jobStarting = true; } // Source: one job at a time
  closeAc();
  const ta = $('n-body');
  const noteId = current.id; // bind the job to THIS note — setup below may span a note switch
  const head = ta.value.slice(0, ctx.start);
  const tail = ta.value.slice(ctx.end);
  const commandText = ta.value.slice(ctx.start, ctx.end);
  const label = `@${ctx.spec.cmd}`;
  // Same region path as @mentions in Live — the command's OUTPUT streams into a region where
  // the command was (no global lock, animated widget); classic textarea placeholder in Source.
  const regionId = useRegion ? `job-${++_jobSeq}` : null;
  if (useRegion) {
    bodyReplaceRange('', ctx.start, ctx.end, ctx.start); // remove the "@cmd …" line — output replaces it
    beginRegion(cm.view, regionId, label, ctx.start);
  } else {
    ta.value = `${head}⏳ ${label} — starting…${tail}`; // immediate ack + global lock
    ta.readOnly = true;
    mirrorToCm();
  }
  setStatus(`Running ${label}…`);
  setSideTab('activity');
  const fail = (msg) => {
    if (useRegion && cm) { finishRegion(cm.view, regionId); bodyReplaceRange(commandText, ctx.start, ctx.start, ctx.end); }
    else { ta.value = head + commandText + tail; ta.readOnly = false; mirrorToCm(); _jobStarting = false; }
    setStatus(''); bodyFocus(); toast(msg); return true;
  };
  try {
    let deps;
    try { deps = await agentDeps(); } catch { return fail('Agent unavailable'); }
    const settings = await deps.getSettings();
    const targetAgent = deps.getTarget(settings, settings.activeAgentId);
    if (!targetAgent) return fail('Set up a model in ChatPanel settings first');
    const license = await deps.getLicense();
    if (!deps.canUseAgent(license, settings, targetAgent)) return fail('That agent needs ChatPanel Pro');
    const resolved = deps.resolveTarget(targetAgent, settings);
    // A "#[Skill]" mention in the instruction scopes the tools + folds in the skill's prompt.
    const skill = resolveSkillMention(ctx.instruction, settings, license, deps);
    await runNoteJob({
      deps, settings, license, targetAgent, resolved, head, tail, commandText, noteId,
      cmdLabel: ctx.spec.cmd, systemPrompt: ctx.spec.sys, instruction: skill.instruction,
      armToolset: !!ctx.spec.tools, skillRun: skill.skillRun, regionId, regionFrom: useRegion ? ctx.start : 0,
      versionLabel: `@${ctx.spec.cmd}${skill.skillLabel ? ` #${skill.skillLabel}` : ''} · ${targetAgent.name || resolved.model || 'agent'}`,
    });
  } finally { if (!useRegion) _jobStarting = false; }
  return true;
}

// Shared background-job runner for @commands AND @agent-mentions: streams a model into
// the note where the command was written, drives the activity panel, attributes the
// output to the model in the provenance ledger, and persists — reused so the two paths
// never drift. `makeExtraProviders(job)` lets the caller add tools (e.g. the note-write
// provider) that need a reference to the live job.
async function runNoteJob({
  deps, settings, license, targetAgent, resolved,
  head, tail, commandText, cmdLabel, systemPrompt, instruction,
  makeExtraProviders = null, armToolset = true, maxTokens = 1800, temperature = 0.4, versionLabel, skillRun = null, answerPrefix = '', regionId = null, regionFrom = 0, noteId = current?.id,
}) {
  const ta = $('n-body');
  // regionId set + Live active → stream into a CM region (animated widget, NO global lock, you
  // can edit elsewhere). The region + its widget were already opened by the caller.
  const region = !!regionId && cmActive && !!cm;
  // Bind to the note the run was LAUNCHED from (passed by the caller, captured with head/tail),
  // NOT `current` now — the caller's async setup (deps/tools) can span a note switch, and reading
  // `current` here would bind the job to the WRONG note: its A-note output would then persist onto
  // B (corrupting it) while A silently loses the answer. `noteId` keeps head/tail/target aligned.
  const job = {
    id: regionId || `job-${++_jobSeq}`, noteId: noteId || current?.id, cmd: cmdLabel, instruction,
    head, tail, commandText, answerPrefix, out: '', steps: [], tools: [],
    region, regionId, regionFrom, detached: false, detachedDoc: null, detachedAt: 0,
    redacted: false, status: 'starting', statusText: 'starting…',
    modelLabel: targetAgent.name || resolved.model || resolved.bridgeAgent || 'agent',
    abort: new AbortController(), done: false, error: null,
  };
  // Build the toolset (job exists first so extra providers can bind to it), armed the
  // SAME way the side panel is (web + history + MCP, per-Notes overrides) + any extras.
  let tools = null;
  const extraProviders = makeExtraProviders ? makeExtraProviders(job) : [];
  if (armToolset || extraProviders.length || skillRun) {
    try {
      const bridge = await deps.checkBridge(settings.bridgeUrl).catch(() => ({ ok: false }));
      const nt = settings.ui?.notes?.tools || {};
      tools = await deps.buildTurnTools({
        resolvedAgent: resolved, settings, license,
        bridgeUrl: settings.bridgeUrl, bridgeAvailable: !!bridge?.ok, userText: instruction,
        includeWebSearch: armToolset && nt.webSearch !== false,
        includeMcp: armToolset && nt.mcp !== false,
        includeHistory: armToolset && nt.history !== false,
        skillRun, // a #skill mention scopes tools + adds its guidance
        extraProviders,
      });
    } catch { /* fall back to no tools */ }
  }
  // PII redaction wraps EVERY note→model call — the harness must never be skipped.
  let redaction = null;
  try { redaction = deps.buildRedaction({ settings, license }); } catch { /* redaction off */ }
  job.tools = (tools?.specs || []).map((s) => s.name).filter(Boolean);
  job.redacted = !!redaction;
  const noteCtx = noteCommandContext(head, tail); // ground in the note's own content

  noteJobs.set(job.id, job);
  recordActivity(job);
  // Guaranteed restore point: snapshot the PRISTINE note (before the header/placeholder the
  // caller just inserted, and before any output streams) so the run is always revertible even
  // if its region is dropped before completion — deduped, so a no-op run adds nothing. Only when
  // the launch note is still open (pushVersion targets `current`); if we already switched away,
  // skip it rather than snapshot onto the wrong note.
  if (current?.id === job.noteId) pushVersion(HUMAN, `Before ${cmdLabel}`, head + commandText + tail);
  if (!region) {
    ta.readOnly = true;            // textarea path: whole editor is read-only while it streams
    streamStart();                 // scroll-anchoring for the mirror path
    renderJob(job);
  } // region path: no global lock, CM auto-scrolls each append
  setSideTab('activity'); // surface the run in the sidebar
  renderList($('n-search').value);
  try {
    await deps.streamChat({
      agent: { ...resolved, systemPrompt, maxTokens, temperature },
      settings,
      signal: job.abort.signal,
      tools,
      redaction,
      messages: [{ role: 'user', content: noteCtx ? `${noteCtx}\n\n---\nInstruction: ${instruction}` : instruction }],
      onDelta: (d) => {
        job.out += d; job.status = 'writing'; job.statusText = 'writing…';
        if (region) {
          const live = current?.id === job.noteId && cm && !job.detached && activeRegions(cm.view.state).some((r) => r.id === regionId);
          if (live) appendRegion(cm.view, regionId, d);   // note open → stream into the live region
          else appendDetached(job, d);                    // note switched away → buffer + persist to store
        } else scheduleJobRender(job);
        scheduleActivityRender();
      },
      onEvent: (ev) => {
        if (ev?.type === 'tool' && ev.phase === 'start') {
          job.status = 'tool';
          job.statusText = ev.name === 'web_search' ? 'searching the web…' : `${ev.name || 'tool'}…`;
          job.steps.push({ tool: ev.name || 'tool', input: ev.input, callId: ev.callId, done: false });
        } else if (ev?.type === 'tool' && ev.phase === 'done') {
          const step = ev.callId ? job.steps.find((s) => s.callId === ev.callId) : job.steps[job.steps.length - 1];
          if (step) { step.done = true; step.status = ev.status; step.result = ev.result; }
          job.status = 'writing'; job.statusText = 'writing…';
        } else if (ev?.type === 'reasoning') {
          job.status = 'thinking'; job.statusText = 'thinking…';
        }
        recordActivity(job);
        if (!region) scheduleJobRender(job);
        scheduleActivityRender();
      },
    });
  } catch (e) {
    if (!job.abort.signal.aborted) { job.error = e?.message || String(e); toast(`Command error: ${job.error}`); }
  } finally {
    const aborted = job.abort.signal.aborted;
    job.done = true;
    noteJobs.delete(job.id);
    const open = current?.id === job.noteId;
    if (region) {
      // Region job. If its note is OPEN, do the authoritative save + snapshot here — gated ONLY on
      // the note being open, NOT on the region still being "live". A region can be dropped mid-run
      // (an edit at its boundary, the position-mapping filter); gating persistence on region
      // survival used to lose the WHOLE run's output. `cm.value` is normally the truth, but if the
      // stream got diverted to the detached buffer mid-run (region dropped while you stayed on the
      // note), cm is missing the tail — the buffer holds the complete output, so prefer it and
      // mirror it back. If it finished while DETACHED (you were on another note), land the buffer.
      if (open && cm) {
        finishRegion(cm.view, regionId);
        const complete = job.head + jobFinalMid(job) + job.tail; // full output from the job buffers
        const body = (job.detachedDoc != null && complete.length > cm.value.length) ? complete : cm.value;
        if (cm.value !== body) mirrorToCm(body); // repair the live surface if the stream had diverted
        current.body = $('n-body').value = body;
        if (!aborted && !job.error && job.out.trim()) {
          pushVersion(job.modelLabel, versionLabel || `${cmdLabel} · ${job.modelLabel}`);
          logActivity(job.modelLabel, job.cmd.startsWith('@') ? 'completed a task' : `@${job.cmd} inserted`);
        }
        histCoalescing = false; // the completed run is a clean undo unit — the next edit starts fresh
        updateWordCount();
        setStatus(aborted ? '' : 'Saved', !aborted);
        renderActivity();
        renderHistory();
        dirty = true;
        await flushSave();
      } else {
        clearTimeout(job._saveTimer);
        if (job.detachedDoc != null) await persistDetachedBody(job); // finished in the background
        if (!aborted && !job.error) logActivity(job.modelLabel, 'completed a task');
      }
    } else {
      if (open) {
        $('n-body').readOnly = false;
        renderJob(job); // collapse the progress block down to the final output
        if (!aborted && !job.error) {
          recordEdit({ author: job.modelLabel, discrete: true }); // attribute the produced text
          pushVersion(job.modelLabel, versionLabel || `${cmdLabel} · ${job.modelLabel}`);
          logActivity(job.modelLabel, job.cmd.startsWith('@') ? 'completed a task' : `@${job.cmd} inserted`);
        }
        current.body = $('n-body').value;
        updateWordCount();
        setStatus(aborted ? '' : 'Saved', !aborted);
        renderActivity();
        renderHistory();
      }
      await persistJobBody(job); // lands the result (+ ledger) even if the note isn't open
    }
    renderList($('n-search').value);
  }
  return job;
}

// @mention an agent to run a task in the note. `@[Agent Name] do X` → resolve the named
// agent, arm note-write tools (create new notes / edit this one) + research/web/history,
// and run it as a background job. Its streamed output lands where the mention was; tool
// actions create/edit notes on the side. All attributed to the agent + revertible.
async function runAgentTask(mention) {
  if (!current || noteHasBlockingJob(current.id)) return true; // a Source/global-lock job is running
  const useRegion = cmActive && !!cm;
  if (!useRegion) { if (_jobStarting) return true; _jobStarting = true; } // Source: one job at a time
  closeAc();
  const ta = $('n-body');
  const noteId = current.id; // bind the job to THIS note — setup below may span a note switch
  const head = ta.value.slice(0, mention.start);
  const tail = ta.value.slice(mention.end);
  const commandText = ta.value.slice(mention.start, mention.end);
  const question = (mention.task || '').split('\n').map((l) => `> ${l}`).join('\n');
  const prefix = `${question}\n\n**${mention.name}:**\n\n`;
  const regionId = useRegion ? `job-${++_jobSeq}` : null;
  // IMMEDIATE, deterministic ack — the instant Enter is pressed, before the (possibly slow)
  // deps/bridge/tool setup, so it's obvious the request was taken and you don't press again.
  if (useRegion) {
    // Live: replace the mention line with the Q&A header, then open an (empty, animated)
    // region for the answer. NO global lock — the region guard protects only the answer span,
    // so you can keep editing elsewhere while the agent works.
    const regionStart = mention.start + prefix.length;
    bodyReplaceRange(prefix, mention.start, mention.end, regionStart);
    beginRegion(cm.view, regionId, mention.name, regionStart);
    // Park the caret on a fresh line below the region so the user can immediately keep
    // typing / invoke another agent instead of being stuck inside the streaming answer.
    parkCaretBelowRegion(regionStart);
  } else {
    ta.value = `${head}${prefix}⏳ starting…${tail}`; // classic textarea placeholder + global lock
    ta.readOnly = true;
    mirrorToCm();
  }
  setStatus(`Sending to ${mention.name}…`);
  setSideTab('activity');
  const fail = (msg) => {
    if (useRegion && cm) { finishRegion(cm.view, regionId); bodyReplaceRange(commandText, mention.start, mention.start + prefix.length, mention.end); }
    else { ta.value = head + commandText + tail; ta.readOnly = false; mirrorToCm(); _jobStarting = false; }
    setStatus(''); bodyFocus(); toast(msg); return true;
  };
  try {
    let deps;
    try { deps = await agentDeps(); } catch { return fail('Agent unavailable'); }
    const settings = await deps.getSettings();
    const targetAgent = getTargetByName(settings, mention.name);
    if (!targetAgent) return fail(`No configured agent named “${mention.name}”`);
    const license = await deps.getLicense();
    if (!deps.canUseAgent(license, settings, targetAgent)) return fail(`${targetAgent.name || 'That agent'} needs ChatPanel Pro`);
    const resolved = deps.resolveTarget(targetAgent, settings);
    const sys = `You are "${targetAgent.name || 'the agent'}", completing a task INSIDE the user's note. Use your tools to do it well:\n`
      + '- research with web_search / history tools when you need facts or the user\'s own material;\n'
      + '- note_create to spin off a NEW note — do this whenever the user asks for a new / separate / standalone / printable note (if they say "notes", create one per note, e.g. one per category), or when a substantial self-contained piece truly belongs on its own page. When the user asked for a separate note, put the real content in that note (not inline) and let your streamed reply be a short confirmation with the [link](notes.html#id). Otherwise write inline. NEVER create an empty note or one that just links back to this note;\n'
      + '- note_edit to revise the user\'s EXISTING text in THIS note (exact find/replace).\n'
      + 'Your streamed text is inserted where the task was written — use it for the main answer (or a brief confirmation when the substance went into a new note via note_create), tools for side effects. Output clean GitHub-flavored markdown, no preamble or meta commentary.';
    // Swarm awareness: if other named agents have sections/mentions in THIS note, tell the
    // agent it's co-writing a shared doc with them — otherwise it claims to be the only one.
    const mates = noteCollaborators(`${head}\n${tail}`, settings, targetAgent.name);
    const teamSys = mates.length
      ? `\n\nYou are co-writing this SHARED note alongside other AI agents: ${mates.join(', ')}. Each agent's replies appear under its own "**Name:**" header — treat those sections as written by them, not you. If the user asks who else is working here, answer with that roster; never claim you're the only agent.`
      : '';
    // Honor a "#[Skill]" mention in the task (scoped tools + the skill's prompt).
    const skill = resolveSkillMention(mention.task, settings, license, deps);
    // Keep the user's question in the note (as a blockquote), with the agent's answer
    // BELOW it — a readable Q&A trail, instead of the answer replacing the question.
    await runNoteJob({
      deps, settings, license, targetAgent, resolved, head, tail, commandText, noteId,
      cmdLabel: `@${targetAgent.name || 'agent'}`, systemPrompt: sys + teamSys, instruction: skill.instruction,
      armToolset: true, maxTokens: 2400, skillRun: skill.skillRun, regionId, regionFrom: useRegion ? mention.start + prefix.length : 0,
      answerPrefix: `${question}\n\n**${targetAgent.name || 'Agent'}:**\n\n`,
      makeExtraProviders: (job) => [makeNoteTools(job)],
      versionLabel: `@${targetAgent.name || 'agent'}${skill.skillLabel ? ` #${skill.skillLabel}` : ''} · task`,
    });
  } finally { if (!useRegion) _jobStarting = false; }
  return true;
}

// Resolve a "#[Skill]" mention in an instruction: strip the token, and if it names a
// configured skill, merge the skill's saved prompt with the task + return its skillRun
// (tool scope). Unknown skill → just the cleaned instruction, no skillRun.
function resolveSkillMention(instruction, settings, license, deps) {
  const { name, text } = parseSkillMention(instruction);
  if (!name) return { instruction: text, skillRun: null, skillLabel: '' };
  const skill = findSkillByName(settings.skills, name);
  if (!skill) return { instruction: text, skillRun: null, skillLabel: '' };
  const skillRun = deps.skillRunFromSkill(skill, { includeMeetings: !!deps.can?.(license, 'liveMeetings') });
  return { instruction: mergeSkillPrompt(skill.prompt, text), skillRun, skillLabel: skill.name || skill.title || name };
}

// Resolve a mentioned target by NAME (endpoints + agents), exact first, then contains,
// then by model/bridge id.
function getTargetByName(settings, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const all = [...(settings.endpoints || []), ...(settings.agents || [])];
  return all.find((t) => (t.name || '').toLowerCase() === q)
    || all.find((t) => (t.name || '').toLowerCase().includes(q))
    || all.find((t) => String(t.model || t.bridgeAgent || '').toLowerCase() === q)
    || null;
}

// The note-write tool provider handed to a mentioned agent. Bound to the live job so
// note_edit can revise the surrounding text (head/tail) mid-run without fighting the
// streamed output; all changes are attributed to the agent when the job completes.
function makeNoteTools(job) {
  const specs = [
    {
      name: 'note_create',
      description: 'Create a NEW standalone note, with the content in `body`. USE THIS whenever the user asks for a new / separate / standalone / printable note (or "notes" — then call it once per note, e.g. one per category), or when a substantial self-contained piece clearly belongs on its own page. When the user asks for a separate note, the content goes in `body` here — do NOT also write it inline. Otherwise default to writing inline in the current note. Do NOT create a note that is empty or whose body is just a link back to the current note (that call is rejected). `body` must be real markdown prose. Returns the new note id + a notes.html#id link to reference as [markdown](link).',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 'Optional; first line is used if omitted.' }, body: { type: 'string', description: 'GitHub-flavored markdown.' } }, required: ['body'] },
    },
    {
      name: 'note_edit',
      description: "Revise the CURRENT note by replacing an exact snippet of its EXISTING text (not the part you're writing). `find` must be an exact substring of the note. Returns ok, or an error if `find` was not found.",
      parameters: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] },
    },
  ];
  const execute = async (name, input) => {
    try {
      if (name === 'note_create') {
        const title = String(input?.title || '').trim();
        let body = String(input?.body || '');
        // Guard: never materialize an EMPTY or link-only note. The model otherwise calls
        // note_create reflexively and leaves behind a blank note (or one whose whole body is
        // just a [[backlink]] to the doc it's working on) — clutter the user never asked for.
        // Require real prose: strip [[wikilinks]] + [text](url) links, then demand a letter/digit.
        const prose = body
          .replace(/\[\[[^\]\n]*\]\]/g, ' ')
          .replace(/\[[^\]\n]*\]\([^)\s]*\)/g, ' ');
        if (!/[\p{L}\p{N}]/u.test(prose)) {
          return JSON.stringify({ error: 'Refusing to create an empty or link-only note. Put the actual content in `body` (real prose — not just a link back to this note), or write inline instead of calling note_create.' });
        }
        // Backlink: append a [[wikilink]] to the SOURCE note so the new note is navigable and
        // shows as connected in the graph/related view (both directions resolve from this one
        // link). Skipped if the source is untitled or already linked.
        const srcTitle = (list.find((e) => e.id === job.noteId)?.title
          || (current?.id === job.noteId ? current?.title : '') || '').trim();
        if (srcTitle && !body.includes(`[[${srcTitle}]]`)) body += `\n\n---\n\nFrom [[${srcTitle}]]`;
        // Authorship: the agent created this note — attribute the whole body to it and seed a
        // "Created by …" version so provenance/history shows who made it (not "You").
        const at = Date.now();
        const attribution = blankAttribution(body.length, job.modelLabel, at);
        const versions = [{ body, attribution, at, by: job.modelLabel, label: `Created by ${job.modelLabel}` }];
        let rec;
        try {
          rec = await createNote({ title, body, attribution, versions });
        } catch (e) {
          // Free-tier note cap: tell the agent to fold this into the current note instead.
          if (e instanceof NoteLimitError) return JSON.stringify({ error: `Note limit reached — the Free plan keeps ${e.limit} notes. Write this content into the current note instead of creating a new one (Pro unlocks unlimited notes).` });
          throw e;
        }
        noteCreatedCount += 1; // keep the header cap count in sync with the lifetime counter
        await reloadIndex();
        renderList($('n-search').value);
        if (current?.id === job.noteId) logActivity(job.modelLabel, `created “${rec.title}”`);
        return JSON.stringify({ ok: true, id: rec.id, title: rec.title, link: `notes.html#${rec.id}` });
      }
      if (name === 'note_edit') {
        const find = String(input?.find || '');
        const replace = String(input?.replace || '');
        if (!find) return JSON.stringify({ error: '`find` is required.' });
        if (job.region && cm && current?.id === job.noteId) {
          // Region job: edit the LIVE document (an agent write, so the region guard allows it).
          const idx = cm.value.indexOf(find);
          if (idx < 0) return JSON.stringify({ error: '`find` was not an exact substring of the note. Copy the exact text to replace.' });
          agentReplace(cm.view, idx, idx + find.length, replace, job.modelLabel);
        } else if (job.head.includes(find)) { job.head = job.head.replace(find, replace); scheduleJobRender(job); }
        else if (job.tail.includes(find)) { job.tail = job.tail.replace(find, replace); scheduleJobRender(job); }
        else return JSON.stringify({ error: '`find` was not an exact substring of the note (outside the text being written). Copy the exact text to replace.' });
        if (current?.id === job.noteId) logActivity(job.modelLabel, 'edited the note');
        return JSON.stringify({ ok: true });
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    } catch (e) {
      return JSON.stringify({ error: e?.message || String(e) });
    }
  };
  return { specs, execute };
}

// ── Editor co-writer — Phase 1 of the swarm ──────────────────────────────────────
// Watches on a typing pause, asks a cheap model to fix ONLY typos/grammar, diffs its
// output to precise one-click fixes, and shows them in an ambient strip. Opt-in
// (cost + control). All heavy deps are lazy-loaded — nothing on the page load path.
let cwEnabled = localStorage.getItem('chatpanel.notes.cowriter') === '1';
let cwTimer = null;
let cwGen = 0;
let cwSuggestions = [];
let boardSuggestions = []; // the swarm's shared suggestion queue (Connector links, etc.) rendered alongside Editor fixes
let _cwDiff = null;
let _lintMod = null; // deterministic Editor pre-pass (cowriter-lint.js)
let cwModel = ''; // provenance: the model (or "deterministic pass") the Editor last used
const cwDismissed = new Set();
const boardDismissed = new Set();

function scheduleCowriter() {
  if (!cwEnabled) return;
  if (cwSuggestions.length) clearCowriterUI(); // stale as the user types; recompute on pause
  clearTimeout(cwTimer);
  cwTimer = setTimeout(() => { runCowriter(); runTitleCheck(); }, 1400);
}
function clearCowriterUI() {
  cwSuggestions = [];
  boardSuggestions = [];
  _cwAnnounced = 0; // next new suggestion re-pulses / re-reveals
  const el = $('n-cowriter');
  el.innerHTML = '';
  el.classList.add('hidden');
}

// The paragraph the cursor sits in (blank-line delimited).
function currentParagraph() {
  const v = bodyText();
  const pos = bodyCursor();
  const b = v.lastIndexOf('\n\n', pos - 1);
  const start = b < 0 ? 0 : b + 2;
  const n = v.indexOf('\n\n', pos);
  const end = n < 0 ? v.length : n;
  return { text: v.slice(start, end), start };
}

// Spans of [[wikilinks]] in a block — the Editor must never "fix" a typo inside one
// (it would break the link target). Also lets us skip link-only paragraphs entirely.
function linkSpans(text) {
  const spans = []; const re = /\[\[[^\]]*\]\]/g; let m;
  while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}
async function runCowriter() {
  if (!cwEnabled || !current || noteHasJob(current.id) || agentAbort) return;
  const para = currentParagraph();
  if (para.text.trim().length < 12) return;
  // Skip paragraphs that are essentially just a link / code / URL — nothing to copy-edit,
  // and any "fix" would land inside a [[wikilink]] and corrupt it.
  const prose = para.text.replace(/\[\[[^\]]*\]\]/g, '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '');
  if (prose.replace(/[^A-Za-z]/g, '').length < 8) return;
  const gen = ++cwGen;
  const ta = $('n-body');
  const spans = linkSpans(para.text);
  const offset = (edits, base) => edits
    .filter((e) => !spans.some(([s, en]) => e.start < en && e.end > s)) // never edit inside a [[wikilink]]
    .map((e) => ({ ...e, start: e.start + base, end: e.end + base, key: _cwDiff.editKey(e) }))
    .filter((e) => !cwDismissed.has(e.key));
  const finish = (n, free) => { renderCowriter(); if (n) logActivity('Editor', `${n} fix${n === 1 ? '' : 'es'}${free ? ' (free)' : ''}`); setSwarmState('editor', 'idle', n ? `${n} fix${n === 1 ? '' : 'es'}` : ''); };

  // Deterministic pass FIRST — mechanical fixes for free. Only spend a token if it's clean.
  try {
    if (!_cwDiff) _cwDiff = await import('./js/cowriter-diff.js');
    if (!_lintMod) _lintMod = await import('./js/cowriter-lint.js');
  } catch { return; }
  const lint = _lintMod.lintText(para.text);
  if (lint.length) {
    const idx0 = ta.value.indexOf(para.text);
    if (idx0 < 0) return;
    cwModel = 'deterministic pass';
    cwSuggestions = offset(lint, idx0);
    return finish(cwSuggestions.length, true); // saved a token
  }

  // Clean of mechanical errors → spend a (budgeted) token on the model for subtle grammar.
  if (!budgetOk()) { setSwarmState('editor', 'idle', 'rate cap'); return; }
  let deps;
  try { deps = await agentDeps(); } catch { return; }
  const settings = await deps.getSettings();
  const license = await deps.getLicense();
  const editor = await roleAgent(deps, settings, license, 'editor'); // routed → cheapest usable model
  if (!editor) return;
  const resolved = editor.resolved;
  cwModel = resolved.autocompleteModel || resolved.model || resolved.bridgeAgent || 'model'; // provenance
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }
  const sys = 'You are a meticulous copy-editor. Fix ONLY clear spelling, typo, and grammar mistakes in the text. Change as LITTLE as possible — never rewrite, rephrase, restructure, or change wording, style, or meaning. Preserve ALL markdown, punctuation, and line breaks exactly. Return ONLY the corrected text, nothing else.';
  let corrected = '';
  setSwarmState('editor', 'working');
  budgetSpend();
  try {
    corrected = await deps.streamChat({
      agent: { ...resolved, model: resolved.autocompleteModel || resolved.model, systemPrompt: sys, maxTokens: Math.min(1200, Math.ceil(para.text.length / 2) + 200), temperature: 0 },
      settings,
      redaction, // the PII harness wraps this call too — nothing leaks from a co-writer
      messages: [{ role: 'user', content: para.text }],
    });
  } catch { setSwarmState('editor', 'idle'); return; }
  if (gen !== cwGen || !current || !cwEnabled) return; // superseded / disabled / note switched
  const idx = ta.value.indexOf(para.text); // relocate (user may have edited above); bail if it moved
  if (idx < 0) { setSwarmState('editor', 'idle'); return; }
  cwSuggestions = offset(_cwDiff.filterTypoEdits(_cwDiff.wordDiff(para.text, corrected.trim())), idx);
  finish(cwSuggestions.length, false);
}

// The Editor also proofreads the TITLE (people notice title typos most). Deterministic
// pass first, then the cheap model; fixes land as chips in the shared queue.
let titleGen = 0;
let lastTitleChecked = '';
async function runTitleCheck() {
  if (!cwEnabled || !current) return;
  const title = ($('n-title').value || '').trim();
  if (title.length < 6 || title === lastTitleChecked) return;
  try {
    if (!_cwDiff) _cwDiff = await import('./js/cowriter-diff.js');
    if (!_lintMod) _lintMod = await import('./js/cowriter-lint.js');
  } catch { return; }
  const lintEdits = _lintMod.lintText(title);
  if (lintEdits.length) { lastTitleChecked = title; return offerTitleFixes(lintEdits, 'deterministic pass'); }
  if (!budgetOk()) return;
  const gen = ++titleGen;
  let deps;
  try { deps = await agentDeps(); } catch { return; }
  const settings = await deps.getSettings();
  const license = await deps.getLicense();
  const editor = await roleAgent(deps, settings, license, 'editor');
  if (!editor) return;
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }
  budgetSpend();
  let corrected = '';
  try {
    corrected = await deps.streamChat({
      agent: { ...editor.resolved, model: editor.resolved.autocompleteModel || editor.resolved.model, systemPrompt: 'Fix ONLY clear spelling/typo mistakes in this short note title. Change as little as possible; keep the wording. Return ONLY the corrected title, nothing else.', maxTokens: 60, temperature: 0 },
      settings, redaction,
      messages: [{ role: 'user', content: title }],
    });
  } catch { return; }
  if (gen !== titleGen || !current) return;
  lastTitleChecked = title;
  offerTitleFixes(_cwDiff.filterTypoEdits(_cwDiff.wordDiff(title, corrected.trim())), editor.resolved.model || 'model');
}
function offerTitleFixes(edits, model) {
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'title');
  let n = 0;
  for (const e of edits) {
    const key = `title:${e.before}=>${e.after}`;
    if (boardDismissed.has(key)) continue;
    n += 1;
    boardSuggestions.push({
      role: 'title', icon: '✍️', key,
      html: `<s>${escapeHtml(e.before.trim() || '∅')}</s>→<b>${escapeHtml(e.after.trim() || '∅')}</b> <span class="cw-hand">title</span>`,
      title: `Fix the title · via ${escapeHtml(model)} (Editor)`,
      apply: () => applyTitleFix(e),
    });
  }
  if (n) { renderCowriter(); logActivity('Editor', `title: ${n} fix${n === 1 ? '' : 'es'}`); }
}
function applyTitleFix(e) {
  const t = $('n-title');
  const i = t.value.indexOf(e.before);
  if (i < 0) return;
  t.value = t.value.slice(0, i) + e.after + t.value.slice(i + e.before.length);
  lastTitleChecked = t.value.trim();
  updateWordCount();
  scheduleSave();
  toast('Title fixed');
}

// Nudge attention to the Co-writer tab when NEW suggestions arrive. The badge pulses for
// everyone (a quiet, discoverable cue — the maintainer's own confusion was "nothing
// prompted me"); with "Show fixes as they land" on, we also switch to the tab. Tracks the
// last-announced count so it fires on 0→N / N↑, never on a re-render or an accept.
let _cwAnnounced = 0;
function announceCowriter() {
  const n = cwSuggestions.length + boardSuggestions.length;
  if (n > _cwAnnounced) {
    const tab = document.querySelector('#n-side .side-tab[data-side="cowriter"]');
    if (tab) { tab.classList.remove('pulse'); void tab.offsetWidth; tab.classList.add('pulse'); } // restart the CSS pulse
    if (AI_PREFS.revealFixes && activeSide !== 'cowriter') setSideTab('cowriter');
  }
  _cwAnnounced = n;
}
function renderCowriter() {
  const el = $('n-cowriter');
  el.innerHTML = '';
  el.classList.remove('hidden'); // clearCowriterUI() parks it as .hidden (display:none !important) — un-park it so the chips are actually clickable when this tab is shown
  if (!cwSuggestions.length && !boardSuggestions.length) {
    el.innerHTML = '<div class="cw-empty">No suggestions yet. With the co-writer on, the Editor posts typo/grammar fixes and the Connector posts links here as you write.</div>';
    refreshSideTabs();
    announceCowriter();
    return;
  }
  const label = document.createElement('span');
  label.className = 'cw-label';
  label.innerHTML = icon('cowriter') + ' Co-writer';
  el.appendChild(label);
  for (const s of cwSuggestions.slice(0, 6)) {
    const chip = document.createElement('button');
    chip.className = 'cw-fix';
    chip.title = cwModel ? `Apply fix · via ${cwModel} (Editor)` : 'Apply fix'; // provenance
    chip.innerHTML = `<s>${escapeHtml(s.before.trim() || '∅')}</s><span class="cw-arrow">→</span><b>${escapeHtml(s.after.trim() || '∅')}</b>`;
    chip.onclick = () => applyCowriterFix(s);
    el.appendChild(chip);
  }
  // The shared suggestion queue — other roles (Connector links, …), each carrying provenance.
  for (const s of boardSuggestions.slice(0, 5)) {
    const chip = document.createElement('button');
    chip.className = `cw-sug cw-${s.role}`;
    chip.title = s.title || '';
    chip.innerHTML = `<span class="cw-ico">${iconForEmoji(s.icon) || escapeHtml(s.icon || '')}</span>${s.html}`;
    chip.onclick = () => { s.apply(); boardSuggestions = boardSuggestions.filter((x) => x !== s); renderCowriter(); };
    el.appendChild(chip);
  }
  if (cwSuggestions.length > 1) {
    const all = document.createElement('button');
    all.className = 'cw-all';
    all.textContent = 'Apply all';
    all.onclick = applyAllCowriter;
    el.appendChild(all);
  }
  const x = document.createElement('button');
  x.className = 'cw-x';
  x.title = 'Dismiss';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = icon('close');
  x.onclick = () => { cwSuggestions.forEach((s) => cwDismissed.add(s.key)); boardSuggestions.forEach((s) => boardDismissed.add(s.key)); clearCowriterUI(); };
  el.appendChild(x);
  refreshSideTabs();
  announceCowriter();
}

function commitCowriterBody() {
  current.body = $('n-body').value;
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  updateWordCount();
  dirty = true;
  scheduleSave();
}
function applyCowriterFix(s) {
  const ta = $('n-body');
  ta.value = ta.value.slice(0, s.start) + s.after + ta.value.slice(s.end);
  const delta = s.after.length - (s.end - s.start);
  cwSuggestions = cwSuggestions.filter((x) => x !== s).map((x) => (x.start > s.start ? { ...x, start: x.start + delta, end: x.end + delta } : x));
  commitCowriterBody();
  renderCowriter();
}
function applyAllCowriter() {
  const ta = $('n-body');
  ta.value = _cwDiff.applyEdits(ta.value, cwSuggestions);
  cwSuggestions = [];
  commitCowriterBody();
  clearCowriterUI();
  toast('Fixes applied');
}

// ── Connector — token-free: link new topics/entities to your existing docs ─────────
// On a typing pause it matches phrases in the current paragraph against your existing
// note/chat/meeting titles and suggests a [[wikilink]] for each unlinked mention. No
// model call — pure title matching against linkTargets(). Feeds the suggestion queue.
let connectorGen = 0;
let _connectMod = null;
async function runConnector() {
  if (!cwEnabled || !current) return;
  const para = currentParagraph();
  if (para.text.trim().length < 12) return;
  const gen = ++connectorGen;
  let targets;
  try {
    if (!_connectMod) _connectMod = await import('./js/cowriter-connect.js');
    targets = await linkTargets();
  } catch { return; }
  if (gen !== connectorGen || !cwEnabled || !current) return;
  const text = para.text;
  const hits = _connectMod.connectorMatches(text, targets, {
    selfTitle: current.title || '',
    linked: _connectMod.existingLinks(text),
    dismissed: boardDismissed,
  });
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'connector').concat(hits.map((h) => ({
    role: 'connector', icon: '🔗', key: `link:${h.title.toLowerCase()}`,
    html: `<b>[[${escapeHtml(h.title)}]]</b>`,
    title: `Link “${h.mention}” to your existing “${h.title}” · Connector (your workspace)`,
    apply: () => applyConnector(h),
  })));
  if (hits.length) logActivity('Connector', `${hits.length} link${hits.length === 1 ? '' : 's'} suggested`);
  setSwarmState('connector', 'idle', hits.length ? `${hits.length} link${hits.length === 1 ? '' : 's'}` : '');
  renderCowriter();
}
function applyConnector(h) {
  const ta = $('n-body');
  const i = ta.value.indexOf(h.mention);
  if (i < 0 || ta.value.slice(i - 2, i) === '[[') return; // moved/edited, or already linked
  ta.value = `${ta.value.slice(0, i)}[[${h.mention}]]${ta.value.slice(i + h.mention.length)}`;
  commitCowriterBody();
  logActivity('Connector', `linked “${h.title}”`);
  toast('Linked');
}
function setCowriter(on, announce = false) {
  cwEnabled = on;
  localStorage.setItem('chatpanel.notes.cowriter', on ? '1' : '0');
  const btn = $('n-cw-toggle');
  btn.classList.toggle('on', on);
  btn.title = on ? 'Co-writer swarm: on — proofreads as you write · ⌘↵ draft ahead · 🔎 research' : 'Co-writer: off';
  if (on) { scheduleCowriter(); scheduleResearch(); if (announce) toast('Co-writer on — proofreads as you type · ⌘↵ to draft ahead'); }
  else clearCowriterUI();
  renderSwarmStatus(); // show/clear the footer team strip
}

// ── Researcher co-writer — Phase 2 of the swarm ──────────────────────────────────
// A token-FREE research lane. On an idle pause it retrieves related material from the
// user's own workspace (notes/chats/meetings) via history-rag — no model call — and on
// demand also searches the web (still no model: webSearch returns structured results).
// Hits land in an ambient, collapsible shelf as cards you can insert (as a [[wikilink]]
// or [markdown](url)), open, or dismiss. Reuses retrieveHistory + webSearch wholesale.
let researchGen = 0;
let researchCards = [];
let researchBusy = false;
let researchTimer = null;
let researchQuestion = ''; // set when the affordance orchestrator triggered research for a "?" line
let _ragMod = null;
const researchDismissed = new Set();

function researchQuery() {
  // Intent + title + the section around the cursor — a strong, cheap relevance signal.
  const title = ($('n-title').value || '').trim();
  const para = currentParagraph().text.trim();
  return [board.intent, title, para].filter(Boolean).join('\n').trim().slice(0, 500);
}
// salientTerms + researchRelevance (the relevance gate) are pure — they live in
// notes-util.js so the same "content-bearing terms only" scoring is testable and
// reusable. We build a targeted web query from the note's title + salient terms so the
// search isn't a raw sentence that drags in unrelated results.
function webQuery(title, salient) {
  return [title, [...salient].slice(0, 8).join(' ')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function setResearchStatus(t) { const el = $('n-research-status'); if (el) el.textContent = t || ''; }
function clearResearch() {
  researchGen++; researchCards = []; researchBusy = false; researchQuestion = '';
  if ($('n-research-cards')) $('n-research-cards').innerHTML = '';
  setResearchStatus('');
  refreshSideTabs();
}
function scheduleResearch() {
  if (!cwEnabled) return;               // the researcher rides the same swarm toggle
  clearTimeout(researchTimer);
  researchTimer = setTimeout(() => observe(), 2600); // longer idle than the editor
}

async function runResearch({ web = false, question = '' } = {}) {
  if (!current) return;
  researchQuestion = question; // a question-driven run offers a Writer handoff in the shelf
  const q = question || researchQuery();
  if (!q) { if (web) toast('Write something to research first'); return; }
  if (q.length < 16 && !web && !question) return;
  const gen = ++researchGen;
  researchBusy = true;
  setSwarmState('researcher', 'working');
  setResearchStatus(web ? 'Searching your workspace and the web…' : 'Finding related material…');
  renderResearch(); // reveal the shelf with a working state immediately

  // Local lane — free, always. Related notes/chats/meetings from the user's own history,
  // GROUNDED in what you're writing: the ranker returns its top-N even on a query of common
  // words, so gate results to those that actually share a salient term with the query —
  // otherwise unrelated past notes surface. Empty is better than irrelevant.
  const salient = salientTerms(q);
  let local = [];
  try {
    if (!_ragMod) _ragMod = await import('./js/history-rag.js');
    const { results } = await _ragMod.retrieveHistory(q, { includeMeetings: true, limit: 8 });
    local = results
      .filter((r) => r.sourceId !== `note:${current.id}`)
      .map((r) => ({ kind: sourceKind(r.sourceId), title: r.title || 'Untitled', url: r.url, snippet: researchSnippet(r.text), key: r.url || r.sourceId }))
      .filter((c) => !researchDismissed.has(c.key))
      // Grounded: keep only workspace hits that actually share enough with the query (two
      // terms, or one specific one) and rank by that overlap. Empty is better than irrelevant.
      .map((c) => ({ c, s: researchRelevance(c, salient) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  } catch { /* local lane is best-effort */ }
  if (gen !== researchGen) return;

  // Web lane — on demand only (network + a Free daily quota); still token-free. The query is
  // built from the note's TOPIC (title + the most salient terms across the WHOLE note, or the
  // question), so the results are on-topic — show them (deduped) WITHOUT re-gating on snippet
  // term-overlap, which was dropping valid web hits and leaving only workspace results.
  let webCards = [];
  if (web) {
    try {
      const [ws, lic, store] = await Promise.all([import('./js/web-search.js'), import('./js/license.js'), import('./js/store.js')]);
      const settings = await store.getSettings();
      const license = await lic.getLicense();
      // Topic query: the note's title + its most FREQUENT content words (not stray meta/agent
      // words that appear early), so the web search is about what the note is actually about.
      const topic = topicTerms(`${$('n-title').value || ''}\n${bodyText()}`, 10);
      const term = question || webQuery(($('n-title').value || '').trim(), topic) || q.split('\n').filter(Boolean).pop() || q;
      const res = await ws.webSearch(term, ws.webSearchOpts(settings, lic.isPro(license)));
      if (gen !== researchGen) return;
      webCards = (res.results || []).slice(0, 8)
        .filter((r) => r.url && !researchDismissed.has(r.url))
        .map((r) => ({ kind: 'web', title: r.title || r.url, url: r.url, snippet: researchSnippet(r.text), key: r.url }));
    } catch (e) { toast(e?.message ? `Web search: ${e.message}` : 'Web search unavailable'); }
  }
  if (gen !== researchGen) return;

  // Web results first on an explicit web search (that's what the user asked for), then the
  // grounded workspace hits. Dedup by key. A LOCAL-only refresh (web=false — e.g. the edit made
  // when you Insert a card re-triggers the ambient researcher) must NOT drop the web results you
  // were working with, so carry the existing (undismissed) web cards forward.
  const priorWeb = web ? [] : researchCards.filter((c) => c.kind === 'web' && !researchDismissed.has(c.key));
  const seen = new Set();
  researchCards = [...webCards, ...priorWeb, ...local].filter((c) => c.key && !seen.has(c.key) && seen.add(c.key)).slice(0, 10);
  researchBusy = false;
  setResearchStatus('');
  renderResearch();
  if (researchCards.length) logActivity('Researcher', question ? `answered “${question.slice(0, 40)}” · ${researchCards.length} sources` : `${researchCards.length} related`);
  setSwarmState('researcher', 'idle', researchCards.length ? `${researchCards.length} found` : '');
}

function renderResearch() {
  const shelf = $('n-research');
  const wrap = $('n-research-cards');
  if (!shelf || !wrap) return;
  renderSrcFilter();
  const cards = researchCards.filter((c) => srcAllowed(c.kind)); // honor the source-type filter
  $('n-research-count').textContent = cards.length ? String(cards.length) : '';
  wrap.innerHTML = '';
  if (researchQuestion) { // Researcher → Writer handoff — inline OR a spun-off note, your call
    const h = document.createElement('button');
    h.className = 'rcard-answer';
    h.title = 'Draft the answer INLINE here, grounded in these sources';
    h.innerHTML = `${icon('continue')} Draft inline <span class="ra-q">“${escapeHtml(researchQuestion.slice(0, 44))}”</span>`;
    h.onclick = () => draftAnswer();
    wrap.appendChild(h);
    const n = document.createElement('button');
    n.className = 'rcard-answer alt';
    n.title = 'Spin this off into a NEW linked note the swarm plans out';
    n.innerHTML = icon('plan') + ' New note';
    n.onclick = () => planInNewNote(researchQuestion);
    wrap.appendChild(n);
  }
  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'research-empty';
    empty.textContent = researchBusy ? 'Working…'
      : (researchCards.length ? 'No sources match your filter above.'
      : (researchQuestion ? 'No sources found — the Writer can still answer.' : 'Nothing related yet — keep writing, or search.'));
    wrap.appendChild(empty);
    refreshSideTabs();
    return;
  }
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'rcard';
    card.innerHTML =
      `<div class="rcard-top"><span class="rcard-ico">${iconForEmoji(KIND_ICON[c.kind]) || icon('file-text')}</span>` +
      `<span class="rcard-title">${escapeHtml(c.title)}</span></div>` +
      (c.snippet ? `<div class="rcard-snip">${escapeHtml(c.snippet)}</div>` : '') +
      `<div class="rcard-acts">` +
      `<button class="rcard-insert" title="Insert a link at the cursor">Insert</button>` +
      `<button class="rcard-open" title="Open">Open</button>` +
      `<button class="rcard-x" title="Dismiss" aria-label="Dismiss">${icon('close')}</button></div>`;
    card.querySelector('.rcard-insert').onclick = () => insertResearch(c);
    card.querySelector('.rcard-open').onclick = () => openResearch(c);
    card.querySelector('.rcard-x').onclick = () => { researchDismissed.add(c.key); researchCards = researchCards.filter((x) => x !== c); renderResearch(); };
    wrap.appendChild(card);
  }
  refreshSideTabs();
}

// ── Source-type filter — shared by Research + Related ────────────────────────────
// Toggle which kinds (notes / chats / meetings / web) are surfaced. Persisted; applied at
// render time so toggling is instant and never loses fetched cards. Web applies to Research
// only (Related has no web lane).
const SRC_KINDS = [
  { key: 'note', label: 'Notes', icon: 'notes' },
  { key: 'chat', label: 'Chats', icon: 'chat' },
  { key: 'meeting', label: 'Meetings', icon: 'meetings' },
  { key: 'web', label: 'Web', icon: 'web' },
];
const SRC_KEYS = new Set(SRC_KINDS.map((s) => s.key));
let srcFilter = loadSrcFilter();
function loadSrcFilter() {
  try { const raw = JSON.parse(localStorage.getItem('chatpanel.notes.srcFilter') || 'null'); if (Array.isArray(raw) && raw.length) return new Set(raw.filter((k) => SRC_KEYS.has(k))); } catch { /* default below */ }
  return new Set(SRC_KEYS);
}
function saveSrcFilter() { localStorage.setItem('chatpanel.notes.srcFilter', JSON.stringify([...srcFilter])); }
const srcAllowed = (kind) => !SRC_KEYS.has(kind) || srcFilter.has(kind); // unknown kinds always pass
function renderSrcFilter() {
  const host = $('n-research-filter');
  if (!host) return;
  host.innerHTML = '';
  for (const s of SRC_KINDS) {
    const on = srcFilter.has(s.key);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'src-chip' + (on ? ' on' : '');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? `Hide ${s.label}` : `Show ${s.label}`;
    b.innerHTML = icon(s.icon) + escapeHtml(s.label);
    b.onclick = () => {
      if (srcFilter.has(s.key)) { if (srcFilter.size > 1) srcFilter.delete(s.key); } // keep at least one source on
      else srcFilter.add(s.key);
      saveSrcFilter();
      renderSrcFilter();
      renderResearch();
      if (activeSide === 'related') refreshRelated(current?.id, { force: true });
    };
    host.appendChild(b);
  }
}

// This note's topics as a chip cloud, each annotated with how many notes share it (corpus
// signal from the lightweight index — no body decrypts). Reuses deterministicTopicPreview.
function renderNoteTopicsPane() {
  const host = $('n-topics-pane');
  if (!host) return;
  host.innerHTML = '';
  if (!current) { host.innerHTML = '<div class="research-empty">Open a note to see its topics.</div>'; return; }
  let items = current.topics?.items || [];
  let pending = false;
  if (!items.length) { items = deterministicTopicPreview(current.body || ''); pending = true; }
  if (!items.length) { host.innerHTML = '<div class="research-empty">Topics appear as you write.</div>'; return; }
  const freq = new Map(); // corpus frequency of each topic
  for (const e of list) for (const t of e.topics || []) freq.set(t, (freq.get(t) || 0) + 1);
  const head = document.createElement('div');
  head.className = 'rv-head';
  head.textContent = pending ? 'Topics (drafting…)' : 'This note’s topics';
  host.appendChild(head);
  const cloud = document.createElement('div');
  cloud.className = 'chip-cloud';
  for (const topic of items.slice(0, 20)) {
    const shared = freq.get(topic) || 0;
    const b = document.createElement('button');
    b.className = 'topic-chip';
    b.innerHTML = escapeHtml(topic) + (shared > 1 ? ` <span class="chip-count">${shared}</span>` : '');
    b.title = shared > 1
      ? `Shared with ${shared - 1} other note${shared - 1 === 1 ? '' : 's'} — find “${topic}” everywhere`
      : `Find “${topic}” across notes, chats & meetings`;
    b.onclick = () => openOmni(topic);
    cloud.appendChild(b);
  }
  host.appendChild(cloud);
}
// The open note's connection neighbourhood: an ego graph (focus node + 1-hop neighbours),
// drawn with the shared graph-view module. Same relationship model as the corpus dashboard,
// filtered to what touches THIS note.
async function renderNoteGraph() {
  const host = $('n-graph-pane');
  if (!host) return;
  if (!current) { host.innerHTML = '<div class="research-empty">Open a note to see its graph.</div>'; return; }
  if (!list.length) { host.innerHTML = '<div class="research-empty">No notes yet.</div>'; return; }
  const noteId = current.id;
  host.innerHTML = '<div class="research-empty">Mapping connections…</div>';
  // Yield so the "mapping…" paint lands; graphWithTopics is a cheap index-only pass.
  await Promise.resolve();
  if (!current || current.id !== noteId || activeSide !== 'graph') return; // superseded while building
  const ego = egoSubgraph(graphWithTopics(), noteId);
  if (ego.nodes.length <= 1) { host.innerHTML = '<div class="research-empty">Not connected yet — add [[links]], tags or shared topics to relate this note.</div>'; return; }
  try {
    if (!_graphMod) _graphMod = await import('./js/graph-view.js');
    host.innerHTML = '';
    const open = (nd) => { if (nd.type === 'topic') return openOmni(nd.label); if (nd.id !== noteId) openNote(nd.id); };
    _graphMod.drawGraph(host, ego.nodes, ego.links, open, open);
  } catch { host.innerHTML = '<div class="research-empty">Graph unavailable.</div>'; }
}
function insertResearch(c) {
  const link = c.kind === 'note' ? `[[${c.title}]]` : `[${escapeMdText(c.title)}](${c.url})`;
  const { start, end } = bodySel();
  const lead = start > 0 && !/\s$/.test(bodyText().slice(0, start)) ? ' ' : '';
  bodyReplaceRange(lead + link + ' ', start, end);
  bodyFocus();
  toast('Inserted');
}
function openResearch(c) {
  if (!c.url) return;
  const [page, hash] = c.url.split('#');
  if (page === 'notes.html' && hash) return openNote(decodeURIComponent(hash));
  if (/^https?:/i.test(c.url)) window.open(c.url, '_blank', 'noopener,noreferrer');
  else chrome.tabs?.create?.({ url: c.url });
}
// Open a link the Live (CM6) editor resolved from a click — a URL or a [[wikilink]] title.
// Mirrors the Read/Split preview click handler so both surfaces behave the same.
async function openEditorLink(target) {
  if (!target) return;
  if (target.kind === 'wikilink') {
    const t = (await linkTargets()).find((x) => x.title.toLowerCase() === target.title.toLowerCase());
    if (!t) return toast(`No document named "${target.title}" yet`);
    const [page, hash] = t.url.split('#');
    if (page === 'notes.html' && hash) openNote(decodeURIComponent(hash));
    else chrome.tabs.create({ url: t.url });
    return;
  }
  const url = target.url;
  if (!url || url.startsWith('#')) return;
  if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  else if (/^chrome-extension:/i.test(url)) chrome.tabs.create({ url });
}

// ── Writer co-writer — Phase 3 of the swarm ──────────────────────────────────────
// Draft-ahead "ghost text". On ⌘/Ctrl+Enter the strong (routed) Writer model continues
// from the caret — grounded in the Researcher's shelf, so the swarm members hand off —
// and streams the draft in as a SELECTED suggestion. Tab accepts, Esc/typing/blur
// rejects. A pending ghost is tracked separately and NEVER persists un-accepted:
// every save/switch/blur strips it first.
let writerGen = 0;
let writerAbort = null;
let ghost = null;          // { from, to } range of the pending suggestion in n-body
let ghostApplying = false; // true while WE mutate the textarea (so input handlers ignore it)
let ghostAuthor = HUMAN;   // who authored the pending ghost — attributed to the ledger on accept

function ghostHintEl() {
  let el = document.getElementById('n-ghost-hint');
  if (!el) { el = document.createElement('div'); el.id = 'n-ghost-hint'; el.className = 'ghost-hint hidden'; document.body.appendChild(el); }
  return el;
}
function showGhostHint(text) {
  const el = ghostHintEl();
  el.textContent = text;
  const { x, y } = caretXY($('n-body'));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y + 4)}px`;
  el.classList.remove('hidden');
}
function hideGhostHint() { ghostHintEl().classList.add('hidden'); }

function clearGhost({ remove = false } = {}) {
  const ta = $('n-body');
  if (ghost && remove && ta.value.length >= ghost.to) {
    ghostApplying = true;
    ta.setRangeText('', ghost.from, ghost.to, 'end'); // caret returns to `from`
    ghostApplying = false;
  }
  if (ghost) setSwarmState('writer', 'idle');
  ghost = null;
  ghostAuthor = HUMAN;
  hideGhostHint();
  mirrorToCm(); // reflect the removed ghost onto the live editor
  if (cmActive && cm) cm.clearGhost(); // drop the AI-draft tint
}
function renderGhost(from, text) {
  const ta = $('n-body');
  ghostApplying = true;
  const prevTo = ghost ? ghost.to : from;
  ta.setRangeText(text, from, prevTo, 'select'); // replace prior ghost, keep the draft selected
  ghostApplying = false;
  ghost = { from, to: from + text.length };
  autoGrow();
  mirrorToCm(); // show the streaming draft in the live editor too
  if (cmActive && cm) cm.setGhost(from, from + text.length); // tint it as an un-accepted AI draft
}
// Commit the pending draft into the note: attribute it to its author, snapshot a version, save.
// `keepSelection` leaves the selection + focus untouched — used when accepting on ⌘C so the
// browser's native copy still grabs the (now-permanent) selected text.
function acceptGhost({ keepSelection = false } = {}) {
  if (!ghost) return;
  const ta = $('n-body');
  if (!keepSelection) ta.selectionStart = ta.selectionEnd = ghost.to; // collapse to end — keep the text
  const author = ghostAuthor;
  ghost = null;
  ghostAuthor = HUMAN;
  hideGhostHint();
  setSwarmState('writer', 'idle');
  // Provenance: the accepted draft was written by the AI — attribute it + snapshot.
  recordEdit({ author, discrete: true });
  pushVersion(author, author);
  logActivity(author.startsWith('Autocomplete') ? 'Autocomplete' : 'Writer', 'draft accepted');
  current.body = ta.value;
  noteGoalProgress(); // re-baseline goal-drive so an accepted draft doesn't instantly re-fire
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  if (cmActive && cm) cm.clearGhost(); // it's committed text now — drop the AI-draft tint
  updateWordCount();
  renderHistory();
  dirty = true;
  scheduleSave();
  if (!keepSelection) bodyFocus();
}

// Leaving the note (switch / save) with a pending ghost. A Writer DRAFT-AHEAD is content the
// user deliberately requested (⌘↵) — commit it into the note rather than silently deleting it.
// An as-you-type Autocomplete prediction is ephemeral — drop it. `keepSelection` avoids the
// focus/selection churn of a normal accept since we're on our way out of this note anyway.
function resolvePendingGhost() {
  if (!ghost) return;
  if (ghostAuthor.startsWith('Writer')) acceptGhost({ keepSelection: true });
  else clearGhost({ remove: true });
}

function writerTail(before) {
  const title = ($('n-title').value || '').trim();
  const tail = before.length > 1600 ? `…${before.slice(-1600)}` : before;
  return (title ? `# ${title}\n\n` : '') + tail;
}

// ── Inline autocomplete — as-you-type ghost prediction (opt-in; model in Notes settings)
// A short continuation predicted on a typing pause, shown as selected ghost text: Tab
// accepts (attributed to the model in the ledger), Esc / any keystroke dismisses. Reuses
// the Writer's ghost machinery; fires only at the very END of the note to stay simple
// and safe. Off by default; the model is chosen in Settings → Notes.
let autoTimer = null;
let autoAbort = null;
let autoGen = 0;
let autocompleteCfg = { enabled: false, agentId: '' };
let mentionTargets = []; // [{ name }] configured agents/endpoints, for the @ picker & @mention
let mentionSkills = [];  // [{ name }] configured skills, for the # picker

// Cheap direct reads of the (plaintext) settings object for the @ / # pickers — must
// NOT pull the agent graph onto the load path.
async function loadMentionTargets() {
  try {
    const s = (await chrome.storage.local.get('chatpanel:settings'))['chatpanel:settings'] || {};
    const out = [];
    const seen = new Set();
    for (const t of [...(s.endpoints || []), ...(s.agents || [])]) {
      const name = t?.name || t?.model || t?.bridgeAgent;
      if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push({ name }); }
    }
    mentionTargets = out;
    mentionSkills = (s.skills || []).filter((sk) => sk && (sk.name || sk.title)).map((sk) => ({ name: sk.name || sk.title }));
  } catch { mentionTargets = []; mentionSkills = []; }
}

async function loadAutocompleteCfg() {
  // Cheap direct read of the (plaintext) settings object — must NOT pull the agent
  // graph onto the notes load path; the heavy deps load lazily only when a prediction
  // actually fires (runAutocomplete → agentDeps).
  try {
    const got = await chrome.storage.local.get('chatpanel:settings');
    autocompleteCfg = got['chatpanel:settings']?.ui?.notes?.autocomplete || { enabled: false, agentId: '' };
  } catch { autocompleteCfg = { enabled: false, agentId: '' }; }
}
function cancelAutocomplete() {
  clearTimeout(autoTimer);
  autoGen++;
  if (autoAbort) { autoAbort.abort(); autoAbort = null; }
}
function scheduleAutocomplete() {
  if (!autocompleteCfg.enabled) return;
  cancelAutocomplete();
  autoTimer = setTimeout(runAutocomplete, 650);
}
// Keep it short: at most the first sentence / line of what the model returns.
function clipCompletion(s) {
  let t = (s || '').replace(/^\s+/, '');
  const nl = t.indexOf('\n'); if (nl >= 0) t = t.slice(0, nl);
  const m = t.match(/^.*?[.!?](\s|$)/); if (m) t = m[0];
  return t.replace(/\s+$/, '');
}
async function runAutocomplete() {
  if (!autocompleteCfg.enabled || !current) return;
  const ta = $('n-body');
  if (ta.readOnly || ghost || writerAbort || agentAbort || ac.open || noteHasJob(current.id)) return;
  const from = ta.selectionStart;
  if (from !== ta.selectionEnd || from !== ta.value.length) return; // a collapsed cursor at the very end
  const before = ta.value.slice(0, from);
  if (before.trim().length < 12) return;                            // need some context
  const gen = ++autoGen;
  let deps; try { deps = await agentDeps(); } catch { return; }
  const settings = await deps.getSettings();
  const target = deps.getTarget(settings, autocompleteCfg.agentId || settings.activeAgentId);
  if (!target) return;
  const license = await deps.getLicense();
  if (!deps.canUseAgent(license, settings, target)) return;
  const resolved = deps.resolveTarget(target, settings);
  const model = resolved.autocompleteModel || resolved.model;
  const label = `Autocomplete · ${target.name || model || 'model'}`;
  const sys = 'You are an inline writing autocomplete. Continue the note from EXACTLY where it stops with a SHORT continuation — a few words up to one sentence. Match the voice and markdown. Output ONLY the text to append: no quotes, no preamble, no repetition of prior text. If nothing sensible follows, output nothing.';
  autoAbort = new AbortController();
  let out = '';
  try {
    await deps.streamChat({
      agent: { ...resolved, model, systemPrompt: sys, maxTokens: 48, temperature: 0.1 },
      settings,
      signal: autoAbort.signal,
      messages: [{ role: 'user', content: writerTail(before) }],
      onDelta: (d) => { out += d; },
    });
  } catch { return; } finally { autoAbort = null; }
  // Show only if nothing changed while we waited (still valid, caret still at the end).
  if (gen !== autoGen || ghost || writerAbort || ta.readOnly) return;
  if (ta.selectionStart !== from || ta.value.length !== from) return;
  const clip = clipCompletion(out);
  if (!clip) return;
  ghostAuthor = label;
  renderGhost(from, clip);
  showGhostHint('AI draft · Tab ↹ keep · Esc discard');
}
async function draftAhead(opts = {}) {
  if (!current || ghost || writerAbort || agentAbort || noteHasJob(current.id)) return;
  // A line that @mentions an agent is a DELEGATION, not a spot for the ambient Writer to
  // continue — route ⌘↵ to that agent instead of drafting a continuation over the task.
  const men = currentMention();
  if (men) { runAgentTask(men); return; }
  // Instruction mode — an imperative line ("summarize the above in 3 sentences") is
  // EXECUTED as a task and its result streamed below the line (opt-in / explicit). Any
  // other ⌘↵ is a plain continuation from the caret. Same ghost = same accept/reject.
  let instr = opts.instruction || null;
  let iLine = null;
  if (instr) iLine = currentLine();
  else if (AI_PREFS.actOnInstructions) { const io = instructionOnLine(); if (io) { instr = io.text; iLine = currentLine(); } }
  const from = instr ? iLine.end : bodyCursor();
  const before = bodyText().slice(0, from);
  const ctxBefore = instr ? bodyText().slice(0, iLine.start) : before; // instruction: context is the note ABOVE the line
  const sep = instr ? (before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n') : ''; // drop the result onto its own line
  if (!instr && before.trim().length < 8) return toast('Write a little first, then ⌘↵ to draft ahead');
  const gen = ++writerGen;
  let deps;
  try { deps = await agentDeps(); } catch { return toast('Writer unavailable'); }
  clearTimeout(saveTimer);
  await flushSave(); // persist real edits so no autosave fires mid-stream (and dirty resets)
  const settings = await deps.getSettings();
  const license = await deps.getLicense();
  const writer = await roleAgent(deps, settings, license, 'writer'); // strong, routed
  if (!writer) return toast('Set up a model in ChatPanel settings first');
  if (!budgetOk()) return toast('Swarm rate cap reached — try again in a moment');
  budgetSpend();

  // Research handoff — ground the Writer in what the Researcher gathered.
  const grounding = researchCards.length
    ? '\n\nRelated material you may draw on (only if genuinely useful — cite as [[title]] or [text](url)):\n'
      + researchCards.slice(0, 5).map((c) => `- ${c.title}${c.snippet ? ` — ${c.snippet}` : ''}`).join('\n')
    : '';
  const intentLine = board.intent ? `The note's goal (guide your writing toward it): ${board.intent}.\n\n` : '';
  const sys = instr
    ? `You are executing an instruction inside the user's note. Use the note as context and do EXACTLY what the instruction says. Match the note's voice, tone, and markdown style. Output ONLY the resulting markdown to insert — no preamble, no restating the instruction, no meta commentary.${board.intent ? ` The note's goal: ${board.intent}.` : ''}${grounding}`
    : intentLine + "You continue the user's note from where it stops. Match their voice, tone, and markdown style exactly. Write only the NEXT one or two sentences (or finish the current one) — concise, natural, no preamble, no repetition of prior text, no meta commentary. Output ONLY the continuation." + grounding;
  const userContent = instr
    ? `NOTE SO FAR:\n${writerTail(ctxBefore)}\n\nINSTRUCTION (do exactly this, output only the result):\n${instr}`
    : writerTail(before);
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }

  writerAbort = new AbortController();
  ghostAuthor = `Writer · ${writer.resolved.model || writer.resolved.bridgeAgent || 'model'}`;
  // NB: no readOnly — setRangeText() throws on a readOnly textarea. Typing is blocked
  // instead by the keydown guard (which swallows keys while writerAbort is set).
  // Name the model/agent doing the drafting so the status isn't anonymous (router-appointed).
  const writerLabel = writer.label || writer.resolved.model || writer.resolved.bridgeAgent || 'model';
  setStatus(`Drafting… · ${writerLabel}`);
  showGhostHint(`${writerLabel} drafting…`);
  setSwarmState('writer', 'working');
  // If the Writer is a bridge agent, its tools/subagents stream into the activity widget
  // (not the note body). API models with no tools show nothing extra.
  const act = makeSwarmActivity(current.id, '✨ Writer', writer.resolved.model || writer.resolved.bridgeAgent || 'model', !!redaction);
  let out = '';
  try {
    await deps.streamChat({
      agent: { ...writer.resolved, systemPrompt: sys, maxTokens: instr ? 600 : 220, temperature: instr ? 0.4 : 0.6 },
      settings,
      signal: writerAbort.signal,
      redaction, // the PII harness wraps the draft-ahead call too
      messages: [{ role: 'user', content: userContent }],
      onDelta: (d) => { if (gen === writerGen) { out += d; scheduleStreamRender(() => { if (gen === writerGen) renderGhost(from, sep + out); }); } }, // one paint/frame; anchor fixed at `from`
      onEvent: act.onEvent,
    });
  } catch (e) {
    if (!writerAbort.signal.aborted) toast(`Writer error: ${e?.message || e}`);
  } finally {
    const aborted = writerAbort?.signal.aborted;
    act.done(aborted ? null : undefined);
    writerAbort = null;
    streamStop(); // drop any pending frame before finalizing the ghost
    setStatus('');
    if (!aborted && gen === writerGen && out.trim()) { renderGhost(from, sep + out.replace(/\s+$/, '')); showGhostHint('AI draft · Tab ↹ / ↵ keep · Esc discard'); setSwarmState('writer', 'idle', 'draft ready'); logActivity('Writer', instr ? 'ran an instruction' : 'drafted a continuation'); }
    else { clearGhost({ remove: true }); setSwarmState('writer', 'idle'); }
  }
}

// ── Swarm team panel — Phase 4b: the model router, made visible & controllable ────
// Shows each role, the model the router APPOINTED (with its tier / subagent mode), and
// a dropdown to pin an override. Reuses swarmCandidates + the pure router; overrides
// persist to the same key roleAgent() already reads, so pinning takes effect instantly.
async function renderSwarmMenu() {
  const menu = $('n-swarm-menu');
  let deps, settings, license, cands, overrides, router;
  try {
    deps = await agentDeps();
    settings = await deps.getSettings();
    license = await deps.getLicense();
    cands = swarmCandidates(deps, settings, license); // ALL configured models (enabled + disabled)
    overrides = swarmOverrides();
    router = await getRouter();
  } catch { menu.innerHTML = '<div class="agent-hint">Set up a model in ChatPanel settings first</div>'; return; }
  if (!cands.length) { menu.innerHTML = '<div class="agent-hint">Add a model in ChatPanel settings to use the co-writer swarm.</div>'; return; }
  // Only ENABLED + license-usable models are actually routable; disabled ones are shown
  // in the dropdown as inactive so you know to enable them (Settings → API / Agents).
  const pickable = cands.filter((c) => c.enabled !== false && c.usable !== false);
  const reasonFor = (c) => (c.enabled === false ? ' — inactive (enable in Settings)' : (c.usable === false ? ' — needs Pro' : ''));
  menu.innerHTML = '<div class="swarm-title">Co-writer team</div>';
  // Two gears — Ambient (quiet, suggest-only) vs Focus (drafts sections + fact-checks).
  const gearRow = document.createElement('div');
  gearRow.className = 'swarm-gear';
  gearRow.innerHTML =
    `<button class="sg-opt ${swarmGear === 'ambient' ? 'on' : ''}" data-g="ambient" title="Quiet — suggestions only, cheap/free members">🌙 Ambient</button>`
    + `<button class="sg-opt ${swarmGear === 'focus' ? 'on' : ''}" data-g="focus" title="Active — drafts sections on the spot + runs the Fact-checker">${icon('zap')} Focus</button>`;
  gearRow.querySelectorAll('.sg-opt').forEach((b) => { b.onclick = () => setGear(b.dataset.g); });
  menu.appendChild(gearRow);
  // Shared intent — this note's goal; guides the Writer & Researcher.
  const intentWrap = document.createElement('label');
  intentWrap.className = 'swarm-intent';
  intentWrap.innerHTML = `<span>${icon('target')} Working on</span>`;
  const intentIn = document.createElement('input');
  intentIn.type = 'text';
  intentIn.className = 'swarm-intent-in';
  intentIn.placeholder = 'e.g. draft a launch plan…';
  intentIn.maxLength = 200;
  intentIn.value = board.intent;
  intentIn.oninput = () => setIntent(intentIn.value);
  intentWrap.appendChild(intentIn);
  menu.appendChild(intentWrap);
  // How proactive? — independent opt-ins (default off). Off = the calm default: fixes
  // wait quietly in the Co-writer tab, nothing drafts unless you ask (⌘↵). On = the
  // co-writer reaches into your flow. Each is a small, reversible choice.
  const proWrap = document.createElement('div');
  proWrap.className = 'swarm-prefs';
  proWrap.innerHTML = `<div class="swarm-prefs-h">${icon('sparkles')} How proactive?</div>`;
  const PREF_META = [
    { k: 'revealFixes', label: 'Show fixes as they land', desc: 'Auto-open the Co-writer tab when a typo/link is ready — no hunting for the badge.' },
    { k: 'actOnInstructions', label: 'Act on instruction lines', desc: 'A line like “summarize the above in 3 sentences” becomes a task the Writer drafts (accept/reject).' },
    { k: 'goalDrive', label: 'Let the goal keep writing', desc: 'With a goal set above, draft the next line toward it whenever you pause. Always accept/reject; respects the spend cap.' },
  ];
  for (const p of PREF_META) {
    const row = document.createElement('label');
    row.className = 'swarm-pref';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!AI_PREFS[p.k];
    cb.onchange = () => { setAIPref(p.k, cb.checked); toast(cb.checked ? `${p.label} — on` : `${p.label} — off`); };
    row.appendChild(cb);
    const txt = document.createElement('div');
    txt.className = 'swarm-pref-txt';
    txt.innerHTML = `<b>${escapeHtml(p.label)}</b><span>${escapeHtml(p.desc)}</span>`;
    row.appendChild(txt);
    proWrap.appendChild(row);
  }
  menu.appendChild(proWrap);
  for (const role of SWARM_ROLE_META) {
    const appt = router.appoint(SWARM_ROLES[role.id], pickable, { overrides }); // route only among enabled+usable
    const tier = appt?.mode === 'subagent' ? 'subagent' : (appt?.tier || SWARM_ROLES[role.id].prefer);
    const pinned = overrides[role.id] && pickable.some((c) => c.id === overrides[role.id]) ? overrides[role.id] : ''; // a disabled pin → falls back to Auto
    const row = document.createElement('div');
    row.className = 'swarm-row';
    row.innerHTML =
      `<div class="swarm-role"><span class="swarm-ico">${iconForEmoji(role.icon) || escapeHtml(role.icon || '')}</span>` +
      `<div class="swarm-role-txt"><b>${role.name}</b><span>${escapeHtml(role.desc)}</span></div>` +
      `<span class="swarm-tier tier-${escapeHtml(tier)}">${escapeHtml(tier)}</span></div>`;
    const sel = document.createElement('select');
    sel.className = 'swarm-select';
    // Show every configured model; disable (grey, unselectable) the ones that can't run,
    // with the reason, so you know to go enable them in Settings → API / Agents.
    sel.innerHTML = `<option value="">${escapeHtml(appt ? `Auto → ${appt.name || appt.model}` : 'Auto (no active model)')}</option>`
      + cands.map((c) => {
        const off = c.enabled === false || c.usable === false;
        return `<option value="${escapeHtml(c.id)}"${off ? ' disabled' : ''}>${escapeHtml(c.name || c.model)}${escapeHtml(reasonFor(c))}</option>`;
      }).join('');
    sel.value = pinned;
    sel.onchange = () => setRoleOverride(role.id, sel.value);
    row.appendChild(sel);
    menu.appendChild(row);
  }
  const meter = document.createElement('div');
  meter.className = 'swarm-meter';
  const used = budgetUsed();
  meter.innerHTML = `<span>Spend this minute</span><b class="${used >= swarmBudget.capPerMin ? 'over' : ''}">${used} / ${swarmBudget.capPerMin}</b><span>model calls</span>`;
  menu.appendChild(meter);
  const hint = document.createElement('div');
  hint.className = 'agent-hint';
  hint.textContent = cands.length > pickable.length
    ? 'Greyed models are inactive — enable them in Settings → API / Agents. Auto routes among active models by role (cheap → strong).'
    : 'Auto = the router picks by role (cheap → strong). Free work (deterministic edits, retrieval) never counts against spend.';
  menu.appendChild(hint);
}
function setRoleOverride(roleId, candId) {
  const o = swarmOverrides();
  if (candId) o[roleId] = candId; else delete o[roleId];
  localStorage.setItem('chatpanel.notes.cowriter.roles', JSON.stringify(o));
  renderSwarmMenu();
  toast(candId ? 'Role pinned' : 'Role back to auto');
}

// ── Swarm status strip — the orchestrator's live view of the team (Phase 4) ───────
// A shared, tiny state board each member updates as it works, rendered as an ambient
// line of role chips in the footer (only while the swarm is on). Gives "the team is
// working for you" visibility with no rewrite of the members — they call setSwarmState
// at their edges. A pulsing dot = working; a count/label = the last result.
const swarm = {
  editor: { state: 'idle', info: '' },      // idle | working | 'N fixes'
  researcher: { state: 'idle', info: '' },  // idle | working | 'N found'
  writer: { state: 'idle', info: '' },      // idle | working | 'draft ready'
  connector: { state: 'idle', info: '' },   // idle | 'N links'
  factcheck: { state: 'idle', info: '' },   // idle | working | 'N flags' (Focus only)
};
let swarmGear = localStorage.getItem('chatpanel.notes.gear') || 'ambient'; // 'ambient' | 'focus'

// Fine-grained co-writer proactivity — each an independent OPT-IN (default OFF), so a
// calm writer keeps a quiet editor and an active writer turns just the parts they want
// on. Persisted; orthogonal to the Ambient/Focus gear (a preset). All require the
// co-writer master toggle on. Surfaced as checkboxes in the team menu (notes settings).
//   revealFixes       — auto-reveal the Co-writer tab when new fixes/links land
//   actOnInstructions — a plain imperative line ("summarize the above in 3 sentences")
//                       becomes a runnable task the Writer drafts a result for
//   goalDrive         — with a goal set, keep drafting toward it on idle (accept/reject)
const AI_PREFS = { revealFixes: false, actOnInstructions: false, goalDrive: false };
function loadAIPrefs() {
  try { Object.assign(AI_PREFS, JSON.parse(localStorage.getItem('chatpanel.notes.aiPrefs') || '{}')); }
  catch { /* keep defaults */ }
}
function setAIPref(k, v) {
  if (!(k in AI_PREFS)) return;
  AI_PREFS[k] = !!v;
  localStorage.setItem('chatpanel.notes.aiPrefs', JSON.stringify(AI_PREFS));
}

function setGear(g) {
  swarmGear = g === 'focus' ? 'focus' : 'ambient';
  localStorage.setItem('chatpanel.notes.gear', swarmGear);
  renderSwarmStatus();
  if ($('n-swarm-menu') && !$('n-swarm-menu').classList.contains('hidden')) renderSwarmMenu();
}
// Visible spend guardrail — a rolling per-minute cap on swarm MODEL calls. Free work
// (the deterministic Editor pass, retrieval-only Researcher/Connector) never counts;
// over the cap, the token-spending members skip until the window clears.
const swarmBudget = { calls: [], capPerMin: 20 };
function budgetOk() {
  const now = Date.now();
  swarmBudget.calls = swarmBudget.calls.filter((t) => now - t < 60000);
  return swarmBudget.calls.length < swarmBudget.capPerMin;
}
function budgetSpend() { swarmBudget.calls.push(Date.now()); }
function budgetUsed() { const now = Date.now(); return swarmBudget.calls.filter((t) => now - t < 60000).length; }
function setSwarmState(role, state, info = '') {
  if (!swarm[role]) return;
  swarm[role] = { state, info };
  renderSwarmStatus();
}
function resetSwarmState() {
  for (const k of Object.keys(swarm)) swarm[k] = { state: 'idle', info: '' };
  renderSwarmStatus();
}
function renderSwarmStatus() {
  const el = $('n-swarm-status');
  if (!el) return;
  if (!cwEnabled) { el.innerHTML = ''; return; }
  const chip = (glyph, r, title) =>
    `<span class="ss ss-${r.state}" title="${title}"><span class="ss-dot"></span>${glyph}${r.info ? ` <span class="ss-info">${escapeHtml(r.info)}</span>` : ''}</span>`;
  el.innerHTML =
    (swarmGear === 'focus' ? `<span class="ss ss-focus" title="Focus mode — the swarm drafts sections + fact-checks (set in ⚙)">${icon('zap')} Focus</span>` : '')
    + (board.intent ? `<span class="ss ss-intent" title="This note's goal — guides the Writer & Researcher">${icon('target')} <span class="ss-info">${escapeHtml(board.intent.slice(0, 48))}</span></span>` : '')
    + chip(icon('cowriter'), swarm.editor, 'Editor — proofreads as you type')
    + chip(icon('research'), swarm.researcher, 'Researcher — finds related material')
    + chip(icon('sparkles'), swarm.writer, 'Writer — ⌘↵ to draft ahead')
    + chip(icon('link'), swarm.connector, 'Connector — links new topics to your docs')
    + (swarmGear === 'focus' ? chip('⚠️', swarm.factcheck, 'Fact-checker — flags shaky claims') : '');
}

// ── The blackboard — shared intent + activity log the whole swarm reads (Phase 4) ──
// One place the members coordinate: the user's one-line INTENT (what this note is for —
// guides the Writer & Researcher) and a rolling LOG of what each member did (the
// timeline). Per-note, local-only — a working hint, not note content.
const board = { intent: '', log: [] };
function boardIntentKey() { return current ? `chatpanel.notes.intent.${current.id}` : ''; }
function loadIntent() { board.intent = (current && localStorage.getItem(boardIntentKey())) || ''; }
function setIntent(v) {
  board.intent = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const k = boardIntentKey();
  if (k) { if (board.intent) localStorage.setItem(k, board.intent); else localStorage.removeItem(k); }
  renderSwarmStatus();
}
function logActivity(who, what) {
  const head = board.log[0];
  if (head && head.who === who && head.what === what) { head.at = Date.now(); head.n = (head.n || 1) + 1; renderSwarmStatus(); scheduleActivityRender(); return; } // collapse repeats
  board.log.unshift({ who, what, at: Date.now(), n: 1 });
  if (board.log.length > 30) board.log.length = 30;
  renderSwarmStatus();
  scheduleActivityRender(); // the Team-activity timeline
}
// The away-timeline: click the status strip to see what the team did while you wrote.
function timelineEl() {
  let el = document.getElementById('n-timeline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'n-timeline';
    el.className = 'timeline hidden';
    el.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(el);
  }
  return el;
}
function toggleTimeline() {
  const el = timelineEl();
  if (!el.classList.contains('hidden')) return el.classList.add('hidden');
  if (!board.log.length) return toast('No swarm activity yet');
  el.innerHTML = '<div class="tl-title">Swarm activity · click a row to open it</div>' + board.log.map((e, i) =>
    `<div class="tl-row" data-i="${i}"><span class="tl-who">${escapeHtml(e.who)}</span><span class="tl-what">${escapeHtml(e.what)}${e.n > 1 ? ` ·×${e.n}` : ''}</span><span class="tl-when">${escapeHtml(relTime(e.at))}</span></div>`).join('');
  el.querySelectorAll('.tl-row').forEach((row) => {
    const e = board.log[+row.dataset.i];
    row.onclick = () => {
      el.classList.add('hidden');
      if (/Researcher/.test(e.who)) { $('n-body').focus(); runResearch({ web: false }); } // re-surface what it found
      else { $('n-cowriter').scrollIntoView({ block: 'nearest' }); } // fixes/links live in the strip
    };
  });
  el.classList.remove('hidden');
  const strip = $('n-swarm-status').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.round(Math.min(Math.max(8, strip.left + strip.width / 2 - r.width / 2), window.innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.round(strip.top - r.height - 8)}px`;
}

// The single line the cursor sits on (for affordance detection).
function currentLine() {
  const v = bodyText(); const pos = bodyCursor();
  const s = v.lastIndexOf('\n', pos - 1) + 1;
  let e = v.indexOf('\n', pos); if (e < 0) e = v.length;
  return { text: v.slice(s, e), start: s, end: e };
}

// Affordance orchestrator — the single debounced observer that wakes the RIGHT member
// for what the text affords: a finished question ("…?") → Researcher (+ Writer handoff);
// an empty heading / TODO / bullet → a Writer draft NUDGE (offered, never auto-spent —
// token control); otherwise → related-material (Researcher) + link-new-topics (Connector).
let lastQuestion = '';
function observe() {
  if (!cwEnabled || !current || noteHasJob(current.id)) return;
  const t = currentLine().text.trim();
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'mention' && s.role !== 'instruction'); // recomputed per line
  // A directed task line — an @command/slash at the start, OR an "@[Agent] …" mention
  // ANYWHERE on the line (the natural "do X @agent" form, not just "@agent do X"). The
  // ambient swarm must NOT research/draft/fact-check it (noise, and an auto-draft would
  // swallow the Enter that runs it). For a mention, surface a one-click Run (mirrors Enter).
  const men = parseAgentMention(t);
  if (men.name && men.task) { addMentionNudge(men.name); return; }
  if (/^[@/]/.test(t)) { removeWriterNudge(); return; }
  // An imperative line the user wants executed ("summarize the above in 3 sentences") →
  // a one-click "Do this" (⌘↵ also runs it). Opt-in; otherwise it's just prose to continue.
  if (AI_PREFS.actOnInstructions) { const io = instructionOnLine(); if (io) { addInstructionNudge(io); return; } }
  const isQuestion = /\?\s*$/.test(t) && t.split(/\s+/).length >= 3;
  const aff = writerAffordance();
  // Focus mode actively drafts a section on the spot; Ambient just nudges.
  if (aff) { if (swarmGear === 'focus' && aff.kind === 'section') autoDraft(aff); else addWriterNudge(aff); }
  else removeWriterNudge();
  if (isQuestion) { if (t !== lastQuestion) { lastQuestion = t; runResearch({ question: t, web: true }); } } // a question wants an answer → search the web too
  else { runResearch(); runConnector(); }
  // With a goal set, keep the draft moving toward it on idle (opt-in) — but only when the
  // line affords nothing else (no outline/heading nudge, not a question to research).
  if (!aff && !isQuestion) maybeGoalDraft();
  if (swarmGear === 'focus') runFactcheck(); // the reasoning-tier member only runs in Focus
}
let lastAutoDraft = '';
function autoDraft(aff) {
  const key = `${aff.kind}:${aff.at}`;
  if (ghost || writerAbort || key === lastAutoDraft) { addWriterNudge(aff); return; } // never repeat a spot
  lastAutoDraft = key;
  const ta = $('n-body');
  ta.focus();
  ta.selectionStart = ta.selectionEnd = Math.min(aff.at, ta.value.length);
  draftAhead();
}

// Fact-checker — Focus-only, reasoning-tier. Checks the last completed sentence in the
// current paragraph against the rest of the note for unsupported / contradictory claims,
// and flags it in the suggestion queue. Rate-limited by design: Focus-gated, once per
// sentence, on the 2.6s idle — and it goes through the PII harness like every member.
let factcheckGen = 0;
let lastFactSentence = '';
async function runFactcheck() {
  if (!cwEnabled || !current || swarmGear !== 'focus' || noteHasJob(current.id) || agentAbort || writerAbort) return;
  const claim = ((currentParagraph().text.match(/[^.!?]+[.!?]+/g) || []).pop() || '').trim();
  if (claim.length < 24 || claim === lastFactSentence) return;
  lastFactSentence = claim;
  const gen = ++factcheckGen;
  let deps;
  try { deps = await agentDeps(); } catch { return; }
  const settings = await deps.getSettings();
  const license = await deps.getLicense();
  const fc = await roleAgent(deps, settings, license, 'factcheck');
  if (!fc) return;
  if (!budgetOk()) { setSwarmState('factcheck', 'idle', 'rate cap'); return; }
  budgetSpend();
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }
  setSwarmState('factcheck', 'working');
  const sys = 'You are a careful fact-checker reviewing ONE claim from a note. Decide only if the claim is internally UNSUPPORTED or CONTRADICTS the rest of the note — do not judge outside facts. Reply with a single compact JSON object and nothing else: {"verdict":"ok"|"unsupported"|"contradiction","why":"<=12 words"}.';
  const act = makeSwarmActivity(current.id, '⚠️ Fact-checker', fc.resolved.model || fc.resolved.bridgeAgent || 'model', !!redaction);
  let out = '';
  try {
    out = await deps.streamChat({
      agent: { ...fc.resolved, systemPrompt: sys, maxTokens: 120, temperature: 0 },
      settings, redaction,
      messages: [{ role: 'user', content: `NOTE:\n${(current.body || '').slice(0, 4000)}\n\nCLAIM TO CHECK:\n${claim}` }],
      onEvent: act.onEvent,
    });
    act.done();
  } catch { act.done(); setSwarmState('factcheck', 'idle'); return; }
  if (gen !== factcheckGen || !cwEnabled) return;
  let verdict = null;
  try { verdict = JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { /* non-JSON → treat as ok */ }
  const bad = verdict && (verdict.verdict === 'unsupported' || verdict.verdict === 'contradiction');
  if (bad) {
    const key = `fact:${claim.slice(0, 48).toLowerCase()}`;
    if (!boardDismissed.has(key)) {
      boardSuggestions = boardSuggestions.filter((s) => s.key !== key).concat([{
        role: 'factcheck', icon: '⚠️', key,
        html: `${verdict.verdict === 'contradiction' ? 'Contradiction' : 'Unsupported'} <span class="cw-hand">— find a source</span>`,
        title: `${escapeHtml(verdict.why || 'shaky claim')} · Fact-checker (${escapeHtml(fc.resolved.model || 'model')}) — click to hand off to the Researcher`,
        // Fact-checker → Researcher handoff: look for a source that supports the claim.
        apply: () => { toast(verdict.why || 'Flagged claim'); boardDismissed.add(key); runResearch({ question: claim, web: true }); },
      }]);
      logActivity('Fact-checker', `${verdict.verdict}: ${(verdict.why || '').slice(0, 40)}`);
    }
  }
  setSwarmState('factcheck', 'idle', bad ? '1 flag' : 'ok');
  renderCowriter();
}

// What the cursor line affords the Writer: an empty outline item, a TODO marker, or a
// heading with no body yet → { kind, at, label }, or null. The Writer only DRAFTS on an
// explicit nudge/⌘↵, so detecting the spot is free.
function writerAffordance() {
  const v = $('n-body').value;
  const line = currentLine();
  const t = line.text;
  if (/^\s*([-*]|\d+\.)\s*(\[ \]\s*)?$/.test(t)) return { kind: 'item', at: line.end, label: 'this item' };
  if (/\b(TODO|TK|TBD)\b:?\s*$/i.test(t)) return { kind: 'todo', at: line.end, label: 'this to-do' };
  if (/^#{1,6}\s+\S/.test(t)) { // heading whose section has no body yet
    const next = v.slice(line.end).replace(/^\n/, '').split('\n', 1)[0] || '';
    if (!next.trim() || /^#{1,6}\s/.test(next)) return { kind: 'section', at: line.end, label: 'this section' };
  }
  if (!t.trim()) { // blank line directly under a heading
    const before = v.slice(0, line.start).replace(/\n$/, '');
    const prev = before.slice(before.lastIndexOf('\n') + 1);
    if (/^#{1,6}\s+\S/.test(prev)) return { kind: 'section', at: line.start, label: 'this section' };
  }
  return null;
}
function addWriterNudge(aff) {
  const key = `draft:${aff.kind}:${aff.at}`;
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'writer');
  if (!boardDismissed.has(key)) {
    boardSuggestions.push({
      role: 'writer', icon: '✨', key,
      html: `Draft ${escapeHtml(aff.label)}`,
      title: 'Hand to the Writer — draft here (or press ⌘↵)',
      apply: () => { const ta = $('n-body'); ta.focus(); ta.selectionStart = ta.selectionEnd = Math.min(aff.at, ta.value.length); draftAhead(); },
    });
  }
  renderCowriter();
}
function removeWriterNudge() {
  if (boardSuggestions.some((s) => s.role === 'writer')) {
    boardSuggestions = boardSuggestions.filter((s) => s.role !== 'writer');
    renderCowriter();
  }
}

// An imperative line the user wants ACTED on ("summarize the above in 3 sentences",
// "list the key risks", "rewrite this as bullets") — distinct from prose to continue.
// Opt-in (actOnInstructions): conservative verb-led match, never an @mention/slash line.
// Returns { text, at } (at = end of the line, where the drafted result is inserted).
const INSTRUCTION_RE = /^\s*(?:please\s+|can you\s+|now\s+)?(summari[sz]e|recap|tl;?dr|rewrite|re-?write|reword|rephrase|expand|elaborate|continue|list|enumerate|outline|draft|write|compose|generate|create|add|explain|describe|define|compare|contrast|shorten|condense|tighten|simplify|translate|convert|turn\s+.+\s+into|make\s+(?:this|it|these|a\b)|bullet|brainstorm|suggest|proofread|polish|improve)\b/i;
function instructionOnLine() {
  const line = currentLine();
  const t = line.text.trim();
  if (t.length < 6) return null;
  if (/^[@/]/.test(t) || parseAgentMention(t).name) return null; // mentions/commands run elsewhere
  if (!INSTRUCTION_RE.test(t)) return null;
  return { text: t, at: line.end };
}
function addInstructionNudge(io) {
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'writer' && s.role !== 'instruction');
  const key = `do:${io.text.slice(0, 60).toLowerCase()}`;
  if (!boardDismissed.has(key)) {
    boardSuggestions.push({
      role: 'instruction', icon: '▶️', key,
      html: `Do this <span class="cw-hand">— ${escapeHtml(io.text.slice(0, 40))}${io.text.length > 40 ? '…' : ''}</span>`,
      title: 'Run this instruction on the note — the Writer drafts a result you accept (or press ⌘↵)',
      apply: () => {
        const ta = $('n-body');
        const i = ta.value.indexOf(io.text);
        if (i < 0) { toast('That line moved — click back on it'); return; }
        ta.focus();
        ta.selectionStart = ta.selectionEnd = i; // put the caret on the instruction line
        draftAhead({ instruction: io.text });
      },
    });
  }
  renderCowriter();
}

// Goal-drive — with a goal set and "Let the goal keep writing" on, offer to draft the next
// line toward it when the user pauses at a natural stopping point. Reuses the Writer's ghost
// (accept/reject) and its prompt already carries board.intent, so this is just an idle auto-⌘↵.
//
// It must NOT loop: without a strong guard it re-fires on every keystroke-pause (each Enter
// changes the length) and re-drafts near-duplicates. So it fires AT MOST ONCE per burst of
// the user's OWN writing — the doc must have grown by real typing since the last auto-draft.
// `lastGoalLen` is the body length at the last draft; accepting a draft bumps it too (see
// acceptGhost), so an accepted continuation doesn't immediately trigger the next one — the
// user has to add more of their own words first. -1 = armed (fire once when there's context).
let lastGoalLen = -1;
const GOAL_MIN_NEW = 24; // chars of the user's own writing between auto-drafts
function maybeGoalDraft() {
  if (!AI_PREFS.goalDrive || !board.intent) return;
  if (ghost || writerAbort || agentAbort || (current && noteHasJob(current.id))) return;
  const ta = $('n-body');
  if (ta.readOnly || ta.selectionStart !== ta.selectionEnd) return;
  const v = ta.value;
  const from = ta.selectionStart;
  if (from !== v.length && v[from] !== '\n') return;               // only at a line / paragraph / doc end
  if (v.slice(0, from).trim().length < 24) return;                 // need real context to continue
  if (lastGoalLen >= 0 && v.length <= lastGoalLen + GOAL_MIN_NEW) return; // wait for the user to write more themselves
  if (!budgetOk()) return;                                          // respect the visible spend cap
  lastGoalLen = v.length;
  draftAhead();                                                     // intent is already injected into its prompt
}
function noteGoalProgress() { if (AI_PREFS.goalDrive) lastGoalLen = $('n-body').value.length; } // re-baseline after an accepted draft

// A one-click "Run @Agent" chip for a line that mentions an agent — the same task Enter
// would run, for the user who reaches for a button instead. Also drops the Writer nudge,
// since a mention line is a directed task, not a spot to auto-draft.
function addMentionNudge(name) {
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'writer');
  const m = mentionForName(name);
  if (m) {
    const key = `run:${name}:${m.task.slice(0, 48).toLowerCase()}`;
    if (!boardDismissed.has(key)) {
      boardSuggestions.push({
        role: 'mention', icon: '▶️', key,
        html: `Run <b>@${escapeHtml(name)}</b>`,
        title: `Assign this task to ${escapeHtml(name)} — it can research and edit the note (or press Enter)`,
        apply: () => { const men = mentionForName(name); if (men) runAgentTask(men); else toast('That mention is no longer in the note'); },
      });
    }
  }
  renderCowriter();
}
// Locate a line carrying a runnable "@[name] task" mention → a full mention object with
// start/end recomputed from the LIVE body, so a click still targets the right line after
// the cursor moves or the text shifts.
function mentionForName(name) {
  const val = $('n-body').value;
  let pos = 0;
  for (const ln of val.split('\n')) {
    const p = parseAgentMention(ln);
    if (p.name === name && p.task) return { name: p.name, task: p.task, start: pos, end: pos + ln.length };
    pos += ln.length + 1;
  }
  return null;
}

// Researcher → Writer handoff: draft an answer to the question the Researcher just
// gathered sources for. Reuses the ghost machinery — position the caret right after the
// question and let the (research-grounded) Writer continue.
async function draftAnswer() {
  if (!lastQuestion || ghost || writerAbort) return;
  const ta = $('n-body');
  const i = ta.value.indexOf(lastQuestion);
  if (i < 0) return;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = i + lastQuestion.length; // caret right after the "?"
  await draftAhead();
}

// ── wire up ───────────────────────────────────────────────────────────────────
function init() {
  $('n-new').onclick = newNote;
  $('n-new2').onclick = newNote;
  $('n-new3').onclick = newNote;
  $('n-delete').onclick = removeCurrent;
  $('n-copy').onclick = copyCurrent;
  // Export menu → Markdown (.md download) or PDF (print/save). Extensible for future formats.
  $('n-export').onclick = (e) => { e.stopPropagation(); $('n-export-menu').classList.toggle('hidden'); };
  for (const b of $('n-export-menu').querySelectorAll('button[data-export]')) {
    b.onclick = () => { $('n-export-menu').classList.add('hidden'); if (b.dataset.export === 'pdf') exportPdf(); else downloadCurrent(); };
  }
  document.addEventListener('click', () => $('n-export-menu').classList.add('hidden'));
  $('n-ask').onclick = askAboutNote;
  $('n-open-panel').onclick = openPanel;
  $('n-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#notes') });
  // Assistant sidebar — tab switching + collapse.
  document.querySelectorAll('#n-side .side-tab').forEach((b) => { b.onclick = () => setSideTab(b.dataset.side); });
  renderSrcFilter(); // paint the source-type filter chips (Notes/Chats/Meetings/Web)
  $('n-side-collapse').onclick = () => setSideCollapsed(true);
  $('n-side-toggle').onclick = () => setSideCollapsed(!sideCollapsed);
  $('n-activity-clear').onclick = () => {
    if (!current) return;
    if (noteHasJob(current.id)) return toast('Still running — stop it first (Esc)');
    noteActivity.delete(current.id); // the tool-call detail
    board.log = [];                   // and the Team-activity timeline
    renderActivity();
    renderSwarmStatus();
  };

  // Layout controls (bottom toolbar): collapse list · focus (both) · collapse panel.
  const collapseBtn = $('n-collapse');
  applyRailCollapsed(localStorage.getItem('chatpanel.notes.railCollapsed') === '1');
  collapseBtn.onclick = () => applyRailCollapsed(!railCollapsed);
  $('n-collapse-both').onclick = () => setBothCollapsed(!(railCollapsed && sideCollapsed));

  $('n-title').addEventListener('input', () => { updateWordCount(); scheduleSave(); scheduleCowriter(); });
  // Enter / ↓ in the title drops into the body (title is single-line).
  $('n-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      // In Live mode the visible body is CM6, not the (hidden mirror) textarea — focus the
      // right surface and drop the caret at the very start of the body.
      if (cmActive && cm) { cm.focus(); cm.setSelection(0, 0); }
      else { const b = $('n-body'); b.focus(); b.setSelectionRange(0, 0); }
    }
  });
  $('n-body').addEventListener('input', onBodyInput);
  $('n-body').addEventListener('paste', onEditorPaste); // paste a bare URL → [Title](url) (classic mode)
  $('n-body').addEventListener('keydown', (e) => {
    const ta = $('n-body');
    // Dropdown navigation takes priority while open.
    if (ac.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveAc(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveAc(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return acceptAc(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeAc(); }
    }
    // Writer draft-ahead ghost. While streaming, swallow keys (Esc aborts). When a draft
    // is pending: Tab accepts, Esc rejects, any other key rejects then applies normally.
    if (writerAbort) {
      // …but Enter on a directed @[Agent]/@command line still submits the task (abort the
      // in-flight ambient draft first) — the user's explicit action wins.
      if (e.key === 'Enter' && !e.shiftKey && (currentMention() || currentCommandLine())) {
        writerAbort.abort();
        clearGhost({ remove: true });
      } else {
        if (e.key === 'Escape') { e.preventDefault(); writerAbort.abort(); clearGhost({ remove: true }); }
        return;
      }
    }
    if (ghost) {
      if (e.key === 'Tab') { e.preventDefault(); return acceptGhost(); }
      // A deliberate ⌘↵ Writer draft-ahead also accepts on plain Enter (an as-you-type
      // Autocomplete prediction keeps Enter = newline, so it falls through and drops).
      if (e.key === 'Enter' && !e.shiftKey && ghostAuthor.startsWith('Writer')) { e.preventDefault(); return acceptGhost(); }
      if (e.key === 'Escape') { e.preventDefault(); return clearGhost({ remove: true }); }
      // ⌘C → commit the draft so the copy keeps it in the note (native copy still proceeds).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) { acceptGhost({ keepSelection: true }); return; }
      // A ⌘/Ctrl shortcut (⌘A/⌘S…) must NOT drop the draft — ⌘A to copy it would delete it
      // (a ghost is never versioned). A real ⌘V paste still drops it via the input path.
      if (!(e.metaKey || e.ctrlKey) && !['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) clearGhost({ remove: true });
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); return draftAhead(); }
    // Typing the second [ auto-closes to [[]] with the cursor inside → opens the picker.
    if (e.key === '[' && ta.selectionStart === ta.selectionEnd && ta.value[ta.selectionStart - 1] === '[') {
      e.preventDefault();
      const pos = ta.selectionStart;
      ta.setRangeText('[]]', pos, pos, 'end');
      ta.selectionStart = ta.selectionEnd = pos + 1;
      onBodyInput();
      return;
    }
    // Esc stops the most-recent job running on THIS note (jobs on other notes keep going).
    const openJob = current && lastJobForNote(current.id);
    if (e.key === 'Escape' && openJob) { e.preventDefault(); openJob.abort.abort(); return; }
    // Enter on "@research <topic>" wakes the Researcher for that topic (local + web) and
    // consumes the command line. Self-contained — doesn't touch the @command job path.
    if (e.key === 'Enter' && !e.shiftKey && !openJob) {
      const rline = currentLine();
      const rm = rline.text.match(/^@research\s+(.{2,})$/i);
      if (rm) {
        e.preventDefault();
        ta.setRangeText('', rline.start, rline.end, 'end');
        onBodyInput();
        runResearch({ question: rm[1].trim(), web: true });
        return;
      }
      // "/plan <topic>" → spin the topic off into a new, linked plan note (vs inline).
      const pm = rline.text.match(/^\/plan\s+(.{2,})$/i);
      if (pm) {
        e.preventDefault();
        ta.setRangeText('', rline.start, rline.end, 'end');
        onBodyInput();
        planInNewNote(pm[1].trim());
        return;
      }
    }
    // Enter on an "@[Agent] task" line assigns the task to that named agent.
    if (e.key === 'Enter' && !e.shiftKey && !openJob) {
      const mention = currentMention();
      if (mention) { e.preventDefault(); runAgentTask(mention); return; }
    }
    // Enter on an "@command instruction" line runs it (instead of a newline).
    if (e.key === 'Enter' && !e.shiftKey && !openJob && currentCommandLine()) {
      e.preventDefault();
      runNoteCommand();
      return;
    }
    // ↑ at the very start of the body hops back to the title.
    if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault();
      const t = $('n-title');
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  });
  $('n-body').addEventListener('blur', () => {
    setTimeout(closeAc, 120); // let a click land first
    // Only reject a pending draft-ahead when focus moved to ANOTHER element in this page
    // (title, a note in the list, …). When the whole WINDOW loses focus — clicking another
    // app/window, or switching tabs — leave in-flight AI work running in the background.
    if (!document.hasFocus()) return;
    if (writerAbort) writerAbort.abort();
    clearGhost({ remove: true });
  });
  $('n-search').addEventListener('input', (e) => onNotesSearch(e.target.value));
  for (const b of $('n-modes').children) b.onclick = () => setSearchMode(b.dataset.mode);
  $('omni-open').onclick = () => openOmni($('n-search').value || '');
  $('n-graph-toggle').onclick = toggleDash;
  for (const b of $('n-dash').querySelectorAll('.dash-tabs button')) b.onclick = () => setDashTab(b.dataset.dash);

  for (const b of $('n-mode').children) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $('n-fmt').children) b.onclick = () => applyFmt(b.dataset.fmt);
  $('n-dictate').onclick = toggleDictate;
  $('n-transcribe').onclick = toggleTranscribe;
  // Paragraph-alignment menu (reading view).
  $('n-align').onclick = (e) => { e.stopPropagation(); $('n-align-menu').classList.toggle('hidden'); };
  for (const b of $('n-align-menu').querySelectorAll('button[data-align]')) {
    b.onclick = () => { setAlign(b.dataset.align); $('n-align-menu').classList.add('hidden'); };
  }

  // Rendered-markdown links: external URLs carry the target in data-href (no live
  // href, to dodge Chrome's speculative preload), so open them via a click handler.
  $('n-preview').addEventListener('click', async (e) => {
    // Task-list checkbox → toggle the matching `- [ ]`/`- [x]` in the source so read
    // mode stays interactive (the native toggle is overridden by the re-render).
    const cb = e.target.closest?.('input.md-check[data-task]');
    if (cb) { toggleTaskCheckbox(Number(cb.getAttribute('data-task'))); return; }
    // [[wiki links]] → resolve the title to a doc and navigate.
    const wl = e.target.closest?.('a.wikilink[data-wikilink]');
    if (wl) {
      e.preventDefault();
      const title = wl.getAttribute('data-wikilink') || '';
      const t = (await linkTargets()).find((x) => x.title.toLowerCase() === title.toLowerCase());
      if (!t) return toast(`No document named "${title}" yet`);
      const [page, hash] = t.url.split('#');
      if (page === 'notes.html' && hash) openNote(decodeURIComponent(hash));
      else chrome.tabs.create({ url: t.url });
      return;
    }
    const a = e.target.closest?.('a.md-link[data-href], a[href]');
    if (!a) return;
    const url = a.getAttribute('data-href') || a.getAttribute('href');
    if (!url || url.startsWith('#')) return;
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    else if (/^chrome-extension:/i.test(url)) chrome.tabs.create({ url });
  });

  // Agent menu: click to open; click while streaming = stop. Menu items run actions.
  $('n-agent').onclick = (e) => {
    e.stopPropagation();
    if (agentAbort) { agentAbort.abort(); return; }
    $('n-agent-menu').classList.toggle('hidden');
  };
  for (const b of $('n-agent-menu').querySelectorAll('button[data-act]')) b.onclick = () => (b.dataset.act === 'plannote' ? planInNewNote() : runAgentAction(b.dataset.act));
  document.addEventListener('click', closeAgentMenu);
  document.addEventListener('click', () => $('n-align-menu').classList.add('hidden'));

  // Co-writer swarm toggle (opt-in; persisted). Announce only on user action, not load.
  $('n-cw-toggle').onclick = () => setCowriter(!cwEnabled, true);
  setCowriter(cwEnabled);

  // Researcher: 🔎 opens the Research tab and runs research on demand (local + web).
  // Explicit Search → open Research, make sure Web is included in the filter, then run.
  const runSearch = () => { setSideTab('research'); if (!srcFilter.has('web')) { srcFilter.add('web'); saveSrcFilter(); renderSrcFilter(); } runResearch({ web: true }); };
  $('n-research-btn').onclick = runSearch;
  $('n-research-web').onclick = runSearch;

  // History (🕓) — authorship ledger + version snapshots (opens the History tab).
  $('n-history-btn').onclick = () => setSideTab('history');
  $('n-history-save').onclick = () => { pushVersion(HUMAN, 'Manual save'); scheduleSave(true); renderHistory(); toast('Version saved'); };
  $('n-history-attrib').onclick = () => {
    const v = $('n-history-attrib-view');
    const show = !v.classList.contains('shown');
    v.classList.toggle('shown', show);
    v.classList.toggle('hidden', !show);
    $('n-history-attrib').classList.toggle('on', show);
    if (show) renderAttribView();
  };

  // Swarm team panel (⚙) — open shows the router's appointments + per-role overrides.
  $('n-swarm').onclick = (e) => {
    e.stopPropagation();
    const menu = $('n-swarm-menu');
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (willOpen) renderSwarmMenu();
  };
  $('n-swarm-menu').addEventListener('click', (e) => e.stopPropagation()); // keep open while choosing
  document.addEventListener('click', () => $('n-swarm-menu').classList.add('hidden'));

  // Status strip → the away-timeline of what the swarm did.
  $('n-swarm-status').onclick = (e) => { e.stopPropagation(); revealActivity(); }; // → the unified Team-activity panel
  document.addEventListener('click', () => timelineEl().classList.add('hidden'));

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    // Undo / redo for the note body — our own history (native ⌘Z is dead because the
    // editor rewrites the body programmatically). Handled at document level so it works
    // in read mode too (the body textarea is hidden there). The title & search fields
    // keep their native undo.
    if (k === 'z' || k === 'y') {
      // Only drive the note-body history when the body (or a non-text element, e.g. in
      // read mode) is focused — any OTHER text field (title, search, tag/intent inputs)
      // keeps its native undo.
      const el = document.activeElement;
      if (el && el !== $('n-body') && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redoEdit(); else undoEdit();
      return;
    }
    if (k === 'n') { e.preventDefault(); newNote(); }
    else if (e.key === '/') { e.preventDefault(); setSideCollapsed(!sideCollapsed); }
    else if (k === 'k') { e.preventDefault(); openOmni($('n-search').value || ''); }
    else if (k === 'f' && !e.shiftKey) { e.preventDefault(); $('n-search').focus(); }
    else if (k === 's') { e.preventDefault(); flushSave(); toast('Saved'); }
    else if (e.key === '\\') { e.preventDefault(); collapseBtn.click(); }
    else if (e.key === '.') { e.preventDefault(); setBothCollapsed(!(railCollapsed && sideCollapsed)); }
    // ⌘A in Read mode: select only the rendered note text (not the whole window — nav,
    // list, toolbar…). Fields keep their native select-all.
    else if (k === 'a' && $('n-panes').classList.contains('read')) {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents($('n-preview'));
      sel.addRange(r);
    }
    else if (k === 'b' && document.activeElement === $('n-body')) { e.preventDefault(); applyFmt('bold'); }
    else if (k === 'i' && document.activeElement === $('n-body')) { e.preventDefault(); applyFmt('italic'); }
  });
  window.addEventListener('beforeunload', flushSave);

  // Keep the list fresh when notes change elsewhere (e.g. a web highlight → Inbox in
  // another tab). Debounced; refreshes only the LIST, never the open editor.
  let extRefreshTimer = null;
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Pick up autocomplete on/off + model and the agent list from the Settings tab.
      if (changes['chatpanel:settings']) { loadAutocompleteCfg(); loadMentionTargets(); }
      if (changes['chatpanel:license']) refreshLicense(); // upgrade/downgrade → unlock notes + repaint cap
      if (!Object.keys(changes).some((k) => k.startsWith('chatpanel:note'))) return;
      clearTimeout(extRefreshTimer);
      extRefreshTimer = setTimeout(async () => { await reloadIndex(); renderList($('n-search').value); }, 400);
    });
  }
  loadAIPrefs(); // co-writer proactivity opt-ins (reveal fixes / act on instructions / goal-drive)
  loadAutocompleteCfg(); // inline-autocomplete on/off + model (Settings → Notes)
  loadMentionTargets();  // configured agents for the @ picker / @mention task runner

  // Live is the default editor; Source (raw markdown) is the only other view. Coerce any
  // legacy saved mode (write/split/read) → live so an old preference doesn't strand the user.
  setMode(localStorage.getItem('chatpanel.notes.mode') === 'write' ? 'write' : 'live');
  setAlign(localStorage.getItem(ALIGN_KEY) || 'justify');
  setSideTab(localStorage.getItem('chatpanel.notes.sideTab') || 'activity', { open: false });
  setSideCollapsed(localStorage.getItem('chatpanel.notes.sideCollapsed') === '1');
  initResizers();

  // Mirror the Notes UI + co-writer config (localStorage: swarm role→model overrides,
  // gear, source filter, layout) into chrome.storage so the service-worker auto-backup
  // can capture it — the SW has no localStorage. Dynamic-imported + deferred to stay off
  // first paint; flushes the latest snapshot whenever the page is hidden or unloaded.
  import('./js/notes-config.js').then(({ mirrorNotesConfig }) => {
    mirrorNotesConfig();
    document.addEventListener('visibilitychange', () => { if (document.hidden) mirrorNotesConfig(); });
    window.addEventListener('pagehide', () => mirrorNotesConfig());
  });
}

(async function start() {
  init();
  refreshLicense();         // read entitlement + cap once (local, off the paint path); repaints the header cap when ready
  await reloadIndex();      // one decrypt (the index), not one-per-note
  renderList('');
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId && list.some((n) => n.id === hashId)) openNote(hashId);
  else if (list.length) openDash(); // land on the dashboard (graph) — like the Chats/Meetings pages
})();
