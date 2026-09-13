// Settings → Agents: the pool — the agents you define, each with a name, a specialty, a
// prompt, skills, grants and an ENGINE (a model from Models, a coding agent from Harnesses,
// auto by policy, or the chat's own model for the built-in Assistant), and the scorecard
// of what it has actually done, read from the gateway.
//
// `agentFromForm` is the one shaping (events/agent.js), so an agent made here is exactly an
// agent made in the desktop. The pool is the shared `agents` section (settings.agentPool —
// NOT settings.agents, which is the harness list); a team's role says `agent: <id>` and is
// filled from here at run time. Deferred from settings.js, which is at its first-paint ceiling.

import { getSettings, saveSettings } from './store.js';
import { starterAgents, blankAgent, agentFromForm, assistantAgent, describeAgent, APPLIES_TO } from './events/agent.js';
import { describeEngine, ROUTE_PREFERS } from './events/engine.js';
import { GRANTABLE } from './events/team.js';
import { rosterFor, runStore } from './team-host.js';

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
const inp = (attrs, value, onInput) => { const n = el('input', attrs); n.value = value ?? ''; n.addEventListener('input', () => onInput(n.value)); return n; };
const sel = (options, value, onChange) => { const n = el('select'); for (const o of options) n.append(el('option', { value: o[0], text: o[1] })); n.value = value; n.addEventListener('change', () => onChange(n.value)); return n; };
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/** The engine, on the form: kind + what the kind needs. `roster` is this panel's endpoints and installed agents. */
function engineEditor(f, roster, render) {
  const e = f.engine && typeof f.engine === 'object' ? f.engine : { kind: 'auto', prefer: 'balanced' };
  f.engine = e;
  const models = roster.filter((c) => c.kind !== 'bridge');
  const harnesses = roster.filter((c) => c.kind === 'bridge');
  const box = el('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' });
  box.append(sel([['auto', 'auto · the recruiter picks'], ['model', 'a model'], ['harness', 'a coding agent (harness)'], ['assistant', 'the chat’s model']], e.kind || 'auto', (v) => { f.engine = v === 'auto' ? { kind: 'auto', prefer: e.prefer || 'balanced' } : { kind: v }; render(); }));
  if (e.kind === 'auto') box.append(sel(ROUTE_PREFERS.map((p) => [p, p.replace(/-/g, ' ')]), e.prefer || e.policy?.prefer || 'balanced', (v) => { e.prefer = v; }));
  if (e.kind === 'model') {
    const cur = e.providerId ? `${e.providerId}|${e.model || ''}` : (e.model || '');
    box.append(sel([['', 'pick a model…'], ...models.map((c) => [`${c.id}|${c.model || ''}`, `${c.name}${c.model && c.model !== c.name ? ` · ${c.model}` : ''}${c.usable ? '' : ' — not usable'}`]), ...(cur && !models.some((c) => `${c.id}|${c.model || ''}` === cur) ? [[cur, `${e.model} (not configured now)`]] : [])], cur, (v) => { const [providerId, model] = v.split('|'); e.providerId = providerId || undefined; e.model = model || providerId || ''; }));
  }
  if (e.kind === 'harness') {
    box.append(sel([['', 'pick a harness…'], ...harnesses.map((c) => [c.bridgeAgent || c.id, `${c.name}${c.usable ? '' : ' — not usable'}`]), ...(e.harnessId && !harnesses.some((c) => (c.bridgeAgent || c.id) === e.harnessId) ? [[e.harnessId, `${e.harnessId} (not installed now)`]] : [])], e.harnessId || '', (v) => { e.harnessId = v; }));
    box.append(inp({ placeholder: 'model (optional)', style: 'width:130px' }, e.model || '', (v) => { e.model = v || undefined; }));
  }
  return box;
}

function agentEditor({ initial, roster, servers, existingIds, onSave, onCancel }) {
  const f = { ...initial, skills: (initial.skills || []).join(', '), grants: (initial.grants || ['none']).join(', '), appliesTo: [...(initial.appliesTo || ['jobs'])] };
  if (f.engine?.kind === 'auto') f.engine = { kind: 'auto', prefer: f.engine.policy?.prefer || f.engine.prefer || 'balanced' };
  const root = el('div', { class: 'entity s-entity' });
  const errors = el('ul', { style: 'margin:4px 0;padding-left:18px;font-size:12.4px;color:var(--danger)' });
  const grantHint = `${GRANTABLE.join(' · ')}${servers.length ? ` · ${servers.map((x) => `mcp:${x.id}`).join(' · ')}` : ''}`;
  const render = () => {
    root.innerHTML = '';
    root.append(el('div', { class: 'entity-head', style: 'gap:8px' },
      inp({ placeholder: 'id (blank: from the name)', style: 'width:150px' }, f.id, (v) => { f.id = v.replace(/[^a-z0-9_-]/gi, '').toLowerCase(); }),
      inp({ placeholder: 'Name', style: 'width:160px' }, f.name, (v) => { f.name = v; }),
      inp({ placeholder: 'Specialty — one line', style: 'flex:1' }, f.purpose, (v) => { f.purpose = v; }),
    ));
    root.append(el('div', { class: 'muted tiny', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:6px 0' },
      el('label', {}, 'Engine ', engineEditor(f, roster, render)),
      el('label', {}, 'Applies to ', ...APPLIES_TO.map((a) => { const cb = el('input', { type: 'checkbox' }); cb.checked = f.appliesTo.includes(a); cb.addEventListener('change', () => { f.appliesTo = cb.checked ? [...new Set([...f.appliesTo, a])] : f.appliesTo.filter((x) => x !== a); }); return el('span', { style: 'margin-right:6px' }, cb, ` ${a}`); })),
    ));
    root.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0' },
      inp({ placeholder: `grants: ${grantHint}`, title: `Tools this agent may hold: ${grantHint}`, style: 'flex:1;min-width:220px' }, f.grants, (v) => { f.grants = v; }),
      inp({ placeholder: 'skills: names, comma-separated', style: 'flex:1;min-width:180px' }, f.skills, (v) => { f.skills = v; }),
      inp({ placeholder: 'working directory (a repository, for a harness engine)', style: 'flex:1;min-width:220px' }, f.workdir || '', (v) => { f.workdir = v; }),
    ));
    const ta = el('textarea', { rows: '5', placeholder: 'The prompt: what this agent does, how it works, what it must not do.', style: 'width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px' });
    ta.value = f.prompt || '';
    ta.addEventListener('input', () => { f.prompt = ta.value; });
    root.append(ta, errors);
    root.append(el('div', { style: 'display:flex;gap:8px;align-items:center' },
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: onCancel }),
      el('button', { class: 'btn primary', type: 'button', text: 'Save agent', onclick: () => {
        const r = agentFromForm(f);
        errors.innerHTML = '';
        if (!r.ok) { for (const e of r.errors) errors.append(el('li', { text: e })); return; }
        if (existingIds.has(r.agent.id)) { errors.append(el('li', { text: `An agent with the id "${r.agent.id}" already exists.` })); return; }
        onSave(r.agent);
      } }),
    ));
  };
  render();
  return root;
}

/** One agent's card: what it is, what it runs on, what it has done (the gateway's scorecard). */
function agentCard(a, { roster, store, editing, onEdit, onDelete, onToggle, fixed = false }) {
  const card = el('div', { class: `entity s-entity${a.enabled === false ? ' is-off' : ''}` });
  const harnessName = (id) => roster.find((c) => c.kind === 'bridge' && (c.bridgeAgent === id || c.id === id))?.name || id;
  const providerName = (id) => roster.find((c) => c.id === id)?.name || id;
  const head = el('div', { class: 'entity-head' },
    el('strong', { text: a.name || a.id }),
    el('span', { class: 'muted', text: a.purpose || '' }),
    el('span', { class: 'chip', text: describeEngine(a.engine, { harnessName, providerName }) }),
  );
  if (!fixed) {
    const toggle = el('input', { type: 'checkbox', title: 'Enabled' });
    toggle.checked = a.enabled !== false;
    toggle.addEventListener('change', () => onToggle(toggle.checked));
    head.append(
      el('label', { class: 'muted tiny', style: 'margin-left:auto;display:flex;gap:6px;align-items:center' }, toggle, 'Enabled'),
      el('button', { class: 'btn', type: 'button', text: 'Edit', ...(editing ? { disabled: '' } : {}), onclick: onEdit }),
      el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: onDelete }),
    );
  } else head.append(el('span', { class: 'muted tiny', style: 'margin-left:auto', text: 'built in' }));
  card.append(head);
  card.append(el('div', { class: 'muted tiny', text: `tools: ${(a.grants || ['none']).join(', ')}${a.skills?.length ? ` · skills: ${a.skills.join(', ')}` : ''}${a.workdir ? ` · in ${a.workdir}` : ''} · applies to ${(a.appliesTo || ['jobs']).join(', ')}` }));
  // The record — the capability strip's observed half (pillars §8): tasks done/failed,
  // rating, the engines it ran on and how it did on each. From the gateway; absent is
  // "no record yet", not an error.
  const rec = el('div', { class: 'muted tiny', text: 'record: …' });
  card.append(rec);
  store.scorecard(a.id).then((r) => {
    const s = r.ok ? r.data?.summary : null;
    if (!s || !s.entries) { rec.textContent = 'record: nothing yet'; return; }
    const engines = (s.byEngine || []).slice(0, 4).map((e) => `${e.id}${e.model ? `/${e.model}` : ''} ${e.tasks} (${pct(e.rating?.avg)})`).join(' · ');
    rec.textContent = `record: ${s.jobsDone} done, ${s.jobsFailed} failed · rated ${pct(s.rating?.avg)} (${s.rating?.count || 0})${s.engineIndependence != null ? ` · engine-independence ${pct(s.engineIndependence)}` : ''}${s.scm?.commits ? ` · ${s.scm.commits} commits, ${s.scm.prs} PRs, ${s.scm.merged} merged` : ''}${engines ? ` · on: ${engines}` : ''}${r.data?.attested?.ok ? ' · attested' : ''}`;
  });
  return card;
}

export function renderAgents(root, { settings, onChange, editing = null, license = null }) {
  root.innerHTML = '';
  const list = (Array.isArray(settings.agentPool) ? settings.agentPool : []).filter((a) => a && a.id);
  const roster = rosterFor(settings, license, { like: settings.activeAgentId || '' });
  const servers = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).filter((x) => x && x.id);
  const store = runStore(settings);
  const persist = async (next) => {
    await saveSettings({ ...(await getSettings()), agentPool: next });
    onChange?.(next);
  };
  const starters = starterAgents().filter((a) => !list.some((x) => x.id === a.id));
  const actions = el('div', { class: 'card-actions' });
  if (starters.length) actions.append(el('button', { class: 'btn', type: 'button', text: `+ ${starters.length === 7 ? 'the engineering org' : `${starters.length} starter${starters.length > 1 ? 's' : ''}`}`, title: starters.map((a) => a.name).join(', '), onclick: () => persist([...list, ...starters.map((a) => ({ ...a, createdAt: Date.now() }))]) }));
  actions.append(el('button', { class: 'btn primary', type: 'button', text: '+ New agent', ...(editing ? { disabled: '' } : {}), onclick: () => renderAgents(root, { settings, onChange, license, editing: { index: -1, agent: blankAgent() } }) }));
  root.append(el('div', { class: 'card-head' },
    el('h2', {}, 'Agents ', el('span', { class: 'sub', text: `— the ones you define${list.length ? ` · ${list.length}` : ''}` })),
    actions,
  ));
  root.append(el('p', { class: 'muted' },
    'An agent is yours: a name, a specialty, a prompt, the skills and grants it carries, and an engine — a model from Models, a coding agent from Harnesses, or auto, where the recruiter picks by policy. '
    + 'A team role can stand for an agent (Teams → a role → Agent), so one agent serves many teams and an edit lands everywhere. '
    + 'Each keeps a scorecard of the work it has actually done — written by the runner, attested by the gateway, never by the agent. Shared with the desktop app.'));
  if (editing) {
    root.append(agentEditor({
      initial: editing.agent, roster, servers,
      existingIds: new Set(list.filter((_, j) => j !== editing.index).map((a) => a.id)),
      onCancel: () => renderAgents(root, { settings, onChange, license }),
      onSave: (agent) => {
        const stamped = { ...agent, createdAt: editing.agent.createdAt || Date.now() };
        persist(editing.index < 0 ? [...list, stamped] : list.map((x, j) => (j === editing.index ? stamped : x)));
      },
    }));
  }
  root.append(agentCard(assistantAgent(), { roster, store, editing, fixed: true }));
  list.forEach((a, i) => {
    root.append(agentCard(a, {
      roster, store, editing,
      onEdit: () => renderAgents(root, { settings, onChange, license, editing: { index: i, agent: a } }),
      onToggle: (on) => persist(list.map((x, j) => (j === i ? { ...x, enabled: on } : x))),
      onDelete: async () => {
        const { confirmDelete } = await import('./confirm-modal.js');
        if (!(await confirmDelete({ title: 'Delete agent?', body: `${a.name || a.id} will be removed from every client. Teams whose roles stand for it will not run until the role is changed. Its scorecard stays on the gateway.`, confirmLabel: 'Delete' }))) return;
        await persist(list.filter((_, j) => j !== i));
      },
    }));
  });
  if (!list.length && !editing) root.append(el('p', { class: 'muted tiny', text: `Nothing defined yet. ${describeAgent(starters[0] || {}) ? 'Add the engineering org to start — Architect, Implementer, Reviewer, Tester, Librarian, Scribe, Release — or make your own.' : ''}` }));
}
