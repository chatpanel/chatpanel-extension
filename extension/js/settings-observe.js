// Settings → Agent Teams → Observe (F8 §17.2): what is happening, where the time and money
// went, what needs you — the inbox, the engines' availability, one run's timeline, spend by
// agent / team / engine. Every number comes from events/team-observe.js (the desktop's
// ObserveTab reads the same); "—" where nothing priced it. Deferred, polling only while shown.

import { observeInbox, observeStrip, runLanes, spendRows, engineStrip } from './events/team-observe.js';
import { agentColor } from './events/team-org.js';
import { runStore } from './team-host.js';
import { agentAvatar } from './settings-agents.js';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
const money = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);
const mins = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`; };
const clock = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const isDark = () => { try { return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true; } catch { return false; } };
const stat = (value, label, detail, tone) => el('div', { class: 'org-stat' }, el('b', { text: value, ...(tone ? { style: `color:var(--${tone})` } : {}) }), el('span', { text: label }), el('i', { text: detail }));

/** Returns a disposer: polls while the card is on screen. */
export function renderObserve(root, { settings, openBoard = () => {} }) {
  root._observeDispose?.();
  root.innerHTML = '';
  const store = runStore(settings);
  const pool = (Array.isArray(settings.agentPool) ? settings.agentPool : []).filter((a) => a && a.id);
  const dark = isDark();
  const state = { runs: [], full: null, engines: [], by: 'agent', err: '' };
  root.append(el('div', { class: 'card-head' }, el('h2', {}, 'Observe ', el('span', { class: 'sub', text: '' }))));
  root.append(el('p', { class: 'muted', text: 'What is happening, where the time and money went, and what needs you. A number is shown only where it is known — a run through an agent tool reports no tokens, so its row says time, never a made-up price.' }));
  const strip = el('div', { class: 'org-strip' });
  const inbox = el('div', { class: 'org-panel' });
  const engines = el('div', { class: 'org-panel' });
  const timeline = el('div', { class: 'org-panel' });
  const spend = el('div', { class: 'org-panel' });
  root.append(strip, el('div', { class: 'org-two' }, inbox, engines), timeline, spend);
  const colourOf = (run, roleId) => { const role = (run?.roles || []).find((r) => r?.id === roleId); return agentColor(role?.agent || `${run?.team || ''}-${roleId}`, { dark }); };
  const draw = () => {
    const now = Date.now();
    const s = observeStrip(state.runs, { now });
    strip.innerHTML = '';
    strip.append(
      stat(String(s.live), 'live runs', s.stalled ? `${s.stalled} stalled > 2 min` : 'none stalled'),
      stat(String(s.asks), 'asks waiting', s.asks ? 'a run is paused on you' : 'nothing waits on you', s.asks ? 'danger' : ''),
      stat(money(s.spend.usd || null), 'spend, 7 days', `+ ${mins(s.spend.ms)} on agent tools`),
      stat(s.tasks.done + s.tasks.failed ? `${Math.round((s.tasks.done / (s.tasks.done + s.tasks.failed)) * 100)}%` : '—', 'tasks done', `${s.tasks.done} of ${s.tasks.done + s.tasks.failed} this week`),
      stat(String(s.completed), 'runs completed', `of ${s.runs} this week`),
    );
    const items = observeInbox(state.runs, { now });
    inbox.innerHTML = '';
    inbox.append(el('h3', {}, el('span', { text: 'Inbox' }), items.length ? el('span', { class: 'org-chip warn', text: String(items.length) }) : null));
    for (const i of items) {
      inbox.append(el('div', { class: `org-ask${i.kind === 'stalled' ? ' stalled' : ''}` },
        el('span', {}, el('b', { text: i.kind === 'ask' ? `${i.count} ask${i.count === 1 ? '' : 's'}` : 'stalled' }), ` · /${i.team} · ${i.request}`),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'btn primary', type: 'button', text: i.action === 'answer' ? 'Answer' : 'Open the board', onclick: openBoard })));
    }
    if (!items.length) inbox.append(el('div', { class: 'muted tiny', text: state.err ? `The gateway did not answer: ${state.err}` : 'Nothing needs you.' }));
    engines.innerHTML = '';
    engines.append(el('h3', { text: 'Engines · availability, last 24 h' }));
    for (const e of state.engines.slice(0, 8)) {
      engines.append(el('div', { class: 'org-lane' },
        el('div', { class: 'nm mono', title: e.key }, el('span', { text: e.label })),
        el('div', { class: 'org-avail' }, ...e.cells.map((c) => el('i', { class: c === 'declined' ? 'd' : c === 'none' ? 'n' : '' }))),
        el('div', { class: `muted tiny num${e.decliningNow ? ' risk' : ''}`, text: `${e.decliningNow ? 'declining now' : e.rate != null ? `${Math.round(e.rate * 100)}%` : '—'}${e.p50 != null ? ` · p50 ${(e.p50 / 1000).toFixed(1)} s` : ''}` })));
    }
    if (!state.engines.length) engines.append(el('div', { class: 'muted tiny', text: 'No engine has a record yet — a card grows from the runs\' routes and calls (gateway 0.6.89+).' }));
    timeline.innerHTML = '';
    const focus = state.full;
    const lanes = focus ? runLanes(focus, { now }) : null;
    timeline.append(el('h3', {}, el('span', { text: `Run timeline${focus ? ` · /${focus.team} · ${String(focus.request || '').slice(0, 60)}` : ''}` }), lanes ? el('span', { class: `org-chip ${lanes.live ? 'good' : ''}`, text: lanes.live ? `live ${clock(lanes.span)}` : clock(lanes.span) }) : null));
    if (lanes) {
      for (const l of lanes.lanes) {
        const role = (focus.roles || []).find((r) => r?.id === l.role);
        timeline.append(el('div', { class: 'org-lane', ...(l.parent ? { style: 'padding-left:16px' } : {}) },
          el('div', { class: 'nm' }, agentAvatar({ id: role?.agent || `${focus.team || ''}-${l.role}`, name: l.role || l.title }, { small: true }), el('span', { title: l.title, text: l.kind === 'merge' ? 'merge' : l.title })),
          el('div', { class: 'tl' }, ...l.segments.map((sg) => el('i', { class: sg.kind === 'declined' ? 'r' : sg.kind === 'waiting' ? 'a' : '', style: `left:${sg.from * 100}%;width:${Math.max(0.5, (sg.to - sg.from) * 100)}%${sg.kind === 'working' ? `;background:${colourOf(focus, l.role)}` : ''}`, title: sg.label }))),
          el('div', { class: 'muted tiny num', text: `${l.ms ? clock(l.ms) : ''}${l.status ? ` · ${l.status}` : ''}${l.findings ? ` · ${l.findings} findings` : ''}` })));
      }
      timeline.append(el('div', { class: 'org-axis' }, el('div'), el('div', {}, el('span', { text: '0:00' }), el('span', { text: clock(lanes.span / 2) }), el('span', { text: clock(lanes.span) })), el('div')));
      timeline.append(el('div', { class: 'muted tiny', text: 'A bar in the agent\'s colour is it working · violet is waiting on a person · red is a decline, then the rotation.' }));
    } else timeline.append(el('div', { class: 'muted tiny', text: 'No run to draw yet.' }));
    spend.innerHTML = '';
    const sel = el('select', {});
    for (const [v, t] of [['agent', 'by agent'], ['team', 'by team'], ['engine', 'by engine']]) sel.append(el('option', { value: v, text: t }));
    sel.value = state.by; sel.addEventListener('change', () => { state.by = sel.value; draw(); });
    spend.append(el('h3', {}, el('span', { text: 'Spend · 7 days' }), el('span', { style: 'flex:1' }), sel));
    const rows = spendRows(state.runs, { by: state.by, now });
    for (const r of rows.slice(0, 10)) {
      const label = state.by === 'agent' ? (pool.find((a) => a.id === r.key)?.name || r.key) : r.key;
      spend.append(el('div', { class: 'org-spend' },
        el('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, state.by === 'agent' ? agentAvatar(pool.find((a) => a.id === r.key) || { id: r.key, name: r.label }, { small: true }) : null, label),
        el('div', { class: 'bar', style: 'height:8px' }, el('i', { style: `width:${Math.round(r.share * 100)}%${state.by === 'agent' ? `;background:${agentColor(r.key, { dark })}` : ''}` })),
        el('span', { class: 'v', text: `${money(r.usd)} · ${mins(r.ms)}` })));
    }
    if (!rows.length) spend.append(el('div', { class: 'muted tiny', text: 'No spend recorded this week.' }));
    spend.append(el('div', { class: 'muted tiny', text: '“—” is a run through an agent tool that reports no tokens. Time is always known.' }));
  };
  let alive = true;
  const refresh = async () => {
    const res = await store.list({ limit: 50 });
    if (!alive) return;
    if (!res.ok) { state.err = res.error || 'no answer'; state.runs = []; draw(); return; }
    state.err = '';
    state.runs = res.data?.runs || [];
    const focus = [...state.runs].sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0)).find((r) => ['planning', 'running', 'merging', 'waiting'].includes(r.status)) || state.runs[0] || null;
    if (focus) { const r = await store.get(focus.id); if (alive && r.ok) state.full = r.data?.run || null; } else state.full = null;
    draw();
  };
  store.engines().then((r) => { if (alive && r.ok) { state.engines = (r.data?.engines || []).map(engineStrip); draw(); } }).catch(() => {});
  draw();
  refresh();
  const timer = setInterval(refresh, 5000);
  const dispose = () => { alive = false; clearInterval(timer); };
  root._observeDispose = dispose;
  return dispose;
}
