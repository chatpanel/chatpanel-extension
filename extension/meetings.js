// Full-page Meetings dashboard. Visualizes every recorded meeting from the same
// encrypted storage the side panel uses, with:
//  • full-text search (ranked "Best match" or literal "Exact text")
//  • insights parsed from the saved notes markdown (no new model calls)
//  • a topic relationship graph + related-meeting discovery
import {
  getMeetingIndex, getMeeting, getMeetingNotes, saveMeetingNotes,
  getMeetingNoteVersions, setActiveMeetingNote, deleteMeetingNoteVersion,
  deleteMeeting, meetingToMarkdown, meetingToText, persistMeeting, PLATFORMS, getMeetingTopics, saveMeetingTopics,
} from './js/store-meetings.js';
import { getSettings, getTarget } from './js/store.js';
import { getLicense, can, subscribe } from './js/license.js';
import { streamChat } from './js/providers.js';
import { buildIndex, bm25Search, buildGraph, tokenize } from './js/meeting-index.js';
import { drawGraph } from './js/graph-view.js';
import { buildMeetingTopicGraph, graphParticipantNames, graphTopicTerms } from './js/meeting-graph.js';
import { initialHistoryView } from './js/history-state.js';
import { isMeetingImageValue, participantRowsOfMeeting, peopleOfMeeting, speakerCountOfMeeting } from './js/meeting-people.js';
import { contentHash, insightTopicItemsFromNotes, makeTopicIndex, topicDisplayForMeetingSource, topicSourceTextForMeeting } from './js/topic-extraction.js';
import { MEETING_INSIGHT_SECTIONS, composeMeetingInsightNotes, meetingInsightPrompt } from './js/meeting-insights.js';
import { parseTranscriptText, repairImportedTranscriptDate, repairTranscriptParticipants } from './js/meeting-transcript-import.js';
import { icon, iconForEmoji, hydrate } from './js/icons.js';

const $ = (id) => document.getElementById(id);
const PLATFORM_ICON = { zoom: '📹', meet: '📹', teams: '🟦', webex: '🟢', imported: '📄' };
const GRAPH_RENDER_LIMIT = 150;

let index = [];            // index entries (metadata)
const store = new Map();   // id -> { entry, rec, notes, parsed, people, terms, text }
let bm25 = null;
let graph = null;
let current = null;        // selected store entry (+ .tab)
let mode = 'smart';        // search mode: smart | keyword
let inGraph = false;       // global graph view shown?
let winId = null;          // this window — to open the side panel within a gesture
let graphDrawToken = 0;

// --- helpers ---------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isImg = isMeetingImageValue;
const platIcon = (p) => { const g = PLATFORM_ICON[p] || '🎙'; return iconForEmoji(g) || esc(g); };
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
const peopleOf = peopleOfMeeting;

// --- notes markdown → structured insights ----------------------------------
const isBullet = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
const stripBullet = (l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim();
function sectionKind(h) {
  const s = h.toLowerCase();
  if (/tl;?dr|summary|overview|recap/.test(s)) return 'summary';
  if (/topic|agenda/.test(s)) return 'topics';
  if (/key moment|moments|highlight|decision/.test(s)) return 'moments';
  if (/shared link|link|url|resource|reference/.test(s)) return 'links';
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
  const out = { summary: '', topics: [], moments: [], links: [], actions: [], hasAny: false };
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
    else if (cur === 'links') {
      if (isBullet(line)) {
        const value = demd(stripBullet(line));
        if (value && !/^no shared links\.?$/i.test(value)) out.links.push(value);
      }
    }
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
  out.hasAny = !!(out.summary || out.topics.length || out.moments.length || out.links.length || out.actions.length);
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
  host.innerHTML = results.map(({ d, snippet }) => {
    const e = d.entry;
    const live = e.status && e.status !== 'ended';
    const dur = live ? '<span class="pill live">● live</span>' : (fmtDuration(e.startedAt, e.endedAt) ? `<span class="pill">${esc(fmtDuration(e.startedAt, e.endedAt))}</span>` : '');
    return `<div class="mitem${current && current.entry.id === e.id ? ' active' : ''}" data-id="${esc(e.id)}">
      <div class="t"><span>${platIcon(e.platform)}</span> ${esc(e.title || 'Untitled meeting')}</div>
      <div class="meta"><span>${esc(platLabel(e.platform))}</span><span>·</span><span>${esc(fmtDateShort(e.startedAt))}</span>${dur}</div>
      ${snippet ? `<div class="snip">${snippet}</div>` : ''}
    </div>`;
  }).join('');
}

// --- detail ----------------------------------------------------------------
function speakerCount(rec) {
  return speakerCountOfMeeting(rec);
}

// Refresh the open meeting's summary versions + active text from storage (e.g. after
// switching or deleting a version, or to pick up versions the side panel regenerated).
async function reloadCurrentNotes() {
  if (!current) return;
  const ver = await getMeetingNoteVersions(current.entry.id).catch(() => ({ activeId: null, versions: [] }));
  current.versions = ver.versions;
  current.activeId = ver.activeId;
  current.notes = await getMeetingNotes(current.entry.id).catch(() => current.notes);
  current.parsed = parseNotes(current.notes);
}

function versionLabel(v) {
  if (!v) return 'Summary';
  if (v.id === 'live') return '🔴 Live';
  const style = v.style === 'detailed' ? 'Detailed' : 'Concise';
  const d = new Date(v.createdAt || 0);
  return `${style} · ${d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

async function switchVersionPage(vid) {
  if (!current) return;
  await setActiveMeetingNote(current.entry.id, vid).catch(() => {});
  await reloadCurrentNotes();
  renderDetail();
}

async function deleteVersionPage(vid) {
  if (!current) return;
  const v = (current.versions || []).find((x) => x.id === vid);
  if (!confirm(`Delete the ${versionLabel(v)} summary version? Other versions and the transcript are untouched.`)) return;
  await deleteMeetingNoteVersion(current.entry.id, vid).catch(() => {});
  await reloadCurrentNotes();
  renderDetail();
  toast('Version deleted');
}

async function select(id) {
  const d = store.get(id);
  if (!d) return;
  current = d; current.tab = current.tab || 'insights';
  topicGraphFocus = null; // a fresh meeting resets any topic-graph drill-down
  await reloadCurrentNotes(); // pick up any versions the side panel created since boot
  graphDrawToken += 1;
  const graphHost = $('m-biggraph');
  if (graphHost?._stop) graphHost._stop();
  inGraph = false;
  $('m-graph').classList.add('hidden');
  $('m-graph-toggle').classList.remove('active');
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
          <span class="stat">${icon('calendar')} ${esc(fmtDate(rec.startedAt))}</span>
          ${live ? '<span class="stat"><span class="pill live">● live</span></span>' : (fmtDuration(rec.startedAt, rec.endedAt) ? `<span class="stat">${icon('timer')} ${esc(fmtDuration(rec.startedAt, rec.endedAt))}</span>` : '')}
          ${ppl ? `<span class="stat">${icon('users')} ${ppl} participant${ppl === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
      <div class="dactions">
        <button class="btn" id="m-gen" type="button">${icon('sparkles')} ${parsed.hasAny ? 'Regenerate' : 'Generate insights'}</button>
        <button class="btn" id="m-ask" type="button">${icon('chat')} Ask</button>
        <button class="btn" id="m-export" type="button">${icon('arrow-up')} Export</button>
        <button class="btn danger" id="m-delete" type="button" title="Delete meeting" aria-label="Delete meeting">${icon('trash-2')}</button>
      </div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="n">${decisions}</div><div class="l">Decisions</div></div>
      <div class="metric"><div class="n">${parsed.actions.length}</div><div class="l">Action items</div></div>
      <div class="metric"><div class="n">${risks}</div><div class="l">Risks</div></div>
      <div class="metric"><div class="n">${lines}</div><div class="l">Transcript lines</div></div>
    </div>
    ${(current.versions || []).length > 1 ? `
    <div class="ver-bar" id="m-verbar">
      <span class="ver-title">Summary version</span>
      ${current.versions.map((v) => `<span class="ver ${v.id === current.activeId ? 'on' : ''}"><button class="ver-pick" data-vid="${esc(v.id)}" title="View this version">${esc(versionLabel(v))}</button>${v.id !== 'live' ? `<button class="ver-x" data-vid="${esc(v.id)}" title="Delete version" aria-label="Delete version">${icon('close')}</button>` : ''}</span>`).join('')}
    </div>` : ''}
    <div class="tabs">
      <button data-tab="insights" class="${tab === 'insights' ? 'active' : ''}" type="button">Insights</button>
      <button data-tab="related" class="${tab === 'related' ? 'active' : ''}" type="button">Related</button>
      <button data-tab="topic-graph" class="${tab === 'topic-graph' ? 'active' : ''}" type="button">Topic Graph</button>
      <button data-tab="participants" class="${tab === 'participants' ? 'active' : ''}" type="button">Participants</button>
      <button data-tab="transcript" class="${tab === 'transcript' ? 'active' : ''}" type="button">Transcript</button>
    </div>
    <div id="m-tabbody"></div>`;

  c.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { current.tab = b.dataset.tab; renderDetail(); }));
  c.querySelectorAll('.ver-pick').forEach((b) => (b.onclick = () => switchVersionPage(b.dataset.vid)));
  c.querySelectorAll('.ver-x').forEach((b) => (b.onclick = () => deleteVersionPage(b.dataset.vid)));
  $('m-gen').onclick = () => generateInsights(current);
  $('m-ask').onclick = askAboutMeeting;
  $('m-export').onclick = exportMeeting;
  $('m-delete').onclick = removeMeeting;
  if (tab === 'transcript') renderTranscript();
  else if (tab === 'participants') renderParticipants();
  else if (tab === 'topic-graph') renderTopicGraph();
  else if (tab === 'related') renderRelated();
  else renderInsights();
}

function tileList(items, render, listClass = '') {
  if (!items.length) return '<div class="tile-empty">Nothing captured.</div>';
  return `<ul${listClass ? ` class="${listClass}"` : ''}>${items.map(render).join('')}</ul>`;
}

function streamBlock(section, placeholder) {
  const text = (section?.text || '').trim();
  const status = section?.error
    ? `<div class="stream-status err">⚠ ${esc(section.error)}</div>`
    : section?.done
      ? '<div class="stream-status ok">✓ Complete</div>'
      : '<div class="stream-status">Streaming…</div>';
  const body = text || placeholder;
  return `${status}<div class="stream-block${text ? '' : ' pending'}">${esc(body)}</div>`;
}

function renderInsightDraft(draft) {
  const sections = draft?.sections || {};
  $('m-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>${icon('file-text')} Summary</h3>${streamBlock(sections.summary, 'Waiting for summary…')}</div>
      <div class="tile"><h3>${icon('hash')} Topics</h3>${streamBlock(sections.topics, 'Waiting for topics…')}</div>
      <div class="tile"><h3>${icon('sparkles')} Key Moments</h3>${streamBlock(sections.moments, 'Waiting for key moments…')}</div>
      <div class="tile"><h3>${icon('link')} Shared Links</h3>${streamBlock(sections.links, 'Waiting for shared links…')}</div>
      <div class="tile span"><h3>${icon('list-checks')} Action Items</h3>${streamBlock(sections.actions, 'Waiting for action items…')}</div>
    </div>`;
}

function renderInsights() {
  if (current?.insightDraft) {
    renderInsightDraft(current.insightDraft);
    return;
  }
  const { parsed } = current;
  if (!parsed.hasAny) {
    $('m-tabbody').innerHTML = `<div class="tile span"><div class="tile-empty">No summary yet. Open this meeting in the ChatPanel side panel and run <strong>Meeting notes</strong> (or let the live scribe auto-summarize) to populate insights here.</div></div>`;
    return;
  }
  const moments = tileList(
    parsed.moments,
    (m) => `<li><span class="badge ${esc(m.badge)}">${esc(m.badge)}</span><span class="moment-text">${esc(m.text)}</span></li>`,
    'moment-list',
  );
  const topics = tileList(parsed.topics, (t) => `<li><span class="dot">•</span><span>${esc(t)}</span></li>`);
  const links = (parsed.links || []).length
    ? tileList(parsed.links, renderSharedLink, 'link-list')
    : '<div class="tile-empty">No shared links.</div>';
  const actions = renderActionItems(parsed.actions);
  $('m-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>${icon('file-text')} Summary</h3>${parsed.summary ? `<p>${esc(parsed.summary)}</p>` : '<div class="tile-empty">No summary.</div>'}</div>
      <div class="tile"><h3>${icon('hash')} Topics</h3>${topics}</div>
      <div class="tile"><h3>${icon('sparkles')} Key Moments</h3>${moments}</div>
      <div class="tile"><h3>${icon('link')} Shared Links</h3>${links}</div>
      <div class="tile span"><h3>${icon('list-checks')} Action Items</h3>${actions}</div>
    </div>`;
  $('m-tabbody').querySelectorAll('.chk').forEach((cb) => (cb.onchange = () => toggleAction(Number(cb.dataset.line), Number(cb.dataset.i), cb.checked)));
}

function groupActionsByOwner(actions) {
  const groups = new Map();
  (actions || []).forEach((action, index) => {
    const owner = (action.owner || '').trim() || 'Unassigned';
    if (!groups.has(owner)) groups.set(owner, { owner, items: [] });
    groups.get(owner).items.push({ action, index });
  });
  return [...groups.values()].sort((a, b) => {
    if (a.owner === 'Unassigned') return 1;
    if (b.owner === 'Unassigned') return -1;
    return a.owner.localeCompare(b.owner);
  });
}

function renderActionItems(actions) {
  if (!actions.length) return '<div class="tile-empty">No action items.</div>';
  return groupActionsByOwner(actions).map((group) => `
    <div class="action-group">
      <h4>${esc(group.owner)}</h4>
      <ul>${group.items.map(({ action: a, index: i }) => `<li>
        <input type="checkbox" class="chk" data-line="${a.lineIndex}" data-i="${i}" ${a.done ? 'checked' : ''} />
        <span class="${a.done ? 'act-done' : ''}">${esc(a.text)}${a.due ? ` <span class="owner">· ${esc(a.due)}</span>` : ''}</span>
      </li>`).join('')}</ul>
    </div>`).join('');
}

function linkParts(value) {
  const text = String(value || '').trim();
  const match = text.match(/https?:\/\/[^\s<>)\]]+/i);
  if (!match) return { label: text, url: '' };
  const url = match[0].replace(/[.,;:!?]+$/, '');
  const label = text.slice(0, match.index).replace(/[-–—:|\s]+$/, '').trim() || url;
  return { label, url };
}

function renderSharedLink(value) {
  const { label, url } = linkParts(value);
  if (!url) return `<li><span class="dot">${icon('external-link')}</span><span>${esc(label)}</span></li>`;
  return `<li><span class="dot">${icon('external-link')}</span><a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a></li>`;
}

function relatedReasonList(items, limit = 3) {
  const values = [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (values.length <= limit) return values.join(', ');
  return `${values.slice(0, limit).join(', ')} +${values.length - limit}`;
}

function relatedMeetingReason(r) {
  const parts = [];
  const people = relatedReasonList(r.sharedPeople || []);
  const topics = relatedReasonList(r.sharedTopics || []);
  const titleTerms = relatedReasonList(r.sharedTitleTerms || []);
  if (people) parts.push(`shared participants: ${people}`);
  if (topics) parts.push(`shared topics: ${topics}`);
  if (titleTerms) parts.push(`similar title: ${titleTerms}`);
  return parts.join(' · ') || `relationship score ${r.weight || 0}`;
}

function renderRelated() {
  const id = current.entry.id;
  const related = graph.relatedMeetings(id);
  const topics = current.terms || [];
  const topicTitle = current.topicFallback ? '# Suggested Topics' : '# Topics';
  let topicHint = '';
  if (current.topicFallback && topics.length) {
    topicHint = current.topicSource === 'notes'
      ? '<p class="muted tiny">Suggested from generated insights because the Topics section was empty or not parseable. Regenerate insights to replace these with explicit topics.</p>'
      : '<p class="muted tiny">Local fallback from the transcript. Generate insights to replace these with concrete meeting topics.</p>';
  }
  const topicChips = topics.length
    ? `<div class="chips">${topics.map((t) => `<button class="chip" data-topic="${esc(t)}" type="button"># ${esc(t)}</button>`).join('')}</div>`
    : '<div class="tile-empty">No strong topics detected yet.</div>';
  const relatedList = related.length
    ? `<ul>${related.map((r) => {
        const d = store.get(r.id); if (!d) return '';
        return `<li class="rel" data-id="${esc(r.id)}"><span class="dot">${icon('external-link')}</span><span><strong>${esc(d.rec.title || 'Untitled')}</strong>
          <span class="owner">— ${esc(fmtDateShort(d.rec.startedAt))} · ${esc(relatedMeetingReason(r))}</span></span></li>`;
      }).join('')}</ul>`
    : '<div class="tile-empty">No related meetings found yet.</div>';

  $('m-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>${topicTitle}</h3>${topicChips}${topicHint}</div>
      <div class="tile span"><h3>${icon('link')} Related meetings</h3>${relatedList}</div>
    </div>`;

  $('m-tabbody').querySelectorAll('.chip[data-topic]').forEach((b) => (b.onclick = () => searchTopic(b.dataset.topic)));
  $('m-tabbody').querySelectorAll('.rel[data-id]').forEach((li) => (li.onclick = () => select(li.dataset.id)));
}

// The meeting the topic graph is currently DRILLED into (null = the open meeting).
// Single-click a related meeting node to re-center the graph on it; double-click opens it.
let topicGraphFocus = null;

function renderTopicGraph() {
  const focusId = (topicGraphFocus && store.get(topicGraphFocus)) ? topicGraphFocus : current.entry.id;
  const focusD = store.get(focusId) || current;
  const q = $('m-search').value.trim();
  const related = graph.relatedMeetings(focusId);
  let meetings = [focusD, ...related.slice(0, 6).map((r) => store.get(r.id)).filter(Boolean)];
  const matchIds = q ? new Set(searchResults(q).map((r) => r.d?.entry?.id).filter(Boolean)) : null;
  if (matchIds) meetings = meetings.filter((d) => matchIds.has(d.entry.id));
  const graphData = buildMeetingTopicGraph(meetings, { topicPrefix: 'm-topic:', participantPrefix: 'm-participant:', focusId, connectorQuery: q });
  const topics = graphData.nodes.filter((n) => n.type === 'topic').length;
  const participants = graphData.nodes.filter((n) => n.type === 'participant').length;
  const drilled = focusId !== current.entry.id;
  $('m-tabbody').innerHTML = `
    <div class="graph-head">
      <div><strong>Meeting graph</strong> <span class="owner">— ${drilled ? `focused on “${esc(focusD.rec.title || 'Untitled')}” · ` : ''}${meetings.length} meeting${meetings.length === 1 ? '' : 's'} · ${topics} topic${topics === 1 ? '' : 's'} · ${participants} participant${participants === 1 ? '' : 's'}${q ? ` · matching “${esc(q)}”` : ''}. Single-click a meeting to drill into it; double-click to open it.</span></div>
      ${drilled ? `<button class="btn" id="m-graph-back" type="button">↩ Back to “${esc(current.rec.title || 'this meeting')}”</button>` : ''}
      <div class="legend"><span class="lg"><i class="sw meeting"></i> Meeting</span><span class="lg"><i class="sw topic"></i> Topic</span><span class="lg"><i class="sw participant"></i> Participant</span></div>
    </div>
    <div class="graph-host big" id="m-meetinggraph"></div>`;
  if (drilled) $('m-graph-back').onclick = () => { topicGraphFocus = null; renderTopicGraph(); };
  drawGraph(
    $('m-meetinggraph'), graphData.nodes, graphData.links,
    (n) => { // single tap → drill into a meeting / filter by a topic
      if (n.type === 'meeting') { topicGraphFocus = n.id; renderTopicGraph(); }
      else searchTopic(n.label);
    },
    (n) => { // double tap → open the object
      if (n.type === 'meeting') select(n.id);
      else searchTopic(n.label);
    },
  );
}

function renderParticipants() {
  const rows = participantRowsOfMeeting(current.rec);
  const list = rows.length
    ? `<ul class="participant-list">${rows.map((p) => `<li>
        <span class="avatar">${esc((p.initials || p.name.slice(0, 2)).toUpperCase())}</span>
        <span><strong>${esc(p.name)}</strong>${p.role ? ` <span class="owner">— ${esc(p.role)}</span>` : ''}</span>
      </li>`).join('')}</ul>`
    : '<div class="tile-empty">No participants captured for this meeting.</div>';

  $('m-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>${icon('users')} Participants</h3>${list}</div>
    </div>`;
}

function linkifyText(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

function highlightText(text, query) {
  if (!query) return linkifyText(text);
  const safe = esc(text);
  return safe.replace(new RegExp(`(${reEsc(esc(query))})`, 'ig'), '<mark>$1</mark>');
}

function transcriptSection(title, rows, query) {
  const shown = query ? rows.filter((row) => row.search.toLowerCase().includes(query)) : rows;
  if (!shown.length) return '';
  return `
    <div class="transcript-section-title">${esc(title)}</div>
    ${shown.map((row) => row.html(query)).join('')}`;
}

function renderTranscript() {
  const segs = current.rec.segments || [];
  const chats = current.rec.chat || [];
  const participants = current.rec.participants || [];
  const body = $('m-tabbody');
  if (!segs.length && !chats.length && !participants.length) { body.innerHTML = '<div class="tile-empty">No transcript captured for this meeting.</div>'; return; }
  body.innerHTML = `<input id="m-tsearch" class="tsearch" type="search" placeholder="Search transcript…" /><div class="transcript" id="m-tlines"></div>`;
  const paint = (q = '') => {
    const ql = q.trim().toLowerCase();
    const transcriptRows = segs.map((s) => ({
      search: `${s.speaker || ''} ${s.text || ''}`,
      html: (query) => {
      const time = esc(new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const spk = (s.speaker || '').trim();
      const spHtml = isImg(spk) ? `<img class="av" src="${esc(spk)}" alt="" loading="lazy" />` : `<span class="sp">${esc(spk)}</span>`;
      const tt = (s.text || '').trim();
      let bodyHtml;
      if (isImg(tt)) bodyHtml = `<a class="tline-imglink" href="${esc(tt)}" target="_blank" rel="noopener"><img class="tline-img" src="${esc(tt)}" alt="shared image" loading="lazy" /></a>`;
      else bodyHtml = `<span class="ttext">${highlightText(s.text || '', query)}</span>`;
      return `<div class="tline"><span class="ts">${time}</span>${spHtml}${bodyHtml}</div>`;
      },
    }));
    const chatRows = chats.map((c) => ({
      search: `${c.sender || ''} ${c.receiver || ''} ${c.text || ''}`,
      html: (query) => `<div class="tline chat-line">
        <span class="ts">${esc(new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
        <span class="sp">${esc(c.sender || 'Chat')} → ${esc(c.receiver || 'Everyone')}</span>
        <span class="ttext">${highlightText(c.text || '', query)}</span>
      </div>`,
    }));
    const participantRows = participants.map((p) => ({
      search: `${p.name || ''} ${p.role || ''} ${p.initials || ''}`,
      html: () => `<div class="tline participant-line">
        <span class="ts"></span>
        <span class="sp">${p.initials ? esc(p.initials) : icon('users')}</span>
        <span class="ttext">${esc(p.name || '')}${p.role ? ` <span class="owner">— ${esc(p.role)}</span>` : ''}</span>
      </div>`,
    }));
    const html = [
      transcriptSection('Transcript', transcriptRows, ql),
      transcriptSection('Chat', chatRows, ql),
      transcriptSection('Participants', participantRows, ql),
    ].filter(Boolean).join('');
    $('m-tlines').innerHTML = html || '<div class="tile-empty">No matching lines.</div>';
    $('m-tlines').querySelectorAll('img.av').forEach((img) => (img.onerror = () => { const x = document.createElement('span'); x.className = 'sp'; x.innerHTML = icon('user'); img.replaceWith(x); }));
    $('m-tlines').querySelectorAll('img.tline-img').forEach((img) => (img.onerror = () => { const x = document.createElement('span'); x.className = 'img-chip'; x.innerHTML = icon('image') + ' image'; (img.closest('.tline-imglink') || img).replaceWith(x); }));
  };
  $('m-tsearch').oninput = (e) => paint(e.target.value);
  paint();
}

function showGraphView() {
  inGraph = true;
  $('m-empty').classList.add('hidden');
  $('m-content').classList.add('hidden');
  const host = $('m-graph'); host.classList.remove('hidden');
  const previousGraph = $('m-biggraph');
  if (previousGraph?._stop) previousGraph._stop();
  // Reflect the current search/mode: graph only the matching meetings (+ their topics).
  const q = $('m-search').value.trim();
  const allMeetings = searchResults(q).map((r) => r.d);
  const meetings = allMeetings.slice(0, GRAPH_RENDER_LIMIT);
  if (!allMeetings.length) { host.innerHTML = `<div class="empty">${q ? 'No meetings match your search.' : 'No meetings to graph yet.'}</div>`; return; }
  const graphData = buildMeetingTopicGraph(meetings, { topicPrefix: 'm-topic:', participantPrefix: 'm-participant:', connectorQuery: q });
  const topics = graphData.nodes.filter((n) => n.type === 'topic').length;
  const participants = graphData.nodes.filter((n) => n.type === 'participant').length;
  const limited = allMeetings.length > meetings.length;
  host.innerHTML = `
    <div class="graph-head">
      <div><strong>Meeting graph</strong> <span class="owner">— ${meetings.length} meeting${meetings.length === 1 ? '' : 's'} graphed · ${topics} topic${topics === 1 ? '' : 's'} · ${participants} participant${participants === 1 ? '' : 's'}${limited ? ` · showing ${meetings.length} of ${allMeetings.length} matches` : ''}${q ? ` matching “${esc(q)}”` : ''}. Click a meeting to open it, a topic or participant to filter.</span></div>
      <div class="legend"><span class="lg"><i class="sw meeting"></i> Meeting</span><span class="lg"><i class="sw topic"></i> Topic</span><span class="lg"><i class="sw participant"></i> Participant</span></div>
    </div>
    <div class="graph-host big" id="m-biggraph"></div>`;
  const token = ++graphDrawToken;
  requestAnimationFrame(() => {
    if (token !== graphDrawToken) return;
    const graphHost = $('m-biggraph');
    if (!graphHost?.isConnected) return;
    drawGraph(
      graphHost, graphData.nodes, graphData.links,
      (n) => searchTopic(n.label),                                          // single → filter
      (n) => { if (n.type === 'meeting') select(n.id); else searchTopic(n.label); }, // double → open
    );
  });
}

function toggleGraph() {
  if (inGraph) {
    graphDrawToken += 1;
    const graphHost = $('m-biggraph');
    if (graphHost?._stop) graphHost._stop();
    inGraph = false; $('m-graph').classList.add('hidden'); if (current) renderDetail(); else $('m-empty').classList.remove('hidden');
  }
  else showGraphView();
  $('m-graph-toggle').classList.toggle('active', inGraph);
}

// --- actions ---------------------------------------------------------------
function searchTopic(topic) {
  mode = 'keyword';
  $('m-modes').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'keyword'));
  $('m-search').value = topic;
  renderList();
  if (inGraph) showGraphView();
  else if (current?.tab === 'topic-graph') renderTopicGraph();
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
  await chrome.storage.local.set({ 'chatpanel:attachMeetingId': id }).catch(() => {});
  try { if (winId != null) await chrome.sidePanel.open({ windowId: winId }); } catch { /* may already be open */ }
  chrome.runtime.sendMessage({ type: 'attach-meeting', id }).catch(() => {});
  toast('Meeting transcript attached — ask in ChatPanel');
}

function searchableMeetingText(rec, notes = '', people = peopleOf(rec), entry = {}) {
  const transcriptText = (rec.segments || []).map((s) => (isImg((s.text || '').trim()) ? '' : (s.text || ''))).join(' ');
  const chatText = (rec.chat || []).map((c) => `${c.sender || ''} ${c.receiver || ''} ${c.text || ''}`).join(' ');
  const peopleText = (people || []).join(' ');
  return [
    entry.title || '',
    rec.title || '',
    entry.meetingKey || rec.meetingKey || '',
    notes || '',
    peopleText,
    transcriptText,
    chatText,
  ].join('\n');
}

// --- generate insights (uses the configured ChatPanel agent/model) ---------
let insightDraftRenderTimer = null;

function newInsightDraft() {
  return {
    sections: Object.fromEntries(MEETING_INSIGHT_SECTIONS.map((section) => [
      section.id,
      { text: '', done: false, error: '' },
    ])),
  };
}

function scheduleInsightDraftRender(d) {
  if (current !== d || (current.tab || 'insights') !== 'insights') return;
  if (insightDraftRenderTimer) return;
  insightDraftRenderTimer = setTimeout(() => {
    insightDraftRenderTimer = null;
    if (current === d && d.insightDraft && (current.tab || 'insights') === 'insights') renderInsights();
  }, 80);
}

function sectionMaxTokens(agent, section) {
  const configured = Number(agent?.maxTokens);
  if (Number.isFinite(configured) && configured > 0) return Math.min(configured, section.maxTokens || configured);
  return section.maxTokens;
}

async function runMeetingInsightJob({ section, d, agent, settings, transcript }) {
  const slot = d.insightDraft.sections[section.id];
  let text = '';
  try {
    await streamChat({
      agent: {
        ...agent,
        systemPrompt: 'You extract one section of meeting notes. Follow the user prompt exactly.',
        temperature: 0.2,
        maxTokens: sectionMaxTokens(agent, section),
      },
      messages: [{ role: 'user', content: meetingInsightPrompt(section, transcript) }],
      settings,
      usage: { surface: 'meeting', sourceId: d?.id || d?.meetingId || null },
      onDelta: (delta) => {
        text += delta;
        slot.text = text;
        scheduleInsightDraftRender(d);
      },
      onEvent: () => {},
    });
    slot.text = text.trim();
    slot.done = true;
    scheduleInsightDraftRender(d);
    return { id: section.id, text: slot.text };
  } catch (e) {
    slot.error = e?.message || String(e);
    scheduleInsightDraftRender(d);
    throw e;
  }
}

function refreshDoc(d) {
  d.people = peopleOf(d.rec);
  d.text = searchableMeetingText(d.rec, d.notes, d.people, d.entry);
  const topicDisplay = topicDisplayForMeetingSource(null, d.notes, d.text, 10);
  d.terms = topicDisplay.items;
  d.topicFallback = topicDisplay.fallback;
  d.topicSource = topicDisplay.source;
  d.parsed = parseNotes(d.notes);
}

async function generateInsights(d) {
  if (!d) return;
  const settings = await getSettings();
  const agent = getTarget(settings, settings.activeAgentId);
  if (!agent) { toast('No active model/agent — configure one in Settings → API/Agents.'); return; }
  const gen = $('m-gen');
  if (gen) { gen.disabled = true; gen.innerHTML = icon('sparkles') + ' Generating…'; }
  d.insightDraft = newInsightDraft();
  if (current === d) renderInsights();
  toast('Generating insight sections in parallel…');
  const transcript = meetingToText(d.rec);
  const jobs = MEETING_INSIGHT_SECTIONS.map((section) => runMeetingInsightJob({ section, d, agent, settings, transcript }));
  const results = await Promise.allSettled(jobs);
  const parts = {};
  results.forEach((result) => {
    if (result.status === 'fulfilled') parts[result.value.id] = result.value.text;
  });
  const notes = composeMeetingInsightNotes(parts);
  const successCount = Object.values(parts).filter((value) => String(value || '').trim()).length;
  const errorCount = results.filter((result) => result.status === 'rejected').length;
  if (!successCount) {
    delete d.insightDraft;
    if (gen) { gen.disabled = false; gen.innerHTML = icon('sparkles') + ' ' + (d.parsed.hasAny ? 'Regenerate' : 'Generate insights'); }
    if (current === d) renderDetail();
    toast(errorCount ? 'Couldn’t generate insights.' : 'No insights returned by the model.');
    return;
  }
  d.notes = notes;
  await saveMeetingNotes(d.entry.id, d.notes).catch(() => {});
  const insightTopics = insightTopicItemsFromNotes(d.notes, 10);
  if (insightTopics.length) {
    const topicText = topicSourceTextForMeeting(d.rec, d.notes);
    await saveMeetingTopics(d.entry.id, makeTopicIndex({
      hash: contentHash(topicText),
      targetId: 'insights',
      items: insightTopics,
      fallback: false,
    })).catch(() => {});
  }
  delete d.insightDraft;
  refreshDoc(d);
  rebuildIndexes();          // related insights / graph reflect the new notes
  if (current === d) renderDetail();
  renderList();
  toast(errorCount ? `Insights saved (${errorCount} section${errorCount === 1 ? '' : 's'} failed).` : 'Insights generated.');
}

// --- import existing transcripts (.md / .txt) ------------------------------
async function importFiles(files) {
  let last = null;
  for (const file of [...files]) {
    let text = '';
    try { text = await file.text(); } catch { toast(`Couldn’t read ${file.name}`); continue; }
    const p = parseTranscriptText(text, file.name);
    if (!p.segments.length && !p.chat.length && !p.participants.length) { toast(`No transcript lines found in ${file.name}`); continue; }
    const id = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const rec = { id, platform: 'imported', meetingKey: 'import:' + id, title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, status: 'ended', segments: p.segments, chat: p.chat, participants: p.participants };
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
  graph = buildGraph(ds.map((d) => ({ id: d.entry.id, title: d.rec.title, platform: d.rec.platform, startedAt: d.rec.startedAt, people: graphParticipantNames(d), terms: graphTopicTerms(d) })));
}

function showProGate() {
  $('m-count').textContent = '';
  ['m-import', 'm-graph-toggle'].forEach((id) => $(id)?.classList.add('hidden'));
  document.querySelector('.layout').innerHTML = `
    <div class="progate">
      <div class="progate-card">
        <div class="progate-ic">${icon('calendar')}${icon('sparkles')}</div>
        <h2>Meetings is a Pro feature</h2>
        <p>The live meeting scribe and this dashboard — transcripts, AI summaries, action items, search and the relationship graph — are part of ChatPanel Pro.</p>
        <button class="btn primary" id="m-upgrade">${icon('sparkles')} Upgrade to Pro</button>
      </div>
    </div>`;
  // Open the pricing page carrying this install's id (so checkout seats THIS
  // device) and poll; reload to reveal the dashboard the moment Pro activates.
  const up = document.getElementById('m-upgrade');
  if (up) up.onclick = () => subscribe('pro', { onActivated: () => location.reload() });
}

async function boot() {
  const license = await getLicense();
  if (!can(license, 'liveMeetings')) { showProGate(); return; }
  try { winId = (await chrome.windows.getCurrent()).id; } catch { /* ok */ }
  index = await getMeetingIndex();
  await Promise.all(index.map(async (e) => {
    const rec = await getMeeting(e.id); if (!rec) return;
    if (repairTranscriptParticipants(rec) || repairImportedTranscriptDate(rec)) {
      await persistMeeting(rec).catch(() => {});
    }
    const notes = await getMeetingNotes(e.id).catch(() => '');
    const people = peopleOf(rec);
    const text = searchableMeetingText(rec, notes, people, e);
    const savedTopics = await getMeetingTopics(e.id).catch(() => null);
    const topicDisplay = topicDisplayForMeetingSource(savedTopics, notes, text, 10);
    const terms = topicDisplay.items;
    store.set(e.id, { entry: e, rec, notes, parsed: parseNotes(notes), people, terms, topicFallback: topicDisplay.fallback, topicSource: topicDisplay.source, text });
  }));
  rebuildIndexes();
  renderList();

  $('m-items').addEventListener('click', (e) => { const it = e.target.closest('.mitem'); if (it?.dataset.id) select(it.dataset.id); });
  $('m-search').oninput = () => { renderList(); if (inGraph) showGraphView(); else if (current?.tab === 'topic-graph') renderTopicGraph(); };
  $('m-modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    mode = b.dataset.mode;
    $('m-modes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderList(); if (inGraph) showGraphView(); else if (current?.tab === 'topic-graph') renderTopicGraph();
  });
  $('m-graph-toggle').onclick = toggleGraph;
  $('m-import').onclick = () => $('m-import-file').click();
  $('m-import-file').onchange = (e) => { const fs = e.target.files; if (fs && fs.length) importFiles(fs); e.target.value = ''; };
  $('m-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#meetings') });

  const initialView = initialHistoryView(location.hash, 'meeting');
  if (initialView.view === 'meeting' && store.has(initialView.id)) {
    await select(initialView.id);
  } else {
    showGraphView();
    $('m-graph-toggle').classList.add('active');
  }
}
boot();
