// Full-page Chat-history dashboard — mirrors the Meetings dashboard for
// conversations: full-text search (BM25 "Best match", exact "Exact text"), the
// conversation thread, related chats, and a topic relationship graph.
// Reads the same local storage the side panel uses; nothing leaves the device.
import {
  getIndex, getConversation, deleteConversation, conversationToMarkdown,
  getSettings, getTarget,
} from './js/store.js';
import { buildIndex, bm25Search, buildGraph, tokenize } from './js/meeting-index.js';
import { drawGraph } from './js/graph-view.js';
import { initialHistoryView } from './js/history-state.js';
import { renderMarkdown } from './js/markdown.js';
import { topicDisplayForSource } from './js/topic-extraction.js';

const $ = (id) => document.getElementById(id);
const GRAPH_RENDER_LIMIT = 150;

let index = [];
const store = new Map();   // id -> { entry, conv, agent, terms, text }
let settings = null;
let bm25 = null;
let graph = null;          // topic-overlap graph for related chats
let current = null;        // selected store entry (+ .tab)
let mode = 'smart';        // smart | keyword
let inGraph = false;
let winId = null;          // this window — to open the side panel within a gesture
let graphDrawToken = 0;

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
function relatedReasonList(items, limit = 3) {
  const values = [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (values.length <= limit) return values.join(', ');
  return `${values.slice(0, limit).join(', ')} +${values.length - limit}`;
}
function relatedHistoryReason(r) {
  const parts = [];
  const topics = relatedReasonList(r.sharedTopics || []);
  const titleTerms = relatedReasonList(r.sharedTitleTerms || []);
  if (topics) parts.push(`shared topics: ${topics}`);
  if (titleTerms) parts.push(`similar title: ${titleTerms}`);
  return parts.join(' · ') || `relationship score ${r.weight || 0}`;
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
const docText = (entry, conv) => [
  entry?.title || '',
  conv.title || '',
  ...(conv.messages || []).map((m) => `${m.role === 'user' ? 'You' : (m.agentName || 'Assistant')}: ${m.content || ''}`),
].join('\n');

// --- assistant tool actions (mirror the side panel's "Actions" log) --------
const LABELED_TOOLS = new Set(['inspect_page', 'fill_form', 'fill_combobox', 'click_element', 'click_by_text', 'screenshot', 'marked_screenshot', 'click_mark', 'click_at', 'type_text', 'press_key', 'scroll', 'draw_path']);
function displayMcpServer(slug) {
  const s = String(slug || 'mcp').replace(/_/g, ' ');
  if (/^deepwiki$/i.test(s)) return 'DeepWiki';
  if (/^context7$/i.test(s)) return 'Context7';
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function stepLabel(s) {
  const i = s.input || {};
  switch (s.tool) {
    case 'inspect_page': return '🔍 Read the page';
    case 'fill_form': return `⌨️ Filled ${i.fields?.length || 0} field(s)`;
    case 'fill_combobox': return `⌨️ Typed “${String(i.value || '').slice(0, 40)}” → select`;
    case 'click_element': return `🖱️ Clicked ${String(i.selector || '').slice(0, 48)}`;
    case 'click_by_text': return `🖱️ Clicked “${String(i.text || '').slice(0, 40)}”`;
    case 'screenshot': return '📸 Took a screenshot';
    case 'marked_screenshot': return '🔢 Tagged clickable elements';
    case 'click_mark': return `🖱️ Clicked element #${i.n}`;
    case 'click_at': return `🖱️ Clicked at (${Math.round(i.x)}, ${Math.round(i.y)})`;
    case 'type_text': return `⌨️ Typed “${String(i.text || '').slice(0, 40)}”`;
    case 'press_key': return `⌨️ Pressed ${i.key}`;
    case 'scroll': return `🖱️ Scrolled ${i.dy > 0 ? 'down' : 'up'}`;
    default: { const m = /^mcp_(.+?)__(.+)$/.exec(s.tool || ''); return m ? `${displayMcpServer(m[1])} / ${m[2]}` : `🔧 ${s.tool}`; }
  }
}
function stepArgs(s) {
  if (LABELED_TOOLS.has(s.tool) || s.input == null) return '';
  const i = s.input;
  if (typeof i === 'object' && !Array.isArray(i)) {
    const rows = Object.entries(i).filter(([, v]) => v != null && v !== '').map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `<div class="step-arg"><span class="step-arg-key">${esc(k)}</span><span class="step-arg-val">${esc(val.length > 260 ? val.slice(0, 260) + '…' : val)}</span></div>`;
    }).join('');
    return rows ? `<div class="step-args-list">${rows}</div>` : '';
  }
  let str = typeof i === 'string' ? i : JSON.stringify(i);
  if (!str || str === '{}' || str === '""') return '';
  return `<div class="step-args">${esc(str.length > 220 ? str.slice(0, 220) + '…' : str)}</div>`;
}
function renderSteps(steps) {
  const items = steps.map((s) => {
    const m = /^mcp_(.+?)__(.+)$/.exec(s.tool || '');
    const head = m
      ? `<div class="step step-mcp"><span class="step-server">${esc(displayMcpServer(m[1]))}</span><span class="step-tool">${esc(m[2])}</span></div>`
      : `<div class="step">${esc(stepLabel(s))}</div>`;
    const status = s.status ? `<span class="step-status ${/error|fail|blocked/i.test(s.status) ? 'bad' : ''}">${esc(s.status)}</span>` : '';
    const shot = s.image ? `<img class="step-shot" src="${esc(s.image)}" alt="screenshot" loading="lazy" />` : '';
    return `${head}${status}${stepArgs(s)}${shot}`;
  }).join('');
  return `<details class="agent-steps"><summary>🔧 Actions (${steps.length})</summary><div class="steps-body">${items}</div></details>`;
}
function msgBody(m) {
  let html = '';
  if (m.steps?.length) html += renderSteps(m.steps);
  if (m.thinking) html += `<details class="thinking"><summary>💭 Thinking</summary><div class="thinking-body">${esc(m.thinking)}</div></details>`;
  html += m.content ? renderMarkdown(String(m.content)) : '';
  return html || '<span class="owner">(no text)</span>';
}

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
  graphDrawToken += 1;
  const graphHost = $('h-biggraph');
  if (graphHost?._stop) graphHost._stop();
  inGraph = false; $('h-graph').classList.add('hidden');
  $('h-graph-toggle').classList.remove('active');
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
      const att = (m.attachments || []).length ? `<div class="msg-att">${m.attachments.map((a) => `📎 ${esc(a.title || a.url || 'attachment')}`).join(' · ')}</div>` : '';
      return `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}"><div class="msg-role">${esc(who)}</div><div class="msg-body md">${msgBody(m)}${att}</div></div>`;
    }).join('') : '<div class="tile-empty">No matching messages.</div>';
  };
  $('h-tsearch').oninput = (e) => paint(e.target.value);
  paint();
}

function renderRelated() {
  const id = current.entry.id;
  const related = graph.relatedMeetings(id);
  const topics = current.terms || [];
  const topicTitle = current.topicFallback ? '# Suggested Topics' : '# Topics';
  const topicHint = current.topicFallback && topics.length
    ? '<p class="muted tiny">Local fallback from this chat. Saved model-extracted topics replace these after topic extraction runs.</p>'
    : '';
  const topicChips = topics.length
    ? `<div class="chips">${topics.map((t) => `<button class="chip" data-topic="${esc(t)}" type="button"># ${esc(t)}</button>`).join('')}</div>`
    : '<div class="tile-empty">No strong topics detected yet.</div>';
  const relatedList = related.length
    ? `<ul>${related.map((r) => {
        const d = store.get(r.id); if (!d) return '';
        return `<li class="rel" data-id="${esc(r.id)}"><span class="dot">↗</span><span><strong>${esc(d.conv.title || 'Untitled')}</strong>
          <span class="owner">— ${esc(relTime(d.entry.updatedAt))} · ${esc(relatedHistoryReason(r))}</span></span></li>`;
      }).join('')}</ul>`
    : '<div class="tile-empty">No related chats found yet.</div>';

  $('h-tabbody').innerHTML = `
    <div class="tiles">
      <div class="tile span"><h3>${topicTitle}</h3>${topicChips}${topicHint}</div>
      <div class="tile span"><h3>🔗 Related chats</h3>${relatedList}</div>
      <div class="tile span"><h3>🕸 Topic graph</h3><div class="graph-host" id="h-relgraph"></div></div>
    </div>`;
  $('h-tabbody').querySelectorAll('.chip[data-topic]').forEach((b) => (b.onclick = () => searchTopic(b.dataset.topic)));
  $('h-tabbody').querySelectorAll('.rel[data-id]').forEach((li) => (li.onclick = () => select(li.dataset.id)));

  const chats = [current, ...related.slice(0, 6).map((r) => store.get(r.id)).filter(Boolean)];
  const { nodes, links } = topicGraph(chats, 'h-topic:');
  if (nodes.some((n) => n.id === id)) nodes.find((n) => n.id === id).focus = true;
  drawGraph($('h-relgraph'), nodes, links, (nd) => { if (nd.type === 'meeting') select(nd.id); else searchTopic(nd.label); });
}

// --- global graph ----------------------------------------------------------
function topicGraph(items, prefix) {
  const nodes = [];
  const links = [];
  const topics = new Map();
  items.forEach((d) => {
    nodes.push({ id: d.entry.id, type: 'meeting', label: d.conv.title || 'Untitled' });
    (d.terms || []).slice(0, 6).forEach((t) => {
      if (!topics.has(t)) topics.set(t, []);
      topics.get(t).push(d.entry.id);
    });
  });
  for (const [topic, ids] of topics) {
    if (ids.length < 2 && items.length > 1) continue;
    const tid = `${prefix}${topic}`;
    nodes.push({ id: tid, type: 'person', label: topic });
    ids.forEach((id) => links.push({ s: id, t: tid }));
  }
  if (!links.length && items.length > 1) {
    items.slice(1).forEach((d) => links.push({ s: items[0].entry.id, t: d.entry.id }));
  }
  return { nodes, links };
}

function showGraphView() {
  inGraph = true;
  $('h-empty').classList.add('hidden');
  $('h-content').classList.add('hidden');
  const host = $('h-graph'); host.classList.remove('hidden');
  const previousGraph = $('h-biggraph');
  if (previousGraph?._stop) previousGraph._stop();
  // Reflect the current search/mode: graph only the matching chats (+ their topics).
  const q = $('h-search').value.trim();
  const allChats = searchResults(q).map((r) => r.d);
  const chats = allChats.slice(0, GRAPH_RENDER_LIMIT);
  if (!allChats.length) { host.innerHTML = `<div class="empty">${q ? 'No chats match your search.' : 'No chats to graph yet.'}</div>`; return; }
  const topics = new Set(chats.flatMap((d) => d.terms || []));
  const limited = allChats.length > chats.length;
  host.innerHTML = `
    <div class="graph-head">
      <div><strong>Topic graph</strong> <span class="owner">— ${chats.length} chat${chats.length === 1 ? '' : 's'} graphed · ${topics.size} topic${topics.size === 1 ? '' : 's'}${limited ? ` · showing ${chats.length} of ${allChats.length} matches` : ''}${q ? ` matching “${esc(q)}”` : ''}. Click a chat to open it, a topic to filter.</span></div>
      <div class="legend"><span class="lg"><i class="sw meeting"></i> Chat</span><span class="lg"><i class="sw person"></i> Topic</span></div>
    </div>
    <div class="graph-host big" id="h-biggraph"></div>`;
  const token = ++graphDrawToken;
  requestAnimationFrame(() => {
    if (token !== graphDrawToken) return;
    const graphHost = $('h-biggraph');
    if (!graphHost?.isConnected) return;
    const { nodes, links } = topicGraph(chats, 'h-topic:');
    drawGraph(graphHost, nodes, links, (nd) => { if (nd.type === 'meeting') select(nd.id); else searchTopic(nd.label); });
  });
}
function toggleGraph() {
  if (inGraph) {
    graphDrawToken += 1;
    const graphHost = $('h-biggraph');
    if (graphHost?._stop) graphHost._stop();
    inGraph = false; $('h-graph').classList.add('hidden'); if (current) renderDetail(); else $('h-empty').classList.remove('hidden');
  }
  else showGraphView();
  $('h-graph-toggle').classList.toggle('active', inGraph);
}

// --- actions ---------------------------------------------------------------
function searchTopic(topic) {
  mode = 'keyword';
  $('h-modes').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'keyword'));
  $('h-search').value = topic;
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
  const id = current.entry.id;
  // Fresh-open path: the side panel's init() reads this flag when it boots.
  await chrome.storage.local.set({ 'chatpanel:openConversationId': id }).catch(() => {});
  // Open the panel (no-op if already open) within the click gesture.
  try { if (winId != null) await chrome.sidePanel.open({ windowId: winId }); } catch { /* may already be open */ }
  // Already-open path: nudge the live panel to switch to this chat.
  chrome.runtime.sendMessage({ type: 'open-conversation', id }).catch(() => {});
  toast('Opening this chat in the side panel…');
}

// --- boot ------------------------------------------------------------------
function rebuildIndexes() {
  const ds = [...store.values()];
  bm25 = buildIndex(ds.map((d) => ({ id: d.entry.id, text: d.text })));
  graph = buildGraph(ds.map((d) => ({ id: d.entry.id, title: d.conv.title, startedAt: d.entry.updatedAt, people: [], terms: d.terms })));
}

async function boot() {
  try { winId = (await chrome.windows.getCurrent()).id; } catch { /* ok */ }
  settings = await getSettings();
  index = await getIndex();
  await Promise.all(index.map(async (e) => {
    const conv = await getConversation(e.id); if (!conv) return;
    const text = docText(e, conv);
    const topicDisplay = topicDisplayForSource(conv.topics, text, 10);
    store.set(e.id, { entry: e, conv, agent: agentLabel(conv), terms: topicDisplay.items, topicFallback: topicDisplay.fallback, text });
  }));
  rebuildIndexes();
  renderList();

  $('h-items').addEventListener('click', (e) => { const it = e.target.closest('.mitem'); if (it?.dataset.id) select(it.dataset.id); });
  $('h-search').oninput = () => { renderList(); if (inGraph) showGraphView(); };
  $('h-modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    mode = b.dataset.mode === 'keyword' ? 'keyword' : 'smart';
    $('h-modes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderList(); if (inGraph) showGraphView();
  });
  $('h-graph-toggle').onclick = toggleGraph;
  $('h-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });

  const initialView = initialHistoryView(location.hash);
  if (initialView.view === 'chat' && store.has(initialView.id)) {
    await select(initialView.id);
  } else {
    showGraphView();
    $('h-graph-toggle').classList.add('active');
  }
}
boot();
