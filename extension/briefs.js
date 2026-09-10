// The Briefs dashboard — the derived layer's own surface.
//
// A brief is only ever an aggregate, so unlike Notes/Chats/Meetings there is no useful
// "one brief happened yesterday" list: the DASHBOARD is the default view and a single
// subject is the drill-down. That inverts the other three pages on purpose.
//
// FAST LOAD, the same way the notes list does it: everything on screen before a subject is
// opened comes from the brief INDEX (one decrypt) — name, kind, aliases, counts, terms. A
// brief body, with its claims and citations, is decrypted only when you open it.
//
// Derivation is NOT here. `@chatpanel/events/knowledge.js` owns what a brief is, because a
// mobile client and the gateway have to derive the same briefs from the same records; this
// file loads the corpus, hands it over, and renders the result.

import {
  getBriefIndex, getBrief, getBriefSettings, saveBriefSettings, briefsAreStale,
  getBriefMerges, mergeSubjects, unmergeSubject, getProposals, putProposal, pendingProposals,
} from './js/store-briefs.js';
import { getSettings } from './js/store.js';
// The build pass is where derivation lives. Imported statically HERE — this page is the one
// surface whose whole job is briefs, and a Rebuild button that first fetches 60 KB would be
// the wrong trade — but never from store-briefs.js, which the service worker reaches.
import { rebuildBriefs, briefDrift, suggestBriefMerges, selfNameFrom } from './js/briefs-build.js';
import { openSidePanel } from './js/side-panel.js';
import { hydrate } from './js/icons.js';

const $ = (id) => document.getElementById(id);

let index = [];        // index rows — no bodies
let current = null;    // the open brief, decrypted on demand
let kindFilter = '';
let dashTab = 'stats';
let corpusCache = null; // loaded lazily; a rebuild and the drift check both want it
let _maintSeq = 0;      // a tab switch mid-report must stop the passes, not race them

/**
 * The maintenance report, cached.
 *
 * Every pass reads the whole corpus, so recomputing on each tab switch made the tab feel
 * broken — you left it, came back, and waited again for an answer that had not changed.
 * Keyed by the corpus VERSION so a rebuild or a new record invalidates it honestly, with a
 * TTL as the backstop for anything that changes without bumping that counter. Held in memory
 * only: this is derived from a projection, so it is never worth persisting.
 */
const MAINT_TTL_MS = 5 * 60_000;
let _maintCache = null; // { at, version, sections, suggestions }

// How many merge suggestions to show before "show more". A wall of them is not more useful
// than a handful — each one is a decision, and nobody makes forty in a row.
const MERGE_PAGE = 8;
let _shownMerges = MERGE_PAGE;
let driftCache = null;

const KIND_LABEL = { person: 'person', topic: 'topic', tag: 'tag', title: 'wanted' };

// Why a pair was proposed, in the user's words. A suggestion whose reason is legible is one
// they can answer in a second; an unexplained one gets ignored or, worse, accepted blindly.
const MERGE_WHY = {
  initials: 'same surname, shortened first name',
  containment: 'one name contains the other',
  spelling: 'one character apart — likely a typo',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $('b-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function relDay(ms) {
  if (!ms) return '';
  const d = Math.round((Date.now() - ms) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

// ── the corpus, loaded once per page ─────────────────────────────────────────
// history-rag drags in the whole source layer, so it is dynamic-imported at the call site
// rather than statically: opening this page to READ briefs must not pay for the machinery
// that BUILDS them.
async function loadCorpus() {
  if (corpusCache) return corpusCache;
  const [{ loadHistorySources }, { getMemories }] = await Promise.all([
    import('./js/history-rag.js'),
    import('./js/store-memory.js'),
  ]);
  const records = await loadHistorySources({
    includeChats: true, includeMeetings: true, includeNotes: true,
    // Briefs are derived FROM records, so deriving them from briefs would be a feedback
    // loop: last run's synthesis would become this run's evidence and the citations would
    // stop leading anywhere real.
    includeBriefs: false,
  });
  corpusCache = { records, memories: await getMemories().catch(() => []) };
  return corpusCache;
}

// ── the subject list ─────────────────────────────────────────────────────────
function filtered() {
  const q = ($('b-search').value || '').trim().toLowerCase();
  let rows = index;
  if (kindFilter) rows = rows.filter((e) => e.kind === kindFilter);
  if (!q) return rows;
  // `person:alex` narrows by kind and text in one token, matching how tag: works elsewhere.
  const scoped = /^(person|topic|tag|title|wanted)\s*:\s*(.*)$/.exec(q);
  const kind = scoped ? (scoped[1] === 'wanted' ? 'title' : scoped[1]) : '';
  const text = scoped ? scoped[2].trim() : q;
  return rows.filter((e) => (!kind || e.kind === kind)
    && (!text || [e.name, ...(e.aliases || []), ...(e.terms || [])].some((t) => String(t).toLowerCase().includes(text))));
}

function renderList() {
  const host = $('b-items');
  const rows = filtered();
  $('b-count').textContent = index.length ? `(${index.length})` : '';
  if (!rows.length) {
    host.innerHTML = `<div class="dash-empty">${index.length ? 'No subject matches that.' : 'No briefs yet.'}</div>`;
    return;
  }
  // Evidence is scaled against the best-evidenced subject, so the bar reads as "how much
  // is behind this compared with what I actually have" rather than against an absolute
  // nobody can calibrate.
  const top = Math.max(...rows.map((e) => e.stats?.records || 0), 1);
  host.innerHTML = '';
  for (const e of rows) {
    const el = document.createElement('div');
    el.className = `brow${current?.id === e.id ? ' on' : ''}`;
    el.innerHTML =
      `<div class="brow-head">`
      + `<span class="brow-name">${escapeHtml(e.name)}</span>`
      + `<span class="bkind ${e.kind}">${KIND_LABEL[e.kind] || e.kind}</span>`
      + (e.aliases?.length ? `<span class="baka">aka ${escapeHtml(e.aliases.join(', '))}</span>` : '')
      + `</div>`
      + `<div class="bbar"><i style="width:${Math.max(6, Math.round(((e.stats?.records || 0) / top) * 100))}%"></i></div>`
      + `<div class="brow-meta">${e.stats?.records || 0} record${e.stats?.records === 1 ? '' : 's'} · ${e.claims} claim${e.claims === 1 ? '' : 's'}${e.stats?.last ? ` · ${relDay(e.stats.last)}` : ''}</div>`;
    el.onclick = () => openBrief(e.id);
    host.appendChild(el);
  }
}

// ── one brief ────────────────────────────────────────────────────────────────
function citeChip(ref, drifted) {
  const isMem = ref.kind === 'memory';
  const cls = `cite${isMem ? ' mem' : ''}${drifted.has(`${ref.kind}:${ref.id}`) ? ' drift' : ''}`;
  const label = isMem ? 'you said' : `${ref.kind}:${String(ref.id).slice(0, 10)}`;
  return `<button class="${cls}" type="button" data-kind="${escapeHtml(ref.kind)}" data-id="${escapeHtml(ref.id)}">${escapeHtml(label)}</button>`;
}

async function openBrief(id) {
  const brief = await getBrief(id);
  if (!brief) { toast('That brief is gone — rebuild to re-derive it.'); return; }
  current = brief;
  location.hash = encodeURIComponent(id);
  $('b-dash').classList.add('hidden');
  $('b-blank').classList.add('hidden');
  const view = $('b-view');
  view.classList.remove('hidden');

  // Drift is looked up from the cached report rather than recomputed: it is a whole-corpus
  // question and answering it per click would decrypt everything on every open.
  const drifted = new Set(
    (driftCache?.find((d) => d.id === id)?.drifted || []).map((d) => `${d.ref.kind}:${d.ref.id}`),
  );

  const s = brief.stats || {};
  view.innerHTML =
    `<div class="bhead">`
    + `<h2>${escapeHtml(brief.subject.name)}</h2>`
    + `<span class="bkind ${brief.kind}">${KIND_LABEL[brief.kind] || brief.kind}</span>`
    + (brief.subject.aliases?.length ? `<span class="baka">aka ${escapeHtml(brief.subject.aliases.join(', '))}</span>` : '')
    + `<span class="bhead-meta">${s.records || 0} records · ${s.mentions || 0} mentions · built ${relDay(brief.updatedAt)}</span>`
    + `</div>`
    + `<p class="muted" style="margin:0 0 6px;font-size:12.5px">`
    + `Derived from your own records — every claim links to the one it came from. `
    + `<button id="b-ask" class="cite" type="button">Ask ChatPanel about this</button> `
    + `<button id="b-sameas" class="cite" type="button" title="Fold this subject into another one">Same as…</button> `
    + `<button id="b-synth" class="cite b-synth" type="button" title="Ask your model what these records establish — lands in Proposed, never directly in the brief">✦ Synthesise</button>`
    + `<span id="b-sameas-box" class="sameas hidden"></span></p>`
    + (brief.summary ? `<div class="bsummary">${escapeHtml(brief.summary)}</div>` : '')
    + `<div class="bsec-head">What the records say</div>`
    + brief.claims.map((c) =>
      `<div class="claim claim-${c.kind}">`
      + `<div><div class="claim-kind">${c.kind === 'stated' ? 'You told ChatPanel' : c.cls === 'C' ? 'Synthesised · you accepted' : escapeHtml(c.kind)}</div>`
      + `<div class="claim-txt">${escapeHtml(c.text)}</div></div>`
      + `<div class="cites">${c.refs.map((r) => citeChip(r, drifted)).join('')}</div>`
      + `</div>`).join('')
    + (brief.records.length
      ? `<div class="bsec-head">Records behind it (${brief.records.length})</div>`
        + [...brief.records].reverse().slice(0, 40).map((r) =>
          `<div class="related-card" data-open="${escapeHtml(r.id)}">`
          + `<div class="related-card-title">${escapeHtml(r.title || 'Untitled')}</div>`
          + `<div class="related-card-meta">${escapeHtml(r.type)}${r.date ? ` · ${new Date(r.date).toLocaleDateString()}` : ''}</div>`
          + `</div>`).join('')
      : '');

  for (const el of view.querySelectorAll('.cite[data-id]')) {
    el.onclick = () => openRecord(`${el.dataset.kind}:${el.dataset.id}`);
  }
  for (const el of view.querySelectorAll('[data-open]')) el.onclick = () => openRecord(el.dataset.open);
  const ask = $('b-ask');
  if (ask) ask.onclick = () => askPanel(brief);
  const same = $('b-sameas');
  if (same) same.onclick = () => openSameAs(brief);
  const synth = $('b-synth');
  if (synth) synth.onclick = () => synthesise(brief, synth);
  hydrate(view);
  renderList();
}

/**
 * "Same as…" — the merge control ON the brief, where the duplicate is in front of you.
 *
 * The Maintenance tab proposes merges it can justify; this is for the ones it cannot see
 * (a nickname, a different transliteration) and for the moment you are already looking at
 * the wrong page. Same rule as every other merge: stored as an INPUT to derivation, so a
 * rebuild re-applies it, and the better-evidenced side is offered first because it is the
 * name the user thinks in. Only subjects of the same kind are offered — a person is never
 * "the same as" a topic.
 */
function openSameAs(brief) {
  const box = $('b-sameas-box');
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const candidates = index
    .filter((e) => e.kind === brief.kind && e.id !== brief.id)
    .sort((a, b) => (b.stats?.records || 0) - (a.stats?.records || 0));
  box.innerHTML = '<input class="prefinput sameas-input" type="text" placeholder="Type the name this really is…" list="b-sameas-list" />'
    + `<datalist id="b-sameas-list">${candidates.slice(0, 200).map((e) => `<option value="${escapeHtml(e.name)}"></option>`).join('')}</datalist>`
    + '<button class="btn" id="b-sameas-go" type="button">Merge</button>';
  box.classList.remove('hidden');
  const input = box.querySelector('input');
  input.focus();
  const go = async () => {
    const into = input.value.trim();
    if (!into || into.toLowerCase() === brief.subject.name.toLowerCase()) return;
    await mergeSubjects(brief.subject.name, into);
    _maintCache = null; // the report's "possibly the same" list just changed
    toast(`“${brief.subject.name}” is “${into}”. Rebuilding…`);
    box.classList.add('hidden');
    await rebuild($('b-rebuild'));
    // Land on the survivor — the page you were on no longer exists.
    const target = (await getBriefIndex()).find((e) => e.name.toLowerCase() === into.toLowerCase());
    if (target) openBrief(target.id);
  };
  $('b-sameas-go').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { box.classList.add('hidden'); } };
}

/** A citation is only useful if it opens the thing it cites. */
function openRecord(id) {
  const [kind, ...rest] = String(id).split(':');
  const rec = rest.join(':');
  if (kind === 'memory') { toast('That came from something you told ChatPanel — see Settings → Memory.'); return; }
  const page = kind === 'meeting' ? 'meetings.html' : kind === 'note' ? 'notes.html' : 'history.html';
  location.assign(chrome.runtime.getURL(`${page}#${encodeURIComponent(rec)}`));
}

/**
 * The brief is a starting point, not an endpoint. Opening the panel with the subject
 * pre-filled is the shortest path from "what do I know" to "and now do something with it",
 * and it goes through the normal retrieval path — the brief competes for rank like any
 * other source rather than being force-fed into the prompt (decision K2).
 */
async function askPanel(brief) {
  const prompt = `What do we know about ${brief.subject.name}?`;
  // Open WITHIN the click gesture, before any await — Firefox's sidebarAction.open()
  // rejects after one, which is why side-panel.js is statically imported here.
  const opening = openSidePanel().catch(() => { /* may already be open */ });
  try {
    // Fresh-open path: the panel's init() reads this once and clears it.
    await chrome.storage.local.set({ 'chatpanel:composerSeed': prompt });
    await opening;
    // Already-open path: nudge the live panel, the same pair history.js uses.
    chrome.runtime.sendMessage({ type: 'context-seed', prompt }).catch(() => {});
    toast('Asking in the side panel…');
  } catch { toast('Could not open the side panel.'); }
}

// ── the dashboard ────────────────────────────────────────────────────────────
function showDash() {
  current = null;
  if (location.hash) history.replaceState(null, '', location.pathname);
  $('b-view').classList.add('hidden');
  $('b-blank').classList.toggle('hidden', index.length > 0);
  $('b-dash').classList.toggle('hidden', index.length === 0);
  renderList();
  if (index.length) renderDash();
}

function renderStats() {
  const host = $('b-dash-stats');
  const byKind = {};
  let claims = 0; let records = 0; let stated = 0;
  for (const e of index) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    claims += e.claims || 0;
    records += e.stats?.records || 0;
    if (e.stats?.wanted) stated += 1;
  }
  const card = (n, l) => `<div class="metric"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  host.innerHTML =
    `<div class="metrics">`
    + card(index.length, 'Briefs')
    + card(claims, 'Claims')
    + card(byKind.person || 0, 'People')
    + card(byKind.topic || 0, 'Topics')
    + card(byKind.title || 0, 'Wanted pages')
    + card(driftCache ? driftCache.length : '—', 'Drifted')
    + `</div>`
    + `<div class="bsec-head">Best evidenced</div><div id="b-top"></div>`
    + `<div class="bsec-head">How these are built</div><div id="b-prefs"></div>`;

  const top = $('b-top');
  for (const e of [...index].sort((a, b) => (b.stats?.records || 0) - (a.stats?.records || 0)).slice(0, 12)) {
    const el = document.createElement('div');
    el.className = 'related-card';
    el.innerHTML =
      `<div class="related-card-title">${escapeHtml(e.name)} <span class="bkind ${e.kind}">${KIND_LABEL[e.kind] || e.kind}</span></div>`
      + `<div class="related-card-meta">${e.stats?.records || 0} records · ${e.claims} claims</div>`;
    el.onclick = () => openBrief(e.id);
    top.appendChild(el);
  }
  renderPrefs();
  hydrate(host);
}

/**
 * The controls live HERE rather than in Settings.
 *
 * Not to avoid a settings tab: a threshold is only meaningful next to the list it produced.
 * "3 records and 5 mentions" means nothing on a settings page and means something obvious
 * two inches under "34 briefs, and these are the best evidenced". Raising it and watching
 * the list shrink is the calibration, and it cannot happen on another screen.
 */
async function renderPrefs() {
  const host = $('b-prefs');
  if (!host) return;
  const s = await getBriefSettings();
  const { memories } = corpusCache || { memories: [] };
  const knownSelf = s.selfName || selfNameFrom(memories);
  const row = (title, why, control) =>
    `<div class="prefrow"><div><div class="prefrow-t">${title}</div><div class="prefrow-w">${why}</div></div>${control}</div>`;
  host.innerHTML =
    `<div class="maint-group">`
    + row('Build briefs from my records',
      'Runs entirely on your device. No model, no network — every claim is a restatement of something a record already says.',
      `<button id="b-pref-on" class="btn${s.enabled ? ' active' : ''}" type="button">${s.enabled ? 'On' : 'Off'}</button>`)
    + row('A subject earns a page at',
      `${index.length} of your subjects clear this today. Raise it if the list is noisy; lower it if a subject you think about is missing.`,
      `<span class="prefnum"><button class="btn ghost" data-th="-" type="button">−</button>`
      + `<b>${s.minRecords} records · ${s.minMentions} mentions</b>`
      + `<button class="btn ghost" data-th="+" type="button">+</button></span>`)
    + row('Who is “You”',
      knownSelf
        ? `Meeting platforms label you “You”, so your own records would file you as a stranger. Using <b>${escapeHtml(knownSelf)}</b>${s.selfName ? '' : ' — from what you told ChatPanel to remember'}.`
        : 'Zoom, Meet and Teams all label the local participant “You”, so you appear in your own corpus under a name that is not a name. Tell ChatPanel who that is and every “You” folds into your subject. Never guessed — an unnamed “You” is left out entirely.',
      `<input id="b-pref-self" class="prefinput" type="text" placeholder="Your name" value="${escapeHtml(s.selfName)}" />`)
    + row('Share briefs with local agents',
      'Codex, Claude Code and OpenCode read them through the gateway on this machine. Records already sync; this is about your synthesised conclusions.',
      `<button id="b-pref-share" class="btn${s.shareWithAgents ? ' active' : ''}" type="button">${s.shareWithAgents ? 'Shared' : 'Private'}</button>`)
    + `</div>`;

  $('b-pref-on').onclick = async () => {
    const next = await saveBriefSettings({ enabled: !s.enabled });
    toast(next.enabled ? 'Briefs are on — rebuild to derive them.' : 'Briefs are off. Existing ones stay until you rebuild.');
    renderPrefs();
  };
  const selfInput = $('b-pref-self');
  if (selfInput) {
    const commit = async () => {
      const next = selfInput.value.trim();
      if (next === s.selfName) return;
      await saveBriefSettings({ selfName: next });
      toast(next ? 'Rebuild to fold “You” into your subject.' : 'Rebuild to stop folding “You”.');
      renderPrefs();
    };
    selfInput.onblur = commit;
    selfInput.onkeydown = (e) => { if (e.key === 'Enter') selfInput.blur(); };
  }
  $('b-pref-share').onclick = async () => {
    const next = await saveBriefSettings({ shareWithAgents: !s.shareWithAgents });
    toast(next.shareWithAgents
      ? 'Local agents can read your briefs.'
      : 'Local agents will stop seeing briefs after the next sync.');
    renderPrefs();
  };
  for (const b of host.querySelectorAll('[data-th]')) {
    b.onclick = async () => {
      // Records and mentions move together: a threshold where they diverge invites the
      // combination nobody meant (1 record, 40 mentions is one chatty document, not a
      // subject), and the sweep in tools/knowledge-survey.mjs moves them in step too.
      const step = b.dataset.th === '+' ? 1 : -1;
      await saveBriefSettings({
        minRecords: Math.max(2, Math.min(12, s.minRecords + step)),
        minMentions: Math.max(2, Math.min(30, s.minMentions + step * 2)),
      });
      renderPrefs();
      toast('Rebuild to apply the new threshold.');
    };
  }
  hydrate(host);
}

/**
 * The subject graph. A brief is a HUB by construction — it sits on every record that
 * mentions its subject — so this is the one graph in the product where the nodes are the
 * things you think in rather than the documents you happened to produce.
 */
/**
 * The subject graph — the one view where the nodes are the things you think in rather than
 * the documents you happened to produce.
 *
 * IT IS CAPPED, and the cap is not cosmetic. A force simulation pushes every node away from
 * its neighbours each frame; `graph-view.js` uses a spatial grid so that is not naively
 * quadratic, but the grid only helps when nodes are SPREAD, and a few hundred densely
 * connected subjects all start in one clump — so every node is "nearby" every other and the
 * grid degenerates to N² per frame, at 60 frames a second. With a full corpus that is not a
 * slow graph, it is an unresponsive page.
 *
 * So the same rule omni-search.js already applies: the graph shows the best-evidenced
 * subjects and the LIST carries the long tail. A graph of three hundred nodes was not
 * readable anyway — the screenshot that prompted this was a hairball with every label
 * overlapping.
 */
const GRAPH_NODE_CAP = 80;   // matches omni-search.js — readable, and comfortably fast
const GRAPH_LINKS_PER_NODE = 4; // the strongest neighbours; a dense mesh reads as noise

async function renderGraph() {
  const host = $('b-dash-graph');
  if (!index.length) { host.innerHTML = '<div class="dash-empty">No briefs yet.</div>'; return; }
  host.innerHTML = '<div class="dash-empty">Laying out the graph…</div>';
  try {
    const { drawGraph } = await import('./js/graph-view.js');

    // Best-evidenced first: if the graph can only show some subjects, they should be the
    // ones with the most behind them.
    const shown = [...index]
      .sort((a, b) => (b.stats?.records || 0) - (a.stats?.records || 0) || a.name.localeCompare(b.name))
      .slice(0, GRAPH_NODE_CAP);
    const byName = new Map(shown.map((e) => [e.name.toLowerCase(), e]));
    const nodes = shown.map((e) => ({ id: e.id, label: e.name, type: e.kind === 'person' ? 'person' : 'topic' }));

    const links = [];
    const seen = new Set();
    for (const e of shown) {
      let added = 0;
      for (const term of e.terms || []) {
        if (added >= GRAPH_LINKS_PER_NODE) break;
        const other = byName.get(String(term).toLowerCase());
        if (!other || other.id === e.id) continue;
        const key = [e.id, other.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ s: e.id, t: other.id });
        added += 1;
      }
    }

    host.innerHTML = '';
    drawGraph(host, nodes, links, (n) => openBrief(n.id), (n) => openBrief(n.id));

    const hidden = index.length - shown.length;
    if (hidden > 0) {
      const note = document.createElement('div');
      note.className = 'dash-empty';
      note.style.paddingTop = '10px';
      note.textContent = `Showing the ${shown.length} best-evidenced subjects. ${hidden} more are in the list on the left.`;
      host.appendChild(note);
    }
  } catch (e) {
    host.innerHTML = `<div class="dash-empty">Graph unavailable: ${escapeHtml(e?.message || e)}</div>`;
  }
}

/**
 * Synthesise: one model call, on the user's click, landing in the Proposed queue.
 *
 * Streams the claims as they arrive so the user watches the synthesis form. Never writes to
 * the brief — accept() is the only path (I-K3), and it is a button on the Proposed tab.
 */
async function synthesise(brief, btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Thinking…';
  const live = document.createElement('div');
  live.className = 'synth-live';
  btn.parentElement.after(live);
  try {
    const [{ synthesiseBrief }, settings, { records }] = await Promise.all([
      import('./js/brief-synthesis.js'), getSettings(), loadCorpus(),
    ]);
    const out = await synthesiseBrief(brief.id, {
      settings, records,
      onPartial: (v) => {
        const claims = v?.claims || [];
        live.innerHTML = claims.length
          ? `<div class="claim-kind">Forming…</div>${claims.map((c) => `<div class="synth-line">• ${escapeHtml(c.text || '')}</div>`).join('')}`
          : '<div class="claim-kind">Reading the records…</div>';
      },
    });
    live.remove();
    if (!out || !out.proposal) {
      const refused = out?.refused?.length || 0;
      toast(refused
        ? `The model proposed ${refused} claim${refused === 1 ? '' : 's'} it could not cite — refused. Nothing added.`
        : 'The records establish nothing beyond what is already listed.');
      return;
    }
    await updateProposedCount();
    toast(`${out.proposal.claims.length} claim${out.proposal.claims.length === 1 ? '' : 's'} proposed${out.refused.length ? ` (${out.refused.length} refused for missing citations)` : ''} — review them under Proposed.`);
  } catch (e) {
    live.remove();
    toast(`Could not synthesise: ${e?.message || e}`);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function updateProposedCount() {
  const n = (await pendingProposals()).length;
  $('b-proposed-count').textContent = n ? `(${n})` : '';
}

/**
 * The Proposed queue — the piece that makes the layer defensible rather than a liability.
 * Each proposal shows a diff against what the brief says now, and accept/reject is one
 * click, because a gate people avoid is a gate that gets switched off.
 */
async function renderProposed() {
  const host = $('b-dash-proposed');
  const pending = await pendingProposals();
  await updateProposedCount();
  if (!pending.length) {
    host.innerHTML = '<div class="dash-empty">Nothing waiting. Open a brief and press <b>✦ Synthesise</b> to ask your model what its records establish — the answer lands here for you to accept or reject, never directly in the brief.</div>';
    return;
  }
  const { diffProposal } = await import('./js/events/promotion.js');
  host.innerHTML = '';
  for (const p of pending) {
    const brief = await getBrief(p.briefId);
    const entry = index.find((e) => e.id === p.briefId);
    const diff = brief ? diffProposal(brief, p) : p.claims.map((c) => ({ claim: c, replaces: null }));
    const card = document.createElement('div');
    card.className = 'proposal';
    card.innerHTML =
      `<div class="brief-head brow-head"><span class="brow-name">${escapeHtml(entry?.name || brief?.subject?.name || p.briefId)}</span>`
      + `<span class="bkind ${entry?.kind || 'topic'}">${KIND_LABEL[entry?.kind] || ''}</span>`
      + `<span class="brief-meta baka">proposed by ${escapeHtml(p.by)} · ${relDay(p.at)}${brief ? '' : ' · brief no longer exists'}</span></div>`
      + (p.summary ? `<div class="bsummary">${escapeHtml(p.summary)}</div>` : '')
      + diff.map((d) =>
        `<div class="claim claim-synthesis">`
        + `<div>${d.replaces ? `<div class="diff-del">− ${escapeHtml(d.replaces)}</div>` : ''}`
        + `<div class="diff-add">+ ${escapeHtml(d.claim.text)}</div></div>`
        + `<div class="cites">${(d.claim.refs || []).map((r) => `<button class="cite" type="button" data-kind="${escapeHtml(r.kind)}" data-id="${escapeHtml(r.id)}">${escapeHtml(r.kind)}:${escapeHtml(String(r.id).slice(0, 10))}</button>`).join('')}</div>`
        + `</div>`).join('')
      + `<div class="btns"><button class="btn primary" data-accept type="button">Accept</button>`
      + `<button class="btn" data-reject type="button">Reject</button>`
      + (brief ? `<button class="btn ghost" data-open type="button">Open brief</button>` : '') + `</div>`;
    card.querySelector('[data-accept]').onclick = async () => {
      if (!brief) { toast('That brief no longer exists — rebuild, then synthesise again.'); return; }
      const { accept } = await import('./js/events/promotion.js');
      const { brief: next, proposal } = accept(brief, p, { now: Date.now() });
      await putProposal(proposal);
      // The projection is rewritten with the promoted claims NOW, and writeBriefs re-applies
      // the accepted proposal on every later rebuild, so this survives I-K2.
      const { writeBriefs } = await import('./js/store-briefs.js');
      const others = [];
      for (const e of index) if (e.id !== next.id) { const b = await getBrief(e.id); if (b) others.push(b); }
      await writeBriefs([...others, next]);
      index = await getBriefIndex();
      _maintCache = null;
      toast(`Accepted — ${proposal.claims.length} claim${proposal.claims.length === 1 ? '' : 's'} now in the brief.`);
      renderProposed();
    };
    card.querySelector('[data-reject]').onclick = async () => {
      const { reject } = await import('./js/events/promotion.js');
      await putProposal(reject(p, { now: Date.now() }));
      toast('Rejected.');
      renderProposed();
    };
    const open = card.querySelector('[data-open]');
    if (open) open.onclick = () => openBrief(p.briefId);
    for (const el of card.querySelectorAll('.cite[data-id]')) el.onclick = () => openRecord(`${el.dataset.kind}:${el.dataset.id}`);
    host.appendChild(card);
  }
  hydrate(host);
}

/**
 * Maintenance — the W0 survey, made continuous.
 *
 * Every pass here is deterministic and free, which is the point: a model would "notice"
 * mostly the same things at a cost, and the model half of the curator (W3/W4) only ever
 * looks at what this flagged.
 */
/**
 * Maintenance — the W0 survey, made continuous.
 *
 * Every pass is deterministic and free, which is the point: a model would "notice" mostly
 * the same things at a cost, and the model half of the curator (W3/W4) only ever looks at
 * what this flagged.
 *
 * IT RENDERS PROGRESSIVELY, one group at a time, yielding to the event loop between them.
 * Loading the corpus decrypts every record and the passes then walk it several times; doing
 * all of that in one synchronous stretch is how this tab froze the page. Yielding does not
 * make it faster — it keeps the page alive and shows each answer as it is found.
 */
const YIELD = () => new Promise((r) => setTimeout(r, 0));

const maintGroup = (title, why, body) =>
  `<div class="maint-group"><h3>${title}</h3><p>${why}</p>${body}</div>`;

/**
 * The merge-suggestion section, as a function of its data — so paging can redraw it from
 * the cache instead of re-reading the corpus, and so the counter is a real count.
 */
function mergeSectionHtml(suggestions) {
  const shown = suggestions.slice(0, _shownMerges);
  const remaining = suggestions.length - shown.length;
  const body = suggestions.length
    ? `<div class="mergelist">${shown.map((m, i) =>
      `<div class="mergerow" data-merge="${i}">`
      + `<span class="bkind ${m.kind}">${KIND_LABEL[m.kind] || m.kind}</span>`
      + `<span class="mergenames"><b>${escapeHtml(m.dropName)}</b> is <b>${escapeHtml(m.keepName)}</b></span>`
      + `<span class="mergewhy">${MERGE_WHY[m.reason] || m.reason}</span>`
      + `<button class="btn" data-yes="${i}" type="button">Same</button>`
      + `<button class="btn ghost" data-no="${i}" type="button">Different</button>`
      + `</div>`).join('')}</div>`
      + (remaining > 0
        // The label carries the progress, not just the page size: "Show 8 more of 40"
        // read the same on every click, and nobody could tell it was working.
        ? `<div class="mergepager">Showing ${shown.length} of ${suggestions.length}`
          + ` · <button class="btn ghost" id="b-more-merges" type="button">Show ${Math.min(MERGE_PAGE, remaining)} more</button></div>`
        : (suggestions.length > MERGE_PAGE ? `<div class="mergepager">All ${suggestions.length} shown</div>` : ''))
    : '<div class="maint-ok">Nothing looks like a duplicate identity.</div>';
  return maintGroup('Possibly the same subject',
    'The alias rule folds what it can prove. These are the pairs it refuses to decide alone, because deciding wrongly merges two people permanently. Your answer is stored and re-applied on every rebuild.',
    body);
}

function mergedNamesHtml(merges) {
  return maintGroup('Names you have merged',
    'Corrections you made. They are an input to every rebuild, never an edit to one — which is why they survive.',
    Object.keys(merges).length
      ? `<div class="maint-list">${Object.entries(merges).map(([from, into]) =>
        `<button class="topic-chip" data-unmerge="${escapeHtml(from)}" title="Undo this merge">${escapeHtml(from)} → ${escapeHtml(into)} \u2715</button>`).join('')}</div>`
      : '<div class="maint-ok">None yet.</div>');
}

async function renderMaint({ force = false } = {}) {
  const host = $('b-dash-maint');
  const token = ++_maintSeq;

  // Serve the cache first. Coming back to a tab should be instant; the report is a snapshot
  // of a corpus that has not moved.
  const version = await corpusVersion();
  if (!force && _maintCache && _maintCache.version === version && Date.now() - _maintCache.at < MAINT_TTL_MS) {
    host.innerHTML = _maintCache.sections.join('');
    wireMaintActions(host, _maintCache.suggestions);
    hydrate(host);
    return;
  }

  host.innerHTML = '<div class="dash-empty">Reading your records…</div>';

  const group = maintGroup;
  const chips = (items) => (items.length
    ? `<div class="maint-list">${items.map((t) => `<span class="topic-chip">${escapeHtml(t)}</span>`).join('')}</div>`
    : '<div class="maint-ok">Nothing to do here.</div>');

  // Each pass appends its own section, so the first answer is on screen long before the last
  // is computed — and a slow pass never hides the ones that already finished.
  const sections = [];
  const add = async (html) => {
    if (token !== _maintSeq) return false; // the user switched tabs; stop working
    sections.push(html);
    host.innerHTML = sections.join('');
    await YIELD();
    return token === _maintSeq;
  };

  try {
    const { records, memories } = await loadCorpus();
    if (token !== _maintSeq) return;
    await YIELD();

    const curate = await import('./js/events/curate.js');

    const suggestions = await suggestBriefMerges(records, { memories });
    const merges = await getBriefMerges();
    if (!await add(mergeSectionHtml(suggestions))) return;
    if (!await add(mergedNamesHtml(merges))) return;

    const redaction = curate.redactionCost(records);
    if (!await add(group('Redacted mentions',
      'Placeholders like <code>PERSON_1</code> that privacy redaction left in your records. They cannot become subjects: the vault is per-conversation and is not kept, so one conversation\'s PERSON_1 is not another\'s. This is what redaction costs your graph.',
      redaction.total
        ? `<div class="maint-list">${Object.entries(redaction.byType).map(([t, n]) =>
          `<span class="topic-chip">${escapeHtml(t)} <span class="chip-count">${n}</span></span>`).join('')}`
          + `<span class="topic-chip">${redaction.records} records affected</span></div>`
        : '<div class="maint-ok">None — nothing was redacted out of your own records.</div>'))) return;

    const wanted = curate.wantedPages(records).slice(0, 20);
    if (!await add(group('Wanted pages',
      'A <code>[[link]]</code> pointing at nothing. Somebody already decided the subject was worth naming — this is the corpus asking for a page.',
      chips(wanted.map((w) => `${w.target} \u00b7 ${w.recordCount}`))))) return;

    const orphans = curate.orphanRecords(records);
    if (!await add(group('Records connected to nothing',
      'No link, no shared tag, no shared topic. Only full-text search can reach these.',
      `<div class="maint-list">${orphans.length
        ? `<span class="topic-chip">${orphans.length} of ${records.length} records</span>`
        : '<span class="maint-ok">Everything is connected.</span>'}</div>`))) return;

    driftCache = await briefDrift(records);
    $('b-maint-count').textContent = driftCache.length ? `(${driftCache.length})` : '';
    if (!await add(group('Claims citing a record that changed',
      'The record a claim points at has been edited or deleted since the claim was derived. Rebuilding re-derives against what is there now.',
      driftCache.length
        ? `<div class="maint-list">${driftCache.slice(0, 20).map((d) => `<span class="topic-chip">${escapeHtml(d.name)} \u00b7 ${d.drifted.length}</span>`).join('')}</div>`
        : '<div class="maint-ok">Every citation still resolves.</div>'))) return;

    const dupes = curate.duplicateTitles(records).slice(0, 12);
    if (!await add(group('The same thing, titled twice',
      'Exact and near-duplicate titles. Reported, never merged \u2014 \u201cQ3 Planning\u201d and \u201cQ4 Planning\u201d are one character apart and are not the same meeting.',
      chips(dupes.map((g) => g.titles.join('  |  ')))))) return;

    const drift = curate.vocabularyDrift(records).slice(0, 12);
    if (!await add(group('One term, filed several ways',
      'Tags and topics that normalize close but were typed differently, so they file apart.',
      chips(drift.map((g) => g.terms.map((t) => `${t.term}(${t.count})`).join(' | ')))))) return;

    _maintCache = { at: Date.now(), version, sections: [...sections], suggestions, merges };
    wireMaintActions(host, suggestions);
    hydrate(host);
  } catch (e) {
    if (token !== _maintSeq) return;
    host.innerHTML = `<div class="dash-empty">Could not check the corpus: ${escapeHtml(e?.message || e)}</div>`;
  }
}

/**
 * A cheap fingerprint of "has anything changed" — the stale flag plus the brief index's
 * newest write. Cheap on purpose: answering it must not cost the decrypt the cache exists
 * to avoid.
 */
async function corpusVersion() {
  try {
    const stale = await briefsAreStale();
    const newest = index.reduce((m, e) => Math.max(m, e.updatedAt || 0), 0);
    return `${index.length}:${newest}:${stale ? 1 : 0}`;
  } catch { return String(index.length); }
}

function wireMaintActions(host, suggestions) {
  const more = host.querySelector('#b-more-merges');
  if (more) {
    more.onclick = () => {
      _shownMerges += MERGE_PAGE;
      // Paging is a view change, not a reason to read the corpus again. The first version
      // said exactly that in a comment and then nulled the cache and forced a recompute on
      // the next line — every "show more" re-decrypted the corpus, and because the ranker
      // returned the same capped list, the label never moved either.
      if (_maintCache) {
        _maintCache.sections[0] = mergeSectionHtml(_maintCache.suggestions);
        host.innerHTML = _maintCache.sections.join('');
        wireMaintActions(host, _maintCache.suggestions);
        hydrate(host);
      } else {
        renderMaint({ force: true });
      }
    };
  }
  for (const b of host.querySelectorAll('[data-yes]')) {
    b.onclick = async () => {
      const m = suggestions[Number(b.dataset.yes)];
      await mergeSubjects(m.dropName, m.keepName);
      toast(`\u201c${m.dropName}\u201d is \u201c${m.keepName}\u201d. Rebuild to apply it.`);
      renderMaint({ force: true }); // the answer changed the input; recompute honestly
    };
  }
  for (const b of host.querySelectorAll('[data-no]')) {
    // "Different" dismisses for this session only. A permanent no would need its own store,
    // and a wrong permanent no is invisible forever — worse than being asked twice.
    b.onclick = () => { b.closest('.mergerow').remove(); };
  }
  for (const b of host.querySelectorAll('[data-unmerge]')) {
    b.onclick = async () => {
      await unmergeSubject(b.dataset.unmerge);
      toast('Merge undone. Rebuild to apply it.');
      renderMaint({ force: true });
    };
  }
}

function renderDash() {
  $('b-dash-stats').classList.toggle('hidden', dashTab !== 'stats');
  $('b-dash-graph').classList.toggle('hidden', dashTab !== 'graph');
  $('b-dash-proposed').classList.toggle('hidden', dashTab !== 'proposed');
  $('b-dash-maint').classList.toggle('hidden', dashTab !== 'maint');
  if (dashTab === 'stats') renderStats();
  else if (dashTab === 'graph') renderGraph();
  else if (dashTab === 'proposed') renderProposed();
  else renderMaint();
}

// ── rebuild ──────────────────────────────────────────────────────────────────
/**
 * I-K2 made a button: throw every brief away and re-derive from the records.
 *
 * Safe by construction — a brief is a projection, so this is a cache clear rather than
 * data loss, and that is exactly why the derived layer is allowed to be wrong. Nothing
 * else in ChatPanel gets a button like this.
 */
async function rebuild(btn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
  try {
    const { records, memories } = await loadCorpus();
    const report = await rebuildBriefs(records, { memories });
    if (!report.ok) { toast(report.reason === 'disabled' ? 'Briefs are switched off in settings.' : 'Nothing to build.'); return; }
    index = await getBriefIndex();
    driftCache = null;
    _maintCache = null; // the corpus moved; the report is no longer a description of it
    toast(index.length
      ? `${index.length} brief${index.length === 1 ? '' : 's'} from ${records.length} records.`
      : 'No subject has enough evidence for a page yet — keep chatting and meeting.');
    $('b-rebuild').classList.remove('active');
    await explainEmpty();
    showDash();
  } catch (e) {
    toast(`Could not build: ${e?.message || e}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; hydrate(btn.parentElement); }
  }
}

/** The empty state should say WHY it is empty, which is a different sentence each time. */
async function explainEmpty() {
  const settings = await getBriefSettings();
  const el = $('b-blank-why');
  if (!settings.enabled) { el.textContent = 'Briefs are switched off in ChatPanel settings.'; return; }
  el.textContent = settings.lastBuiltAt
    ? `Last built ${relDay(settings.lastBuiltAt)} — no subject reached ${settings.minRecords} records and ${settings.minMentions} mentions yet.`
    : 'Nothing is built yet. This runs entirely on your device and calls no model.';
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function init() {
  hydrate(document);
  index = await getBriefIndex();

  $('b-search').oninput = renderList;
  for (const b of document.querySelectorAll('#b-kinds button')) {
    b.onclick = () => {
      for (const o of document.querySelectorAll('#b-kinds button')) o.classList.toggle('active', o === b);
      kindFilter = b.dataset.kind;
      renderList();
    };
  }
  for (const b of document.querySelectorAll('#b-dash .dash-tabs button')) {
    b.onclick = () => {
      for (const o of document.querySelectorAll('#b-dash .dash-tabs button')) o.classList.toggle('active', o === b);
      dashTab = b.dataset.dash;
      renderDash();
    };
  }
  $('b-rebuild').onclick = () => rebuild($('b-rebuild'));
  $('b-build').onclick = () => rebuild($('b-build'));
  $('b-open-panel').onclick = () => openSidePanel();
  $('b-settings').onclick = () => chrome.runtime.openOptionsPage();
  $('omni-open').onclick = () => openOmni($('b-search').value || '');
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openOmni($('b-search').value || ''); }
    if (e.key === 'Escape' && current) showDash();
  });
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) openBrief(id); else showDash();
  });

  await explainEmpty();
  updateProposedCount().catch(() => {});
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && index.some((e) => e.id === id)) await openBrief(id);
  else showDash();

  // FIRST VISIT builds automatically. Time-to-first-value is a stated requirement, and an
  // empty page with a button is a worse answer than a built one — this costs no model call
  // and no network, so there is nothing to ask permission for.
  const settings = await getBriefSettings();
  if (settings.enabled && !index.length && !settings.lastBuiltAt) { await rebuild($('b-build')); return; }

  // After that, staleness is REPORTED rather than acted on. Deriving decrypts the whole
  // corpus, and doing that on every page open — for someone who came to read one brief —
  // would be the panel's old "attach the whole page to say hi" mistake in another costume.
  if (settings.enabled && index.length && await briefsAreStale()) markStale();
}

function markStale() {
  const btn = $('b-rebuild');
  btn.classList.add('active');
  btn.title = 'Your records changed since these were built — rebuild to re-derive them';
  const dash = $('b-dash-stats');
  if (dash && !dash.querySelector('.b-stale')) {
    const note = document.createElement('div');
    note.className = 'maint-group b-stale';
    note.innerHTML = '<h3>New records since these were built</h3>'
      + '<p>Briefs are derived, so they do not update themselves. Rebuilding re-derives every one from your records — safe, because a brief is a projection and never the original.</p>';
    const go = document.createElement('button');
    go.className = 'btn primary';
    go.textContent = 'Rebuild now';
    go.onclick = () => rebuild(go);
    note.appendChild(go);
    dash.prepend(note);
  }
}

function openOmni(query = '') {
  import('./js/omni-search.js').then((m) => m.openOmni({
    query,
    currentType: 'brief',
    onOpen: (r) => {
      if (r.type === 'brief') { openBrief(r.sourceId); return; }
      location.assign(r.url);
    },
  })).catch(() => { /* module load failed — no-op */ });
}

init().catch((e) => console.error('[chatpanel] briefs init failed', e));
