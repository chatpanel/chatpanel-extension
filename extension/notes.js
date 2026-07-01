// Notes dashboard — a calm, dependency-free markdown editor over store-notes.js.
// Live preview, autosave, a formatting toolbar and keyboard shortcuts. Designed with
// clean seams for the agent layer to come (autocomplete / suggestions / topic
// extraction / snippet capture) — those hook the same textarea + save path.
//
// FAST LOAD: the list renders from the note INDEX alone (one decrypt) — each index
// entry carries a title + snippet. A full note body is decrypted only when opened.

import {
  getNoteIndex, getNote, createNote, saveNote, deleteNote, noteToMarkdown,
} from './js/store-notes.js';
import { renderMarkdown } from './js/markdown.js';

const $ = (id) => document.getElementById(id);

let list = [];          // index entries: {id,title,snippet,tags,createdAt,updatedAt,chars}
let current = null;     // the full record of the OPEN note (decrypted on demand)
let dirty = false;
let saveTimer = null;

// ── utilities ─────────────────────────────────────────────────────────────────
function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function highlight(text, q) {
  const t = escapeHtml(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return escapeHtml(text.slice(0, i)) + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>' + escapeHtml(text.slice(i + q.length));
}
let toastTimer = null;
function toast(msg) {
  const el = $('n-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ── list (index-only — no body decrypts) ────────────────────────────────────────
async function reloadIndex() {
  list = await getNoteIndex(); // already newest-first
}
function updateEntry(rec) {
  // Fold a just-saved record into the in-memory index and move it to the front.
  const entry = {
    id: rec.id, title: rec.title, snippet: snippetOf(rec.body),
    tags: rec.tags || [], createdAt: rec.createdAt, updatedAt: rec.updatedAt, chars: (rec.body || '').length,
  };
  list = [entry, ...list.filter((e) => e.id !== rec.id)];
}
function snippetOf(body) {
  const b = String(body || '');
  const nl = b.indexOf('\n');
  const rest = nl >= 0 ? b.slice(nl + 1) : '';
  return rest.replace(/[#*_`>~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}

function renderList(query = '') {
  const q = query.trim().toLowerCase();
  const items = $('n-items');
  const filtered = q
    ? list.filter((n) => (n.title || '').toLowerCase().includes(q) || (n.snippet || '').toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q)))
    : list;
  $('n-count').textContent = list.length ? `· ${list.length}` : '';
  $('n-empty-list').classList.toggle('hidden', list.length > 0);
  items.innerHTML = '';
  for (const n of filtered) {
    const el = document.createElement('div');
    el.className = 'nitem' + (current && n.id === current.id ? ' active' : '');
    const tags = (n.tags || []).slice(0, 3).map((t) => `<span class="nitem-tag">#${escapeHtml(t)}</span>`).join(' ');
    el.innerHTML =
      `<div class="nitem-title">${highlight(n.title || 'Untitled note', q)}</div>` +
      `<div class="nitem-snippet">${highlight(n.snippet || 'Empty note', q)}</div>` +
      `<div class="nitem-meta"><span>${relTime(n.updatedAt)}</span>${tags}</div>`;
    el.onclick = () => openNote(n.id);
    items.appendChild(el);
  }
}

// ── editor ───────────────────────────────────────────────────────────────────
function setMode(mode) {
  const panes = $('n-panes');
  panes.classList.remove('write', 'split', 'read');
  panes.classList.add(mode);
  for (const b of $('n-mode').children) b.classList.toggle('active', b.dataset.mode === mode);
  localStorage.setItem('chatpanel.notes.mode', mode);
  if (mode !== 'write') updatePreview();
  if (mode !== 'read') autoGrow();
}
function updatePreview() { $('n-preview').innerHTML = renderMarkdown($('n-body').value); }
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
  if (agentAbort) agentAbort.abort(); // stop any in-flight generation before switching
  await flushSave();
  current = preloaded || await getNote(id);
  if (!current) return;
  $('n-blank').classList.add('hidden');
  $('n-editor').classList.remove('hidden');
  $('n-title').value = current.title || '';
  $('n-body').value = current.body || '';
  renderTags(current.tags || []);
  suggestTags();
  updatePreview();
  updateWordCount();
  autoGrow();
  $('n-when').textContent = current.updatedAt ? `Edited ${relTime(current.updatedAt)}` : '';
  setStatus('');
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  renderList($('n-search').value);
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
  if (!dirty || !current) return;
  dirty = false;
  current.title = $('n-title').value;
  current.body = $('n-body').value;
  const saved = await saveNote({ id: current.id, title: current.title, body: current.body, tags: current.tags, createdAt: current.createdAt });
  Object.assign(current, saved); // pick up derived title + updatedAt
  updateEntry(current);
  $('n-when').textContent = `Edited ${relTime(current.updatedAt)}`;
  setStatus('Saved', true);
  renderList($('n-search').value);
}

// ── toolbar ─────────────────────────────────────────────────────────────────
function surround(before, after = before) {
  const ta = $('n-body');
  const [s, e] = [ta.selectionStart, ta.selectionEnd];
  const sel = ta.value.slice(s, e) || '';
  ta.setRangeText(before + sel + after, s, e, 'end');
  if (!sel) ta.selectionStart = ta.selectionEnd = s + before.length;
  ta.focus();
  onBodyInput();
}
function linePrefix(prefix) {
  const ta = $('n-body');
  const s = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
  ta.setRangeText(prefix, lineStart, lineStart, 'end');
  ta.focus();
  onBodyInput();
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
      const ta = $('n-body');
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'text';
      const [s, e] = [ta.selectionStart, ta.selectionEnd];
      ta.setRangeText(`[${sel}](url)`, s, e, 'end');
      ta.focus();
      return onBodyInput();
    }
    default: break;
  }
}
function onBodyInput() {
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  updateWordCount();
  scheduleSave();
  scheduleSuggest();
  maybeAutocomplete();
}

// ── agent beside you: local topic extraction → tag suggestions (no LLM) ──────────
const tagify = (s) => String(s).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
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

// ── actions ─────────────────────────────────────────────────────────────────
async function newNote() {
  await flushSave();
  const rec = await createNote({ body: '' });
  updateEntry(rec);
  openNote(rec.id, rec);
  $('n-title').focus();
}
async function removeCurrent() {
  if (!current) return;
  if (!confirm(`Delete "${current.title || 'this note'}"? This can't be undone.`)) return;
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
function copyCurrent() {
  if (!current) return;
  navigator.clipboard.writeText(noteToMarkdown(current)).then(() => toast('Copied as Markdown'), () => toast('Copy failed'));
}
function downloadCurrent() {
  if (!current) return;
  const safe = (current.title || 'note').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 70) || 'note';
  const url = URL.createObjectURL(new Blob([noteToMarkdown(current)], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${safe}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── agent actions (LLM) — everything model-related is LAZY-LOADED, so providers.js
//    and the store/license graph never touch the notes page load path ─────────────
let _agentDeps = null;
async function agentDeps() {
  if (_agentDeps) return _agentDeps;
  const [p, s, l] = await Promise.all([import('./js/providers.js'), import('./js/store.js'), import('./js/license.js')]);
  _agentDeps = { streamChat: p.streamChat, getSettings: s.getSettings, getTarget: s.getTarget, resolveTarget: s.resolveTarget, getLicense: l.getLicense, canUseAgent: l.canUseAgent };
  return _agentDeps;
}

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
  btn.textContent = busy ? '⏹ Stop' : '✨ Agent';
  $('n-body').readOnly = busy;
}
function closeAgentMenu() { $('n-agent-menu').classList.add('hidden'); }

async function runAgentAction(kind) {
  closeAgentMenu();
  if (!current || agentAbort) return;
  const spec = AGENT_SPECS[kind];
  const ta = $('n-body');
  const body = ta.value;
  const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
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
  const scroller = document.querySelector('.editor-scroll');
  const follow = kind === 'continue' || kind === 'summarize'; // appends → keep the tail in view
  const render = () => {
    if (current !== streamNote) return;
    ta.value = head + out + tail;
    autoGrow();
    if (!$('n-panes').classList.contains('write')) updatePreview();
    if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
  };
  try {
    await deps.streamChat({
      agent: { ...resolved, systemPrompt: spec.sys, maxTokens: spec.max, temperature: 0.5 },
      settings,
      signal: agentAbort.signal,
      messages: [{ role: 'user', content: target }],
      onDelta: (d) => { out += d; render(); },
    });
  } catch (e) {
    if (agentAbort?.signal.aborted) toast('Stopped');
    else toast(`Agent error: ${e?.message || e}`);
  } finally {
    const aborted = agentAbort?.signal.aborted;
    agentAbort = null;
    setAgentBusy(false);
    if (current === streamNote) {
      current.body = head + out + tail;
      updateWordCount();
      dirty = true;
      await flushSave();
      if (!aborted) setStatus('Saved', true);
    }
  }
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

const ac = { open: false, items: [], index: 0, range: null };
function closeAc() { ac.open = false; ac.range = null; $('n-ac').classList.add('hidden'); }

// The [[…]] link query under the cursor, or null.
function currentWikiQuery() {
  const ta = $('n-body');
  if (ta.selectionStart !== ta.selectionEnd) return null;
  const pos = ta.selectionStart;
  const upto = ta.value.slice(0, pos);
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
  const ctx = currentWikiQuery();
  if (!ctx) return closeAc();
  ac.range = ctx;
  const q = ctx.query.toLowerCase();
  const all = await linkTargets();
  if (!ac.range) return; // closed while awaiting
  ac.items = (q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all).slice(0, 8);
  ac.index = 0;
  renderAc();
}

function renderAc() {
  const el = $('n-ac');
  if (!ac.range) return closeAc();
  el.innerHTML = '';
  if (!ac.items.length) {
    el.innerHTML = '<div class="ac-empty">No match — keep typing to name a new link</div>';
  } else {
    ac.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'ac-item' + (i === ac.index ? ' sel' : '');
      d.innerHTML = `<span class="ac-badge ${it.type}">${it.type}</span><span class="ac-title">${escapeHtml(it.title)}</span>`;
      d.onmousedown = (e) => { e.preventDefault(); ac.index = i; acceptAc(); };
      el.appendChild(d);
    });
  }
  const { x, y } = caretXY($('n-body'));
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
  const ta = $('n-body');
  const it = ac.items[ac.index];
  const title = it ? it.title : ac.range.query; // allow a new (unmatched) link name too
  ta.setRangeText(title, ac.range.start, ac.range.end, 'end');
  const after = ac.range.start + title.length;
  ta.selectionStart = ta.selectionEnd = ta.value.slice(after, after + 2) === ']]' ? after + 2 : after;
  closeAc();
  onBodyInput();
}

// ── wire up ───────────────────────────────────────────────────────────────────
function init() {
  $('n-new').onclick = newNote;
  $('n-new2').onclick = newNote;
  $('n-new3').onclick = newNote;
  $('n-delete').onclick = removeCurrent;
  $('n-copy').onclick = copyCurrent;
  $('n-download').onclick = downloadCurrent;

  // Collapsible list rail → full-width editor. Persisted.
  const collapseBtn = $('n-collapse');
  const applyCollapsed = (c) => {
    $('n-layout').classList.toggle('rail-collapsed', c);
    collapseBtn.textContent = c ? '⇥' : '⇤';
    collapseBtn.title = c ? 'Show list' : 'Hide list (⌘\\)';
  };
  let collapsed = localStorage.getItem('chatpanel.notes.railCollapsed') === '1';
  applyCollapsed(collapsed);
  collapseBtn.onclick = () => { collapsed = !collapsed; localStorage.setItem('chatpanel.notes.railCollapsed', collapsed ? '1' : '0'); applyCollapsed(collapsed); };

  $('n-title').addEventListener('input', () => { updateWordCount(); scheduleSave(); });
  // Enter / ↓ in the title drops into the body (title is single-line).
  $('n-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      const b = $('n-body');
      b.focus();
      b.setSelectionRange(0, 0);
    }
  });
  $('n-body').addEventListener('input', onBodyInput);
  $('n-body').addEventListener('keydown', (e) => {
    const ta = $('n-body');
    // Dropdown navigation takes priority while open.
    if (ac.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveAc(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveAc(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return acceptAc(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeAc(); }
    }
    // Typing the second [ auto-closes to [[]] with the cursor inside → opens the picker.
    if (e.key === '[' && ta.selectionStart === ta.selectionEnd && ta.value[ta.selectionStart - 1] === '[') {
      e.preventDefault();
      const pos = ta.selectionStart;
      ta.setRangeText('[]]', pos, pos, 'end');
      ta.selectionStart = ta.selectionEnd = pos + 1;
      onBodyInput();
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
  $('n-body').addEventListener('blur', () => setTimeout(closeAc, 120)); // let a click land first
  $('n-search').addEventListener('input', (e) => renderList(e.target.value));

  for (const b of $('n-mode').children) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $('n-fmt').children) b.onclick = () => applyFmt(b.dataset.fmt);

  // Rendered-markdown links: external URLs carry the target in data-href (no live
  // href, to dodge Chrome's speculative preload), so open them via a click handler.
  $('n-preview').addEventListener('click', async (e) => {
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
  for (const b of $('n-agent-menu').querySelectorAll('button[data-act]')) b.onclick = () => runAgentAction(b.dataset.act);
  document.addEventListener('click', closeAgentMenu);

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); newNote(); }
    else if (k === 'k') { e.preventDefault(); $('n-search').focus(); }
    else if (k === 's') { e.preventDefault(); flushSave(); toast('Saved'); }
    else if (e.key === '\\') { e.preventDefault(); collapseBtn.click(); }
    else if (k === 'b' && document.activeElement === $('n-body')) { e.preventDefault(); applyFmt('bold'); }
    else if (k === 'i' && document.activeElement === $('n-body')) { e.preventDefault(); applyFmt('italic'); }
  });
  window.addEventListener('beforeunload', flushSave);

  // Keep the list fresh when notes change elsewhere (e.g. a web highlight → Inbox in
  // another tab). Debounced; refreshes only the LIST, never the open editor.
  let extRefreshTimer = null;
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith('chatpanel:note'))) return;
      clearTimeout(extRefreshTimer);
      extRefreshTimer = setTimeout(async () => { await reloadIndex(); renderList($('n-search').value); }, 400);
    });
  }

  setMode(localStorage.getItem('chatpanel.notes.mode') || 'write');
}

(async function start() {
  init();
  await reloadIndex();      // one decrypt (the index), not one-per-note
  renderList('');
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId && list.some((n) => n.id === hashId)) openNote(hashId);
  else if (list.length) openNote(list[0].id);
})();
