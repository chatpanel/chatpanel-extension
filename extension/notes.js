// Notes dashboard — a calm, dependency-free markdown editor over store-notes.js.
// Live preview, autosave, a formatting toolbar and keyboard shortcuts. Designed with
// clean seams for the agent layer to come (autocomplete / suggestions / topic
// extraction / snippet capture) — those hook the same textarea + save path.

import {
  getNoteIndex, getNote, createNote, saveNote, deleteNote, noteToMarkdown,
} from './js/store-notes.js';
import { renderMarkdown } from './js/markdown.js';

const $ = (id) => document.getElementById(id);

// In-memory working set for the list (title + snippet + search) so the rail renders
// without decrypting on every keystroke. Refreshed on any change.
let notes = [];          // [{id,title,body,tags,createdAt,updatedAt}]
let currentId = null;
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
function snippetOf(body) {
  return String(body || '').replace(/^#{1,6}\s+.*$/m, '').replace(/[#*_`>\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}
let toastTimer = null;
function toast(msg) {
  const el = $('n-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ── data ──────────────────────────────────────────────────────────────────────
async function reload() {
  const index = await getNoteIndex();
  const out = [];
  for (const e of index) {
    const rec = await getNote(e.id);
    if (rec) out.push(rec);
  }
  notes = out; // already newest-first from the index
}

// ── list ─────────────────────────────────────────────────────────────────────
function renderList(query = '') {
  const q = query.trim().toLowerCase();
  const items = $('n-items');
  const filtered = q
    ? notes.filter((n) => (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q)))
    : notes;
  $('n-count').textContent = notes.length ? `· ${notes.length}` : '';
  $('n-empty-list').classList.toggle('hidden', notes.length > 0);
  items.innerHTML = '';
  for (const n of filtered) {
    const el = document.createElement('div');
    el.className = 'nitem' + (n.id === currentId ? ' active' : '');
    el.dataset.id = n.id;
    const tags = (n.tags || []).slice(0, 3).map((t) => `<span class="nitem-tag">#${escapeHtml(t)}</span>`).join(' ');
    el.innerHTML =
      `<div class="nitem-title">${highlight(n.title || 'Untitled note', q)}</div>` +
      `<div class="nitem-snippet">${highlight(snippetOf(n.body) || 'Empty note', q)}</div>` +
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

function updatePreview() {
  $('n-preview').innerHTML = renderMarkdown($('n-body').value);
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
    chip.querySelector('button').onclick = () => {
      const n = notes.find((x) => x.id === currentId);
      n.tags = (n.tags || []).filter((x) => x !== t);
      renderTags(n.tags);
      scheduleSave(true);
    };
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
    const n = notes.find((x) => x.id === currentId);
    if (val && n && !(n.tags || []).includes(val)) { n.tags = [...(n.tags || []), val]; scheduleSave(true); }
    renderTags(n?.tags || []);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') renderTags(notes.find((x) => x.id === currentId)?.tags || []); };
  input.onblur = commit;
}

function openNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  flushSave();
  currentId = id;
  $('n-blank').classList.add('hidden');
  $('n-editor').classList.remove('hidden');
  $('n-title').value = n.title || '';
  $('n-body').value = n.body || '';
  renderTags(n.tags || []);
  updatePreview();
  updateWordCount();
  $('n-when').textContent = n.updatedAt ? `Edited ${relTime(n.updatedAt)}` : '';
  setStatus('');
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  renderList($('n-search').value);
}

function setStatus(text, saved = false) {
  const el = $('n-status');
  el.textContent = text;
  el.classList.toggle('saved', saved);
}

// Debounced autosave. `immediate` (tags) saves without waiting for the keystroke lull.
function scheduleSave(immediate = false) {
  dirty = true;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, immediate ? 0 : 600);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !currentId) return;
  dirty = false;
  const n = notes.find((x) => x.id === currentId);
  if (!n) return;
  n.title = $('n-title').value;
  n.body = $('n-body').value;
  const saved = await saveNote({ id: n.id, title: n.title, body: n.body, tags: n.tags, createdAt: n.createdAt });
  Object.assign(n, saved); // pick up derived title + updatedAt
  // move to front (most-recently edited) without a full reload
  notes = [n, ...notes.filter((x) => x.id !== n.id)];
  $('n-when').textContent = `Edited ${relTime(n.updatedAt)}`;
  setStatus('Saved', true);
  renderList($('n-search').value);
}

// ── toolbar: wrap/insert markdown at the selection ──────────────────────────────
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
      return surroundLink(sel);
    }
    default: break;
  }
}
function surroundLink(text) {
  const ta = $('n-body');
  const [s, e] = [ta.selectionStart, ta.selectionEnd];
  ta.setRangeText(`[${text}](url)`, s, e, 'end');
  ta.focus();
  onBodyInput();
}

function onBodyInput() {
  const panes = $('n-panes');
  if (!panes.classList.contains('write')) updatePreview();
  updateWordCount();
  scheduleSave();
}

// ── actions ─────────────────────────────────────────────────────────────────
async function newNote() {
  flushSave();
  const rec = await createNote({ body: '' });
  notes = [rec, ...notes];
  openNote(rec.id);
  $('n-title').focus();
  renderList('');
}
async function removeCurrent() {
  const n = notes.find((x) => x.id === currentId);
  if (!n) return;
  if (!confirm(`Delete "${n.title || 'this note'}"? This can't be undone.`)) return;
  await deleteNote(n.id);
  notes = notes.filter((x) => x.id !== n.id);
  currentId = null;
  $('n-editor').classList.add('hidden');
  $('n-blank').classList.remove('hidden');
  history.replaceState(null, '', location.pathname);
  renderList($('n-search').value);
  toast('Note deleted');
}
function copyCurrent() {
  const n = notes.find((x) => x.id === currentId);
  if (!n) return;
  navigator.clipboard.writeText(noteToMarkdown(n)).then(() => toast('Copied as Markdown'), () => toast('Copy failed'));
}
function downloadCurrent() {
  const n = notes.find((x) => x.id === currentId);
  if (!n) return;
  const safe = (n.title || 'note').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 70) || 'note';
  const url = URL.createObjectURL(new Blob([noteToMarkdown(n)], { type: 'text/markdown' }));
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
  $('n-history').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  $('n-meetings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('meetings.html') });

  $('n-title').addEventListener('input', () => { updateWordCount(); scheduleSave(); });
  $('n-body').addEventListener('input', onBodyInput);
  $('n-search').addEventListener('input', (e) => renderList(e.target.value));

  for (const b of $('n-mode').children) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $('n-fmt').children) b.onclick = () => applyFmt(b.dataset.fmt);

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); newNote(); }
    else if (k === 'k') { e.preventDefault(); $('n-search').focus(); }
    else if (k === 's') { e.preventDefault(); flushSave(); toast('Saved'); }
    else if (k === 'b' && document.activeElement === $('n-body')) { e.preventDefault(); applyFmt('bold'); }
    else if (k === 'i' && document.activeElement === $('n-body')) { e.preventDefault(); applyFmt('italic'); }
  });
  // Never lose an edit on close.
  window.addEventListener('beforeunload', flushSave);

  setMode(localStorage.getItem('chatpanel.notes.mode') || 'write');
}

(async function start() {
  init();
  await reload();
  renderList('');
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId && notes.some((n) => n.id === hashId)) openNote(hashId);
  else if (notes.length) openNote(notes[0].id);
})();
