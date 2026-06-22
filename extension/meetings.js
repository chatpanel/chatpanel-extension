// Full-page Meetings dashboard. Visualizes every recorded meeting from the same
// encrypted storage the side panel uses, with:
//  • full-text search (BM25 "Smart", exact "Keyword", "People")
//  • insights parsed from the saved notes markdown (no new model calls)
//  • a meeting⇄people relationship graph + related-meeting discovery
import {
  getMeetingIndex, getMeeting, getMeetingNotes, saveMeetingNotes,
  deleteMeeting, meetingToMarkdown, meetingToText, persistMeeting, PLATFORMS,
} from './js/store-meetings.js';
import { getSettings, getTarget, meetingNotesSkill } from './js/store.js';
import { getLicense, can, UPGRADE_URL } from './js/license.js';
import { streamChat } from './js/providers.js';
import { buildIndex, bm25Search, buildGraph, topTerms, tokenize } from './js/meeting-index.js';
import { drawGraph } from './js/graph-view.js';

const $ = (id) => document.getElementById(id);
const PLATFORM_ICON = { zoom: '📹', meet: '📹', teams: '🟦', webex: '🟢', imported: '📄' };

let index = [];            // index entries (metadata)
const store = new Map();   // id -> { entry, rec, notes, parsed, people, terms, text }
let bm25 = null;
let graph = null;
let current = null;        // selected store entry (+ .tab)
let mode = 'smart';        // search mode: smart | keyword | people
let inGraph = false;       // global graph view shown?
let winId = null;          // this window — to open the side panel within a gesture

// --- helpers ---------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isImg = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim())
  && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)|images\.zoom\.us|\/p\/v2\/|gravatar|avatar|googleusercontent|wbxcdn|teams\.(microsoft|live)/i.test(v);
const platIcon = (p) => PLATFORM_ICON[p] || '🎙';
const platLabel = (p) => (p === 'imported' ? 'Imported' : (PLATFORMS[p]?.label || p || 'Meeting'));

function fmtDate(ts) { return ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
function fmtDateShort(ts) { return ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''; }
function fmtDuration(a, b) {
  if (!a || !b || b < a) return '';
  const min = Math.round((b - a) / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`;
}
function toast(msg) {
  const t = $('m-toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}
function peopleOf(rec) {
  const set = new Set();
  (rec.participants || []).forEach((p) => { const n = (p?.name || '').trim(); if (n) set.add(n); });
  (rec.segments || []).forEach((s) => { const sp = (s.speaker || '').trim(); if (sp && !isImg(sp)) set.add(sp); });
  return [...set];
}

// --- notes markdown → structured insights ----------------------------------
const isBullet = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
const stripBullet = (l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim();
function sectionKind(h) {
  const s = h.toLowerCase();
  if (/tl;?dr|summary|overview|recap/.test(s)) return 'summary';
  if (/topic|agenda/.test(s)) return 'topics';
  if (/key moment|moments|highlight|decision/.test(s)) return 'moments';
  if (/action|task|next step|to-?do|follow-?up/.test(s)) return 'actions';
  return null;
}
function badgeOf(text) {
  const m = text.match(/\*{0,2}\[?\s*(decision|risk|question|highlight)\s*\]?\*{0,2}\s*:?/i);
  if (m) return { badge: m[1].toLowerCase(), text: text.slice(m.index + m[0].length).trim() };
  return { badge: 'highlight', text };
}
const demd = (s) => String(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2').replace(/`(.+?)`/g, '$1').replace(/_(.+?)_/g, '$1').trim();

function parseNotes(md) {
  const out = { summary: '', topics: [], moments: [], actions: [], hasAny: false };
  if (!md || !md.trim()) return out;
  const lines = md.split('\n');
  let cur = 'summary';
  const summaryParts = [];
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { cur = sectionKind(h[1]); return; }
    if (!line.trim()) return;
    if (cur === 'summary') summaryParts.push(isBullet(line) ? stripBullet(line) : line.trim());
    else if (cur === 'topics') { if (isBullet(line)) out.topics.push(demd(stripBullet(line))); }
    else if (cur === 'moments') { if (isBullet(line)) { const b = badgeOf(stripBullet(line)); out.moments.push({ badge: b.badge, text: demd(b.text) }); } }
    else if (cur === 'actions') {
      const m = line.match(/^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/);
      if (m) {
        let text = m[2].trim(); let owner = ''; let due = '';
        const ow = text.match(/_\(([^)]+)\)_|\(([^)]+)\)/);
        if (ow) { owner = (ow[1] || ow[2] || '').trim(); text = text.replace(ow[0], '').trim(); }
        const du = text.match(/[—-]\s*_?([^_]+?)_?\s*$/);
        if (du && /due|\d|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow|eod|eow|next/i.test(du[1])) {
          due = du[1].replace(/^due\s*/i, '').trim(); text = text.slice(0, du.index).trim();
        }
        out.actions.push({ text: demd(text), done: m[1].toLowerCase() === 'x', owner: demd(owner), due, lineIndex: idx });
      } else if (isBullet(line)) out.actions.push({ text: demd(stripBullet(line)), done: false, owner: '', due: '', lineIndex: idx });
    }
  });
  out.summary = demd(summaryParts.join(' ').trim());
  out.hasAny = !!(out.summary || out.topics.length || out.moments.length || out.actions.length);
  return out;
}

// --- search ----------------------------------------------------------------
function makeSnippet(d, terms) {
  const text = d.text; const low = text.toLowerCase();
  let pos = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) return '';
  const start = Math.max(0, pos - 50);
  let seg = text.slice(start, start + 170).replace(/\s+/g, ' ').trim();
  let html = esc((start > 0 ? '…' : '') + seg + '…');
  for (const t of terms) if (t.length > 1) html = html.replace(new RegExp(`(${reEsc(t)})`, 'ig'), '<mark>$1</mark>');
  return html;
}

function searchResults(q) {
  const query = (q || '').trim();
  const byDate = (arr) => arr.sort((a, b) => (b.d.rec.startedAt || 0) - (a.d.rec.startedAt || 0));
  if (!query) return byDate([...store.values()].map((d) => ({ d })));
  if (mode === 'people') {
    const ql = query.toLowerCase();
    const matched = [...graph.meetingsByPerson.keys()].filter((p) => p.toLowerCase().includes(ql));
    const set = new Map();
    matched.forEach((p) => graph.meetingsByPerson.get(p).forEach((mid) => {
      if (!set.has(mid)) set.set(mid, new Set()); set.get(mid).add(p);
    }));
    return byDate([...set.entries()].map(([id, ppl]) => ({ d: store.get(id), people: [...ppl] })).filter((r) => r.d));
  }
  if (mode === 'keyword') {
    const ql = query.toLowerCase();
    return byDate([...store.values()].filter((d) => d.text.toLowerCase().includes(ql)).map((d) => ({ d, snippet: makeSnippet(d, [ql]) })));
  }
  const qterms = tokenize(query);
  return bm25Search(bm25, query).map((r) => ({ d: store.get(r.id), score: r.score, snippet: makeSnippet(store.get(r.id), qterms) })).filter((r) => r.d);
}

// --- list ------------------------------------------------------------------
function renderList() {
  const q = $('m-search').value;
  const results = searchResults(q);
  $('m-count').textContent = index.length ? `· ${index.length} recorded` : '';
  const host = $('m-items');
  if (!results.length) {
    host.innerHTML = `<div class="list-empty">${index.length ? 'No matches.' : 'No meetings yet. Join a Zoom / Meet / Teams / Webex call with captions on and ChatPanel records the transcript.'}</div>`;
    return;
  }
  host.innerHTML = results.map(({ d, snippet, people }) => {
    const e = d.entry;
    const live = e.status && e.status !== 'ended';
    const dur = live ? '<span class="pill live">● live</span>' : (fmtDuration(e.startedAt, e.endedAt) ? `<span class="pill">${esc(fmtDuration(e.startedAt, e.endedAt))}</span>` : '');
    return `<div class="mitem${current && current.entry.id === e.id ? ' active' : ''}" data-id="${esc(e.id)}">
      <div class="t"><span>${platIcon(e.platform)}</span> ${esc(e.title || 'Untitled meeting')}</div>
      <div class="meta"><span>${esc(platLabel(e.platform))}</span><span>·</span><span>${esc(fmtDateShort(e.startedAt))}</span>${dur}</div>
      ${people && people.length ? `<div class="snip">👤 ${esc(people.join(', '))}</div>` : ''}
      ${snippet ? `<div class="snip">${snippet}</div>` : ''}
    </div>`;
  }).join('');
}

// --- detail ----------------------------------------------------------------
function speakerCount(rec) {
  const set = new Set((rec.segments || []).map((s) => s.speaker).filter((x) => x && !isImg(x)));
  return rec.participants?.length || set.size || 0;
}

async function select(id) {
  const d = store.get(id);
  if (!d) return;
  current = d; current.tab = current.tab || 'insights';
  inGraph = false;
  $('m-graph').classList.add('hidden');
  history.replaceState(null, '', '#' + id);
  renderList();
  renderDetail();
}

function renderDetail() {
  $('m-empty').classList.add('hidden');
  $('m-graph').classList.add('hidden');
  const c = $('m-content'); c.classList.remove('hidden');
  const { rec, parsed } = current;
  const tab = current.tab || 'insights';
  const live = rec.status !== 'ended';
  const lines = (rec.segments || []).length;
  const ppl = speakerCount(rec);
  const decisions = parsed.moments.filter((m) => m.badge === 'decision').length;
  const risks = parsed.moments.filter((m) => m.badge === 'risk').length;

  c.innerHTML = `
    <div class="dhead">
      <div>
        <h2>${esc(rec.title || 'Untitled meeting')}</h2>
        <div class="sub">
          <span class="stat">${platIcon(rec.platform)} ${esc(platLabel(rec.platform))}</span>
          <span class="stat">🗓 ${esc(fmtDate(rec.startedAt))}</span>
          ${live ? '<span class="stat"><span class="pill live">● live</span></span>' : (fmtDuration(rec.startedAt, rec.endedAt) ? `<span class="stat">⏱ ${esc(fmtDuration(rec.startedAt, rec.endedAt))}</span>` : '')}
          ${ppl ? `<span class="stat">👥 ${ppl} participant${ppl === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
      <div class="dactions">
        <button class="btn" id="m-gen" type="button">${parsed.hasAny ? '✨ Regenerate' : '✨ Generate insights'}</button>
        <button class="btn" id="m-ask" type="button">💬 Ask</button>
        <button class="btn" id="m-export" type="button">⬆ Export</button>
        <button class="btn danger" id="m-delete" type="button" title="Delete meeting">🗑</button>
      </div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="n">${decisions}</div><div class="l">Decisions</div></div>
      <div class="metric"><div class="n">${parsed.actions.length}</div><div class="l">Action items</div></div>
      <div class="metric"><div class="n">${risks}</div><div class="l">Risks</div></div>
      <div class="metric"><div class="n">${lines}</div><div class="l">Transcript lines</div></div>
    </div>
    <div class="tabs">
      <button data-tab="insights" class="${tab === 'insights' ? 'active' : ''}" type="button">Insights</button>
      <button data-tab="related" class="${tab === 'related' ? 'active' : ''}" type="button">Related</button>
      <button data-tab="transcript" class="${tab === 'transcript' ? 'active' : ''}" type="button">Transcript</button>
    </div>
    <div id="m-tabbody"></div>`;

  c.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { current.tab = b.dataset.tab; renderDetail(); }));
  $('m-gen').onclick = () => generateInsights(current);
  $('m-ask').onclick = askAboutMeeting;
  $('m-export').onclick = exportMeeting;
  $('m-delete').onclick = removeMeeting;
  if (tab === 'transcript') renderTranscript();
  else if (tab === 'related') renderRelated();
  else renderInsights();
}

function tileList(items, render) {
  if (!items.length) return '<div class="tile-empty">Nothing captured.</div>';
  return `<ul>${items.map(render).join('')}</ul>`;
}

function renderInsights() {
  const { parsed } = current;
  if (!parsed.hasAny) {
    $('m-tabbody').innerHTML = `<div class="tile span"><div class="tile-empty">No summary yet. Open this meeting in the ChatPanel side panel and run <strong>Meeting notes</strong> (or let the live scribe auto-summarize) to populate insights here.</div></div>`;
    return;
  }
  const moments = tileList(parsed.moments, (m) => `<li><span class="badge ${esc(m.badge)}">${esc(m.badge)}</span><span>${esc(m.text)}</span></li>`);
  const topics = tileList(parsed.topics, (t) => `<li><span class="dot">•</span><span>${esc(t)}</span></li>`);
  const actions = parsed.actions.length
    ? `<ul>${parsed.actions.map((a, i) => `<li>
        <input type="checkbox" class="chk" data-line="${a.lineIndex}" data-i="${i}" ${a.done ? 'checked' : ''} />
        <span class="${a.done ? 'act-done' : ''}">${esc(a.text)}${a.owner ? ` <span class="owner">— ${esc(a.owner)}</span>` : ''}${a.due ? ` <span class="owner">· ${esc(a.due)}</span>` : ''}</span>
      </li>`).join('')}</ul>`
    : '<div class="tile-empty">No action items.</div>';
  $('m-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>▤ Summary</h3>${parsed.summary ? `<p>${esc(parsed.summary)}</p>` : '<div class="tile-empty">No summary.</div>'}</div>
      <div class="tile"><h3>◈ Topics</h3>${topics}</div>
      <div class="tile"><h3>✦ Key Moments</h3>${moments}</div>
      <div class="tile span"><h3>✓ Action Items</h3>${actions}</div>
    </div>`;
  $('m-tabbody').querySelectorAll('.chk').forEach((cb) => (cb.onchange = () => toggleAction(Number(cb.dataset.line), Number(cb.dataset.i), cb.checked)));
}

function renderRelated() {
  const id = current.entry.id;
  const people = current.people;
  const related = graph.relatedMeetings(id);
  const peopleChips = people.length
    ? `<div class="chips">${people.map((p) => `<button class="chip" data-person="${esc(p)}" type="button">👤 ${esc(p)}</button>`).join('')}</div>`
    : '<div class="tile-empty">No participants detected (captions didn’t include speaker names).</div>';
  const relatedList = related.length
    ? `<ul>${related.map((r) => {
        const d = store.get(r.id); if (!d) return '';
        return `<li class="rel" data-id="${esc(r.id)}"><span class="dot">↗</span><span><strong>${esc(d.rec.title || 'Untitled')}</strong>
          <span class="owner">— ${esc(fmtDateShort(d.rec.startedAt))}${r.sharedPeople.length ? ` · shares ${esc(r.sharedPeople.join(', '))}` : ' · shared topics'}</span></span></li>`;
      }).join('')}</ul>`
    : '<div class="tile-empty">No related meetings found yet.</div>';

  $('m-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>👥 People</h3>${peopleChips}</div>
      <div class="tile span"><h3>🔗 Related meetings</h3>${relatedList}</div>
      <div class="tile span"><h3>🕸 Relationship graph</h3><div class="graph-host" id="m-relgraph"></div></div>
    </div>`;

  $('m-tabbody').querySelectorAll('.chip[data-person]').forEach((b) => (b.onclick = () => searchPerson(b.dataset.person)));
  $('m-tabbody').querySelectorAll('.rel[data-id]').forEach((li) => (li.onclick = () => select(li.dataset.id)));

  // Neighborhood graph: this meeting + its people + related meetings.
  const nodes = [{ id, type: 'meeting', label: current.rec.title || 'This meeting', focus: true }];
  const links = [];
  people.forEach((p) => { nodes.push({ id: 'p:' + p, type: 'person', label: p }); links.push({ s: id, t: 'p:' + p }); });
  related.slice(0, 6).forEach((r) => {
    const d = store.get(r.id); if (!d) return;
    nodes.push({ id: r.id, type: 'meeting', label: d.rec.title || 'Untitled' });
    r.sharedPeople.forEach((p) => { if (nodes.some((n) => n.id === 'p:' + p)) links.push({ s: r.id, t: 'p:' + p }); });
    if (!r.sharedPeople.length) links.push({ s: id, t: r.id });
  });
  drawGraph($('m-relgraph'), nodes, links, (n) => { if (n.type === 'meeting') select(n.id); else searchPerson(n.label); });
}

function renderTranscript() {
  const segs = current.rec.segments || [];
  const body = $('m-tabbody');
  if (!segs.length) { body.innerHTML = '<div class="tile-empty">No transcript captured for this meeting.</div>'; return; }
  body.innerHTML = `<input id="m-tsearch" class="tsearch" type="search" placeholder="Search transcript…" /><div class="transcript" id="m-tlines"></div>`;
  const paint = (q = '') => {
    const ql = q.trim().toLowerCase();
    const rows = segs.filter((s) => !ql || (!isImg((s.text || '').trim()) && (s.text || '').toLowerCase().includes(ql)));
    $('m-tlines').innerHTML = rows.length ? rows.map((s) => {
      const time = esc(new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const spk = (s.speaker || '').trim();
      const spHtml = isImg(spk) ? `<img class="av" src="${esc(spk)}" alt="" loading="lazy" />` : `<span class="sp">${esc(spk)}</span>`;
      const tt = (s.text || '').trim();
      let bodyHtml;
      if (isImg(tt)) bodyHtml = `<a class="tline-imglink" href="${esc(tt)}" target="_blank" rel="noopener"><img class="tline-img" src="${esc(tt)}" alt="shared image" loading="lazy" /></a>`;
      else { let txt = esc(s.text || ''); if (ql) txt = txt.replace(new RegExp(`(${reEsc(ql)})`, 'ig'), '<mark>$1</mark>'); bodyHtml = `<span class="ttext">${txt}</span>`; }
      return `<div class="tline"><span class="ts">${time}</span>${spHtml}${bodyHtml}</div>`;
    }).join('') : '<div class="tile-empty">No matching lines.</div>';
    $('m-tlines').querySelectorAll('img.av').forEach((img) => (img.onerror = () => { const x = document.createElement('span'); x.className = 'sp'; x.textContent = '👤'; img.replaceWith(x); }));
    $('m-tlines').querySelectorAll('img.tline-img').forEach((img) => (img.onerror = () => { const x = document.createElement('span'); x.className = 'img-chip'; x.textContent = '🖼 image'; (img.closest('.tline-imglink') || img).replaceWith(x); }));
  };
  $('m-tsearch').oninput = (e) => paint(e.target.value);
  paint();
}

// --- global relationship graph ---------------------------------------------
function showGraphView() {
  inGraph = true;
  $('m-empty').classList.add('hidden');
  $('m-content').classList.add('hidden');
  const host = $('m-graph'); host.classList.remove('hidden');
  // Reflect the current search/mode: graph only the matching meetings (+ their people).
  const q = $('m-search').value.trim();
  const meetings = searchResults(q).map((r) => r.d);
  if (!meetings.length) { host.innerHTML = `<div class="empty">${q ? 'No meetings match your search.' : 'No meetings to graph yet.'}</div>`; return; }
  const people = new Map(); // person -> meeting ids (within the filtered set)
  meetings.forEach((d) => d.people.forEach((p) => { if (!people.has(p)) people.set(p, []); people.get(p).push(d.entry.id); }));
  host.innerHTML = `
    <div class="graph-head">
      <div><strong>Relationship graph</strong> <span class="owner">— ${meetings.length} meeting${meetings.length === 1 ? '' : 's'} · ${people.size} people${q ? ` matching “${esc(q)}”` : ''}. Click a meeting to open it, a person to find their meetings.</span></div>
      <div class="legend"><span class="lg"><i class="sw meeting"></i> Meeting</span><span class="lg"><i class="sw person"></i> Person</span></div>
    </div>
    <div class="graph-host big" id="m-biggraph"></div>`;
  const nodes = []; const links = [];
  meetings.forEach((d) => nodes.push({ id: d.entry.id, type: 'meeting', label: d.rec.title || 'Untitled' }));
  for (const [person, mids] of people) {
    nodes.push({ id: 'p:' + person, type: 'person', label: person });
    mids.forEach((mid) => links.push({ s: mid, t: 'p:' + person }));
  }
  drawGraph($('m-biggraph'), nodes, links, (n) => { if (n.type === 'meeting') select(n.id); else searchPerson(n.label); });
}

function toggleGraph() {
  if (inGraph) { inGraph = false; $('m-graph').classList.add('hidden'); if (current) renderDetail(); else $('m-empty').classList.remove('hidden'); }
  else showGraphView();
  $('m-graph-toggle').classList.toggle('active', inGraph);
}

// --- actions ---------------------------------------------------------------
function searchPerson(name) {
  mode = 'people';
  $('m-modes').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'people'));
  $('m-search').value = name;
  renderList();
  if (inGraph) showGraphView();
}

async function toggleAction(lineIndex, i, checked) {
  if (!current) return;
  const lines = (current.notes || '').split('\n');
  if (lineIndex >= 0 && lineIndex < lines.length) {
    if (/\[[ xX]\]/.test(lines[lineIndex])) lines[lineIndex] = lines[lineIndex].replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]');
    else lines[lineIndex] = lines[lineIndex].replace(/^(\s*(?:[-*+]|\d+\.)\s*)/, (m) => `${m}[${checked ? 'x' : ' '}] `);
    current.notes = lines.join('\n');
    await saveMeetingNotes(current.entry.id, current.notes).catch(() => toast('Could not save'));
  }
  if (current.parsed.actions[i]) current.parsed.actions[i].done = checked;
  renderInsights();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportMeeting() {
  const { rec, notes } = current;
  const head = notes && notes.trim() ? `${notes.trim()}\n\n---\n\n` : '';
  const safe = (rec.title || 'meeting').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'meeting';
  download(`${safe}.md`, head + meetingToMarkdown(rec));
}
async function removeMeeting() {
  if (!current) return;
  if (!confirm(`Delete “${current.rec.title || 'this meeting'}” and its transcript? This can't be undone.`)) return;
  const id = current.entry.id;
  await deleteMeeting(id);
  store.delete(id);
  index = await getMeetingIndex();
  rebuildIndexes();
  current = null;
  history.replaceState(null, '', '#');
  $('m-content').classList.add('hidden');
  $('m-empty').classList.remove('hidden');
  renderList();
  toast('Meeting deleted');
}
async function askAboutMeeting() {
  if (!current) return;
  const id = current.entry.id;
  await chrome.storage.local.set({ 'chatpanel:openMeetingId': id }).catch(() => {});
  try { if (winId != null) await chrome.sidePanel.open({ windowId: winId }); } catch { /* may already be open */ }
  chrome.runtime.sendMessage({ type: 'open-meeting', id }).catch(() => {});
  toast('Opening this meeting in the side panel…');
}

// --- generate insights (uses the configured ChatPanel agent/model) ---------
function refreshDoc(d) {
  const transcriptText = (d.rec.segments || []).map((s) => (isImg((s.text || '').trim()) ? '' : (s.text || ''))).join(' ');
  d.text = [d.rec.title || '', d.notes || '', transcriptText].join('\n');
  d.terms = topTerms(d.text, 10);
  d.people = peopleOf(d.rec);
  d.parsed = parseNotes(d.notes);
}

async function generateInsights(d) {
  if (!d) return;
  const settings = await getSettings();
  const agent = getTarget(settings, settings.activeAgentId);
  if (!agent) { toast('No active model/agent — configure one in Settings → API/Agents.'); return; }
  const gen = $('m-gen');
  if (gen) { gen.disabled = true; gen.textContent = '✨ Generating…'; }
  toast('Generating insights with your active agent…');
  const transcript = meetingToText(d.rec);
  let notes = '';
  try {
    await streamChat({
      agent: { ...agent, systemPrompt: meetingNotesSkill().prompt, temperature: 0.3 },
      messages: [{ role: 'user', content: `Here is the meeting transcript. Produce the notes.\n\n${transcript}` }],
      settings,
      onDelta: (t) => { notes += t; },
      onEvent: () => {},
    });
  } catch (e) {
    if (gen) { gen.disabled = false; gen.textContent = d.parsed.hasAny ? '✨ Regenerate' : '✨ Generate insights'; }
    toast(`Couldn’t generate: ${e?.message || e}`);
    return;
  }
  if (!notes.trim()) { if (gen) gen.disabled = false; toast('No insights returned by the model.'); return; }
  d.notes = notes.trim();
  await saveMeetingNotes(d.entry.id, d.notes).catch(() => {});
  refreshDoc(d);
  rebuildIndexes();          // related insights / graph reflect the new notes
  if (current === d) renderDetail();
  renderList();
  toast('Insights generated.');
}

// --- import existing transcripts (.md / .txt) ------------------------------
function parseTranscriptMd(text, filename) {
  let title = (filename || 'Imported meeting').replace(/\.(md|markdown|txt)$/i, '').replace(/[._-]+/g, ' ').trim();
  const segs = [];
  const start = Date.now();
  let i = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h1 = line.match(/^#\s+(.+)/);
    if (h1) { title = demd(h1[1]); continue; }
    if (/^#{2,}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^_.*_$/.test(line)) continue; // sub-headings, rules, meta line
    let m = line.match(/^\*\*(.+?)\*\*\s*(?:_\(([^)]*)\)_)?\s*:?\s*(.*)$/); // ChatPanel export
    if (m && (m[3] || '').trim()) { segs.push({ t: start + i * 4000, speaker: demd(m[1]), text: demd(m[3]) }); i++; continue; }
    m = line.match(/^(?:\[([^\]]+)\]\s*)?([A-Z][\w .'’-]{0,40}?):\s+(.+)$/); // [time] Speaker: text | Speaker: text
    if (m) { segs.push({ t: start + i * 4000, speaker: m[2].trim(), text: demd(m[3]) }); i++; continue; }
    segs.push({ t: start + i * 4000, speaker: '', text: demd(line) }); i++; // plain line
  }
  return { title: title || 'Imported meeting', startedAt: start, endedAt: start + segs.length * 4000, segments: segs };
}

async function importFiles(files) {
  let last = null;
  for (const file of [...files]) {
    let text = '';
    try { text = await file.text(); } catch { toast(`Couldn’t read ${file.name}`); continue; }
    const p = parseTranscriptMd(text, file.name);
    if (!p.segments.length) { toast(`No transcript lines found in ${file.name}`); continue; }
    const id = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const rec = { id, platform: 'imported', meetingKey: 'import:' + id, title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, status: 'ended', segments: p.segments };
    await persistMeeting(rec);
    const d = { entry: { id, platform: 'imported', title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, status: 'ended', lines: p.segments.length }, rec, notes: '', parsed: parseNotes(''), people: peopleOf(rec), terms: [], text: '' };
    refreshDoc(d);
    store.set(id, d);
    last = d;
  }
  if (!last) return;
  index = await getMeetingIndex();
  rebuildIndexes();
  await select(last.entry.id);
  toast(`Imported “${last.rec.title}” — generating insights…`);
  await generateInsights(last); // auto-summarize with the configured agent
}

// --- boot ------------------------------------------------------------------
function rebuildIndexes() {
  const ds = [...store.values()];
  bm25 = buildIndex(ds.map((d) => ({ id: d.entry.id, text: d.text })));
  graph = buildGraph(ds.map((d) => ({ id: d.entry.id, title: d.rec.title, platform: d.rec.platform, startedAt: d.rec.startedAt, people: d.people, terms: d.terms })));
}

function showProGate() {
  $('m-count').textContent = '';
  ['m-import', 'm-graph-toggle'].forEach((id) => $(id)?.classList.add('hidden'));
  document.querySelector('.layout').innerHTML = `
    <div class="progate">
      <div class="progate-card">
        <div class="progate-ic">🗓✨</div>
        <h2>Meetings is a Pro feature</h2>
        <p>The live meeting scribe and this dashboard — transcripts, AI summaries, action items, search and the relationship graph — are part of ChatPanel Pro.</p>
        <a class="btn primary" id="m-upgrade" href="${UPGRADE_URL}" target="_blank" rel="noopener">✨ Upgrade to Pro</a>
      </div>
    </div>`;
}

async function boot() {
  const license = await getLicense();
  if (!can(license, 'liveMeetings')) { showProGate(); return; }
  try { winId = (await chrome.windows.getCurrent()).id; } catch { /* ok */ }
  index = await getMeetingIndex();
  await Promise.all(index.map(async (e) => {
    const rec = await getMeeting(e.id); if (!rec) return;
    const notes = await getMeetingNotes(e.id).catch(() => '');
    const transcriptText = (rec.segments || []).map((s) => (isImg((s.text || '').trim()) ? '' : (s.text || ''))).join(' ');
    const text = [rec.title || '', notes || '', transcriptText].join('\n');
    store.set(e.id, { entry: e, rec, notes, parsed: parseNotes(notes), people: peopleOf(rec), terms: topTerms(text, 10), text });
  }));
  rebuildIndexes();
  renderList();

  $('m-items').addEventListener('click', (e) => { const it = e.target.closest('.mitem'); if (it?.dataset.id) select(it.dataset.id); });
  $('m-search').oninput = () => { renderList(); if (inGraph) showGraphView(); };
  $('m-modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    mode = b.dataset.mode;
    $('m-modes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderList(); if (inGraph) showGraphView();
  });
  $('m-graph-toggle').onclick = toggleGraph;
  $('m-import').onclick = () => $('m-import-file').click();
  $('m-import-file').onchange = (e) => { const fs = e.target.files; if (fs && fs.length) importFiles(fs); e.target.value = ''; };
  $('m-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#meetings') });

  const fromHash = (location.hash || '').replace('#', '');
  if (fromHash && store.has(fromHash)) await select(fromHash);
}
boot();
