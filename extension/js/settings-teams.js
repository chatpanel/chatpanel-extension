// Settings → Skills → Teams: the saved agent teams, readable and revocable — and every run
// any client ran, read from the gateway's run store, with its board and a Stop that reaches
// the client running it.
//
// A team is made here on a form or added from a starter, or proposed in conversation and
// approved on a card (events/team-tool.js); `teamFromForm` is the one shaping either way, so
// a team made here is exactly a team made in the desktop or on the card. The runs list is
// the desktop's Settings → Teams over the same route (gateway 0.6.78+): a run started in the
// desktop shows here as it grows. Deferred from settings.js, which is at its first-paint
// ceiling.

import { getSettings, saveSettings } from './store.js';
import { starterTeams, blankTeam, teamFromForm, MERGE_POLICIES, PLAN_MODES, ROLE_PREFERS } from './events/team.js';
import { promoteRoles, teamHealth, teamShape, describeTeamShape, missingStarters, upsertAgents, builtinOrg } from './events/team-org.js';
import { runStore, rosterFor, appointerFor, answerAsk, resolveTeamHere } from './team-host.js';
import { agentAvatar, grantPicker } from './settings-agents.js';


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

/** An ask waiting on the person, with its options and an answer box — the member resumes with the answer. */
function askView(run, settings, refresh) {
  const box = el('div');
  const waiting = (run.threads?.threads || []).filter((t) => t.kind === 'ask' && t.status === 'waiting');
  for (const t of waiting) {
    const q = (run.threads.posts || []).find((p) => p.threadId === t.id && p.kind === 'question');
    const card = el('div', { style: 'margin:8px 0;padding:10px 12px;border:1px solid var(--danger);border-radius:9px;font-size:12.6px' });
    card.append(el('div', {}, el('b', { text: `${t.by} is waiting on you: ` }), q?.text || t.title));
    const send = async (text) => { if (!text.trim()) return; const r = await answerAsk(settings, { runId: run.id, threadId: t.id, text: text.trim() }); if (!r.ok) card.append(el('div', { class: 'muted tiny', text: r.error })); else refresh(); };
    const opts = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:8px 0' });
    for (const o of t.ask?.options || []) opts.append(el('button', { class: 'btn', type: 'button', text: o, onclick: () => send(o) }));
    const ta = el('textarea', { rows: '2', placeholder: 'Or type the answer', style: 'width:100%' });
    const row = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, el('button', { class: 'btn primary', type: 'button', text: 'Answer', onclick: () => send(ta.value) }), el('span', { class: 'muted tiny', text: 'Posts as you; the member resumes with it.' }));
    card.append(opts, ta, row);
    box.append(card);
  }
  return box;
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

const toForm = (t) => ({ ...t, roles: (t.roles || []).map((r) => ({ ...r, grants: Array.isArray(r.grants) ? r.grants.join(', ') : (r.agent ? '' : 'none') })), budget: { tokens: t.budget?.tokens ?? '', ms: t.budget?.ms ?? '', usd: t.budget?.usd ?? '' } });
const inp = (attrs, value, onInput) => { const n = el('input', attrs); n.value = value ?? ''; n.addEventListener('input', () => onInput(n.value)); return n; };
const sel = (options, value, onChange) => { const n = el('select'); for (const o of options) n.append(el('option', { value: o[0], text: o[1] })); n.value = value; n.addEventListener('change', () => onChange(n.value)); return n; };

/** The form — the same fields the `team` tool's save action takes. */
function teamEditor({ initial, servers, roster, pool = [], existingNames, onSave, onCancel }) {
  const f = toForm(initial);
  const root = el('div', { class: 'entity s-entity' });
  const errors = el('ul', { style: 'margin:4px 0;padding-left:18px;font-size:12.4px;color:var(--danger)' });
  const render = () => {
    root.innerHTML = '';
    const head = el('div', { class: 'entity-head', style: 'gap:8px' },
      el('span', { class: 'muted', text: '/' }),
      inp({ placeholder: 'name (a short identifier)', style: 'width:160px' }, f.name, (v) => { f.name = v.replace(/[^a-z0-9_-]/gi, '').toLowerCase(); }),
      inp({ placeholder: 'One line — what this team is for', style: 'flex:1' }, f.description, (v) => { f.description = v; }),
    );
    root.append(head);
    const opts = el('div', { class: 'muted tiny', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:6px 0' },
      el('label', {}, 'Plan ', sel(PLAN_MODES.map((m) => [m, m]), f.plan || 'fixed', (v) => { f.plan = v; })),
      el('label', {}, 'Merge ', sel(MERGE_POLICIES.map((m) => [m, m]), f.merge || 'concat', (v) => { f.merge = v; render(); })),
      f.merge === 'judge' ? el('label', {}, 'Judge ', sel([['', 'last role'], ...f.roles.map((r) => [r.id, r.id])], f.judge || '', (v) => { f.judge = v; })) : null,
      el('label', {}, 'Budget tokens ', inp({ type: 'number', min: '1', style: 'width:90px' }, f.budget.tokens, (v) => { f.budget.tokens = v; })),
      el('label', {}, 'ms ', inp({ type: 'number', min: '1', style: 'width:90px' }, f.budget.ms, (v) => { f.budget.ms = v; })),
      el('label', {}, 'usd ', inp({ type: 'number', min: '0', step: '0.01', style: 'width:70px' }, f.budget.usd, (v) => { f.budget.usd = v; })),
    );
    root.append(opts);
    f.roles.forEach((r, i) => {
      const card = el('div', { class: 'entity', style: 'margin:6px 0' });
      card.append(el('div', { class: 'entity-head', style: 'gap:8px' },
        inp({ placeholder: 'role id', style: 'width:130px' }, r.id, (v) => { r.id = v.replace(/[^a-z0-9_-]/gi, '').toLowerCase(); }),
        // A role may STAND FOR an agent from the pool: its prompt, grants, skills and engine
        // come from the card at run time; what is typed here narrows or adds to it.
        sel([['', 'no agent · a role of its own'], ...pool.map((a) => [a.id, `agent: ${a.name || a.id}`]), ...(r.agent && !pool.some((a) => a.id === r.agent) ? [[r.agent, `agent: ${r.agent} (not in the pool)`]] : [])], r.agent || '', (v) => { r.agent = v || undefined; render(); }),
        r.agent ? null : sel(ROLE_PREFERS.map((m) => [m, m]), r.prefer || 'balanced', (v) => { r.prefer = v; }),
        r.agent ? null : sel([['', 'auto · by tier'], ...roster.map((c) => [c.id, `${c.name}${c.kind === 'bridge' ? ' (agent)' : ''}${c.usable ? '' : ' — not usable'}`]), ...(r.model && !roster.some((c) => c.id === r.model) ? [[r.model, `${r.model} (not available now)`]] : [])], r.model || '', (v) => { r.model = v || undefined; }),
        el('button', { class: 'btn', type: 'button', text: 'Remove', onclick: () => { f.roles.splice(i, 1); render(); }, ...(f.roles.length === 1 ? { disabled: '' } : {}) }),
      ));
      // Grants as choices (team-org.js grantChoices); on a role that stands for an agent, checking some narrows what the agent already holds.
      card.append(grantPicker(String(r.grants || '').split(/[,\s]+/).filter(Boolean), { servers, narrowing: !!r.agent, onChange: (g) => { r.grants = g.includes('none') && r.agent ? '' : g.join(', '); } }));
      const ta = el('textarea', { rows: r.agent ? '2' : '3', placeholder: r.agent ? 'Optional — what this role adds in this team; the agent’s own prompt is used.' : 'What this role does.', style: 'width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px' });
      ta.value = r.prompt || '';
      ta.addEventListener('input', () => { r.prompt = ta.value; });
      card.append(ta);
      root.append(card);
    });
    root.append(errors);
    root.append(el('div', { style: 'display:flex;gap:8px;align-items:center' },
      el('button', { class: 'btn', type: 'button', text: '+ Role', onclick: () => { if (f.roles.length < 8) { f.roles.push({ id: `role${f.roles.length + 1}`, prompt: '', prefer: 'balanced', grants: 'none' }); render(); } } }),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: onCancel }),
      el('button', { class: 'btn primary', type: 'button', text: 'Save team', onclick: () => {
        const r = teamFromForm(f);
        errors.innerHTML = '';
        if (!r.ok) { for (const e of r.errors) errors.append(el('li', { text: e })); return; }
        if (existingNames.has(r.team.name)) { errors.append(el('li', { text: `A team named "${r.team.name}" already exists.` })); return; }
        onSave(r.team);
      } }),
    ));
  };
  render();
  return root;
}

/** Returns a disposer: the runs list polls while the card is on screen. */
export function renderTeams(root, { settings, onChange, editing = null, license = null }) {
  root._teamsDispose?.(); // a re-render (New team, Edit, Cancel) must not leave the last poll running
  root.innerHTML = '';
  // The saved section holds what a person made, edited or switched off; the list is the
  // built-in org over it (team-org.js builtinOrg): every starter present without a click.
  const saved = (Array.isArray(settings.teams) ? settings.teams : []).filter((t) => t && t.name);
  const roster = rosterFor(settings, license, { like: settings.activeAgentId || '' });
  const appointRole = appointerFor(settings, license, { like: settings.activeAgentId || '' });
  const servers = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).filter((x) => x && x.id);
  const savedPool = (Array.isArray(settings.agentPool) ? settings.agentPool : []).filter((a) => a && a.id);
  const org = builtinOrg(saved, savedPool);
  const list = org.teams;
  const poolAll = org.pool;
  const pool = poolAll.filter((a) => a.enabled !== false);
  const shippedNames = new Set(starterTeams().map((t) => t.name));
  // A team is saved WITH its cards (F8 §17.1): every inline role becomes a pool agent, a
  // starter brings the agents it stands on — so both sections move together, in one write.
  // `next` is the SAVED section (never a built-in as such); a built-in that is edited or
  // switched off is saved as a copy of ours, which then replaces it.
  const persist = async (next, cards = []) => {
    const nextPool = cards.length ? upsertAgents(savedPool, cards.filter((c) => !c.builtin)) : savedPool;
    await saveSettings({ ...(await getSettings()), teams: next, ...(cards.length ? { agentPool: nextPool } : {}) });
    onChange?.(next, cards.length ? nextPool : undefined);
  };
  const copyOf = (t) => { const { builtin, ...rest } = t; return rest; };
  const upsertTeam = (t) => (saved.some((x) => x.name === t.name) ? saved.map((x) => (x.name === t.name ? t : x)) : [...saved, t]);
  const actions = el('div', { class: 'card-actions' },
    el('button', { class: 'btn primary', type: 'button', text: '+ New team', ...(editing ? { disabled: '' } : {}), onclick: () => renderTeams(root, { settings, onChange, license, editing: { index: -1, team: blankTeam() } }) }),
  );
  root.append(el('div', { class: 'card-head' },
    el('h2', {}, 'Teams ', el('span', { class: 'sub' }, `${list.length} · ${list.filter((t) => t.builtin).length} built in`)),
    actions,
  ));
  root.append(el('p', { class: 'muted' },
    'A team is several roles working one request in parallel, each with the tools you granted it and a shared budget, merged into one answer. '
    + 'The built-in teams ship with the product and run as they are; edit one and your copy replaces it, switch it off and it is gone from the menu. '
    + 'Run any by typing /its-name in any chat, or by asking. Teams and their runs are shared with the desktop app.'));
  if (editing) {
    root.append(teamEditor({
      initial: editing.team, servers, roster, pool,
      existingNames: new Set(list.map((t) => t.name).filter((n) => n !== editing.team.name)),
      onCancel: () => renderTeams(root, { settings, onChange, license }),
      onSave: (form) => {
        const { team, agents } = promoteRoles(form, poolAll);
        const stamped = { ...team, createdAt: editing.team.createdAt || Date.now() };
        persist(upsertTeam(stamped), agents);
      },
    }));
  }
  list.forEach((t, i) => {
    const card = el('div', { class: `entity s-entity${t.enabled === false ? ' is-off' : ''}`, 'data-team': t.name, ...(t.builtin ? { 'data-builtin': '' } : {}) });
    const toggle = el('input', { type: 'checkbox', title: 'Enabled' });
    toggle.checked = t.enabled !== false;
    toggle.addEventListener('change', () => persist(upsertTeam({ ...copyOf(t), enabled: toggle.checked, createdAt: t.createdAt || Date.now() })));
    const isShipped = shippedNames.has(t.name);
    const isSaved = saved.some((x) => x.name === t.name);
    card.append(el('div', { class: 'entity-head' },
      el('strong', { text: `/${t.name}` }),
      t.builtin ? el('span', { class: 'org-chip on', text: 'built-in' }) : null,
      el('span', { class: 'muted', text: t.description || '' }),
      el('span', { class: 'muted tiny', text: `${t.plan || 'fixed'} · merge ${t.merge || 'concat'}${t.judge ? ` (${t.judge})` : ''} · budget ${budgetText(t.budget)}` }),
      el('label', { class: 'muted tiny', style: 'margin-left:auto;display:flex;gap:6px;align-items:center' }, toggle, 'Enabled'),
      el('button', { class: 'btn', type: 'button', text: 'Edit', ...(editing ? { disabled: '' } : {}), onclick: () => renderTeams(root, { settings, onChange, license, editing: { index: i, team: copyOf(t) } }) }),
      // A built-in is the product's: switched off or edited (your copy replaces it), never
      // deleted; an edited one can go back to what shipped.
      isShipped && isSaved ? el('button', { class: 'btn', type: 'button', text: 'Reset to built-in', title: 'Drop your copy; what ships comes back', onclick: () => persist(saved.filter((x) => x.name !== t.name)) }) : null,
      isShipped ? null : el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: async () => {
        const { confirmDelete } = await import('./confirm-modal.js');
        if (!(await confirmDelete({ title: 'Delete team?', body: `/${t.name} will be removed from every client. Its past runs stay on the gateway.`, confirmLabel: 'Delete' }))) return;
        await persist(saved.filter((x) => x.name !== t.name));
      } }),
    ));
    // The team AS ITS SHAPE (team-org.js): columns by dependency — a column runs in parallel,
    // the next waits — the judge last on its own, and you at the end, since nothing lands
    // without a person. Under each node, who the role would get on this panel right now.
    const health = teamHealth(t, poolAll);
    const shape = teamShape(t);
    let appointed = new Map();
    try { for (const r of resolveTeamHere(t, settings, license, { like: settings.activeAgentId || '' }).roles) appointed.set(r.id, r); } catch { /* a hole: drawn below, not thrown */ }
    const engineLine = (r) => {
      const res = appointed.get(r.id);
      if (!res) return r.agent ? `agent: ${r.agent}` : r.mode === 'recipe' ? `recipe ${r.recipe || ''}` : '';
      const got = res.mode === 'recipe' ? null : appointRole(res);
      return got ? `→ ${got.label || got.model}` : 'no model available';
    };
    const node = (r, cls = '') => {
      const hole = health.holes.find((h) => h.role === r.id);
      const a = r.agent ? poolAll.find((x) => x.id === r.agent) : null;
      const n = el('div', { class: `org-node${cls ? ` ${cls}` : ''}${hole ? ' hole' : ''}`, 'data-role': r.id },
        agentAvatar(hole ? { id: r.agent, name: '?' } : (a || { id: `${t.name}-${r.id}`, name: r.name || r.id }), { small: true }),
        el('div', {}, el('div', { class: 'n', text: hole ? `${r.id} — not in the pool` : (a?.name || r.name || r.id) }), el('div', { class: 'e', text: hole ? `agent: ${r.agent}` : engineLine(r) })));
      return n;
    };
    const drawing = el('div', { class: 'org-shape' });
    shape.columns.forEach((c, k) => {
      if (k) drawing.append(el('div', { class: 'org-arrow' }));
      drawing.append(el('div', { class: 'org-col' }, el('div', { class: 'org-col-lb', text: shape.columns.length > 1 ? `${k + 1}${c.parallel ? ' · parallel' : ''}` : (c.parallel ? 'parallel' : '') }), ...c.roles.map((r) => node(t.roles.find((x) => x.id === r.id) || r))));
    });
    if (shape.judge) { drawing.append(el('div', { class: 'org-arrow' })); drawing.append(el('div', { class: 'org-col' }, el('div', { class: 'org-col-lb', text: 'judge' }), node(t.roles.find((x) => x.id === shape.judge.id) || shape.judge, 'judge'))); }
    drawing.append(el('div', { class: 'org-arrow' }));
    drawing.append(el('div', { class: 'org-col' }, el('div', { class: 'org-col-lb', text: 'lands' }), el('div', { class: 'org-node person' }, el('span', { class: 'org-av sm', style: 'background:#7c4dff', text: 'Yo' }), el('div', {}, el('div', { class: 'n', text: 'You' }), el('div', { class: 'e', text: 'approve · reject · hand off' })))));
    card.append(el('div', { class: 'muted tiny', style: 'margin-top:4px', text: `${shape.kind} · ${describeTeamShape(shape)}` }), drawing);
    if (!health.ready) {
      const fixable = missingStarters(t, poolAll);
      card.append(el('div', { class: 'org-row', 'data-health': 'hole' },
        el('span', { class: 'org-chip risk', text: health.reason }),
        ...(fixable.length ? [el('button', { class: 'btn primary', type: 'button', text: `Add the built-in ${fixable.map((a) => a.name).join(', ')}`, onclick: () => persist(saved, fixable.map((a) => ({ ...a, createdAt: Date.now() }))) })] : []),
        ...(health.holes.some((h) => h.fix === 'pick') ? [el('span', { class: 'muted tiny', text: 'or pick another agent for the role with Edit' })] : []),
      ));
    } else card.append(el('div', { class: 'org-row', 'data-health': 'ready' }, el('span', { class: 'org-chip good', text: 'ready' }), el('span', { class: 'muted tiny', text: `run it with /${t.name} in any chat` })));
    // A team saved before roles were cards: its roles run and are scored, but the Agents tab
    // cannot see them. One click promotes them — the same save the form makes.
    if (health.inline.length) {
      card.append(el('div', { class: 'org-row', 'data-health': 'inline' },
        el('span', { class: 'org-chip warn', text: `${health.inline.length} role${health.inline.length === 1 ? ' is' : 's are'} not on the Agents tab yet` }),
        el('button', { class: 'btn', type: 'button', text: `Make ${health.inline.length === 1 ? 'it' : 'them'} cards`, onclick: () => { const { team, agents } = promoteRoles(t, poolAll); persist(upsertTeam({ ...copyOf(team), createdAt: t.createdAt || Date.now() }), agents); } }),
      ));
    }
    root.append(card);
  });

  // Runs — every client's, from the gateway. An older gateway (or none) says so; it is not an error.
  const store = runStore(settings);
  // Every finished run off the record at once; a live one is left for its Stop / Delete.
  let lastRuns = [];
  const clearBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Clear finished', style: 'margin-left:auto', hidden: '', onclick: async () => {
    const done = lastRuns.filter((r) => !LIVE.has(r.status) || r.stale);
    const { confirmDelete } = await import('./confirm-modal.js');
    if (!(await confirmDelete({ title: `Delete ${done.length} finished run${done.length === 1 ? '' : 's'}?`, body: 'Their boards, threads and spend leave the record for everyone — this panel and the desktop alike. Runs still going are kept. This cannot be undone.', confirmLabel: 'Delete' }))) return;
    await Promise.all(done.map((r) => store.remove(r.id)));
    refresh();
  } });
  const runsHead = el('div', { class: 'card-head', style: 'margin-top:16px' }, el('h2', {}, 'Runs ', el('span', { class: 'sub', text: '' })), clearBtn);
  const runsNote = el('p', { class: 'muted', text: 'Every run from any client — this panel or the desktop app — with its board and what it spent. Stop reaches the client running it; an ask waiting on you can be answered here, and the member resumes with it.' });
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
    lastRuns = runs;
    clearBtn.hidden = !runs.some((r) => !LIVE.has(r.status) || r.stale);
    sub.textContent = runs.length ? `${runs.length} recent` : 'none yet';
    runsBox.innerHTML = '';
    for (const r of runs) {
      const live = LIVE.has(r.status) && !r.stale;
      const card = el('div', { class: 'entity s-entity' });
      card.append(el('div', { class: 'entity-head' },
        el('strong', { text: r.team || 'team' }),
        el('span', { class: 'muted', text: (r.request || '').slice(0, 120) }),
        el('span', { class: `chip ${r.stale ? 'warn' : r.status === 'completed' || live ? 'good' : 'warn'}`, text: r.stale ? 'stale' : r.waiting ? `waiting on you (${r.waiting})` : r.status }),
        el('span', { class: 'muted tiny', text: `${when(r.createdAt)} · ${r.client || '?'} · ${r.findings || 0} findings${r.usage?.spent?.tokens ? ` · ${r.usage.spent.tokens} tokens` : ''}` }),
        live ? el('button', { class: 'btn', type: 'button', text: 'Stop', style: 'margin-left:auto', onclick: () => store.stop(r.id).then(refresh) }) : null,
        // Off the record for every client, board and all (a live one is stopped first, gateway 0.6.110).
        el('button', { class: 'btn ghost', type: 'button', text: 'Delete', style: live ? '' : 'margin-left:auto', onclick: async () => {
          const { confirmDelete } = await import('./confirm-modal.js');
          if (!(await confirmDelete({ title: 'Delete run?', body: `${live ? 'This run is still going: it is stopped first. ' : ''}Its board, threads and spend leave the record for everyone — this panel and the desktop alike. This cannot be undone.`, confirmLabel: 'Delete' }))) return;
          const x = await store.remove(r.id);
          if (!x.ok) runsNote.textContent = `delete: ${x.error}`;
          if (open?.id === r.id) open = null;
          refresh();
        } }),
        el('button', { class: 'btn', type: 'button', text: open?.id === r.id ? 'Hide' : 'Board', onclick: async () => {
          if (open?.id === r.id) { open = null; return refresh(); }
          const x = await store.get(r.id);
          if (x.ok) { open = { id: r.id, run: x.data?.run || {} }; refresh(); }
        } }),
      ));
      if (r.waiting && !(open?.id === r.id)) {
        // A waiting ask is shown without opening the board: it needs the person now.
        store.get(r.id).then((x) => { if (x.ok && alive) card.append(askView(x.data?.run || {}, settings, refresh)); });
      }
      if (open?.id === r.id) { card.append(askView(open.run, settings, refresh)); card.append(boardView(open.run)); }
      runsBox.append(card);
    }
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  root._teamsDispose = () => { alive = false; clearInterval(timer); root._teamsDispose = null; };
  // The caller's disposer must reach whichever render is CURRENT, not the one it was handed.
  return () => root._teamsDispose?.();
}
