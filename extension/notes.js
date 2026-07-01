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
    const running = noteJobs.has(n.id);
    el.className = 'nitem' + (current && n.id === current.id ? ' active' : '') + (running ? ' running' : '');
    const tags = (n.tags || []).slice(0, 3).map((t) => `<span class="nitem-tag">#${escapeHtml(t)}</span>`).join(' ');
    const runBadge = running ? '<span class="nitem-run" title="A note command is running…">⏳</span> ' : '';
    el.innerHTML =
      `<div class="nitem-title">${runBadge}${highlight(n.title || 'Untitled note', q)}</div>` +
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
  if (agentAbort) agentAbort.abort(); // stop any in-flight @agent generation before switching
  if (writerAbort) writerAbort.abort();
  clearGhost({ remove: true }); // strip any pending draft-ahead from the OLD note before it's flushed
  // @insert/@command jobs are deliberately NOT aborted here — they run in the
  // background keyed by note id and persist their result on completion.
  const outJob = current && noteJobs.get(current.id);
  if (outJob) {
    dirty = false;            // the job owns this note's body — don't flush the transient progress block
    await persistJobBody(outJob); // snapshot the partial output so a switch/reload loses nothing
  } else {
    await flushSave();
  }
  current = preloaded || await getNote(id);
  if (!current) return;
  $('n-blank').classList.add('hidden');
  $('n-editor').classList.remove('hidden');
  $('n-title').value = current.title || '';
  $('n-body').value = current.body || '';
  renderTags(current.tags || []);
  suggestTags();
  renderBacklinks(current.title);
  clearResearch(); // drop the previous note's research shelf (re-runs on the next typing pause)
  resetSwarmState(); // fresh note → the team starts idle
  lastQuestion = '';
  board.log = [];
  loadIntent(); // this note's saved intent → guides the swarm + shows in the strip
  updatePreview();
  updateWordCount();
  autoGrow();
  $('n-when').textContent = current.updatedAt ? `Edited ${relTime(current.updatedAt)}` : '';
  setStatus('');
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  const inJob = noteJobs.get(current.id);
  if (inJob) attachEditorToJob(inJob); // reopening a note with a running job re-attaches its live progress
  else $('n-body').readOnly = false;
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
  if (ghost) clearGhost({ remove: true }); // never persist an un-accepted draft-ahead
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
  if (ghostApplying) { autoGrow(); return; }     // our own ghost mutation — no autosave / swarm triggers
  if (ghost) { ghost = null; hideGhostHint(); }   // user edited around a pending ghost → drop the stale state
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  updateWordCount();
  scheduleSave();
  scheduleSuggest();
  maybeAutocomplete();
  scheduleCowriter();
  scheduleResearch();
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
// Notes that link TO the current one (via [[Title]]) — computed from the index, no
// body decrypts. Existing notes gain links the next time they're saved.
function renderBacklinks(title) {
  const el = $('n-backlinks');
  el.innerHTML = '';
  const t = (title || '').toLowerCase();
  const refs = t ? list.filter((e) => e.id !== current?.id && (e.links || []).some((l) => l.toLowerCase() === t)) : [];
  if (!refs.length) return;
  const lbl = document.createElement('div');
  lbl.className = 'backlinks-label';
  lbl.textContent = `↩ Linked from ${refs.length} note${refs.length === 1 ? '' : 's'}`;
  el.appendChild(lbl);
  for (const r of refs) {
    const b = document.createElement('button');
    b.className = 'backlink';
    b.innerHTML = `${escapeHtml(r.title || 'Untitled note')} <span class="bl-snip">${escapeHtml(r.snippet || '')}</span>`;
    b.onclick = () => openNote(r.id);
    el.appendChild(b);
  }
}

// Hand this note to the side-panel composer as context, then open the panel — the
// same handoff meetings use ("Ask about this meeting").
async function askAboutNote() {
  if (!current) return;
  await flushSave();
  await chrome.storage.local.set({ 'chatpanel:attachNoteId': current.id });
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    chrome.runtime.sendMessage({ type: 'attach-note', id: current.id }).catch(() => {}); // if already open
    toast('Opened ChatPanel — ask away');
  } catch {
    toast('Open the ChatPanel side panel to continue');
  }
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
  const [p, s, l, t] = await Promise.all([import('./js/providers.js'), import('./js/store.js'), import('./js/license.js'), import('./js/turn-tools.js')]);
  _agentDeps = {
    streamChat: p.streamChat, checkBridge: p.checkBridge,
    getSettings: s.getSettings, getTarget: s.getTarget, resolveTarget: s.resolveTarget,
    getLicense: l.getLicense, canUseAgent: l.canUseAgent,
    buildTurnTools: t.buildTurnTools, buildRedaction: t.buildRedaction,
  };
  return _agentDeps;
}

// ── model router bridge — appoint the right model to each swarm role ──────────────
// The router (cowriter-router.js) is pure/portable; this thin bridge normalizes the
// user's endpoints+agents into candidates and hands back a ready-to-stream agent per
// role. Cheap for the Editor's constant proofreading, stronger for Writer/Researcher.
const SWARM_ROLES = {
  editor: { id: 'editor', prefer: 'cheap' },
  researcher: { id: 'researcher', prefer: 'balanced' },
  writer: { id: 'writer', prefer: 'strong' },
};
let _router = null;
function swarmOverrides() {
  try { return JSON.parse(localStorage.getItem('chatpanel.notes.cowriter.roles') || '{}'); } catch { return {}; }
}
function candidateModel(ag, settings) {
  return ag.model || (ag.endpointId && (settings.endpoints || []).find((e) => e.id === ag.endpointId)?.model) || ag.bridgeAgent || '';
}
function swarmCandidates(deps, settings, license) {
  const out = [];
  for (const ep of settings.endpoints || []) {
    if (ep?.model) out.push({ id: ep.id, name: ep.name || ep.model, kind: ep.kind || 'openai', model: ep.model, usable: deps.canUseAgent(license, settings, ep) });
  }
  for (const ag of settings.agents || []) {
    const model = candidateModel(ag, settings);
    if (!model) continue;
    out.push({ id: ag.id, name: ag.name || ag.bridgeAgent || model, kind: ag.kind || 'bridge', bridgeAgent: ag.bridgeAgent, model, usable: deps.canUseAgent(license, settings, ag) });
  }
  return out;
}
// → { resolved, mode, label } for a role, or null. Falls back to the active agent so a
// single-model user still gets every co-writer.
async function roleAgent(deps, settings, license, roleId) {
  if (!_router) _router = await import('./js/cowriter-router.js');
  const appt = _router.appoint(SWARM_ROLES[roleId], swarmCandidates(deps, settings, license), { overrides: swarmOverrides() });
  const target = appt ? deps.getTarget(settings, appt.id) : deps.getTarget(settings, settings.activeAgentId);
  if (!target || !deps.canUseAgent(license, settings, target)) return null;
  return { resolved: deps.resolveTarget(target, settings), mode: appt?.mode || 'api', label: target.name || appt?.model || '' };
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
    ta.value = head + (out || '⏳ thinking…') + tail;
    autoGrow();
    if (!$('n-panes').classList.contains('write')) updatePreview();
    if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
  };
  render(); // show the placeholder immediately so it's clear something is happening
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
      const finalBody = out.trim() ? head + out + tail : body; // nothing produced → restore original
      ta.value = finalBody;
      current.body = finalBody;
      autoGrow();
      if (!$('n-panes').classList.contains('write')) updatePreview();
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

const ac = { open: false, mode: 'link', items: [], index: 0, range: null };
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
  // [[ document links (deterministic)
  const link = currentWikiQuery();
  if (link) {
    ac.mode = 'link';
    ac.range = link;
    const q = link.query.toLowerCase();
    const all = await linkTargets();
    if (ac.mode !== 'link' || !ac.range) return;
    ac.items = (q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all).slice(0, 8);
    ac.index = 0;
    return renderAc();
  }
  // @ AI commands
  const at = currentAtQuery();
  if (at) {
    ac.mode = 'cmd';
    ac.range = at;
    const q = at.word.toLowerCase();
    ac.items = NOTE_COMMANDS.filter((c) => c.cmd.startsWith(q) || c.label.toLowerCase().startsWith(q)).slice(0, 8);
    ac.index = 0;
    return renderAc();
  }
  closeAc();
}

function renderAc() {
  const el = $('n-ac');
  if (!ac.range) return closeAc();
  el.innerHTML = '';
  if (!ac.items.length) {
    if (ac.mode === 'cmd') return closeAc();
    el.innerHTML = '<div class="ac-empty">No match — keep typing to name a new link</div>';
  } else {
    ac.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'ac-item' + (i === ac.index ? ' sel' : '');
      d.innerHTML = ac.mode === 'cmd'
        ? `<span class="ac-badge cmd">@${it.cmd}</span><span class="ac-title">${escapeHtml(it.hint)}</span>`
        : `<span class="ac-badge ${it.type}">${it.type}</span><span class="ac-title">${escapeHtml(it.title)}</span>`;
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
  if (ac.mode === 'cmd') {
    if (!it) return closeAc();
    // Replace the typed "@word" (the @ is at start-1) with "@cmd " and keep typing.
    ta.setRangeText(`@${it.cmd} `, ac.range.start - 1, ac.range.end, 'end');
    closeAc();
    onBodyInput();
    return;
  }
  const title = it ? it.title : ac.range.query; // allow a new (unmatched) link name too
  ta.setRangeText(title, ac.range.start, ac.range.end, 'end');
  const after = ac.range.start + title.length;
  ta.selectionStart = ta.selectionEnd = ta.value.slice(after, after + 2) === ']]' ? after + 2 : after;
  closeAc();
  onBodyInput();
}

// ── @ commands — AI actions that generate/fetch and insert inline ────────────────
// Slice 1: a built-in set. Slice 2 will surface user Skills flagged "available in
// Notes". Commands with tools:true can fetch live data via web search.
const NOTE_COMMANDS = [
  { cmd: 'insert', label: 'Insert', hint: 'generate or fetch, then insert', tools: true, sys: 'You insert content into the user\'s note. Follow the instruction. If it needs current, live, or web data, USE the web_search tool to fetch it — never guess or use stale knowledge. Output ONLY the content to insert as clean GitHub-flavored markdown — no preamble, no closing remarks.' },
  { cmd: 'table', label: 'Table', hint: 'produce a markdown table', tools: true, sys: 'Produce the requested data as a GitHub-flavored markdown table. If it needs live/current data, USE the web_search tool. Output ONLY the table.' },
  { cmd: 'list', label: 'List', hint: 'produce a bullet/task list', tools: true, sys: 'Produce the requested content as a GitHub-flavored markdown list (use - [ ] for actionable tasks). Use web_search for live data. Output ONLY the list.' },
  { cmd: 'summarize', label: 'Summarize', hint: 'summarize a topic', tools: false, sys: 'Summarize the requested topic concisely in markdown. Output ONLY the summary.' },
  { cmd: 'translate', label: 'Translate', hint: 'translate to a language', tools: false, sys: 'Translate the requested text to the requested language, preserving markdown. Output ONLY the translation.' },
];
// Matches @command anywhere on the line (not just at the start) so it works mid-note.
const NOTE_CMD_RE = new RegExp(`@(${NOTE_COMMANDS.map((c) => c.cmd).join('|')})\\b[ \\t]*(.*)$`, 'i');

// The @word being typed at the cursor (start of line or after whitespace), or null.
function currentAtQuery() {
  const ta = $('n-body');
  if (ta.selectionStart !== ta.selectionEnd) return null;
  const pos = ta.selectionStart;
  const line = ta.value.slice(ta.value.lastIndexOf('\n', pos - 1) + 1, pos);
  const m = line.match(/(?:^|\s)@(\w*)$/);
  if (!m) return null;
  return { word: m[1], start: pos - m[1].length, end: pos };
}

// The runnable "@command instruction" on the cursor's line, or null.
function currentCommandLine() {
  const ta = $('n-body');
  const lineStart = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let end = ta.value.indexOf('\n', ta.selectionStart);
  if (end < 0) end = ta.value.length;
  const line = ta.value.slice(lineStart, end);
  const m = line.match(NOTE_CMD_RE);
  if (!m) return null;
  const spec = NOTE_COMMANDS.find((c) => c.cmd === m[1].toLowerCase());
  const instruction = (m[2] || '').trim();
  if (!spec || !instruction) return null;
  return { spec, instruction, start: lineStart + m.index, end }; // replace from the @ to line end
}

// ── @insert / @command background jobs ──────────────────────────────────────────
// An @command (e.g. `@insert …`) runs as a BACKGROUND job keyed by note id — it is
// NOT tied to the open editor. Switching notes no longer kills it: the job keeps
// streaming, persists its result to the note store on completion (so it lands even
// if you never reopen the note), and RE-ATTACHES its live progress to the editor
// whenever its note is opened. Each job streams a rich activity trace (model, tool
// calls, partial output) so it's always obvious what's happening.
const noteJobs = new Map(); // noteId -> job

function compactInput(input) {
  try {
    if (input == null) return '';
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  } catch { return ''; }
}

const JOB_ICON = { starting: '⏳', thinking: '💭', tool: '🔎', writing: '✍️' };

// What the note's body should hold once the job is finished (or dropped): the
// produced output, or — if it errored before producing anything — the original
// command line, so the user can retry rather than losing their instruction.
function jobFinalMid(job) {
  if (job.error && !job.out.trim()) return job.commandText;
  return job.out;
}

// The transient, human-readable progress block shown IN the note while a job runs:
// a status header (icon · model · what it's doing) + a tool-call trace + the
// partial output streaming in beneath it. Both are visible at once — the old code
// showed the placeholder OR the tokens, so progress vanished the moment text began.
function jobProgressText(job) {
  if (job.done) return jobFinalMid(job);
  const icon = JOB_ICON[job.status] || '⏳';
  const lines = [`${icon} @${job.cmd} · ${job.modelLabel} · ${job.statusText}`];
  // Show the toolset that's ARMED for this turn up front (what's supplied), plus
  // whether PII redaction is on — not just the tools that happen to fire.
  const meta = [];
  if (job.tools.length) meta.push(`🧰 ${job.tools.length} tool${job.tools.length === 1 ? '' : 's'}: ${prettyTools(job.tools)}`);
  if (job.redacted) meta.push('🛡 PII redaction on');
  if (meta.length) lines.push(`   ${meta.join('   ')}`);
  // Each tool call the model actually makes, with its argument and status.
  for (const s of job.steps) {
    const mark = s.status === 'error' ? '✗' : (s.done ? '✓' : '…');
    const arg = s.input != null ? ` ${compactInput(s.input)}` : '';
    lines.push(`   • ${s.tool}${arg} ${mark}`);
  }
  return lines.join('\n') + (job.out ? `\n\n${job.out}` : '');
}

// Compact, readable tool names for the armed-toolset line (MCP tools are namespaced
// `mcp_<server>__<tool>` — show just server/tool), capped so the line stays short.
function prettyTools(names) {
  const pretty = names.map((n) => {
    const m = /^mcp_(.+?)__(.+)$/.exec(n);
    return m ? `${m[1]}/${m[2]}` : n;
  });
  const shown = pretty.slice(0, 6).join(', ');
  return pretty.length > 6 ? `${shown}, +${pretty.length - 6} more` : shown;
}

// Mirror a running job into the editor — ONLY when its note is the open one. Keyed
// by note id (not object identity), so reopening the same note re-attaches even
// though getNote() returns a fresh record.
let _jobRaf = null;
function renderJob(job) {
  if (current?.id !== job.noteId) return;
  const ta = $('n-body');
  ta.value = job.head + jobProgressText(job) + job.tail;
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  const scroller = document.querySelector('.editor-scroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}
function scheduleJobRender(job) {
  if (current?.id !== job.noteId || _jobRaf) return;
  _jobRaf = requestAnimationFrame(() => { _jobRaf = null; renderJob(job); });
}

// Re-attach the editor to an already-running job (from openNote).
function attachEditorToJob(job) {
  $('n-body').readOnly = true;
  renderJob(job);
}

// Persist a job's current body to the store — id-keyed, so it works whether or not
// the note is open. On completion the result lands even for a note you never reopen.
async function persistJobBody(job) {
  const rec = current?.id === job.noteId ? current : await getNote(job.noteId);
  if (!rec) return;
  const body = job.head + jobFinalMid(job) + job.tail;
  const saved = await saveNote({ id: rec.id, title: rec.title, body, tags: rec.tags, createdAt: rec.createdAt });
  Object.assign(rec, saved, { body });
  updateEntry(rec);
  renderList($('n-search').value);
}

async function runNoteCommand() {
  const ctx = currentCommandLine();
  if (!ctx || !current || noteJobs.has(current.id)) return false; // one job per note
  closeAc();
  const ta = $('n-body');
  const head = ta.value.slice(0, ctx.start);
  const tail = ta.value.slice(ctx.end);
  const commandText = ta.value.slice(ctx.start, ctx.end);

  let deps;
  try { deps = await agentDeps(); } catch { toast('Agent unavailable'); return true; }
  const settings = await deps.getSettings();
  const targetAgent = deps.getTarget(settings, settings.activeAgentId);
  if (!targetAgent) { toast('Set up a model in ChatPanel settings first'); return true; }
  const license = await deps.getLicense();
  if (!deps.canUseAgent(license, settings, targetAgent)) { toast('That agent needs ChatPanel Pro'); return true; }
  const resolved = deps.resolveTarget(targetAgent, settings);

  // Arm the SAME ChatPanel toolset the side panel uses — web search + history +
  // your MCP servers — for commands that may need live/external data. Same shared
  // capability, so Notes and the side panel never drift.
  let tools = null;
  if (ctx.spec.tools) {
    try {
      const bridge = await deps.checkBridge(settings.bridgeUrl).catch(() => ({ ok: false }));
      // Per-Notes tool overrides (Settings → Notes): unchecked forces a tool off for
      // note commands only; checked (default) follows the global ChatPanel setting.
      const nt = settings.ui?.notes?.tools || {};
      tools = await deps.buildTurnTools({
        resolvedAgent: resolved,
        settings,
        license,
        bridgeUrl: settings.bridgeUrl,
        bridgeAvailable: !!bridge?.ok,
        userText: ctx.instruction,
        includeWebSearch: nt.webSearch !== false,
        includeMcp: nt.mcp !== false,
        includeHistory: nt.history !== false,
      });
    } catch { /* fall back to no tools */ }
  }
  // PII redaction wraps EVERY note→model call — the harness must never be skipped.
  let redaction = null;
  try { redaction = deps.buildRedaction({ settings, license }); } catch { /* redaction off */ }

  const job = {
    noteId: current.id, cmd: ctx.spec.cmd, instruction: ctx.instruction,
    head, tail, commandText, out: '', steps: [],
    tools: (tools?.specs || []).map((s) => s.name).filter(Boolean), // the armed toolset, shown up front
    redacted: !!redaction,
    status: 'starting', statusText: 'starting…',
    modelLabel: targetAgent.name || resolved.model || resolved.bridgeAgent || 'agent',
    abort: new AbortController(), done: false, error: null,
  };
  noteJobs.set(job.noteId, job);
  ta.readOnly = true;
  renderJob(job);                    // swap the command line for the live progress block
  renderList($('n-search').value);   // show the running badge in the list
  try {
    await deps.streamChat({
      agent: { ...resolved, systemPrompt: ctx.spec.sys, maxTokens: 1800, temperature: 0.4 },
      settings,
      signal: job.abort.signal,
      tools,
      redaction,
      messages: [{ role: 'user', content: job.instruction }],
      onDelta: (d) => { job.out += d; job.status = 'writing'; job.statusText = 'writing…'; scheduleJobRender(job); },
      onEvent: (ev) => {
        if (ev?.type === 'tool' && ev.phase === 'start') {
          job.status = 'tool';
          job.statusText = ev.name === 'web_search' ? 'searching the web…' : `${ev.name || 'tool'}…`;
          job.steps.push({ tool: ev.name || 'tool', input: ev.input, callId: ev.callId, done: false });
        } else if (ev?.type === 'tool' && ev.phase === 'done') {
          const step = ev.callId ? job.steps.find((s) => s.callId === ev.callId) : job.steps[job.steps.length - 1];
          if (step) { step.done = true; step.status = ev.status; step.result = ev.result; }
          job.status = 'writing'; job.statusText = 'writing…';
        } else if (ev?.type === 'reasoning') {
          job.status = 'thinking'; job.statusText = 'thinking…';
        }
        scheduleJobRender(job);
      },
    });
  } catch (e) {
    if (!job.abort.signal.aborted) { job.error = e?.message || String(e); toast(`Command error: ${job.error}`); }
  } finally {
    const aborted = job.abort.signal.aborted;
    job.done = true;
    noteJobs.delete(job.noteId);
    await persistJobBody(job); // lands the result even if the note is no longer open
    if (current?.id === job.noteId) {
      $('n-body').readOnly = false;
      renderJob(job); // collapse the progress block down to the final output
      current.body = $('n-body').value;
      updateWordCount();
      setStatus(aborted ? '' : 'Saved', !aborted);
    }
    renderList($('n-search').value); // clear the running badge
  }
  return true;
}

// ── Editor co-writer — Phase 1 of the swarm ──────────────────────────────────────
// Watches on a typing pause, asks a cheap model to fix ONLY typos/grammar, diffs its
// output to precise one-click fixes, and shows them in an ambient strip. Opt-in
// (cost + control). All heavy deps are lazy-loaded — nothing on the page load path.
let cwEnabled = localStorage.getItem('chatpanel.notes.cowriter') === '1';
let cwTimer = null;
let cwGen = 0;
let cwSuggestions = [];
let boardSuggestions = []; // the swarm's shared suggestion queue (Connector links, etc.) rendered alongside Editor fixes
let _cwDiff = null;
let cwModel = ''; // provenance: the model the Editor last used
const cwDismissed = new Set();
const boardDismissed = new Set();

function scheduleCowriter() {
  if (!cwEnabled) return;
  if (cwSuggestions.length) clearCowriterUI(); // stale as the user types; recompute on pause
  clearTimeout(cwTimer);
  cwTimer = setTimeout(runCowriter, 1400);
}
function clearCowriterUI() {
  cwSuggestions = [];
  boardSuggestions = [];
  const el = $('n-cowriter');
  el.innerHTML = '';
  el.classList.add('hidden');
}

// The paragraph the cursor sits in (blank-line delimited).
function currentParagraph() {
  const ta = $('n-body');
  const v = ta.value;
  const pos = ta.selectionStart;
  const b = v.lastIndexOf('\n\n', pos - 1);
  const start = b < 0 ? 0 : b + 2;
  const n = v.indexOf('\n\n', pos);
  const end = n < 0 ? v.length : n;
  return { text: v.slice(start, end), start };
}

async function runCowriter() {
  if (!cwEnabled || !current || noteJobs.has(current.id) || agentAbort) return;
  const para = currentParagraph();
  if (para.text.trim().length < 12) return;
  const gen = ++cwGen;
  let deps;
  try {
    if (!_cwDiff) _cwDiff = await import('./js/cowriter-diff.js');
    deps = await agentDeps();
  } catch { return; }
  const settings = await deps.getSettings();
  const license = await deps.getLicense();
  const editor = await roleAgent(deps, settings, license, 'editor'); // routed → cheapest usable model
  if (!editor) return;
  const resolved = editor.resolved;
  cwModel = resolved.autocompleteModel || resolved.model || resolved.bridgeAgent || 'model'; // provenance
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }
  const sys = 'You are a meticulous copy-editor. Fix ONLY clear spelling, typo, and grammar mistakes in the text. Change as LITTLE as possible — never rewrite, rephrase, restructure, or change wording, style, or meaning. Preserve ALL markdown, punctuation, and line breaks exactly. Return ONLY the corrected text, nothing else.';
  let corrected = '';
  setSwarmState('editor', 'working');
  try {
    corrected = await deps.streamChat({
      agent: { ...resolved, model: resolved.autocompleteModel || resolved.model, systemPrompt: sys, maxTokens: Math.min(1200, Math.ceil(para.text.length / 2) + 200), temperature: 0 },
      settings,
      redaction, // the PII harness wraps this call too — nothing leaks from a co-writer
      messages: [{ role: 'user', content: para.text }],
    });
  } catch { setSwarmState('editor', 'idle'); return; }
  if (gen !== cwGen || !current || !cwEnabled) return; // superseded / disabled / note switched
  const ta = $('n-body');
  const idx = ta.value.indexOf(para.text); // relocate (user may have edited above); bail if it moved
  if (idx < 0) { setSwarmState('editor', 'idle'); return; }
  cwSuggestions = _cwDiff.filterTypoEdits(_cwDiff.wordDiff(para.text, corrected.trim()))
    .map((e) => ({ ...e, start: e.start + idx, end: e.end + idx, key: _cwDiff.editKey(e) }))
    .filter((e) => !cwDismissed.has(e.key));
  renderCowriter();
  if (cwSuggestions.length) logActivity('Editor', `${cwSuggestions.length} fix${cwSuggestions.length === 1 ? '' : 'es'} offered`);
  setSwarmState('editor', 'idle', cwSuggestions.length ? `${cwSuggestions.length} fix${cwSuggestions.length === 1 ? '' : 'es'}` : '');
}

function renderCowriter() {
  const el = $('n-cowriter');
  el.innerHTML = '';
  if (!cwSuggestions.length && !boardSuggestions.length) { el.classList.add('hidden'); return; }
  const label = document.createElement('span');
  label.className = 'cw-label';
  label.textContent = '✍️ Co-writer';
  el.appendChild(label);
  for (const s of cwSuggestions.slice(0, 6)) {
    const chip = document.createElement('button');
    chip.className = 'cw-fix';
    chip.title = cwModel ? `Apply fix · via ${cwModel} (Editor)` : 'Apply fix'; // provenance
    chip.innerHTML = `<s>${escapeHtml(s.before.trim() || '∅')}</s><span class="cw-arrow">→</span><b>${escapeHtml(s.after.trim() || '∅')}</b>`;
    chip.onclick = () => applyCowriterFix(s);
    el.appendChild(chip);
  }
  // The shared suggestion queue — other roles (Connector links, …), each carrying provenance.
  for (const s of boardSuggestions.slice(0, 5)) {
    const chip = document.createElement('button');
    chip.className = `cw-sug cw-${s.role}`;
    chip.title = s.title || '';
    chip.innerHTML = `<span class="cw-ico">${s.icon}</span>${s.html}`;
    chip.onclick = () => { s.apply(); boardSuggestions = boardSuggestions.filter((x) => x !== s); renderCowriter(); };
    el.appendChild(chip);
  }
  if (cwSuggestions.length > 1) {
    const all = document.createElement('button');
    all.className = 'cw-all';
    all.textContent = 'Apply all';
    all.onclick = applyAllCowriter;
    el.appendChild(all);
  }
  const x = document.createElement('button');
  x.className = 'cw-x';
  x.title = 'Dismiss';
  x.textContent = '✕';
  x.onclick = () => { cwSuggestions.forEach((s) => cwDismissed.add(s.key)); boardSuggestions.forEach((s) => boardDismissed.add(s.key)); clearCowriterUI(); };
  el.appendChild(x);
  el.classList.remove('hidden');
}

function commitCowriterBody() {
  current.body = $('n-body').value;
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  updateWordCount();
  dirty = true;
  scheduleSave();
}
function applyCowriterFix(s) {
  const ta = $('n-body');
  ta.value = ta.value.slice(0, s.start) + s.after + ta.value.slice(s.end);
  const delta = s.after.length - (s.end - s.start);
  cwSuggestions = cwSuggestions.filter((x) => x !== s).map((x) => (x.start > s.start ? { ...x, start: x.start + delta, end: x.end + delta } : x));
  commitCowriterBody();
  renderCowriter();
}
function applyAllCowriter() {
  const ta = $('n-body');
  ta.value = _cwDiff.applyEdits(ta.value, cwSuggestions);
  cwSuggestions = [];
  commitCowriterBody();
  clearCowriterUI();
  toast('Fixes applied');
}

// ── Connector — token-free: link new topics/entities to your existing docs ─────────
// On a typing pause it matches phrases in the current paragraph against your existing
// note/chat/meeting titles and suggests a [[wikilink]] for each unlinked mention. No
// model call — pure title matching against linkTargets(). Feeds the suggestion queue.
let connectorGen = 0;
let _connectMod = null;
async function runConnector() {
  if (!cwEnabled || !current) return;
  const para = currentParagraph();
  if (para.text.trim().length < 12) return;
  const gen = ++connectorGen;
  let targets;
  try {
    if (!_connectMod) _connectMod = await import('./js/cowriter-connect.js');
    targets = await linkTargets();
  } catch { return; }
  if (gen !== connectorGen || !cwEnabled || !current) return;
  const text = para.text;
  const hits = _connectMod.connectorMatches(text, targets, {
    selfTitle: current.title || '',
    linked: _connectMod.existingLinks(text),
    dismissed: boardDismissed,
  });
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'connector').concat(hits.map((h) => ({
    role: 'connector', icon: '🔗', key: `link:${h.title.toLowerCase()}`,
    html: `<b>[[${escapeHtml(h.title)}]]</b>`,
    title: `Link “${h.mention}” to your existing “${h.title}” · Connector (your workspace)`,
    apply: () => applyConnector(h),
  })));
  if (hits.length) logActivity('Connector', `${hits.length} link${hits.length === 1 ? '' : 's'} suggested`);
  setSwarmState('connector', 'idle', hits.length ? `${hits.length} link${hits.length === 1 ? '' : 's'}` : '');
  renderCowriter();
}
function applyConnector(h) {
  const ta = $('n-body');
  const i = ta.value.indexOf(h.mention);
  if (i < 0 || ta.value.slice(i - 2, i) === '[[') return; // moved/edited, or already linked
  ta.value = `${ta.value.slice(0, i)}[[${h.mention}]]${ta.value.slice(i + h.mention.length)}`;
  commitCowriterBody();
  logActivity('Connector', `linked “${h.title}”`);
  toast('Linked');
}
function setCowriter(on, announce = false) {
  cwEnabled = on;
  localStorage.setItem('chatpanel.notes.cowriter', on ? '1' : '0');
  const btn = $('n-cw-toggle');
  btn.classList.toggle('on', on);
  btn.title = on ? 'Co-writer swarm: on — proofreads as you write · ⌘↵ draft ahead · 🔎 research' : 'Co-writer: off';
  if (on) { scheduleCowriter(); scheduleResearch(); if (announce) toast('Co-writer on — proofreads as you type · ⌘↵ to draft ahead'); }
  else clearCowriterUI();
  renderSwarmStatus(); // show/clear the footer team strip
}

// ── Researcher co-writer — Phase 2 of the swarm ──────────────────────────────────
// A token-FREE research lane. On an idle pause it retrieves related material from the
// user's own workspace (notes/chats/meetings) via history-rag — no model call — and on
// demand also searches the web (still no model: webSearch returns structured results).
// Hits land in an ambient, collapsible shelf as cards you can insert (as a [[wikilink]]
// or [markdown](url)), open, or dismiss. Reuses retrieveHistory + webSearch wholesale.
let researchGen = 0;
let researchCards = [];
let researchBusy = false;
let researchTimer = null;
let researchQuestion = ''; // set when the affordance orchestrator triggered research for a "?" line
let _ragMod = null;
const researchDismissed = new Set();
const KIND_ICON = { note: '📝', meeting: '👥', chat: '💬', web: '🌐' };

function researchQuery() {
  // Intent + title + the section around the cursor — a strong, cheap relevance signal.
  const title = ($('n-title').value || '').trim();
  const para = currentParagraph().text.trim();
  return [board.intent, title, para].filter(Boolean).join('\n').trim().slice(0, 500);
}
function sourceKind(sourceId = '') {
  if (sourceId.startsWith('note:')) return 'note';
  if (sourceId.startsWith('meeting:')) return 'meeting';
  return 'chat';
}
function researchSnippet(text = '') {
  return String(text)
    .replace(/^(NOTE|CHAT|MEETING):.*$/gim, '').replace(/^(Date|Tags):.*$/gim, '')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}
function setResearchStatus(t) { const el = $('n-research-status'); if (el) el.textContent = t || ''; }
function clearResearch() {
  researchGen++; researchCards = []; researchBusy = false; researchQuestion = '';
  const el = $('n-research');
  if (el) { el.classList.add('hidden'); $('n-research-cards').innerHTML = ''; }
  setResearchStatus('');
}
function scheduleResearch() {
  if (!cwEnabled) return;               // the researcher rides the same swarm toggle
  clearTimeout(researchTimer);
  researchTimer = setTimeout(() => observe(), 2600); // longer idle than the editor
}

async function runResearch({ web = false, question = '' } = {}) {
  if (!current) return;
  researchQuestion = question; // a question-driven run offers a Writer handoff in the shelf
  const q = question || researchQuery();
  if (!q) { if (web) toast('Write something to research first'); return; }
  if (q.length < 16 && !web && !question) return;
  const gen = ++researchGen;
  researchBusy = true;
  setSwarmState('researcher', 'working');
  setResearchStatus(web ? 'Searching your workspace and the web…' : 'Finding related material…');
  renderResearch(); // reveal the shelf with a working state immediately

  // Local lane — free, always. Related notes/chats/meetings from the user's own history.
  let cards = [];
  try {
    if (!_ragMod) _ragMod = await import('./js/history-rag.js');
    const { results } = await _ragMod.retrieveHistory(q, { includeMeetings: true, limit: 6 });
    cards = results
      .filter((r) => r.sourceId !== `note:${current.id}`)
      .map((r) => ({ kind: sourceKind(r.sourceId), title: r.title || 'Untitled', url: r.url, snippet: researchSnippet(r.text), key: r.url || r.sourceId }))
      .filter((c) => !researchDismissed.has(c.key));
  } catch { /* local lane is best-effort */ }
  if (gen !== researchGen) return;

  // Web lane — on demand only (network + a Free daily quota); still token-free.
  if (web) {
    try {
      const [ws, lic, store] = await Promise.all([import('./js/web-search.js'), import('./js/license.js'), import('./js/store.js')]);
      const settings = await store.getSettings();
      const license = await lic.getLicense();
      const term = q.split('\n').filter(Boolean).pop() || q;
      const res = await ws.webSearch(term, ws.webSearchOpts(settings, lic.isPro(license)));
      if (gen !== researchGen) return;
      for (const r of (res.results || []).slice(0, 5)) {
        if (!researchDismissed.has(r.url)) cards.push({ kind: 'web', title: r.title || r.url, url: r.url, snippet: researchSnippet(r.text), key: r.url });
      }
    } catch (e) { toast(e?.message ? `Web search: ${e.message}` : 'Web search unavailable'); }
  }
  if (gen !== researchGen) return;

  const seen = new Set();
  researchCards = cards.filter((c) => c.key && !seen.has(c.key) && seen.add(c.key)).slice(0, 10);
  researchBusy = false;
  setResearchStatus('');
  renderResearch();
  if (researchCards.length) logActivity('Researcher', question ? `answered “${question.slice(0, 40)}” · ${researchCards.length} sources` : `${researchCards.length} related`);
  setSwarmState('researcher', 'idle', researchCards.length ? `${researchCards.length} found` : '');
}

function renderResearch() {
  const shelf = $('n-research');
  const wrap = $('n-research-cards');
  if (!shelf || !wrap) return;
  $('n-research-count').textContent = researchCards.length ? String(researchCards.length) : '';
  wrap.innerHTML = '';
  if (researchQuestion) { // Researcher → Writer handoff for a "?" the orchestrator caught
    const h = document.createElement('button');
    h.className = 'rcard-answer';
    h.title = 'Hand off to the Writer — draft an answer grounded in these sources';
    h.innerHTML = `✍️ Draft an answer <span class="ra-q">“${escapeHtml(researchQuestion.slice(0, 56))}”</span>`;
    h.onclick = () => draftAnswer();
    wrap.appendChild(h);
  }
  if (!researchCards.length) {
    const empty = document.createElement('div');
    empty.className = 'research-empty';
    empty.textContent = researchBusy ? 'Working…' : (researchQuestion ? 'No sources found — the Writer can still answer.' : 'Nothing related yet — keep writing, or search the web.');
    wrap.appendChild(empty);
    shelf.classList.remove('hidden');
    return;
  }
  for (const c of researchCards) {
    const card = document.createElement('div');
    card.className = 'rcard';
    card.innerHTML =
      `<div class="rcard-top"><span class="rcard-ico">${KIND_ICON[c.kind] || '📄'}</span>` +
      `<span class="rcard-title">${escapeHtml(c.title)}</span></div>` +
      (c.snippet ? `<div class="rcard-snip">${escapeHtml(c.snippet)}</div>` : '') +
      `<div class="rcard-acts">` +
      `<button class="rcard-insert" title="Insert a link at the cursor">Insert</button>` +
      `<button class="rcard-open" title="Open">Open</button>` +
      `<button class="rcard-x" title="Dismiss">✕</button></div>`;
    card.querySelector('.rcard-insert').onclick = () => insertResearch(c);
    card.querySelector('.rcard-open').onclick = () => openResearch(c);
    card.querySelector('.rcard-x').onclick = () => { researchDismissed.add(c.key); researchCards = researchCards.filter((x) => x !== c); renderResearch(); };
    wrap.appendChild(card);
  }
  shelf.classList.remove('hidden');
}
function insertResearch(c) {
  const ta = $('n-body');
  const link = c.kind === 'note' ? `[[${c.title}]]` : `[${escapeMdText(c.title)}](${c.url})`;
  const pos = ta.selectionStart;
  const lead = pos > 0 && !/\s$/.test(ta.value.slice(0, pos)) ? ' ' : '';
  ta.setRangeText(lead + link + ' ', pos, ta.selectionEnd, 'end');
  onBodyInput();
  ta.focus();
  toast('Inserted');
}
function openResearch(c) {
  if (!c.url) return;
  const [page, hash] = c.url.split('#');
  if (page === 'notes.html' && hash) return openNote(decodeURIComponent(hash));
  if (/^https?:/i.test(c.url)) window.open(c.url, '_blank', 'noopener,noreferrer');
  else chrome.tabs?.create?.({ url: c.url });
}
function escapeMdText(s) { return String(s || '').replace(/[[\]]/g, '\\$&'); }

// ── Writer co-writer — Phase 3 of the swarm ──────────────────────────────────────
// Draft-ahead "ghost text". On ⌘/Ctrl+Enter the strong (routed) Writer model continues
// from the caret — grounded in the Researcher's shelf, so the swarm members hand off —
// and streams the draft in as a SELECTED suggestion. Tab accepts, Esc/typing/blur
// rejects. A pending ghost is tracked separately and NEVER persists un-accepted:
// every save/switch/blur strips it first.
let writerGen = 0;
let writerAbort = null;
let ghost = null;          // { from, to } range of the pending suggestion in n-body
let ghostApplying = false; // true while WE mutate the textarea (so input handlers ignore it)

function ghostHintEl() {
  let el = document.getElementById('n-ghost-hint');
  if (!el) { el = document.createElement('div'); el.id = 'n-ghost-hint'; el.className = 'ghost-hint hidden'; document.body.appendChild(el); }
  return el;
}
function showGhostHint(text) {
  const el = ghostHintEl();
  el.textContent = text;
  const { x, y } = caretXY($('n-body'));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y + 4)}px`;
  el.classList.remove('hidden');
}
function hideGhostHint() { ghostHintEl().classList.add('hidden'); }

function clearGhost({ remove = false } = {}) {
  const ta = $('n-body');
  if (ghost && remove && ta.value.length >= ghost.to) {
    ghostApplying = true;
    ta.setRangeText('', ghost.from, ghost.to, 'end'); // caret returns to `from`
    ghostApplying = false;
  }
  if (ghost) setSwarmState('writer', 'idle');
  ghost = null;
  hideGhostHint();
}
function renderGhost(from, text) {
  const ta = $('n-body');
  ghostApplying = true;
  const prevTo = ghost ? ghost.to : from;
  ta.setRangeText(text, from, prevTo, 'select'); // replace prior ghost, keep the draft selected
  ghostApplying = false;
  ghost = { from, to: from + text.length };
  autoGrow();
}
function acceptGhost() {
  if (!ghost) return;
  const ta = $('n-body');
  ta.selectionStart = ta.selectionEnd = ghost.to; // collapse to end — keep the text
  ghost = null;
  hideGhostHint();
  setSwarmState('writer', 'idle');
  logActivity('Writer', 'draft accepted');
  current.body = ta.value;
  autoGrow();
  if (!$('n-panes').classList.contains('write')) updatePreview();
  updateWordCount();
  dirty = true;
  scheduleSave();
  ta.focus();
}

function writerTail(before) {
  const title = ($('n-title').value || '').trim();
  const tail = before.length > 1600 ? `…${before.slice(-1600)}` : before;
  return (title ? `# ${title}\n\n` : '') + tail;
}
async function draftAhead() {
  if (!current || ghost || writerAbort || agentAbort || noteJobs.has(current.id)) return;
  const ta = $('n-body');
  const from = ta.selectionStart;
  const before = ta.value.slice(0, from);
  if (before.trim().length < 8) return toast('Write a little first, then ⌘↵ to draft ahead');
  const gen = ++writerGen;
  let deps;
  try { deps = await agentDeps(); } catch { return toast('Writer unavailable'); }
  clearTimeout(saveTimer);
  await flushSave(); // persist real edits so no autosave fires mid-stream (and dirty resets)
  const settings = await deps.getSettings();
  const license = await deps.getLicense();
  const writer = await roleAgent(deps, settings, license, 'writer'); // strong, routed
  if (!writer) return toast('Set up a model in ChatPanel settings first');

  // Research handoff — ground the Writer in what the Researcher gathered.
  const grounding = researchCards.length
    ? '\n\nRelated material you may draw on (only if genuinely useful — cite as [[title]] or [text](url)):\n'
      + researchCards.slice(0, 5).map((c) => `- ${c.title}${c.snippet ? ` — ${c.snippet}` : ''}`).join('\n')
    : '';
  const intentLine = board.intent ? `The note's goal (guide your writing toward it): ${board.intent}.\n\n` : '';
  const sys = intentLine + "You continue the user's note from where it stops. Match their voice, tone, and markdown style exactly. Write only the NEXT one or two sentences (or finish the current one) — concise, natural, no preamble, no repetition of prior text, no meta commentary. Output ONLY the continuation." + grounding;
  let redaction = null;
  try { redaction = deps.buildRedaction?.({ settings, license }); } catch { /* redaction off */ }

  writerAbort = new AbortController();
  // NB: no readOnly — setRangeText() throws on a readOnly textarea. Typing is blocked
  // instead by the keydown guard (which swallows keys while writerAbort is set).
  setStatus('Drafting…');
  showGhostHint('Drafting…');
  setSwarmState('writer', 'working');
  let out = '';
  try {
    await deps.streamChat({
      agent: { ...writer.resolved, systemPrompt: sys, maxTokens: 220, temperature: 0.6 },
      settings,
      signal: writerAbort.signal,
      redaction, // the PII harness wraps the draft-ahead call too
      messages: [{ role: 'user', content: writerTail(before) }],
      onDelta: (d) => { if (gen === writerGen) { out += d; renderGhost(from, out); } }, // hint already shown; anchor is fixed at `from`
    });
  } catch (e) {
    if (!writerAbort.signal.aborted) toast(`Writer error: ${e?.message || e}`);
  } finally {
    const aborted = writerAbort?.signal.aborted;
    writerAbort = null;
    setStatus('');
    if (!aborted && gen === writerGen && out.trim()) { renderGhost(from, out.replace(/\s+$/, '')); showGhostHint('Tab ↹ accept · Esc dismiss'); setSwarmState('writer', 'idle', 'draft ready'); logActivity('Writer', 'drafted a continuation'); }
    else { clearGhost({ remove: true }); setSwarmState('writer', 'idle'); }
  }
}

// ── Swarm team panel — Phase 4b: the model router, made visible & controllable ────
// Shows each role, the model the router APPOINTED (with its tier / subagent mode), and
// a dropdown to pin an override. Reuses swarmCandidates + the pure router; overrides
// persist to the same key roleAgent() already reads, so pinning takes effect instantly.
const SWARM_ROLE_META = [
  { id: 'editor', icon: '✍️', name: 'Editor', desc: 'Proofreads as you type' },
  { id: 'researcher', icon: '🔎', name: 'Researcher', desc: 'Finds related material' },
  { id: 'writer', icon: '✨', name: 'Writer', desc: 'Drafts ahead on ⌘↵' },
];
async function renderSwarmMenu() {
  const menu = $('n-swarm-menu');
  let deps, settings, license, cands, overrides;
  try {
    deps = await agentDeps();
    settings = await deps.getSettings();
    license = await deps.getLicense();
    cands = swarmCandidates(deps, settings, license).filter((c) => c.usable !== false);
    overrides = swarmOverrides();
    if (!_router) _router = await import('./js/cowriter-router.js');
  } catch { menu.innerHTML = '<div class="agent-hint">Set up a model in ChatPanel settings first</div>'; return; }
  if (!cands.length) { menu.innerHTML = '<div class="agent-hint">Add a model in ChatPanel settings to use the co-writer swarm.</div>'; return; }
  menu.innerHTML = '<div class="swarm-title">Co-writer team</div>';
  // Shared intent — this note's goal; guides the Writer & Researcher.
  const intentWrap = document.createElement('label');
  intentWrap.className = 'swarm-intent';
  intentWrap.innerHTML = '<span>🎯 Working on</span>';
  const intentIn = document.createElement('input');
  intentIn.type = 'text';
  intentIn.className = 'swarm-intent-in';
  intentIn.placeholder = 'e.g. draft a launch plan…';
  intentIn.maxLength = 200;
  intentIn.value = board.intent;
  intentIn.oninput = () => setIntent(intentIn.value);
  intentWrap.appendChild(intentIn);
  menu.appendChild(intentWrap);
  for (const role of SWARM_ROLE_META) {
    const appt = _router.appoint(SWARM_ROLES[role.id], cands, { overrides });
    const tier = appt?.mode === 'subagent' ? 'subagent' : (appt?.tier || SWARM_ROLES[role.id].prefer);
    const pinned = overrides[role.id] && cands.some((c) => c.id === overrides[role.id]) ? overrides[role.id] : '';
    const row = document.createElement('div');
    row.className = 'swarm-row';
    row.innerHTML =
      `<div class="swarm-role"><span class="swarm-ico">${role.icon}</span>` +
      `<div class="swarm-role-txt"><b>${role.name}</b><span>${escapeHtml(role.desc)}</span></div>` +
      `<span class="swarm-tier tier-${escapeHtml(tier)}">${escapeHtml(tier)}</span></div>`;
    const sel = document.createElement('select');
    sel.className = 'swarm-select';
    sel.innerHTML = `<option value="">${escapeHtml(appt ? `Auto → ${appt.name || appt.model}` : 'Auto')}</option>`
      + cands.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.model)}</option>`).join('');
    sel.value = pinned;
    sel.onchange = () => setRoleOverride(role.id, sel.value);
    row.appendChild(sel);
    menu.appendChild(row);
  }
  const hint = document.createElement('div');
  hint.className = 'agent-hint';
  hint.textContent = 'Auto = the router picks by role (cheap → strong). Override to pin a model.';
  menu.appendChild(hint);
}
function setRoleOverride(roleId, candId) {
  const o = swarmOverrides();
  if (candId) o[roleId] = candId; else delete o[roleId];
  localStorage.setItem('chatpanel.notes.cowriter.roles', JSON.stringify(o));
  renderSwarmMenu();
  toast(candId ? 'Role pinned' : 'Role back to auto');
}

// ── Swarm status strip — the orchestrator's live view of the team (Phase 4) ───────
// A shared, tiny state board each member updates as it works, rendered as an ambient
// line of role chips in the footer (only while the swarm is on). Gives "the team is
// working for you" visibility with no rewrite of the members — they call setSwarmState
// at their edges. A pulsing dot = working; a count/label = the last result.
const swarm = {
  editor: { state: 'idle', info: '' },      // idle | working | 'N fixes'
  researcher: { state: 'idle', info: '' },  // idle | working | 'N found'
  writer: { state: 'idle', info: '' },      // idle | working | 'draft ready'
  connector: { state: 'idle', info: '' },   // idle | 'N links'
};
function setSwarmState(role, state, info = '') {
  if (!swarm[role]) return;
  swarm[role] = { state, info };
  renderSwarmStatus();
}
function resetSwarmState() {
  for (const k of Object.keys(swarm)) swarm[k] = { state: 'idle', info: '' };
  renderSwarmStatus();
}
function renderSwarmStatus() {
  const el = $('n-swarm-status');
  if (!el) return;
  if (!cwEnabled) { el.innerHTML = ''; return; }
  const chip = (icon, r, title) =>
    `<span class="ss ss-${r.state}" title="${title}"><span class="ss-dot"></span>${icon}${r.info ? ` <span class="ss-info">${escapeHtml(r.info)}</span>` : ''}</span>`;
  el.innerHTML =
    (board.intent ? `<span class="ss ss-intent" title="This note's goal — guides the Writer & Researcher">🎯 <span class="ss-info">${escapeHtml(board.intent.slice(0, 48))}</span></span>` : '')
    + chip('✍️', swarm.editor, 'Editor — proofreads as you type')
    + chip('🔎', swarm.researcher, 'Researcher — finds related material')
    + chip('✨', swarm.writer, 'Writer — ⌘↵ to draft ahead')
    + chip('🔗', swarm.connector, 'Connector — links new topics to your docs');
}

// ── The blackboard — shared intent + activity log the whole swarm reads (Phase 4) ──
// One place the members coordinate: the user's one-line INTENT (what this note is for —
// guides the Writer & Researcher) and a rolling LOG of what each member did (the
// timeline). Per-note, local-only — a working hint, not note content.
const board = { intent: '', log: [] };
function boardIntentKey() { return current ? `chatpanel.notes.intent.${current.id}` : ''; }
function loadIntent() { board.intent = (current && localStorage.getItem(boardIntentKey())) || ''; }
function setIntent(v) {
  board.intent = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const k = boardIntentKey();
  if (k) { if (board.intent) localStorage.setItem(k, board.intent); else localStorage.removeItem(k); }
  renderSwarmStatus();
}
function logActivity(who, what) {
  board.log.unshift({ who, what, at: Date.now() });
  if (board.log.length > 30) board.log.length = 30;
}
// The away-timeline: click the status strip to see what the team did while you wrote.
function timelineEl() {
  let el = document.getElementById('n-timeline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'n-timeline';
    el.className = 'timeline hidden';
    el.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(el);
  }
  return el;
}
function toggleTimeline() {
  const el = timelineEl();
  if (!el.classList.contains('hidden')) return el.classList.add('hidden');
  if (!board.log.length) return toast('No swarm activity yet');
  el.innerHTML = '<div class="tl-title">Swarm activity</div>' + board.log.map((e) =>
    `<div class="tl-row"><span class="tl-who">${escapeHtml(e.who)}</span><span class="tl-what">${escapeHtml(e.what)}</span><span class="tl-when">${escapeHtml(relTime(e.at))}</span></div>`).join('');
  el.classList.remove('hidden');
  const strip = $('n-swarm-status').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.round(Math.min(Math.max(8, strip.left + strip.width / 2 - r.width / 2), window.innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.round(strip.top - r.height - 8)}px`;
}

// The single line the cursor sits on (for affordance detection).
function currentLine() {
  const ta = $('n-body');
  const v = ta.value; const pos = ta.selectionStart;
  const s = v.lastIndexOf('\n', pos - 1) + 1;
  let e = v.indexOf('\n', pos); if (e < 0) e = v.length;
  return { text: v.slice(s, e), start: s, end: e };
}

// Affordance orchestrator — the single debounced observer that wakes the RIGHT member
// for what the text affords: a finished question ("…?") → Researcher (+ Writer handoff);
// an empty heading / TODO / bullet → a Writer draft NUDGE (offered, never auto-spent —
// token control); otherwise → related-material (Researcher) + link-new-topics (Connector).
let lastQuestion = '';
function observe() {
  if (!cwEnabled || !current || noteJobs.has(current.id)) return;
  const t = currentLine().text.trim();
  const isQuestion = /\?\s*$/.test(t) && t.split(/\s+/).length >= 3;
  const aff = writerAffordance();
  if (aff) addWriterNudge(aff); else removeWriterNudge();
  if (isQuestion) { if (t !== lastQuestion) { lastQuestion = t; runResearch({ question: t }); } }
  else { runResearch(); runConnector(); }
}

// What the cursor line affords the Writer: an empty outline item, a TODO marker, or a
// heading with no body yet → { kind, at, label }, or null. The Writer only DRAFTS on an
// explicit nudge/⌘↵, so detecting the spot is free.
function writerAffordance() {
  const v = $('n-body').value;
  const line = currentLine();
  const t = line.text;
  if (/^\s*([-*]|\d+\.)\s*(\[ \]\s*)?$/.test(t)) return { kind: 'item', at: line.end, label: 'this item' };
  if (/\b(TODO|TK|TBD)\b:?\s*$/i.test(t)) return { kind: 'todo', at: line.end, label: 'this to-do' };
  if (/^#{1,6}\s+\S/.test(t)) { // heading whose section has no body yet
    const next = v.slice(line.end).replace(/^\n/, '').split('\n', 1)[0] || '';
    if (!next.trim() || /^#{1,6}\s/.test(next)) return { kind: 'section', at: line.end, label: 'this section' };
  }
  if (!t.trim()) { // blank line directly under a heading
    const before = v.slice(0, line.start).replace(/\n$/, '');
    const prev = before.slice(before.lastIndexOf('\n') + 1);
    if (/^#{1,6}\s+\S/.test(prev)) return { kind: 'section', at: line.start, label: 'this section' };
  }
  return null;
}
function addWriterNudge(aff) {
  const key = `draft:${aff.kind}:${aff.at}`;
  boardSuggestions = boardSuggestions.filter((s) => s.role !== 'writer');
  if (!boardDismissed.has(key)) {
    boardSuggestions.push({
      role: 'writer', icon: '✨', key,
      html: `Draft ${escapeHtml(aff.label)}`,
      title: 'Hand to the Writer — draft here (or press ⌘↵)',
      apply: () => { const ta = $('n-body'); ta.focus(); ta.selectionStart = ta.selectionEnd = Math.min(aff.at, ta.value.length); draftAhead(); },
    });
  }
  renderCowriter();
}
function removeWriterNudge() {
  if (boardSuggestions.some((s) => s.role === 'writer')) {
    boardSuggestions = boardSuggestions.filter((s) => s.role !== 'writer');
    renderCowriter();
  }
}

// Researcher → Writer handoff: draft an answer to the question the Researcher just
// gathered sources for. Reuses the ghost machinery — position the caret right after the
// question and let the (research-grounded) Writer continue.
async function draftAnswer() {
  if (!lastQuestion || ghost || writerAbort) return;
  const ta = $('n-body');
  const i = ta.value.indexOf(lastQuestion);
  if (i < 0) return;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = i + lastQuestion.length; // caret right after the "?"
  await draftAhead();
}

// ── wire up ───────────────────────────────────────────────────────────────────
function init() {
  $('n-new').onclick = newNote;
  $('n-new2').onclick = newNote;
  $('n-new3').onclick = newNote;
  $('n-delete').onclick = removeCurrent;
  $('n-copy').onclick = copyCurrent;
  $('n-download').onclick = downloadCurrent;
  $('n-ask').onclick = askAboutNote;
  $('n-settings').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#notes') });

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
    // Writer draft-ahead ghost. While streaming, swallow keys (Esc aborts). When a draft
    // is pending: Tab accepts, Esc rejects, any other key rejects then applies normally.
    if (writerAbort) {
      if (e.key === 'Escape') { e.preventDefault(); writerAbort.abort(); clearGhost({ remove: true }); }
      return;
    }
    if (ghost) {
      if (e.key === 'Tab') { e.preventDefault(); return acceptGhost(); }
      if (e.key === 'Escape') { e.preventDefault(); return clearGhost({ remove: true }); }
      if (!['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) clearGhost({ remove: true });
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); return draftAhead(); }
    // Typing the second [ auto-closes to [[]] with the cursor inside → opens the picker.
    if (e.key === '[' && ta.selectionStart === ta.selectionEnd && ta.value[ta.selectionStart - 1] === '[') {
      e.preventDefault();
      const pos = ta.selectionStart;
      ta.setRangeText('[]]', pos, pos, 'end');
      ta.selectionStart = ta.selectionEnd = pos + 1;
      onBodyInput();
      return;
    }
    // Esc stops the @command running on THIS note (jobs on other notes keep going).
    const openJob = current && noteJobs.get(current.id);
    if (e.key === 'Escape' && openJob) { e.preventDefault(); openJob.abort.abort(); return; }
    // Enter on "@research <topic>" wakes the Researcher for that topic (local + web) and
    // consumes the command line. Self-contained — doesn't touch the @command job path.
    if (e.key === 'Enter' && !e.shiftKey && !openJob) {
      const rline = currentLine();
      const rm = rline.text.match(/^@research\s+(.{2,})$/i);
      if (rm) {
        e.preventDefault();
        ta.setRangeText('', rline.start, rline.end, 'end');
        onBodyInput();
        runResearch({ question: rm[1].trim(), web: true });
        return;
      }
    }
    // Enter on an "@command instruction" line runs it (instead of a newline).
    if (e.key === 'Enter' && !e.shiftKey && !openJob && currentCommandLine()) {
      e.preventDefault();
      runNoteCommand();
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
  $('n-body').addEventListener('blur', () => {
    setTimeout(closeAc, 120); // let a click land first
    if (writerAbort) writerAbort.abort();
    clearGhost({ remove: true }); // a pending draft-ahead is rejected when focus leaves
  });
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

  // Co-writer swarm toggle (opt-in; persisted). Announce only on user action, not load.
  $('n-cw-toggle').onclick = () => setCowriter(!cwEnabled, true);
  setCowriter(cwEnabled);

  // Researcher: 🔎 runs research on demand (local + web). Shelf head repeats web + collapses.
  $('n-research-btn').onclick = () => runResearch({ web: true });
  $('n-research-web').onclick = () => runResearch({ web: true });
  $('n-research-collapse').onclick = () => {
    const collapsed = $('n-research').classList.toggle('collapsed');
    localStorage.setItem('chatpanel.notes.researchCollapsed', collapsed ? '1' : '0');
    $('n-research-collapse').textContent = collapsed ? '▸' : '▾';
  };
  if (localStorage.getItem('chatpanel.notes.researchCollapsed') === '1') {
    $('n-research').classList.add('collapsed');
    $('n-research-collapse').textContent = '▸';
  }

  // Swarm team panel (⚙) — open shows the router's appointments + per-role overrides.
  $('n-swarm').onclick = (e) => {
    e.stopPropagation();
    const menu = $('n-swarm-menu');
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (willOpen) renderSwarmMenu();
  };
  $('n-swarm-menu').addEventListener('click', (e) => e.stopPropagation()); // keep open while choosing
  document.addEventListener('click', () => $('n-swarm-menu').classList.add('hidden'));

  // Status strip → the away-timeline of what the swarm did.
  $('n-swarm-status').onclick = (e) => { e.stopPropagation(); toggleTimeline(); };
  document.addEventListener('click', () => timelineEl().classList.add('hidden'));

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
