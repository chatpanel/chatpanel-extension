// Full-page Meetings dashboard — visualizes every recorded meeting from the same
// encrypted storage the side panel uses. Insights are parsed from the saved
// notes markdown (TL;DR → Summary, Topics, Key Moments → badges, Action Items →
// checklist); no new model calls. Opened from the side panel and Settings.
import {
  getMeetingIndex, getMeeting, getMeetingNotes, saveMeetingNotes,
  deleteMeeting, meetingToMarkdown, PLATFORMS,
} from './js/store-meetings.js';

const $ = (id) => document.getElementById(id);
const PLATFORM_ICON = { zoom: '📹', meet: '📹', teams: '🟦', webex: '🟢' };

let index = [];
let current = null; // { entry, rec, notes, parsed, tab }

// --- helpers ---------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A transcript field that is just an image URL (Zoom/Meet/Teams avatars or shared
// images) — render as a small thumbnail/avatar instead of a giant unbreakable URL.
const isImg = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim())
  && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)|images\.zoom\.us|\/p\/v2\/|gravatar|avatar|googleusercontent|wbxcdn|teams\.(microsoft|live)/i.test(v);
const platIcon = (p) => PLATFORM_ICON[p] || '🎙';
const platLabel = (p) => PLATFORMS[p]?.label || p || 'Meeting';

function fmtDate(ts) { return ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
function fmtDateShort(ts) { return ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''; }
function fmtDuration(a, b) {
  if (!a || !b || b < a) return '';
  const min = Math.round((b - a) / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function toast(msg) {
  const t = $('m-toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
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

// Drop simple inline markdown (**bold**, _em_, `code`) for clean tile text.
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
    if (cur === 'summary') {
      summaryParts.push(isBullet(line) ? stripBullet(line) : line.trim());
    } else if (cur === 'topics') {
      if (isBullet(line)) out.topics.push(demd(stripBullet(line)));
    } else if (cur === 'moments') {
      if (isBullet(line)) { const b = badgeOf(stripBullet(line)); out.moments.push({ badge: b.badge, text: demd(b.text) }); }
    } else if (cur === 'actions') {
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
      } else if (isBullet(line)) {
        out.actions.push({ text: demd(stripBullet(line)), done: false, owner: '', due: '', lineIndex: idx });
      }
    }
  });
  out.summary = demd(summaryParts.join(' ').trim());
  out.hasAny = !!(out.summary || out.topics.length || out.moments.length || out.actions.length);
  return out;
}

// --- list ------------------------------------------------------------------
function renderList(query = '') {
  const q = query.trim().toLowerCase();
  const items = index
    .slice()
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .filter((e) => !q || `${e.title || ''} ${platLabel(e.platform)} ${fmtDate(e.startedAt)}`.toLowerCase().includes(q));
  $('m-count').textContent = index.length ? `· ${index.length} recorded` : '';
  const host = $('m-items');
  if (!items.length) {
    host.innerHTML = `<div class="list-empty">${index.length ? 'No meetings match.' : 'No meetings yet. Join a Zoom / Meet / Teams / Webex call with captions on and ChatPanel records the transcript.'}</div>`;
    return;
  }
  host.innerHTML = items.map((e) => {
    const live = e.status && e.status !== 'ended';
    const dur = live ? '<span class="pill live">● live</span>' : (fmtDuration(e.startedAt, e.endedAt) ? `<span class="pill">${esc(fmtDuration(e.startedAt, e.endedAt))}</span>` : '');
    return `<div class="mitem${current && current.entry.id === e.id ? ' active' : ''}" data-id="${esc(e.id)}">
      <div class="t"><span>${platIcon(e.platform)}</span> ${esc(e.title || 'Untitled meeting')}</div>
      <div class="meta"><span>${esc(platLabel(e.platform))}</span><span>·</span><span>${esc(fmtDateShort(e.startedAt))}</span>${dur}</div>
    </div>`;
  }).join('');
}

// --- detail ----------------------------------------------------------------
async function select(id) {
  const entry = index.find((e) => e.id === id);
  if (!entry) return;
  const rec = await getMeeting(id);
  if (!rec) { toast('Meeting not found'); return; }
  const notes = await getMeetingNotes(id).catch(() => '');
  current = { entry, rec, notes, parsed: parseNotes(notes), tab: 'insights' };
  history.replaceState(null, '', '#' + id);
  renderList($('m-search').value);
  renderDetail();
}

function speakerCount(rec) {
  const set = new Set((rec.segments || []).map((s) => s.speaker).filter(Boolean));
  return rec.participants?.length || set.size || 0;
}

function renderDetail() {
  $('m-empty').classList.add('hidden');
  const c = $('m-content'); c.classList.remove('hidden');
  const { rec, parsed, tab } = current;
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
        <button class="btn" id="m-ask" type="button">💬 Ask</button>
        <button class="btn" id="m-export" type="button">⬇ Export</button>
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
      <button data-tab="transcript" class="${tab === 'transcript' ? 'active' : ''}" type="button">Transcript</button>
    </div>
    <div id="m-tabbody"></div>`;

  c.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { current.tab = b.dataset.tab; renderDetail(); }));
  $('m-ask').onclick = askAboutMeeting;
  $('m-export').onclick = exportMeeting;
  $('m-delete').onclick = removeMeeting;
  if (tab === 'transcript') renderTranscript(); else renderInsights();
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

function renderTranscript() {
  const segs = current.rec.segments || [];
  const body = $('m-tabbody');
  if (!segs.length) { body.innerHTML = '<div class="tile-empty">No transcript captured for this meeting.</div>'; return; }
  body.innerHTML = `<input id="m-tsearch" class="tsearch" type="search" placeholder="Search transcript…" /><div class="transcript" id="m-tlines"></div>`;
  const paint = (q = '') => {
    const ql = q.trim().toLowerCase();
    // Image-URL segments aren't searchable text — keep them only when no query.
    const rows = segs.filter((s) => !ql || (!isImg((s.text || '').trim()) && (s.text || '').toLowerCase().includes(ql)));
    $('m-tlines').innerHTML = rows.length ? rows.map((s) => {
      const time = esc(new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const spk = (s.speaker || '').trim();
      const spHtml = isImg(spk) ? `<img class="av" src="${esc(spk)}" alt="" loading="lazy" />` : `<span class="sp">${esc(spk)}</span>`;
      const tt = (s.text || '').trim();
      let body;
      if (isImg(tt)) {
        body = `<a class="tline-imglink" href="${esc(tt)}" target="_blank" rel="noopener"><img class="tline-img" src="${esc(tt)}" alt="shared image" loading="lazy" /></a>`;
      } else {
        let txt = esc(s.text || '');
        if (ql) txt = txt.replace(new RegExp(`(${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
        body = `<span class="ttext">${txt}</span>`;
      }
      return `<div class="tline"><span class="ts">${time}</span>${spHtml}${body}</div>`;
    }).join('') : '<div class="tile-empty">No matching lines.</div>';
    // Broken/blocked images (Zoom avatars often need auth) → compact fallback. CSP
    // forbids inline onerror, so wire it here.
    $('m-tlines').querySelectorAll('img.av').forEach((img) => (img.onerror = () => {
      const s = document.createElement('span'); s.className = 'sp'; s.textContent = '👤'; img.replaceWith(s);
    }));
    $('m-tlines').querySelectorAll('img.tline-img').forEach((img) => (img.onerror = () => {
      const c = document.createElement('span'); c.className = 'img-chip'; c.textContent = '🖼 image';
      (img.closest('.tline-imglink') || img).replaceWith(c);
    }));
  };
  $('m-tsearch').oninput = (e) => paint(e.target.value);
  paint();
}

// --- actions ---------------------------------------------------------------
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
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
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
  await deleteMeeting(current.entry.id);
  index = await getMeetingIndex();
  current = null;
  history.replaceState(null, '', '#');
  $('m-content').classList.add('hidden');
  $('m-empty').classList.remove('hidden');
  renderList($('m-search').value);
  toast('Meeting deleted');
}

async function askAboutMeeting() {
  if (!current) return;
  try {
    await chrome.storage.local.set({ 'chatpanel:openMeetingId': current.entry.id });
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    toast('Opening this meeting in the side panel…');
  } catch {
    toast('Open the ChatPanel side panel, then pick this meeting to ask.');
  }
}

// --- boot ------------------------------------------------------------------
async function boot() {
  index = await getMeetingIndex();
  renderList();
  $('m-items').addEventListener('click', (e) => {
    const item = e.target.closest('.mitem');
    if (item && item.dataset.id) select(item.dataset.id);
  });
  $('m-search').oninput = (e) => renderList(e.target.value);
  $('m-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#meetings') });
  const fromHash = (location.hash || '').replace('#', '');
  if (fromHash && index.some((e) => e.id === fromHash)) await select(fromHash);
}
boot();
