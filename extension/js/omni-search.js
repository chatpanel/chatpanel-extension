// Omni search — one command-palette modal that searches across ALL three local
// sources (notes + chats + meetings) at once, with instant ranked results and a
// live relationship graph. Shared by notes.html, history.html and meetings.html.
//
// Reuse, don't reinvent: the corpus + ranking are the SAME primitives that power
// the /history tool. `loadHistorySources` builds (and caches) the note/chat/meeting
// sources; `rankHistorySources` ranks them off-thread in the search Web Worker with a
// synchronous fallback — so typing stays instant and the corpus is only re-indexed
// when it actually changes (`historySourcesVersion`). The graph reuses `buildGraph`
// (meeting-index) for cross-type edges and `drawGraph` (graph-view) for layout.
//
// LOAD DISCIPLINE: this whole module — modal shell, ranking corpus, graph — is
// `await import()`ed by each page on FIRST open, never statically imported, so it
// never touches a page's first paint. It also injects its own CSS on first open.
//
// Navigation: every source carries a `url` of `page.html#rawId`, which each page's
// existing hash handler already understands. Hosts pass an `onOpen(result)` so a
// same-page hit opens in place (instant) and cross-page hits navigate.

import { loadHistorySources, historySourcesVersion, invalidateHistorySourceCache } from './history-rag.js';
import { rankHistorySources } from './search-engine.js';
import { buildGraph, topTerms } from './meeting-index.js';
import { icon } from './icons.js';

const TYPE_META = {
  note: { label: 'Notes', icon: 'notes', order: 0 },
  chat: { label: 'Chats', icon: 'chat', order: 1 },
  meeting: { label: 'Meetings', icon: 'meetings', order: 2 },
};
const GRAPH_NODE_CAP = 80; // keep the graph readable; the list carries the long tail

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function snippet(text, terms) {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  let pos = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  const start = pos < 0 ? 0 : Math.max(0, pos - 48);
  let seg = raw.slice(start, start + 160).replace(/\s+/g, ' ').trim();
  if (!seg) return '';
  let html = esc((start > 0 ? '…' : '') + seg + (raw.length > start + 160 ? '…' : ''));
  for (const t of terms) if (t.length > 1) html = html.replace(new RegExp(`(${reEsc(t)})`, 'ig'), '<mark>$1</mark>');
  return html;
}
const highlight = (s, terms) => {
  let html = esc(s);
  for (const t of terms) if (t.length > 1) html = html.replace(new RegExp(`(${reEsc(t)})`, 'ig'), '<mark>$1</mark>');
  return html;
};

// ---- module singleton state ------------------------------------------------
let els = null;          // { overlay, input, modes, list, count, graphWrap, graphHost, graphToggle, empty }
let cssInjected = false;
let corpus = null;       // cached sources array
let corpusVersion = -1;  // version the cache was built at
let corpusLoading = null;
let mode = 'best';       // best | exact
let graphOn = false;
let graphBuilt = false;
let graphNodes = [];     // node objects (drawGraph stashes .el on each)
let rows = [];           // current flat result rows (for keyboard nav)
let sel = -1;
let seq = 0;             // query sequence — drop stale async results
let debounceTimer = null;
let onOpen = (r) => { try { location.assign(r.url); } catch { /* ok */ } };
let currentType = null;  // 'note' | 'chat' | 'meeting' — the host page (for the "open here" hint)

// ---- corpus ----------------------------------------------------------------
async function ensureCorpus() {
  const v = historySourcesVersion();
  if (corpus && corpusVersion === v) return corpus;
  if (corpusLoading) return corpusLoading;
  corpusLoading = (async () => {
    const sources = await loadHistorySources({ includeChats: true, includeMeetings: true, includeNotes: true });
    corpus = sources;
    corpusVersion = v;
    graphBuilt = false; // corpus changed → graph is stale
    return sources;
  })();
  try { return await corpusLoading; } finally { corpusLoading = null; }
}

// ---- ranking ---------------------------------------------------------------
function dedupeBySource(results) {
  const best = new Map();
  for (const r of results) {
    const id = r.sourceId || r.id;
    const prev = best.get(id);
    if (!prev || (r.score || 0) > (prev.score || 0)) best.set(id, r);
  }
  return [...best.values()];
}

async function runQuery(query) {
  const q = query.trim();
  const sources = await ensureCorpus();
  if (!q) {
    // Empty query → most-recent across all sources, grouped.
    return sources
      .slice()
      .sort((a, b) => (b.date || 0) - (a.date || 0))
      .slice(0, 24)
      .map((s) => ({ sourceId: s.id, type: s.type, title: s.title, date: s.date, url: s.url, text: '' }));
  }
  const ranked = await rankHistorySources(
    sources, q,
    { mode: mode === 'exact' ? 'exact' : 'best', includeMeetings: true, scope: 'all', limit: 30, recency: true },
    { version: corpusVersion },
  );
  return dedupeBySource(ranked).sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ---- render ----------------------------------------------------------------
function groupRows(results) {
  const groups = new Map();
  for (const r of results) {
    const t = TYPE_META[r.type] ? r.type : 'chat';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(r);
  }
  return [...groups.entries()].sort((a, b) => TYPE_META[a[0]].order - TYPE_META[b[0]].order);
}

function paint(results, terms) {
  const grouped = groupRows(results);
  const frag = document.createDocumentFragment();
  rows = [];
  for (const [type, items] of grouped) {
    const meta = TYPE_META[type];
    const head = document.createElement('div');
    head.className = 'omni-group';
    head.innerHTML = `${icon(meta.icon)} <span>${meta.label}</span> <span class="omni-gcount">${items.length}</span>`;
    frag.appendChild(head);
    for (const r of items) {
      const idx = rows.length;
      rows.push(r);
      const row = document.createElement('div');
      row.className = 'omni-row';
      row.dataset.idx = String(idx);
      row.dataset.sid = r.sourceId;
      const sub = [relTime(r.date)].filter(Boolean).join(' · ');
      const snip = terms.length ? snippet(r.text, terms) : '';
      row.innerHTML =
        `<span class="omni-row-ico">${icon(meta.icon)}</span>` +
        `<span class="omni-row-body">` +
        `<span class="omni-row-title">${highlight(r.title || `Untitled ${type}`, terms)}</span>` +
        (snip ? `<span class="omni-row-snip">${snip}</span>` : '') +
        `</span>` +
        `<span class="omni-row-meta">${esc(sub)}</span>`;
      frag.appendChild(row);
    }
  }
  els.list.replaceChildren(frag);
  els.count.textContent = rows.length ? `${rows.length} result${rows.length === 1 ? '' : 's'}` : '';
  els.empty.classList.toggle('hidden', rows.length > 0);
  sel = rows.length ? 0 : -1;
  reflectSelection();
}

function reflectSelection() {
  const nodes = els.list.querySelectorAll('.omni-row');
  nodes.forEach((n) => n.classList.toggle('sel', Number(n.dataset.idx) === sel));
  const active = els.list.querySelector('.omni-row.sel');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// ---- graph (build once, filter by dimming — no relayout, no flicker) --------
async function buildGraphOnce() {
  if (graphBuilt) return;
  const { drawGraph } = await import('./graph-view.js');
  const sources = await ensureCorpus();
  const picked = sources
    .slice()
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .slice(0, GRAPH_NODE_CAP);
  const model = picked.map((s) => ({
    id: s.id,
    title: s.title || s.id,
    people: [],
    terms: (Array.isArray(s.meta?.terms) && s.meta.terms.length)
      ? s.meta.terms
      : topTerms(`${s.title || ''}\n${String(s.text || '').slice(0, 4000)}`, 10),
  }));
  const g = buildGraph(model);
  const seen = new Set();
  const links = [];
  for (const m of model) {
    for (const rel of g.relatedMeetings(m.id, { limit: 3 })) {
      const key = m.id < rel.id ? `${m.id}|${rel.id}` : `${rel.id}|${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ s: m.id, t: rel.id });
    }
  }
  graphNodes = picked.map((s) => ({ id: s.id, label: s.title || s.id, type: s.type }));
  drawGraph(
    els.graphHost, graphNodes, links,
    (nd) => focusRowFor(nd.id),           // single tap → reveal in list
    (nd) => { const r = rowForSource(nd.id); if (r) close(() => onOpen(r)); }, // double tap → open
  );
  graphBuilt = true;
}

function rowForSource(id) {
  const sources = corpus || [];
  const s = sources.find((x) => x.id === id);
  return s ? { sourceId: s.id, type: s.type, title: s.title, date: s.date, url: s.url } : null;
}
function focusRowFor(id) {
  const node = els.list.querySelector(`.omni-row[data-sid="${CSS.escape(id)}"]`);
  if (node) { sel = Number(node.dataset.idx); reflectSelection(); }
}

// Dim graph nodes/edges that don't match — CSS-only, so it's instant and never
// re-runs the force layout (that would flicker).
function filterGraph(results, hasQuery) {
  if (!graphBuilt || !graphNodes.length) return;
  const svg = els.graphHost.querySelector('svg');
  if (!svg) return;
  svg.classList.toggle('omni-filtering', hasQuery);
  if (!hasQuery) { for (const n of graphNodes) n.el?.classList.remove('faded', 'ghit'); return; }
  const hits = new Set(results.map((r) => r.sourceId));
  for (const n of graphNodes) {
    if (!n.el) continue;
    const on = hits.has(n.id);
    n.el.classList.toggle('faded', !on);
    n.el.classList.toggle('ghit', on);
  }
}

// ---- query pipeline --------------------------------------------------------
function schedule() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(execute, 70);
}
async function execute() {
  const query = els.input.value;
  const my = ++seq;
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  try {
    const results = await runQuery(query);
    if (my !== seq) return; // a newer keystroke already superseded this one
    paint(results, terms);
    if (graphOn) filterGraph(results, !!query.trim());
  } catch {
    if (my !== seq) return;
    els.list.replaceChildren();
    els.count.textContent = '';
    els.empty.classList.remove('hidden');
  }
}

// ---- keyboard --------------------------------------------------------------
function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) { sel = (sel + 1) % rows.length; reflectSelection(); } return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { sel = (sel - 1 + rows.length) % rows.length; reflectSelection(); } return; }
  if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0 && rows[sel]) { const r = rows[sel]; close(() => onOpen(r)); } return; }
}

// ---- open / close ----------------------------------------------------------
async function toggleGraph() {
  graphOn = !graphOn;
  els.graphToggle.classList.toggle('active', graphOn);
  els.graphWrap.classList.toggle('hidden', !graphOn);
  if (graphOn) {
    els.graphHost.innerHTML = '<div class="omni-graph-loading">Mapping connections…</div>';
    try {
      await buildGraphOnce();
      const query = els.input.value;
      filterGraph(await runQuery(query), !!query.trim());
    } catch { els.graphHost.innerHTML = '<div class="omni-graph-loading">Graph unavailable.</div>'; }
  }
}

function close(then) {
  if (!els) return;
  els.overlay.classList.add('hidden');
  document.removeEventListener('keydown', onKey, true);
  if (typeof then === 'function') { try { then(); } catch { /* ok */ } }
}

function build() {
  injectCss();
  const overlay = document.createElement('div');
  overlay.className = 'omni-overlay hidden';
  overlay.innerHTML = `
    <div class="omni-modal" role="dialog" aria-label="Search everything" aria-modal="true">
      <div class="omni-search-row">
        <span class="omni-search-ico">${icon('search')}</span>
        <input class="omni-input" type="text" placeholder="Search notes, chats & meetings…" autocomplete="off" spellcheck="false" aria-label="Search everything" />
        <span class="omni-count"></span>
        <button class="omni-graph-toggle" type="button" title="Toggle connection graph" aria-label="Toggle connection graph">${icon('graph')}</button>
        <kbd class="omni-esc">esc</kbd>
      </div>
      <div class="omni-modes seg" role="tablist">
        <button data-mode="best" class="active" type="button" title="Ranked relevance across all sources">Best match</button>
        <button data-mode="exact" type="button" title="Literal text match">Exact text</button>
      </div>
      <div class="omni-body">
        <div class="omni-list" role="listbox"></div>
        <div class="omni-empty hidden">No matches across notes, chats or meetings.</div>
        <div class="omni-graph-wrap hidden">
          <div class="omni-graph-host graph-host"></div>
          <div class="omni-graph-hint">Bright nodes match your search · tap to reveal · double-tap to open</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  els = {
    overlay,
    input: overlay.querySelector('.omni-input'),
    modes: overlay.querySelector('.omni-modes'),
    list: overlay.querySelector('.omni-list'),
    count: overlay.querySelector('.omni-count'),
    empty: overlay.querySelector('.omni-empty'),
    graphWrap: overlay.querySelector('.omni-graph-wrap'),
    graphHost: overlay.querySelector('.omni-graph-host'),
    graphToggle: overlay.querySelector('.omni-graph-toggle'),
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  els.input.addEventListener('input', schedule);
  els.modes.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    mode = b.dataset.mode === 'exact' ? 'exact' : 'best';
    els.modes.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    execute();
  });
  els.graphToggle.addEventListener('click', toggleGraph);
  els.list.addEventListener('click', (e) => {
    const row = e.target.closest('.omni-row'); if (!row) return;
    const r = rows[Number(row.dataset.idx)]; if (r) close(() => onOpen(r));
  });
}

// Public API — each page calls this on first open (dynamic import keeps it off
// first paint). Repeated calls just re-show the singleton modal.
export async function openOmni(opts = {}) {
  if (typeof opts.onOpen === 'function') onOpen = opts.onOpen;
  if (opts.currentType) currentType = opts.currentType;
  if (!els) build();
  els.overlay.classList.remove('hidden');
  els.input.value = opts.query || '';
  els.input.focus();
  els.input.select();
  document.addEventListener('keydown', onKey, true);
  // Prime the corpus + paint recents immediately; ranking stays instant after.
  els.list.innerHTML = '<div class="omni-loading">Loading your workspace…</div>';
  try { await ensureCorpus(); execute(); }
  catch { els.list.innerHTML = '<div class="omni-loading">Could not load your workspace.</div>'; }
}

// Let a host invalidate the cached corpus after a local edit (optional).
export function refreshOmniCorpus() { corpus = null; corpusVersion = -1; graphBuilt = false; invalidateHistorySourceCache(); }

function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.omni-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(8,10,14,.52); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 9vh 16px 16px; }
.omni-overlay.hidden { display: none; }
.omni-modal { width: min(720px, 96vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--elev, #1b1f26); border: 1px solid var(--border-strong, #353c46); border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,.5); overflow: hidden; }
.omni-search-row { display: flex; align-items: center; gap: 10px; padding: 13px 15px; border-bottom: 1px solid var(--border, #272c34); }
.omni-search-ico { display: inline-flex; color: var(--muted, #9aa1ac); }
.omni-search-ico svg, .omni-graph-toggle svg { width: 18px; height: 18px; }
.omni-input { flex: 1; border: 0; background: none; color: var(--text, #e9ebee); font: inherit; font-size: 16px; outline: none; }
.omni-input::placeholder { color: var(--faint, #6b7280); }
.omni-count { color: var(--faint, #6b7280); font-size: 12px; white-space: nowrap; }
.omni-graph-toggle { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid var(--border, #272c34); background: var(--field, #1f242c); color: var(--muted, #9aa1ac); border-radius: 8px; cursor: pointer; }
.omni-graph-toggle:hover { color: var(--text, #e9ebee); border-color: var(--accent, #818cf8); }
.omni-graph-toggle.active { background: var(--accent, #818cf8); border-color: var(--accent, #818cf8); color: #fff; }
.omni-esc { font-size: 10.5px; color: var(--faint, #6b7280); border: 1px solid var(--border, #272c34); border-radius: 5px; padding: 1px 5px; background: var(--field, #1f242c); }
.omni-modes { margin: 10px 12px 0; }
.omni-body { overflow-y: auto; padding: 8px 8px 12px; }
.omni-group { display: flex; align-items: center; gap: 7px; padding: 12px 10px 5px; color: var(--muted, #9aa1ac); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.omni-group svg { width: 13px; height: 13px; }
.omni-gcount { color: var(--faint, #6b7280); font-weight: 600; }
.omni-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 9px; cursor: pointer; }
.omni-row.sel, .omni-row:hover { background: var(--accent-weak, rgba(129,140,248,.13)); }
.omni-row-ico { display: inline-flex; color: var(--muted, #9aa1ac); margin-top: 1px; }
.omni-row-ico svg { width: 15px; height: 15px; }
.omni-row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.omni-row-title { color: var(--text, #e9ebee); font-size: 13.5px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.omni-row-snip { color: var(--muted, #9aa1ac); font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.omni-row-meta { color: var(--faint, #6b7280); font-size: 11px; white-space: nowrap; margin-top: 1px; }
.omni-row mark, .omni-row-snip mark { background: transparent; color: var(--accent, #818cf8); font-weight: 700; }
.omni-empty, .omni-loading, .omni-graph-loading { color: var(--muted, #9aa1ac); font-size: 13px; padding: 22px 14px; text-align: center; }
.omni-empty.hidden { display: none; }
.omni-graph-wrap.hidden { display: none; }
.omni-graph-wrap { margin: 6px 4px 0; border-top: 1px solid var(--border, #272c34); padding-top: 8px; }
.omni-graph-host { width: 100%; min-height: 300px; }
.omni-graph-hint { color: var(--faint, #6b7280); font-size: 11px; text-align: center; padding: 6px 0 2px; }
/* chat/note node fills (graph-view only styles meeting/topic/person) */
svg .gnode.chat circle { fill: var(--question, #fbbf24); }
svg .gnode.note circle { fill: var(--decision, #34d399); }
svg .gnode.ghit circle { filter: brightness(1.35); }
svg.omni-filtering .gnode.ghit text { opacity: 1; fill: var(--accent, #818cf8); }
svg.omni-filtering .gedge { opacity: .12; }
`;
  document.head.appendChild(style);
}
