// Settings → Teams → Board: every run's board as a message board — the desktop's Agents →
// Board, drawn by the extension over the same gateway run store (0.6.81+).
//
// Left: asks waiting on you pinned at the top, then every run newest first with its threads.
// Right: the thread — posts with replies indented, Approve / Reject on a finding or the
// draft, an ask with its options and an answer box, a reply box at the bottom. A person here
// is a member: an answer resumes the member that asked (in whichever client runs it), a
// decision settles a post for everyone, a reply is read by the next wave.
//
// Deferred from settings.js (its first paint is at ceiling); polls while on screen and
// disposes its poll on re-render, the way settings-teams.js does.
//
// The poll redraws the thread pane from scratch, and a redraw used to take the reply box
// with it — half a sentence typed, gone at the next tick. So a draft lives in state, keyed
// by the box it belongs to, and comes back into the rebuilt box with its caret; and while a
// box in this pane holds focus with text in it, the poll leaves the pane alone (the thread
// list on the left still moves) and the next tick after the person leaves it catches up.

import { runStore, answerAsk, handoffTask, resumeRunHere, rosterFor } from './team-host.js';
import { renderMarkdown } from './markdown.js';

const POLL_MS = 4000;
const LIVE = new Set(['planning', 'running', 'merging', 'waiting']);
const ICON = { task: '⌗', ask: '?', proposal: '≡', discussion: '…' };
const HUES = ['#0b84ff', '#17a673', '#b7791f', '#b45309', '#dc2626', '#15a34a'];
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (t) => { if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : when(t); };
const colour = (by, roles) => (by === 'person' ? '#7c4dff' : by === 'runner' ? 'var(--muted)' : HUES[Math.max(0, (roles || []).indexOf(by)) % HUES.length]);
const initial = (by) => (by === 'person' ? 'Y' : by === 'runner' ? '▸' : String(by || '?').slice(0, 1).toUpperCase());

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
const chip = (t) => {
  const s = t.status;
  const cls = s === 'waiting' ? 'warn' : s === 'approved' || s === 'resolved' ? 'ok' : s === 'rejected' || s === 'failed' ? 'err' : 'on';
  return el('span', { class: `bchip ${cls}`, text: s === 'open' && t.kind === 'proposal' ? 'proposed' : s });
};

/** Returns a disposer. */
export function renderBoard(root, { settings, license = null }) {
  root._boardDispose?.();
  root.innerHTML = '';
  const store = runStore(settings);
  const roster = rosterFor(settings, license, { like: settings.activeAgentId || '' });
  const state = { runs: {}, sel: null, reply: null, loaded: new Set(), err: '', drafts: {} };

  // A box the person may be typing in: its text survives a redraw, and so does its focus.
  let boxes = []; // the draft boxes of the current thread pane
  const draftBox = (key, attrs) => {
    const ta = el('textarea', attrs);
    ta._draftKey = key;
    ta.value = state.drafts[key] || '';
    ta.addEventListener('input', () => { state.drafts[key] = ta.value; });
    boxes.push(ta);
    return ta;
  };
  const focusedBox = () => { const a = document.activeElement; return a && a._draftKey ? a : null; };
  const restoreFocus = (was) => {
    const again = was && boxes.find((t) => t._draftKey === was._draftKey);
    if (!again) return;
    again.focus?.();
    try { again.setSelectionRange?.(was.selectionStart ?? again.value.length, was.selectionEnd ?? again.value.length); } catch { /* not focusable here */ }
  };
  let alive = true;

  const layout = el('div', { class: 'board' });
  const left = el('aside', { class: 'board-threads' });
  const right = el('section', { class: 'board-thread' });
  layout.append(left, right);
  root.append(
    el('div', { class: 'card-head' }, el('h2', {}, 'Board ', el('span', { class: 'sub', id: 'board-sub' }, ''))),
    el('p', { class: 'muted' }, 'Every run\'s board, from this panel or the desktop app: threads per task, the members\' posts and replies, the proposal to approve, and asks waiting on you. Answer, decide or reply here — the members read it.'),
    layout,
  );

  const refresh = async () => {
    const r = await store.list({ limit: 30 });
    if (!alive) return;
    if (!r.ok) { state.err = `gateway not reachable: ${r.error}`; draw(); return; }
    if (/^gateway not reachable/.test(state.err)) state.err = '';
    const list = r.data?.runs || [];
    const want = list.filter((x) => LIVE.has(x.status) || x.waiting > 0 || !state.loaded.has(x.id)).map((x) => x.id);
    if (state.sel?.runId && !want.includes(state.sel.runId)) want.push(state.sel.runId);
    const got = await Promise.all(want.map((id) => store.get(id).then((x) => [id, x.ok ? x.data?.run : null])));
    if (!alive) return;
    for (const [id, run] of got) if (run) { state.runs[id] = run; state.loaded.add(id); }
    draw();
  };

  const threads = () => {
    const all = Object.values(state.runs).filter((run) => run?.threads?.threads);
    const tag = (run, t) => ({ ...t, runId: run.id, team: run.team });
    const waiting = all.flatMap((run) => run.threads.threads.filter((t) => t.kind === 'ask' && t.status === 'waiting').map((t) => tag(run, t))).sort((a, b) => (b.lastAt || b.at) - (a.lastAt || a.at));
    const groups = all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((run) => ({ run, threads: run.threads.threads.filter((t) => !(t.kind === 'ask' && t.status === 'waiting')).map((t) => tag(run, t)).sort((a, b) => (b.lastAt || b.at) - (a.lastAt || a.at)) })).filter((g) => g.threads.length);
    return { waiting, groups };
  };

  const row = (t, pinned) => {
    const on = state.sel?.threadId === t.id;
    const b = el('button', { class: `bth${on ? ' on' : ''}${pinned ? ' pinned' : ''}`, type: 'button', onclick: () => { state.sel = { runId: t.runId, threadId: t.id }; state.reply = null; state.err = ''; draw({ force: true }); } },
      el('span', { class: 'bth-k', text: ICON[t.kind] || '·' }),
      el('span', {}, el('div', { class: 'bth-t', text: t.title }), el('div', { class: 'bth-m' }, chip(t), ` ${t.kind}${t.lastBy && t.lastBy !== 'runner' ? ` · last ${t.lastBy}` : ''} · ${ago(t.lastAt || t.at)}${t.posts ? ` · ${t.posts}` : ''}`)),
    );
    return b;
  };

  const draw = (opts = {}) => {
    const { waiting, groups } = threads();
    const sub = root.querySelector('#board-sub');
    // An error is said as it is — a resume that found no checkpoint is not "gateway not reachable".
    if (sub) sub.textContent = state.err ? `— ${state.err}` : waiting.length ? `${waiting.length} waiting on you` : `${groups.length} run${groups.length === 1 ? '' : 's'}`;
    left.innerHTML = '';
    if (!state.sel && (waiting[0] || groups[0]?.threads[0])) { const t = waiting[0] || groups[0].threads[0]; state.sel = { runId: t.runId, threadId: t.id }; }
    if (waiting.length) left.append(el('div', { class: 'bgrp', text: 'Waiting on you' }));
    for (const t of waiting) left.append(row(t, true));
    for (const g of groups) {
      left.append(el('div', { class: 'bgrp brun' }, el('b', { text: g.run.team }), ` · ${when(g.run.createdAt)} · ${g.run.status}${g.run.client ? ` · ${g.run.client}` : ''}`));
      for (const t of g.threads) left.append(row(t, false));
    }
    if (!waiting.length && !groups.length) left.append(el('div', { class: 'muted tiny', style: 'padding:12px', text: state.err ? `The gateway did not answer: ${state.err} (the board needs gateway 0.6.81+).` : 'No boards yet. Run a team from any chat (/its-name) and its threads appear here as it works.' }));
    // Mid-draft in this thread: the poll leaves the pane alone. (A deliberate redraw — Reply,
    // cancel, a post — calls drawThread itself and restores the draft into the new box.)
    const typing = focusedBox();
    if (typing && typing.value && !opts.force) return;
    drawThread();
  };

  const drawThread = () => {
    const was = focusedBox();
    boxes = [];
    right.innerHTML = '';
    const run = state.sel ? state.runs[state.sel.runId] : null;
    const thread = run?.threads?.threads.find((t) => t.id === state.sel.threadId);
    if (!run || !thread) { right.append(el('div', { class: 'muted tiny', style: 'padding:18px', text: 'Pick a thread.' })); return; }
    const roles = run.roles || [];
    const posts = run.threads.posts.filter((p) => p.threadId === thread.id);
    const live = LIVE.has(run.status);
    const spent = run.usage?.spent; const cap = run.usage?.cap || run.budget;
    // The run strip.
    right.append(el('div', { class: 'brun-strip' },
      el('div', {},
        el('div', { class: 'brun-t' }, el('b', { text: run.team }), el('span', { class: 'muted tiny mono', text: ` ${run.id} · ${when(run.createdAt)} · ${run.client || '?'} ` }), chip({ status: run.status })),
        el('div', { class: 'muted tiny brun-req', text: run.request || '' }),
        el('div', { class: 'blanes' }, ...(run.tasks || []).map((t) => {
          const lane = el('span', { class: `blane${t.status === 'waiting' ? ' waiting' : ''}`, title: t.transcript?.length ? `${t.transcript.length} steps on the record` : '' }, el('i', { style: `background:${colour(t.role, roles)}` }), el('b', { text: t.role }), el('span', { class: 'muted tiny', text: ` ${t.status}${t.model ? ` · ${t.model}` : ''}${t.findings ? ` · ${t.findings} findings` : ''}` }));
          // A task can be handed to another model mid-run: it CONTINUES its transcript there.
          if (live && !run.stale && (t.status === 'running' || t.status === 'waiting') && roster.length) {
            const sel = el('select', { class: 'blane-ho', title: 'Hand this task to another model — it continues from where it is' });
            sel.append(el('option', { value: '', text: 'hand off…' }));
            for (const c of roster.filter((x) => x.usable && x.id !== t.model)) sel.append(el('option', { value: c.id, text: c.kind === 'bridge' ? `${c.name} (agent)` : c.name }));
            sel.addEventListener('change', async () => { const m = sel.value; if (!m) return; const r = await handoffTask(settings, { runId: run.id, taskId: t.id, model: m, reason: 'handed off from the board' }); if (!r.ok) state.err = `hand-off: ${r.error}`; refresh(); });
            lane.append(sel);
          }
          return lane;
        })),
      ),
      el('div', { class: 'brun-side' },
        cap ? el('div', { class: 'muted tiny', text: `Budget ${cap.tokens ? `${spent?.tokens || 0} / ${cap.tokens} tokens` : ''}${cap.ms ? ` · ${Math.round((spent?.ms || 0) / 1000)}s / ${Math.round(cap.ms / 1000)}s` : ''}` }) : null,
        live && !run.stale ? el('button', { class: 'btn danger', type: 'button', text: 'Stop run', onclick: () => store.stop(run.id).then(refresh) }) : null,
        // A run whose client went away, or that stopped, waited or failed, picks up from its record.
        (run.resumable || (live && (run.quietMs || 0) > 60_000)) ? el('button', { class: 'btn primary', type: 'button', text: run.resumable ? 'Resume here' : `Resume here (quiet ${Math.round((run.quietMs || 0) / 1000)} s)`, title: 'Continue this run in this browser from its record — nothing already done is redone', onclick: async () => {
          const [{ streamChat }, { buildTurnTools }] = await Promise.all([import('./providers.js'), import('./turn-tools.js')]);
          const r = await resumeRunHere(settings, license, { runId: run.id, streamChat, buildTurnTools, bridgeUrl: settings.bridgeUrl || '', bridgeAvailable: false });
          if (!r.ok) state.err = `resume: ${r.error}`; refresh();
        } }) : null,
      ),
    ));
    right.append(el('div', { class: 'bthead' }, el('h3', { text: thread.title }), el('div', { class: 'muted tiny' }, chip(thread), ` ${thread.kind}${thread.by && thread.by !== 'runner' ? ` · opened by ${thread.by}` : ''} · ${posts.length} post${posts.length === 1 ? '' : 's'}`)));
    const list = el('div', { class: 'bposts' });
    const post = (p, depth) => {
      const decidable = (p.kind === 'draft' || p.kind === 'finding') && (p.status === 'proposed' || p.status === 'open') && !p.decidedBy;
      const body = el('div', { class: 'bpost-body' });
      body.append(el('div', { class: 'bwho' }, el('b', { text: p.by === 'person' ? 'you' : p.by }), el('span', { class: 'bkind', text: p.kind }), el('span', { text: ago(p.at) }), p.status === 'approved' ? el('span', { class: 'bchip ok', text: 'approved' }) : p.status === 'rejected' ? el('span', { class: 'bchip err', text: 'rejected' }) : p.status === 'proposed' ? el('span', { class: 'bchip on', text: 'proposed' }) : null));
      body.append(el('div', { class: 'btext md selectable', html: renderMarkdown(p.text || '') }));
      if (p.refs?.length) body.append(el('div', { class: 'brefs' }, ...p.refs.map((r) => el('span', { class: 'bref', text: r, title: r }))));
      if (p.kind === 'question' && thread.status === 'waiting' && p.ask) {
        const ask = el('div', { class: 'bask' });
        ask.append(el('div', {}, el('b', { text: 'What should it do? ' }), el('span', { class: 'muted tiny', text: 'The member waits up to 10 min, then the run checkpoints and resumes when you answer.' })));
        const send = async (text) => { if (!text.trim()) return; const r = await answerAsk(settings, { runId: run.id, threadId: thread.id, text: text.trim() }); if (!r.ok) ask.append(el('div', { class: 'status err', text: r.error })); else refresh(); };
        ask.append(el('div', { class: 'bask-opts' }, ...(p.ask.options || []).map((o) => el('button', { class: 'btn', type: 'button', text: o, onclick: () => send(o) }))));
        const ta = draftBox(`ask:${p.id}`, { rows: '2', placeholder: 'Or type the answer' });
        ask.append(ta, el('div', { class: 'bacts' }, el('button', { class: 'btn primary', type: 'button', text: 'Answer', onclick: () => { delete state.drafts[ta._draftKey]; send(ta.value); } }), el('span', { class: 'muted tiny', text: 'Posts as you; the member resumes with it.' })));
        body.append(ask);
      }
      const acts = el('div', { class: 'bacts' });
      if (decidable) {
        acts.append(el('button', { class: 'btn ok', type: 'button', text: 'Approve', onclick: () => store.decide(run.id, { postId: p.id, status: 'approved' }).then(refresh) }));
        acts.append(el('button', { class: 'btn danger', type: 'button', text: 'Reject', onclick: () => store.decide(run.id, { postId: p.id, status: 'rejected' }).then(refresh) }));
      }
      acts.append(el('button', { class: 'btn ghost', type: 'button', text: 'Reply', onclick: () => { state.reply = p; drawThread(); } }));
      body.append(acts);
      list.append(el('div', { class: `bpost${depth ? ' reply' : ''}`, style: depth ? `margin-left:${38 + (depth - 1) * 14}px` : '' }, el('span', { class: `bav${depth ? ' sm' : ''}`, style: `background:${colour(p.by, roles)}`, text: initial(p.by) }), body));
      for (const r of posts.filter((x) => x.replyTo === p.id)) post(r, depth + 1);
    };
    for (const p of posts.filter((x) => !x.replyTo)) post(p, 0);
    if (!posts.length) list.append(el('div', { class: 'muted tiny', text: 'Nothing posted here yet.' }));
    right.append(list);
    const compose = el('div', { class: 'bcompose' });
    if (state.reply) compose.append(el('div', { class: 'muted tiny' }, 'Replying to ', el('b', { text: state.reply.by }), ' · ', el('button', { class: 'btn ghost', type: 'button', text: 'cancel', onclick: () => { state.reply = null; drawThread(); } })));
    const ta = draftBox(`reply:${thread.id}`, { rows: '2', placeholder: 'Reply in this thread — as a member. “decide: …” settles it.' });
    const send = async () => {
      const text = ta.value.trim(); if (!text) return;
      const decision = /^decide:\s*/i.test(text);
      const r = await store.post(run.id, { threadId: thread.id, text: text.replace(/^decide:\s*/i, ''), kind: decision ? 'decision' : 'note', replyTo: state.reply?.id || null });
      if (!r.ok) { compose.append(el('div', { class: 'status err', text: r.error })); return; }
      delete state.drafts[ta._draftKey];
      state.reply = null; ta.value = ''; await refresh();
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
    compose.append(ta, el('div', { class: 'bacts' }, el('button', { class: 'btn primary', type: 'button', text: 'Post', onclick: send }), el('span', { class: 'muted tiny', text: 'On the gateway\'s run store: the desktop shows the same threads, and a member\'s next wave reads what you post.' })));
    right.append(compose);
    restoreFocus(was);
  };

  refresh();
  const timer = setInterval(refresh, POLL_MS);
  root._boardDispose = () => { alive = false; clearInterval(timer); root._boardDispose = null; };
  return () => root._boardDispose?.();
}
