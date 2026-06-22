// Full-page Chat-history dashboard — mirrors the Meetings dashboard for
// conversations: full-text search (BM25 "Smart", exact "Keyword", "Agent"), the
// conversation thread, related chats, and a chat⇄agent relationship graph.
// Reads the same local storage the side panel uses; nothing leaves the device.
import {
  getIndex, getConversation, deleteConversation, conversationToMarkdown,
  getSettings, getTarget,
} from './js/store.js';
import { buildIndex, bm25Search, buildGraph, topTerms, tokenize } from './js/meeting-index.js';
import { drawGraph } from './js/graph-view.js';

const $ = (id) => document.getElementById(id);

let index = [];
const store = new Map();   // id -> { entry, conv, agent, terms, text }
let settings = null;
let bm25 = null;
let graph = null;          // chats ⇄ agents (agents modeled as "people")
let current = null;        // selected store entry (+ .tab)
let mode = 'smart';        // smart | keyword | agent
let inGraph = false;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function toast(msg) {
  const t = $('h-toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

function agentLabel(conv) {
  const fromMsg = conv.messages?.find((m) => m.role === 'assistant' && m.agentName)?.agentName;
  if (fromMsg) return fromMsg;
  const t = conv.agentId ? getTarget(settings, conv.agentId) : null;
  return t?.name || 'Assistant';
}
const docText = (conv) => [conv.title || '', ...(conv.messages || []).map((m) => `${m.role === 'user' ? 'You' : (m.agentName || 'Assistant')}: ${m.content || ''}`)].join('\n');

// --- search ----------------------------------------------------------------
function makeSnippet(d, terms) {
  const low = d.text.toLowerCase();
  let pos = -1;
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) return '';
  const start = Math.max(0, pos - 50);
  const seg = d.text.slice(start, start + 170).replace(/\s+/g, ' ').trim();
  let html = esc((start > 0 ? '…' : '') + seg + '…');
  for (const t of terms) if (t.length > 1) html = html.replace(new RegExp(`(${reEsc(t)})`, 'ig'), '<mark>$1</mark>');
  return html;
}
function searchResults(q) {
  const query = (q || '').trim();
  const byDate = (arr) => arr.sort((a, b) => (b.d.entry.updatedAt || 0) - (a.d.entry.updatedAt || 0));
  if (!query) return byDate([...store.values()].map((d) => ({ d })));
  if (mode === 'agent') {
    const ql = query.toLowerCase();
    return byDate([...store.values()].filter((d) => d.agent.toLowerCase().includes(ql)).map((d) => ({ d, agentMatch: true })));
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
  const results = searchResults($('h-search').value);
  $('h-count').textContent = index.length ? `· ${index.length} chats` : '';
  const host = $('h-items');
  if (!results.length) {
    host.innerHTML = `<div class="list-empty">${index.length ? 'No matches.' : 'No chats yet.'}</div>`;
    return;
  }
  host.innerHTML = results.map(({ d, snippet }) => {
    const e = d.entry;
    return `<div class="mitem${current && current.entry.id === e.id ? ' active' : ''}" data-id="${esc(e.id)}">
      <div class="t"><span>💬</span> ${esc(e.title || 'Untitled chat')}</div>
      <div class="meta"><span>${esc(d.agent)}</span><span>·</span><span>${esc(relTime(e.updatedAt))}</span><span class="pill">${e.msgs || (d.conv.messages || []).length} msgs</span></div>
      ${snippet ? `<div class="snip">${snippet}</div>` : ''}
    </div>`;
  }).join('');
}

// --- detail ----------------------------------------------------------------
async function select(id) {
  const d = store.get(id);
  if (!d) return;
  current = d; current.tab = current.tab || 'chat';
  inGraph = false; $('h-graph').classList.add('hidden');
  history.replaceState(null, '', '#' + id);
  renderList();
  renderDetail();
}

function renderDetail() {
  $('h-empty').classList.add('hidden');
  $('h-graph').classList.add('hidden');
  const c = $('h-content'); c.classList.remove('hidden');
  const { conv, agent } = current;
  const tab = current.tab || 'chat';
  const msgs = conv.messages || [];
  const youN = msgs.filter((m) => m.role === 'user').length;
  const aiN = msgs.filter((m) => m.role === 'assistant').length;
  const words = msgs.reduce((s, m) => s + String(m.content || '').split(/\s+/).filter(Boolean).length, 0);

  c.innerHTML = `
    <div class="dhead">
      <div>
        <h2>${esc(conv.title || 'Untitled chat')}</h2>
        <div class="sub">
          <span class="stat">🤖 ${esc(agent)}</span>
          <span class="stat">🗓 ${esc(fmtDate(conv.createdAt || current.entry.updatedAt))}</span>
          <span class="stat">🕘 ${esc(relTime(current.entry.updatedAt))}</span>
        </div>
      </div>
      <div class="dactions">
        <button class="btn" id="h-open" type="button">💬 Open in panel</button>
        <button class="btn" id="h-export" type="button">⬆ Export</button>
        <button class="btn danger" id="h-delete" type="button" title="Delete chat">🗑</button>
      </div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="n">${msgs.length}</div><div class="l">Messages</div></div>
      <div class="metric"><div class="n">${youN}</div><div class="l">Your turns</div></div>
      <div class="metric"><div class="n">${aiN}</div><div class="l">Agent turns</div></div>
      <div class="metric"><div class="n">${words}</div><div class="l">Words</div></div>
    </div>
    <div class="tabs">
      <button data-tab="chat" class="${tab === 'chat' ? 'active' : ''}" type="button">Conversation</button>
      <button data-tab="related" class="${tab === 'related' ? 'active' : ''}" type="button">Related</button>
    </div>
    <div id="h-tabbody"></div>`;

  c.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { current.tab = b.dataset.tab; renderDetail(); }));
  $('h-open').onclick = openInPanel;
  $('h-export').onclick = exportChat;
  $('h-delete').onclick = removeChat;
  if (tab === 'related') renderRelated(); else renderThread();
}

function renderThread() {
  const msgs = current.conv.messages || [];
  const body = $('h-tabbody');
  if (!msgs.length) { body.innerHTML = '<div class="tile-empty">This chat has no messages.</div>'; return; }
  body.innerHTML = `<input id="h-tsearch" class="tsearch" type="search" placeholder="Search this conversation…" /><div class="thread" id="h-thread"></div>`;
  const paint = (q = '') => {
    const ql = q.trim().toLowerCase();
    const rows = msgs.filter((m) => !ql || String(m.content || '').toLowerCase().includes(ql));
    $('h-thread').innerHTML = rows.length ? rows.map((m) => {
      const who = m.role === 'user' ? 'You' : (m.agentName || current.agent || 'Assistant');
      let txt = esc(String(m.content || ''));
      if (ql) txt = txt.replace(new RegExp(`(${reEsc(ql)})`, 'ig'), '<mark>$1</mark>');
      txt = txt.replace(/\n/g, '<br>');
      const att = (m.attachments || []).length ? `<div class="msg-att">${m.attachments.map((a) => `📎 ${esc(a.title || a.url || 'attachment')}`).join(' · ')}</div>` : '';
      return `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}"><div class="msg-role">${esc(who)}</div><div class="msg-body">${txt}${att}</div></div>`;
    }).join('') : '<div class="tile-empty">No matching messages.</div>';
  };
  $('h-tsearch').oninput = (e) => paint(e.target.value);
  paint();
}

function renderRelated() {
  const id = current.entry.id;
  const related = graph.relatedMeetings(id);
  const relatedList = related.length
    ? `<ul>${related.map((r) => {
        const d = store.get(r.id); if (!d) return '';
        const shared = r.sharedPeople.length ? `shares ${esc(r.sharedPeople.join(', '))}` : 'shared topics';
        return `<li class="rel" data-id="${esc(r.id)}"><span class="dot">↗</span><span><strong>${esc(d.conv.title || 'Untitled')}</strong>
          <span class="owner">— ${esc(relTime(d.entry.updatedAt))} · ${shared}</span></span></li>`;
      }).join('')}</ul>`
    : '<div class="tile-empty">No related chats found yet.</div>';

  $('h-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>🤖 Agent</h3><div class="chips"><button class="chip" data-agent="${esc(current.agent)}" type="button">🤖 ${esc(current.agent)}</button></div></div>
      <div class="tile span"><h3>🔗 Related chats</h3>${relatedList}</div>
      <div class="tile span"><h3>🕸 Relationship graph</h3><div class="graph-host" id="h-relgraph"></div></div>
    </div>`;
  $('h-tabbody').querySelectorAll('.chip[data-agent]').forEach((b) => (b.onclick = () => searchAgent(b.dataset.agent)));
  $('h-tabbody').querySelectorAll('.rel[data-id]').forEach((li) => (li.onclick = () => select(li.dataset.id)));

  const nodes = [{ id, type: 'meeting', label: current.conv.title || 'This chat', focus: true }, { id: 'a:' + current.agent, type: 'person', label: current.agent }];
  const links = [{ s: id, t: 'a:' + current.agent }];
  related.slice(0, 6).forEach((r) => {
    const d = store.get(r.id); if (!d) return;
    nodes.push({ id: r.id, type: 'meeting', label: d.conv.title || 'Untitled' });
    if (d.agent === current.agent) links.push({ s: r.id, t: 'a:' + current.agent });
    else links.push({ s: id, t: r.id });
  });
  drawGraph($('h-relgraph'), nodes, links, (nd) => { if (nd.type === 'meeting') select(nd.id); else searchAgent(nd.label); });
}

// --- global graph ----------------------------------------------------------
function showGraphView() {
  inGraph = true;
  $('h-empty').classList.add('hidden');
  $('h-content').classList.add('hidden');
  const host = $('h-graph'); host.classList.remove('hidden');
  // Reflect the current search/mode: graph only the matching chats (+ their agents).
  const q = $('h-search').value.trim();
  const chats = searchResults(q).map((r) => r.d);
  if (!chats.length) { host.innerHTML = `<div class="empty">${q ? 'No chats match your search.' : 'No chats to graph yet.'}</div>`; return; }
  const agents = new Set(chats.map((d) => d.agent));
  host.innerHTML = `
    <div class="graph-head">
      <div><strong>Relationship graph</strong> <span class="owner">— ${chats.length} chat${chats.length === 1 ? '' : 's'} · ${agents.size} agent${agents.size === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}. Click a chat to open it, an agent to filter.</span></div>
      <div class="legend"><span class="lg"><i class="sw meeting"></i> Chat</span><span class="lg"><i class="sw person"></i> Agent</span></div>
    </div>
    <div class="graph-host big" id="h-biggraph"></div>`;
  const nodes = []; const links = [];
  chats.forEach((d) => nodes.push({ id: d.entry.id, type: 'meeting', label: d.conv.title || 'Untitled' }));
  agents.forEach((a) => nodes.push({ id: 'a:' + a, type: 'person', label: a }));
  chats.forEach((d) => links.push({ s: d.entry.id, t: 'a:' + d.agent }));
  drawGraph($('h-biggraph'), nodes, links, (nd) => { if (nd.type === 'meeting') select(nd.id); else searchAgent(nd.label); });
}
function toggleGraph() {
  if (inGraph) { inGraph = false; $('h-graph').classList.add('hidden'); if (current) renderDetail(); else $('h-empty').classList.remove('hidden'); }
  else showGraphView();
  $('h-graph-toggle').classList.toggle('active', inGraph);
}

// --- actions ---------------------------------------------------------------
function searchAgent(name) {
  mode = 'agent';
  $('h-modes').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'agent'));
  $('h-search').value = name;
  renderList();
  if (inGraph) showGraphView();
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportChat() {
  const { conv } = current;
  const safe = (conv.title || 'chat').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'chat';
  download(`${safe}.md`, conversationToMarkdown(conv));
}
async function removeChat() {
  if (!current) return;
  if (!confirm(`Delete “${current.conv.title || 'this chat'}”? This can't be undone.`)) return;
  const id = current.entry.id;
  await deleteConversation(id);
  store.delete(id);
  index = await getIndex();
  rebuildIndexes();
  current = null;
  history.replaceState(null, '', '#');
  $('h-content').classList.add('hidden');
  $('h-empty').classList.remove('hidden');
  renderList();
  toast('Chat deleted');
}
async function openInPanel() {
  if (!current) return;
  try {
    await chrome.storage.local.set({ 'chatpanel:openConversationId': current.entry.id });
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    toast('Opening this chat in the side panel…');
  } catch { toast('Open the ChatPanel side panel to continue this chat.'); }
}

// --- boot ------------------------------------------------------------------
function rebuildIndexes() {
  const ds = [...store.values()];
  bm25 = buildIndex(ds.map((d) => ({ id: d.entry.id, text: d.text })));
  graph = buildGraph(ds.map((d) => ({ id: d.entry.id, title: d.conv.title, startedAt: d.entry.updatedAt, people: [d.agent], terms: d.terms })));
}

async function boot() {
  settings = await getSettings();
  index = await getIndex();
  await Promise.all(index.map(async (e) => {
    const conv = await getConversation(e.id); if (!conv) return;
    const text = docText(conv);
    store.set(e.id, { entry: e, conv, agent: agentLabel(conv), terms: topTerms(text, 10), text });
  }));
  rebuildIndexes();
  renderList();

  $('h-items').addEventListener('click', (e) => { const it = e.target.closest('.mitem'); if (it?.dataset.id) select(it.dataset.id); });
  $('h-search').oninput = () => { renderList(); if (inGraph) showGraphView(); };
  $('h-modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    mode = b.dataset.mode;
    $('h-modes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderList(); if (inGraph) showGraphView();
  });
  $('h-graph-toggle').onclick = toggleGraph;
  $('h-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });

  const fromHash = (location.hash || '').replace('#', '');
  if (fromHash && store.has(fromHash)) await select(fromHash);
}
boot();
