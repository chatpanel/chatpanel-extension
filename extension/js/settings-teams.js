// Settings → Skills → Teams: the saved agent teams, readable and revocable — and every run
// any client ran, read from the gateway's run store, with its board and a Stop that reaches
// the client running it.
//
// A team is authored in conversation and approved on a card (events/team-tool.js), so this
// page never edits one — a person who wants a different team asks for it. The runs list is
// the desktop's Settings → Teams over the same route (gateway 0.6.78+): a run started in the
// desktop shows here as it grows. Deferred from settings.js, which is at its first-paint
// ceiling.

import { getSettings, saveSettings } from './store.js';
import { describeRole } from './events/team.js';
import { runStore } from './team-host.js';

const budgetText = (b = {}) => Object.entries(b).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const LIVE = new Set(['planning', 'running', 'merging']);

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

function boardView(run) {
  const box = el('div', { class: 'muted', style: 'font-size:12.4px' });
  box.append(el('div', { class: 'tiny', text: (run.tasks || []).map((t) => `${t.role} ${t.status}${t.findings ? ` (${t.findings})` : ''}`).join(' · ') }));
  const ul = el('ul', { style: 'margin:4px 0 0;padding-left:18px' });
  for (const f of run.board || []) ul.append(el('li', {}, el('b', { text: f.role }), ` · ${f.kind}: ${f.text}${f.refs?.length ? ` (${f.refs.join(', ')})` : ''}`));
  box.append(ul);
  if (run.proposal?.text) box.append(el('p', { style: 'white-space:pre-wrap;margin-top:8px', text: run.proposal.text }));
  return box;
}

/** Returns a disposer: the runs list polls while the card is on screen. */
export function renderTeams(root, { settings, onChange }) {
  root.innerHTML = '';
  const list = (Array.isArray(settings.teams) ? settings.teams : []).filter((t) => t && t.name);
  root.append(el('div', { class: 'card-head' },
    el('h2', {}, 'Teams ', el('span', { class: 'sub' }, `${list.length ? `${list.length} saved` : 'none yet'}`)),
  ));
  root.append(el('p', { class: 'muted' },
    'A team is several roles working one request in parallel, each with the tools you granted it and a shared budget, merged into one answer. '
    + 'Ask for one in chat (“run the research team on…”, or /its-name), or ask the assistant to propose a team after a task that needed several kinds of work. '
    + 'Teams and their runs are shared with the desktop app.'));
  const persist = async (next) => {
    await saveSettings({ ...(await getSettings()), teams: next });
    onChange?.(next);
  };
  list.forEach((t, i) => {
    const card = el('div', { class: `entity s-entity${t.enabled === false ? ' is-off' : ''}` });
    const toggle = el('input', { type: 'checkbox', title: 'Enabled' });
    toggle.checked = t.enabled !== false;
    toggle.addEventListener('change', () => persist(list.map((x, j) => (j === i ? { ...x, enabled: toggle.checked } : x))));
    card.append(el('div', { class: 'entity-head' },
      el('strong', { text: `/${t.name}` }),
      el('span', { class: 'muted', text: t.description || '' }),
      el('span', { class: 'muted tiny', text: `${t.plan || 'fixed'} · merge ${t.merge || 'concat'}${t.judge ? ` (${t.judge})` : ''} · budget ${budgetText(t.budget)}` }),
      el('label', { class: 'muted tiny', style: 'margin-left:auto;display:flex;gap:6px;align-items:center' }, toggle, 'Enabled'),
      el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: async () => {
        const { confirmDelete } = await import('./confirm-modal.js');
        if (!(await confirmDelete({ title: 'Delete team?', body: `/${t.name} will be removed from every client. Its past runs stay on the gateway.`, confirmLabel: 'Delete' }))) return;
        await persist(list.filter((_, j) => j !== i));
      } }),
    ));
    const roles = el('ul', { class: 'muted', style: 'margin:0;padding-left:20px;font-size:12px' });
    for (const r of t.roles || []) roles.append(el('li', { text: describeRole(r) }));
    card.append(roles);
    root.append(card);
  });

  // Runs — every client's, from the gateway. An older gateway (or none) says so; it is not an error.
  const store = runStore(settings);
  const runsHead = el('div', { class: 'card-head', style: 'margin-top:16px' }, el('h2', {}, 'Runs ', el('span', { class: 'sub', text: '' })));
  const runsNote = el('p', { class: 'muted', text: 'Every run from any client — this panel or the desktop app — with its board and what it spent. Stop reaches the client running it.' });
  const runsBox = el('div');
  root.append(runsHead, runsNote, runsBox);
  let open = null; // { id, run }
  let alive = true;
  const refresh = async () => {
    const res = await store.list({ limit: 30 });
    if (!alive) return;
    const sub = runsHead.querySelector('.sub');
    if (!res.ok) { sub.textContent = '— gateway not reachable'; runsNote.textContent = `The gateway did not answer: ${res.error} (runs need gateway 0.6.78+).`; runsBox.innerHTML = ''; return; }
    const runs = res.data?.runs || [];
    sub.textContent = runs.length ? `${runs.length} recent` : 'none yet';
    runsBox.innerHTML = '';
    for (const r of runs) {
      const live = LIVE.has(r.status) && !r.stale;
      const card = el('div', { class: 'entity s-entity' });
      card.append(el('div', { class: 'entity-head' },
        el('strong', { text: r.team || 'team' }),
        el('span', { class: 'muted', text: (r.request || '').slice(0, 120) }),
        el('span', { class: `chip ${r.stale ? 'warn' : r.status === 'completed' || live ? 'good' : 'warn'}`, text: r.stale ? 'stale' : r.status }),
        el('span', { class: 'muted tiny', text: `${when(r.createdAt)} · ${r.client || '?'} · ${r.findings || 0} findings${r.usage?.spent?.tokens ? ` · ${r.usage.spent.tokens} tokens` : ''}` }),
        live ? el('button', { class: 'btn', type: 'button', text: 'Stop', style: 'margin-left:auto', onclick: () => store.stop(r.id).then(refresh) }) : null,
        el('button', { class: 'btn', type: 'button', text: open?.id === r.id ? 'Hide' : 'Board', style: live ? '' : 'margin-left:auto', onclick: async () => {
          if (open?.id === r.id) { open = null; return refresh(); }
          const x = await store.get(r.id);
          if (x.ok) { open = { id: r.id, run: x.data?.run || {} }; refresh(); }
        } }),
      ));
      if (open?.id === r.id) card.append(boardView(open.run));
      runsBox.append(card);
    }
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  return () => { alive = false; clearInterval(timer); };
}
