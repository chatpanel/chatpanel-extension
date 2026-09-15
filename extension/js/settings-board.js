// Settings → Teams → Board: every run's board as a message board — the desktop's Agents →
// Board, drawn by the extension over the same gateway run store (0.6.81+).
//
// Left: asks waiting on you pinned at the top, then every run newest first with its threads.
// Right: the thread — posts with replies indented, Approve / Reject on a finding or the
// draft, an ask with its options and an answer box, a reply box at the bottom. A person here
// is a member: an answer resumes the member that asked (in whichever client runs it), a
// decision settles a post for everyone, a reply is read by the next wave.
//
// A TASK'S THREAD IS ITS WORK LOG (team-worklog.js): the prompt, the member's text and its
// reasoning, every tool call and what came back, the attempts and hand-offs, the runner's
// notes, the posts, and how it ended — one timeline, oldest first, the posts keeping their
// Approve / Reject / Reply. A task that failed before its first post used to show "Nothing
// posted here yet."; now it shows what it did and where it stopped.
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
import { workLogFor } from './events/team-worklog.js';
import { threadRows } from './events/team-subtask.js';
import { spendOf, describeSpend, runState, priorWorkFor } from './events/team-record.js';

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
/** The run's chip says what it IS — a record that reads `running` with no events for minutes is STALLED. */
const runChip = (run) => { const st = runState(run); return el('span', { class: `bchip ${st.tone === 'muted' ? '' : st.tone}`, title: st.detail, text: st.label }); };
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
  const state = { runs: {}, sel: null, reply: null, loaded: new Set(), err: '', drafts: {}, rows: { threadId: null, map: new Map() }, strip: { sig: '', el: null }, touchedAt: 0 };
  // WHAT A PERSON IS DOING BEATS WHAT THE POLL WANTS TO DRAW. A dropdown they opened, a fold
  // they just unfolded, a button under the pointer: the pane is left alone while any of that is
  // going on (a rebuilt pane closed the hand-off menu and folded the row they were reading,
  // every four seconds). Rows are cached by their stable id and REUSED when unchanged, so an
  // open fold stays open across the polls that do redraw.
  root.addEventListener('pointerdown', () => { state.touchedAt = Date.now(); }, true);
  root.addEventListener('toggle', () => { state.touchedAt = Date.now(); }, true);
  root.addEventListener('keydown', () => { state.touchedAt = Date.now(); }, true);
  const interacting = () => {
    const a = document.activeElement;
    if (a && root.contains(a) && (a.tagName === 'SELECT' || a.tagName === 'BUTTON')) return true;
    return Date.now() - state.touchedAt < 1500;
  };

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

  const refresh = async (opts = {}) => {
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
    // A run the gateway no longer lists — deleted from the Runs list here or on the desktop — leaves
    // this board too, with its selection. The two are one record; a board that outlived its run
    // is what made "I deleted the board, why is it still in recent?" a reasonable question.
    const listed = new Set(list.map((x) => x.id));
    for (const id of Object.keys(state.runs)) if (!listed.has(id)) { delete state.runs[id]; state.loaded.delete(id); if (state.sel?.runId === id) { state.sel = null; state.reply = null; } }
    draw(opts);
  };
  // A PERSON'S OWN ACTION REDRAWS, whatever the poll's guards say. Approve did nothing for a
  // week: the button they clicked kept focus, `interacting()` read that as "leave the pane
  // alone", and the decision — landed on the gateway — was never drawn. The record the store
  // answers with is taken as is; a refusal is shown, not swallowed.
  const acted = async (p) => {
    const r = await p;
    state.touchedAt = 0;
    if (r && r.ok === false) state.err = r.error || 'the gateway refused';
    else if (r?.data?.run?.id) { state.runs[r.data.run.id] = r.data.run; state.err = ''; }
    return refresh({ force: true });
  };

  const threads = () => {
    const all = Object.values(state.runs).filter((run) => run?.threads?.threads);
    const tag = (run, t) => ({ ...t, runId: run.id, team: run.team });
    const waiting = all.flatMap((run) => run.threads.threads.filter((t) => t.kind === 'ask' && t.status === 'waiting').map((t) => tag(run, t))).sort((a, b) => (b.lastAt || b.at) - (a.lastAt || a.at));
    // A sub-task's thread follows its parent's, indented (threadRows): the plan is a tree.
    const groups = all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((run) => ({ run, threads: threadRows(run.threads.threads.filter((t) => !(t.kind === 'ask' && t.status === 'waiting')).map((t) => tag(run, t)).sort((a, b) => (b.lastAt || b.at) - (a.lastAt || a.at))) })).filter((g) => g.threads.length);
    return { waiting, groups };
  };

  const row = (t, pinned) => {
    const on = state.sel?.threadId === t.id;
    const b = el('button', { class: `bth${on ? ' on' : ''}${pinned ? ' pinned' : ''}`, type: 'button', style: t.depth ? `padding-left:${8 + t.depth * 14}px` : null, onclick: () => { state.sel = { runId: t.runId, threadId: t.id }; state.reply = null; state.err = ''; draw({ force: true }); } },
      el('span', { class: 'bth-k', text: t.depth ? '↳' : (ICON[t.kind] || '·') }),
      el('span', {}, el('div', { class: 'bth-t', text: t.title }), el('div', { class: 'bth-m' }, chip(t), ` ${t.depth ? 'sub-task' : t.kind}${t.holder ? ` · ${t.holder}` : ''}${t.lastBy && t.lastBy !== 'runner' ? ` · last ${t.lastBy}` : ''} · ${ago(t.lastAt || t.at)}${t.posts ? ` · ${t.posts}` : ''}`)),
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
      left.append(el('div', { class: 'bgrp brun' }, el('b', { text: g.run.team }), ` · ${when(g.run.createdAt)} · `, runChip(g.run), `${g.run.client ? ` · ${g.run.client}` : ''}`));
      for (const t of g.threads) left.append(row(t, false));
    }
    if (!waiting.length && !groups.length) left.append(el('div', { class: 'muted tiny', style: 'padding:12px', text: state.err ? `The gateway did not answer: ${state.err} (the board needs gateway 0.6.81+).` : 'No boards yet. Run a team from any chat (/its-name) and its threads appear here as it works.' }));
    // Mid-draft in this thread: the poll leaves the pane alone. (A deliberate redraw — Reply,
    // cancel, a post — calls drawThread itself and restores the draft into the new box.)
    const typing = focusedBox();
    if (typing && typing.value && !opts.force) return;
    drawThread(opts);
  };

  const drawThread = (opts = {}) => {
    const run = state.sel ? state.runs[state.sel.runId] : null;
    const thread = run?.threads?.threads.find((t) => t.id === state.sel.threadId);
    // The poll redraws only when the THREAD changed — a rebuilt pane loses the reader's
    // place (someone scrolled to the bottom to read before typing was thrown back to the
    // top every four seconds). When it must redraw, the scroll position is carried over,
    // pinned to the bottom for a reader who was there.
    const key = run && thread ? `${run.id}:${thread.id}:${run.lastEventAt || 0}:${describeSpend(spendOf(run))}:${runState(run).key}:${run.status}:${thread.status}:${run.threads.posts.length}:${(run.tasks || []).map((t) => `${t.status}${t.transcript?.length || 0}${(t.text || '').length}`).join(',')}` : 'none';
    if (!opts.force && key === state.drawnKey) return;
    if (!opts.force && interacting()) return; // the next poll will draw it; nothing is lost, the record is on the store
    state.drawnKey = key;
    const prevList = right.querySelector('.bposts');
    const scroll = prevList ? { top: prevList.scrollTop, atBottom: prevList.scrollHeight - prevList.clientHeight - prevList.scrollTop < 12 } : null;
    const was = focusedBox();
    boxes = [];
    right.innerHTML = '';
    if (!run || !thread) { right.append(el('div', { class: 'muted tiny', style: 'padding:18px', text: 'Pick a thread.' })); return; }
    const roles = run.roles || [];
    const posts = run.threads.posts.filter((p) => p.threadId === thread.id);
    const live = LIVE.has(run.status);
    const rs = runState(run);
    const spend = spendOf(run);
    // The run strip — reused when nothing on it changed, so a hand-off menu a person opened
    // is the same element after the poll.
    const stripSig = JSON.stringify([run.id, rs.key, rs.detail, describeSpend(spend), spend?.exhausted, run.resumable, Math.round((run.quietMs || 0) / 30000), roster.map((c) => c.id), (run.tasks || []).map((t) => [t.id, t.role, t.status, t.model, t.findings, t.transcript?.length || 0])]);
    if (state.strip.el && state.strip.sig === stripSig) right.append(state.strip.el);
    else { state.strip = { sig: stripSig, el: buildStrip() }; right.append(state.strip.el); }
    function buildStrip() { return el('div', { class: 'brun-strip' },
      el('div', {},
        el('div', { class: 'brun-t' }, el('b', { text: run.team }), el('span', { class: 'muted tiny mono', text: ` ${run.id} · ${when(run.createdAt)} · ${run.client || '?'} ` }), runChip(run), rs.detail ? el('span', { class: 'muted tiny', text: ` ${rs.detail}` }) : null),
        el('div', { class: 'muted tiny brun-req', text: run.request || '' }),
        el('div', { class: 'blanes' }, ...(run.tasks || []).map((t) => {
          const lane = el('span', { class: `blane${t.status === 'waiting' ? ' waiting' : ''}`, title: t.transcript?.length ? `${t.transcript.length} steps on the record` : '' }, el('i', { style: `background:${colour(t.role, roles)}` }), el('b', { text: t.role }), el('span', { class: 'muted tiny', text: ` ${t.status}${t.model ? ` · ${t.model}` : ''}${t.findings ? ` · ${t.findings} findings` : ''}` }));
          // A task can be handed to another model mid-run: it CONTINUES its transcript there.
          if (live && !run.stale && (t.status === 'running' || t.status === 'waiting') && roster.length) {
            const sel = el('select', { class: 'blane-ho', title: 'Hand this task to another model — it continues from where it is' });
            sel.append(el('option', { value: '', text: 'hand off…' }));
            for (const c of roster.filter((x) => x.usable && x.id !== t.model)) sel.append(el('option', { value: c.id, text: c.kind === 'bridge' ? `${c.name} (agent)` : c.name }));
            sel.addEventListener('change', async () => { const m = sel.value; if (!m) return; const r = await handoffTask(settings, { runId: run.id, taskId: t.id, model: m, reason: 'handed off from the board' }); if (!r.ok) state.err = `hand-off: ${r.error}`; acted(r); });
            lane.append(sel);
          }
          return lane;
        })),
      ),
      el('div', { class: 'brun-side' },
        spend ? el('div', { class: 'muted tiny', text: `Budget ${describeSpend(spend)}${spend.exhausted ? ` — ${spend.exhausted} exhausted` : ''}` }) : null,
        live && !run.stale ? el('button', { class: 'btn danger', type: 'button', text: 'Stop run', onclick: () => acted(store.stop(run.id)) }) : null,
        // The run and its board go together (gateway DELETE /v1/teams/runs/:id; 0.6.110 stops a live one first).
        el('button', { class: 'btn ghost', type: 'button', text: 'Delete run', title: live ? 'Stops this run and removes it, with its board and threads, from every client.' : 'Removes this run, with its board and threads, from every client.', onclick: async () => {
          const { confirmDelete } = await import('./confirm-modal.js');
          if (!(await confirmDelete({ title: 'Delete run?', body: `${live ? 'This run is still going: it is stopped first. ' : ''}Its board, threads and spend leave the record for everyone — this panel and the desktop alike. This cannot be undone.`, confirmLabel: 'Delete' }))) return;
          const r = await store.remove(run.id);
          if (r.ok) { delete state.runs[run.id]; state.loaded.delete(run.id); state.sel = null; state.reply = null; }
          acted(r);
        } }),
        // A run whose client went away, or that stopped, waited or failed, picks up from its record.
        (run.resumable || (live && (run.quietMs || 0) > 60_000)) ? el('button', { class: 'btn primary', type: 'button', text: run.resumable ? 'Resume here' : `Resume here (quiet ${Math.round((run.quietMs || 0) / 1000)} s)`, title: 'Continue this run in this browser from its record — nothing already done is redone', onclick: async () => {
          const [{ streamChat }, { buildTurnTools }] = await Promise.all([import('./providers.js'), import('./turn-tools.js')]);
          const r = await resumeRunHere(settings, license, { runId: run.id, streamChat, buildTurnTools, bridgeUrl: settings.bridgeUrl || '', bridgeAvailable: false });
          if (!r.ok) state.err = `resume: ${r.error}`; acted(r);
        } }) : null,
      ),
    ); }
    // A thread comes off the board on a person's say-so (gateway 0.6.106+) — its posts with
    // it, for everyone. Not a waiting ask: the member behind it is blocked on an answer.
    const removable = !(thread.kind === 'ask' && thread.status === 'waiting');
    const removeBtn = removable ? el('button', { class: 'btn ghost bth-rm', type: 'button', text: 'Delete thread', title: live ? 'Takes this thread and its posts off the board for everyone. The run keeps going; what its member posts here later is dropped.' : 'Takes this thread and its posts off the board for everyone.', onclick: async () => {
      const { confirmDelete } = await import('./confirm-modal.js');
      if (!(await confirmDelete({ title: 'Delete thread?', body: `"${thread.title}" and its ${posts.length} post${posts.length === 1 ? '' : 's'} leave the board for everyone — this panel and the desktop alike. This cannot be undone.`, confirmLabel: 'Delete' }))) return;
      state.touchedAt = 0;
      const r = await store.removeThread(run.id, thread.id);
      if (r.ok) { state.sel = null; state.reply = null; state.rows = { threadId: null, map: new Map() }; }
      // A 404 here is an older gateway, not a missing thread — the list it just drew came from the same run.
      else state.err = /404/.test(String(r.error || '')) ? 'delete: the gateway needs 0.6.106+ to remove a thread — update it' : `delete: ${r.error}`;
      acted(r);
    } }) : null;
    right.append(el('div', { class: 'bthead' }, el('div', { class: 'bthead-row' }, el('h3', { text: thread.title }), removeBtn), el('div', { class: 'muted tiny' }, chip(thread), ` ${thread.kind}${thread.parent ? ` · sub-task of ${run.tasks?.find((x) => x.id === thread.parent)?.title || thread.parent}` : ''}${thread.holder ? ` · held by ${thread.holder}` : ''}${thread.by && thread.by !== 'runner' ? ` · opened by ${thread.by}` : ''} · ${posts.length} post${posts.length === 1 ? '' : 's'}`)));
    const list = el('div', { class: 'bposts' });
    const post = (p, depth) => {
      // A DRAFT (the proposal, a proposed agent) is decided; a FINDING is not — it is a member's
      // claim with its ref, on the record. A person can STRIKE a wrong one so the next wave and
      // the merge drop it; thirty-seven Approve buttons under a researcher's findings read as
      // thirty-seven decisions owed.
      const decidable = p.kind === 'draft' && (p.status === 'proposed' || p.status === 'open') && !p.decidedBy;
      const strikable = p.kind === 'finding' && p.status !== 'rejected' && !p.decidedBy;
      const body = el('div', { class: 'bpost-body' });
      body.append(el('div', { class: 'bwho' }, el('b', { text: p.by === 'person' ? 'you' : p.by }), el('span', { class: 'bkind', text: p.kind }), el('span', { text: ago(p.at) }), p.status === 'approved' ? el('span', { class: 'bchip ok', text: 'approved' }) : p.status === 'rejected' ? el('span', { class: 'bchip err', text: 'rejected' }) : p.status === 'proposed' ? el('span', { class: 'bchip on', text: 'proposed' }) : null));
      body.append(el('div', { class: 'btext md selectable', html: renderMarkdown(p.text || '') }));
      if (p.refs?.length) body.append(el('div', { class: 'brefs' }, ...p.refs.map((r) => el('span', { class: 'bref', text: r, title: r }))));
      if (p.kind === 'question' && thread.status === 'waiting' && p.ask) {
        const ask = el('div', { class: 'bask' });
        ask.append(el('div', {}, el('b', { text: 'What should it do? ' }), el('span', { class: 'muted tiny', text: 'The member waits up to 10 min, then the run checkpoints and resumes when you answer.' })));
        const send = async (text) => { if (!text.trim()) return; const r = await answerAsk(settings, { runId: run.id, threadId: thread.id, text: text.trim() }); if (!r.ok) ask.append(el('div', { class: 'status err', text: r.error })); else await acted(r); };
        ask.append(el('div', { class: 'bask-opts' }, ...(p.ask.options || []).map((o) => el('button', { class: 'btn', type: 'button', text: o, onclick: () => send(o) }))));
        const ta = draftBox(`ask:${p.id}`, { rows: '2', placeholder: 'Or type the answer' });
        ask.append(ta, el('div', { class: 'bacts' }, el('button', { class: 'btn primary', type: 'button', text: 'Answer', onclick: () => { delete state.drafts[ta._draftKey]; send(ta.value); } }), el('span', { class: 'muted tiny', text: 'Posts as you; the member resumes with it.' })));
        body.append(ask);
      }
      const acts = el('div', { class: 'bacts' });
      if (decidable) {
        acts.append(el('button', { class: 'btn ok', type: 'button', text: 'Approve', onclick: () => acted(store.decide(run.id, { postId: p.id, status: 'approved' })) }));
        acts.append(el('button', { class: 'btn danger', type: 'button', text: 'Reject', onclick: () => acted(store.decide(run.id, { postId: p.id, status: 'rejected' })) }));
      }
      if (strikable) acts.append(el('button', { class: 'btn ghost', type: 'button', text: 'Strike', title: 'Wrong or stale: drop this finding from what the members and the merge read', onclick: () => acted(store.decide(run.id, { postId: p.id, status: 'rejected' })) }));
      acts.append(el('button', { class: 'btn ghost', type: 'button', text: 'Reply', onclick: () => { state.reply = p; drawThread({ force: true }); } }));
      body.append(acts);
      return el('div', { class: `bpost${depth ? ' reply' : ''}`, style: depth ? `margin-left:${38 + (depth - 1) * 14}px` : '' }, el('span', { class: `bav${depth ? ' sm' : ''}`, style: `background:${colour(p.by, roles)}`, text: initial(p.by) }), body);
    };
    // A post and its replies, in reading order, each with a stable id and a signature of
    // what could change on it.
    const postRows = (p, depth) => {
      const out = [{ id: `post:${p.id}`, sig: JSON.stringify([p.status, p.decidedBy, p.text, p.refs, depth, p.kind === 'question' && thread.status === 'waiting', state.reply?.id === p.id]), build: () => post(p, depth) }];
      for (const r of posts.filter((x) => x.replyTo === p.id)) out.push(...postRows(r, depth + 1));
      return out;
    };
    // The list is REBUILT FROM CACHE: a row whose signature is unchanged is the same element
    // (its fold stays open); only new or changed rows are built. Rows no longer on the log go.
    const cache = state.rows.threadId === thread.id ? state.rows.map : new Map();
    state.rows = { threadId: thread.id, map: new Map() };
    const place = (row) => {
      const had = cache.get(row.id);
      const node = had && had.sig === row.sig ? had.el : row.build();
      if (!node) return;
      state.rows.map.set(row.id, { sig: row.sig, el: node });
      list.append(node);
    };
    // A timeline row that is not a post: who · what · when, the body folded when it is long.
    const fold = (text, open = false) => {
      const t = String(text || '');
      if (t.length <= 240 && !t.includes('\n')) return el('div', { class: 'blog-t selectable', text: t });
      const d = el('details', { class: 'blog-d' }, el('summary', { text: `${t.slice(0, 160).replace(/\s+/g, ' ')}…` }), el('pre', { class: 'blog-pre selectable', text: t }));
      if (open) d.setAttribute('open', '');
      return d;
    };
    const rowFor = (e) => {
      const who = e.by === 'tool' ? '' : e.by;
      const meta = (label, extra = '') => el('div', { class: 'bwho' }, who ? el('b', { text: who === 'person' ? 'you' : who }) : null, el('span', { class: 'bkind', text: label }), extra ? el('span', { class: 'muted tiny', text: extra }) : null, el('span', { text: ago(e.at) }));
      const body = el('div', { class: 'bpost-body' });
      let icon = '·'; let cls = '';
      switch (e.kind) {
        case 'attempt': icon = '▸'; cls = 'runner'; body.append(meta(`attempt ${e.attempt}`, `${e.model}${e.continued ? ' · continues the transcript' : ''}${e.status && e.status !== 'ok' ? ` · ${e.status}` : ''}`)); break;
        case 'prompt': icon = '⌗'; cls = 'runner'; body.append(meta('task'), fold(e.text)); break;
        case 'note': icon = '▸'; cls = 'runner'; body.append(meta('runner'), fold(e.text)); break;
        case 'thought': icon = '…'; cls = 'thought'; body.append(meta('thinking'), fold(e.text)); break;
        case 'text': icon = e.live ? '◌' : '¶'; body.append(meta(e.live ? 'saying' : 'said'), el('div', { class: 'btext md selectable', html: renderMarkdown(e.text || '') })); break;
        case 'call': icon = '→'; cls = 'call'; body.append(meta('called', e.text)); if (e.args && Object.keys(e.args).length) body.append(fold(JSON.stringify(e.args, null, 1))); break;
        case 'result': icon = e.error ? '✗' : '←'; cls = e.error ? 'err' : 'result'; body.append(meta(e.error ? 'failed' : 'returned', e.name), fold(e.text, e.error)); break;
        case 'handoff': icon = '⇄'; cls = 'runner'; body.append(meta('handed off', `${e.from} → ${e.to} by ${e.by}${e.text ? ` — ${e.text}` : ''}`)); break;
        case 'end': icon = e.status === 'ok' ? '✓' : e.status === 'waiting' ? '?' : '✗'; cls = e.status === 'ok' ? 'ok' : e.status === 'waiting' ? 'wait' : 'err'; body.append(meta(e.status, e.text)); break;
        default: return null;
      }
      return el('div', { class: `bpost blog ${cls}` }, el('span', { class: 'bav sm blog-i', text: icon }), body);
    };
    const log = thread.kind === 'task' && thread.taskId ? workLogFor(run, thread.taskId) : [];
    if (log.length) {
      for (const e of log) {
        if (e.kind === 'post') { if (!e.post.replyTo) for (const row of postRows(e.post, 0)) place(row); continue; }
        // A row's own fields are its signature (`at` is stable per entry; the live text changes and is rebuilt).
        place({ id: e.id || `${e.kind}:${e.at}`, sig: JSON.stringify([e.kind, e.text, e.status, e.error, e.model, e.name, e.live]), build: () => rowFor(e) });
      }
    } else {
      for (const p of posts.filter((x) => !x.replyTo)) for (const row of postRows(p, 0)) place(row);
      if (!posts.length) list.append(el('div', { class: 'muted tiny', text: 'Nothing posted here yet.' }));
    }
    right.append(list);
    if (scroll) list.scrollTop = scroll.atBottom ? list.scrollHeight : scroll.top;
    const compose = el('div', { class: 'bcompose' });
    if (state.reply) compose.append(el('div', { class: 'muted tiny' }, 'Replying to ', el('b', { text: state.reply.by }), ' · ', el('button', { class: 'btn ghost', type: 'button', text: 'cancel', onclick: () => { state.reply = null; drawThread({ force: true }); } })));
    const ta = draftBox(`reply:${thread.id}`, { rows: '2', placeholder: 'Reply in this thread — as a member. “decide: …” settles it.' });
    const send = async () => {
      const text = ta.value.trim(); if (!text) return;
      const decision = /^decide:\s*/i.test(text);
      const r = await store.post(run.id, { threadId: thread.id, text: text.replace(/^decide:\s*/i, ''), kind: decision ? 'decision' : 'note', replyTo: state.reply?.id || null });
      if (!r.ok) { compose.append(el('div', { class: 'status err', text: r.error })); return; }
      delete state.drafts[ta._draftKey];
      state.reply = null; ta.value = ''; await acted(r);
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
