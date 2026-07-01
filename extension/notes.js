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
}
function updatePreview() { $('n-preview').innerHTML = renderMarkdown($('n-body').value); }
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
  if (!$('n-panes').classList.contains('write')) updatePreview();
  updateWordCount();
  scheduleSave();
  scheduleSuggest();
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
  $('n-body').addEventListener('input', onBodyInput);
  $('n-search').addEventListener('input', (e) => renderList(e.target.value));

  for (const b of $('n-mode').children) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $('n-fmt').children) b.onclick = () => applyFmt(b.dataset.fmt);

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
