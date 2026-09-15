// Settings → Agents: the pool — the agents you define, each with a name, a specialty, a
// prompt, skills, grants and an ENGINE (a model from Models, a coding agent from Agent Tools,
// auto by policy, or the chat's own model for the built-in Assistant), and the scorecard
// of what it has actually done, read from the gateway.
//
// `agentFromForm` is the one shaping (events/agent.js), so an agent made here is exactly an
// agent made in the desktop. The pool is the shared `agents` section (settings.agentPool —
// NOT settings.agents, which is the harness list); a team's role says `agent: <id>` and is
// filled from here at run time. Deferred from settings.js, which is at its first-paint ceiling.

import { getSettings, saveSettings } from './store.js';
import { starterAgents, blankAgent, agentFromForm, assistantAgent, APPLIES_TO } from './events/agent.js';
import { describeEngine, ROUTE_PREFERS } from './events/engine.js';
import { rosterFor, runStore } from './team-host.js';
import { rosterRows, agentColor, agentInitials, cardNumbers, missingStarters, builtinOrg, grantChoices, grantsFromChoices, skillChoices } from './events/team-org.js';

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

/** The engine, on the form: kind + what the kind needs. `roster` is this panel's endpoints and installed agents. */
function engineEditor(f, roster, render) {
  const e = f.engine && typeof f.engine === 'object' ? f.engine : { kind: 'auto', prefer: 'balanced' };
  f.engine = e;
  const models = roster.filter((c) => c.kind !== 'bridge');
  const harnesses = roster.filter((c) => c.kind === 'bridge');
  const box = el('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' });
  box.append(sel([['auto', 'auto · the recruiter picks'], ['model', 'a model'], ['harness', 'an agent tool (Claude Code, Codex…)'], ['assistant', 'the chat’s model']], e.kind || 'auto', (v) => { f.engine = v === 'auto' ? { kind: 'auto', prefer: e.prefer || 'balanced' } : { kind: v }; render(); }));
  if (e.kind === 'auto') box.append(sel(ROUTE_PREFERS.map((p) => [p, p.replace(/-/g, ' ')]), e.prefer || e.policy?.prefer || 'balanced', (v) => { e.prefer = v; }));
  if (e.kind === 'model') {
    const cur = e.providerId ? `${e.providerId}|${e.model || ''}` : (e.model || '');
    box.append(sel([['', 'pick a model…'], ...models.map((c) => [`${c.id}|${c.model || ''}`, `${c.name}${c.model && c.model !== c.name ? ` · ${c.model}` : ''}${c.usable ? '' : ' — not usable'}`]), ...(cur && !models.some((c) => `${c.id}|${c.model || ''}` === cur) ? [[cur, `${e.model} (not configured now)`]] : [])], cur, (v) => { const [providerId, model] = v.split('|'); e.providerId = providerId || undefined; e.model = model || providerId || ''; }));
  }
  if (e.kind === 'harness') {
    box.append(sel([['', 'pick an agent tool…'], ...harnesses.map((c) => [c.bridgeAgent || c.id, `${c.name}${c.usable ? '' : ' — not usable'}`]), ...(e.harnessId && !harnesses.some((c) => (c.bridgeAgent || c.id) === e.harnessId) ? [[e.harnessId, `${e.harnessId} (not installed now)`]] : [])], e.harnessId || '', (v) => { e.harnessId = v; }));
    box.append(inp({ placeholder: 'model (optional)', style: 'width:130px' }, e.model || '', (v) => { e.model = v || undefined; }));
  }
  return box;
}

function agentEditor({ initial, roster, servers, skills = [], existingIds, onSave, onCancel }) {
  const f = { ...initial, skills: [...(initial.skills || [])], grants: [...(initial.grants || ['none'])], appliesTo: [...(initial.appliesTo || ['jobs'])], builtin: undefined };
  if (f.engine?.kind === 'auto') f.engine = { kind: 'auto', prefer: f.engine.policy?.prefer || f.engine.prefer || 'balanced' };
  const root = el('div', { class: 'entity s-entity' });
  const errors = el('ul', { style: 'margin:4px 0;padding-left:18px;font-size:12.4px;color:var(--danger)' });
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
    root.append(grantPicker(f.grants, { servers, onChange: (g) => { f.grants = g; } }));
    root.append(skillPicker(f.skills, { skills, onChange: (k) => { f.skills = k; } }));
    root.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0' },
      inp({ placeholder: 'working directory (a repository, for an agent-tool engine)', style: 'flex:1;min-width:220px' }, f.workdir || '', (v) => { f.workdir = v; }),
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

/**
 * GRANTS as choices (team-org.js grantChoices): grouped checkboxes with a one-line meaning,
 * the connected servers by name — never a free field of ids. Nothing checked is `none`.
 */
export function grantPicker(selected, { servers = [], onChange, narrowing = false }) {
  const set = new Set((Array.isArray(selected) ? selected : []).filter((g) => g !== 'none'));
  const box = el('div', { class: 'org-picker', 'data-picker': 'grants' });
  for (const g of grantChoices({ servers })) {
    const row = el('div', { class: 'org-picker-group' }, el('span', { class: 'org-picker-lb', text: g.label }));
    for (const it of g.items) {
      const cb = el('input', { type: 'checkbox', value: it.id, id: `g-${it.id.replace(/[^a-z0-9]/gi, '_')}-${Math.random().toString(36).slice(2, 6)}` });
      cb.checked = set.has(it.id);
      cb.addEventListener('change', () => { if (cb.checked) set.add(it.id); else set.delete(it.id); onChange(grantsFromChoices([...set])); });
      row.append(el('label', { class: 'org-check', title: it.hint || '' }, cb, el('span', { text: it.label })));
    }
    box.append(row);
  }
  if (narrowing) box.append(el('div', { class: 'muted tiny', text: 'Nothing checked: the agent\'s own grants. Checking some lends less, never more.' }));
  return box;
}

/** SKILLS as choices from the skills you have (team-org.js skillChoices); a name the list lost is kept and said. */
export function skillPicker(selected, { skills = [], onChange }) {
  const set = new Set(Array.isArray(selected) ? selected : []);
  const box = el('div', { class: 'org-picker', 'data-picker': 'skills' });
  const choices = skillChoices(skills, { current: [...set] });
  if (!choices.length) { box.append(el('span', { class: 'muted tiny', text: 'No skills yet — write one under Skills and it is offered here.' })); return box; }
  const row = el('div', { class: 'org-picker-group' }, el('span', { class: 'org-picker-lb', text: 'Skills' }));
  for (const it of choices) {
    const cb = el('input', { type: 'checkbox', value: it.id });
    cb.checked = set.has(it.id);
    cb.addEventListener('change', () => { if (cb.checked) set.add(it.id); else set.delete(it.id); onChange([...set]); });
    row.append(el('label', { class: `org-check${it.missing ? ' missing' : ''}`, title: it.hint || '' }, cb, el('span', { text: it.label })));
  }
  box.append(row);
  return box;
}

const isDark = () => { try { return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true; } catch { return false; } };
/** The avatar: two letters on the agent's own colour — the same colour on every tab and every client (team-org.js). */
export function agentAvatar(agentOrId, { small = false } = {}) {
  const id = typeof agentOrId === 'string' ? agentOrId : agentOrId?.id;
  return el('span', { class: `org-av${small ? ' sm' : ''}`, style: `background:${agentColor(id, { dark: isDark() })}`, text: agentInitials(agentOrId) });
}
const KIND_LABEL = { builtin: 'built-in', mine: 'yours', 'team-role': 'a team\'s role', created: 'created for a job', proposed: 'proposed', missing: 'not in the pool' };

/**
 * One row of the roster: a pool card — what it is, what it runs on, where it works, the four
 * numbers of its record (the gateway's scorecard, attested) — or a PROPOSED card awaiting
 * Create / Skip, or a MISSING agent a team names, with the fix.
 */
function agentCard(row, { roster, store, editing, onEdit, onDelete, onToggle, onReset, onAddBuiltin, fixed = false }) {
  const a = row.agent;
  const kind = row.kind;
  const card = el('div', { class: `entity s-entity${a.enabled === false ? ' is-off' : ''}${kind === 'proposed' ? ' is-proposed' : ''}${kind === 'missing' ? ' is-hole' : ''}`, 'data-agent': a.id, 'data-kind': kind });
  const harnessName = (id) => roster.find((c) => c.kind === 'bridge' && (c.bridgeAgent === id || c.id === id))?.name || id;
  const providerName = (id) => roster.find((c) => c.id === id)?.name || id;
  const head = el('div', { class: 'entity-head', style: 'margin-bottom:8px;padding-bottom:8px' },
    agentAvatar(a),
    el('strong', { text: a.name || a.id }),
    el('span', { class: `org-chip${kind === 'proposed' ? ' warn' : kind === 'missing' ? ' risk' : kind === 'builtin' ? ' on' : ''}`, text: KIND_LABEL[kind] || kind }),
    el('span', { class: 'muted', text: a.purpose || '' }),
  );
  if (kind === 'missing') {
    head.append(el('span', { class: 'muted tiny', style: 'margin-left:auto', text: `named by ${(row.namedBy || []).map((t) => `/${t}`).join(', ')}` }));
    card.append(head);
    card.append(el('div', { class: 'muted tiny', text: `A team's role says agent: ${a.id}, and no card with that id is in the pool — the team will not run until it is.` }));
    card.append(el('div', { class: 'org-row', style: 'justify-content:flex-end;gap:8px' },
      row.fix === 'add-builtin'
        ? el('button', { class: 'btn primary', type: 'button', text: `Add the built-in ${a.id.replace(/^./, (c) => c.toUpperCase())}`, onclick: () => onAddBuiltin(a.id) })
        : el('span', { class: 'muted tiny', text: 'Pick another agent for that role under Teams → Edit.' })));
    return card;
  }
  head.append(el('span', { class: 'org-chip k', text: describeEngine(a.engine, { harnessName, providerName }) }));
  if (kind === 'proposed') {
    head.append(el('span', { class: 'muted tiny', style: 'margin-left:auto', text: 'never created without you' }));
  } else if (!fixed) {
    const toggle = el('input', { type: 'checkbox', title: 'Enabled' });
    toggle.checked = a.enabled !== false;
    toggle.addEventListener('change', () => onToggle(toggle.checked));
    head.append(
      el('label', { class: 'muted tiny', style: 'margin-left:auto;display:flex;gap:6px;align-items:center' }, toggle, 'Enabled'),
      el('button', { class: 'btn', type: 'button', text: 'Edit', ...(editing ? { disabled: '' } : {}), onclick: onEdit }),
      // A built-in is the product's: switched off or edited (a copy of yours replaces it),
      // never deleted; an edited one can go back to what shipped.
      row.saved && row.shipped ? el('button', { class: 'btn', type: 'button', text: 'Reset to built-in', title: 'Drop your copy; what ships comes back', onclick: onReset }) : null,
      row.shipped ? null : el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: onDelete }),
    );
  } else head.append(el('span', { class: 'muted tiny', style: 'margin-left:auto', text: 'built in' }));
  card.append(head);
  card.append(el('div', { class: 'org-row' },
    ...(a.grants || ['none']).map((g) => el('span', { class: 'org-chip k', text: g })),
    ...(a.skills?.length ? [el('span', { class: 'tiny faint', style: 'margin-left:4px', text: 'skills' }), ...a.skills.map((k) => el('span', { class: 'org-chip k', text: k }))] : []),
    ...(a.workdir ? [el('span', { class: 'muted tiny', text: `in ${a.workdir}` })] : []),
  ));
  const where = row.where || { teams: [], jobs: [] };
  if (where.teams.length || where.jobs.length) {
    card.append(el('div', { class: 'org-row' },
      el('span', { class: 'tiny', text: 'On' }),
      ...where.teams.map((t) => el('a', { class: 'org-chip', href: '#teams', text: `/${t.team}` })),
      ...where.jobs.map((j) => el('span', { class: 'org-chip', title: j.title, text: `${j.title}: ${j.job} · ${j.status}` })),
    ));
  }
  if (kind === 'proposed') return card;
  // How to use it: on its own (a one-role team named after the card — team-org.js soloTeam)
  // or through a team. The Assistant is the chat itself.
  if (!fixed) card.append(el('div', { class: 'org-row', 'data-invoke': a.id }, el('span', { class: 'tiny faint', text: 'Invoke' }), el('code', { class: 'org-chip k', text: `/${String(a.id).toLowerCase()} <request>` }), el('span', { class: 'muted tiny', text: 'in any chat, or ask for it by name — it runs as a one-role team under the default budget; put it on a team to work with others.' })));
  // The record — the four numbers every client shows (team-org.js cardNumbers), from the
  // gateway; "—" is "nothing yet", never a zero that reads as a bad score.
  const nums = el('div', { class: 'org-nums' });
  const draw = (tiles) => { nums.innerHTML = ''; for (const t of tiles) nums.append(el('div', {}, el('b', { text: t.value }), el('span', { text: t.label }), el('i', { text: t.detail }))); };
  draw(cardNumbers(null));
  if (!fixed) store.scorecard(a.id).then((r) => draw(cardNumbers(r.ok ? r.data?.summary : null, { attested: r.ok ? r.data?.attested : null }))).catch(() => {});
  card.append(nums);
  return card;
}

export function renderAgents(root, { settings, onChange, editing = null, license = null, filter = 'all' }) {
  root.innerHTML = '';
  // The saved section holds only what a person made, edited or switched off; the roster is
  // the built-in org over it (team-org.js builtinOrg) — starters present without a click.
  const list = (Array.isArray(settings.agentPool) ? settings.agentPool : []).filter((a) => a && a.id);
  const org = builtinOrg(settings.teams, list);
  const teams = org.teams;
  const shippedIds = new Set(starterAgents().map((a) => a.id));
  const roster = rosterFor(settings, license, { like: settings.activeAgentId || '' });
  const servers = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).filter((x) => x && x.id);
  const store = runStore(settings);
  const persist = async (next) => {
    await saveSettings({ ...(await getSettings()), agentPool: next });
    onChange?.(next);
  };
  const again = (patch) => renderAgents(root, { settings, onChange, license, filter, ...patch });
  const { rows, counts } = rosterRows(org.pool, { teams });
  for (const r of rows) { r.shipped = shippedIds.has(r.agent.id) || String(r.agent.createdBy || '').startsWith('team:') && org.teams.some((t) => t.builtin && t.roles.some((x) => x.agent === r.agent.id)); r.saved = list.some((a) => a.id === r.agent.id); }
  const skills = (Array.isArray(settings.skills) ? settings.skills : []).filter((x) => x && (x.command || x.name));
  const actions = el('div', { class: 'card-actions' });
  actions.append(el('button', { class: 'btn primary', type: 'button', text: '+ New agent', ...(editing ? { disabled: '' } : {}), onclick: () => again({ editing: { index: -1, agent: blankAgent() } }) }));
  root.append(el('div', { class: 'card-head' },
    el('h2', {}, 'Agents ', el('span', { class: 'sub', text: `— the roster${rows.length ? ` · ${rows.length}` : ''}` })),
    actions,
  ));
  root.append(el('p', { class: 'muted' },
    'Every agent that can be put on a team is here: the built-in org, the ones you define, and every team role — a role you write into a team becomes a card here when the team is saved, so nothing that runs is invisible. '
    + 'Each carries a prompt, skills, grants and an engine — a model from Models, a coding agent from Agent Tools, or auto — and keeps a record of the work it has actually done, written by the runner and attested by the gateway. Shared with the desktop app.'));
  // The filter bar — counts from the roster, so a hole or a proposal is visible before it is looked for.
  const FILTERS = [['all', 'All'], ['builtin', 'Built-in'], ['mine', 'Yours'], ['team-role', 'Team roles'], ['created', 'Created'], ['proposed', 'Proposed'], ['missing', 'Missing'], ['onTeam', 'On a team']];
  root.append(el('div', { class: 'org-filters' },
    ...FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, label]) => el('button', { type: 'button', class: `org-chip${filter === k ? ' on' : ''}${k === 'missing' ? ' risk' : k === 'proposed' ? ' warn' : ''}`, 'data-filter': k, text: `${label} ${counts[k] ?? 0}`, onclick: () => again({ filter: k }) })),
  ));
  if (editing) {
    root.append(agentEditor({
      initial: editing.agent, roster, servers, skills,
      existingIds: new Set([...org.pool.map((a) => a.id)].filter((id) => id !== editing.agent.id)),
      onCancel: () => again({ editing: null }),
      onSave: (agent) => {
        // A saved card replaces the built-in of the same id (a copy of yours), or itself.
        const stamped = { ...agent, createdAt: editing.agent.createdAt || Date.now() };
        persist(list.some((x) => x.id === stamped.id) ? list.map((x) => (x.id === stamped.id ? stamped : x)) : [...list, stamped]);
      },
    }));
  }
  const shown = rows.filter((r) => filter === 'all' || (filter === 'onTeam' ? r.where.teams.length : r.kind === filter));
  if (filter === 'all' || filter === 'builtin') root.append(agentCard({ kind: 'builtin', agent: assistantAgent(), where: { teams: [], jobs: [] } }, { roster, store, editing, fixed: true }));
  for (const row of shown) {
    const i = list.findIndex((x) => x.id === row.agent.id);
    const { builtin, ...copy } = row.agent; // what a save or a switch-off writes: a copy of the built-in, ours
    root.append(agentCard(row, {
      roster, store, editing,
      onEdit: () => again({ editing: { index: i, agent: copy } }),
      onToggle: (on) => persist(i >= 0 ? list.map((x, j) => (j === i ? { ...x, enabled: on } : x)) : [...list, { ...copy, enabled: on, createdAt: Date.now() }]),
      onReset: () => persist(list.filter((x) => x.id !== row.agent.id)),
      onAddBuiltin: (id) => persist([...list, ...missingStarters({ roles: [{ id, agent: id }] }, list).map((a) => ({ ...a, createdAt: Date.now() }))]),
      onDelete: async () => {
        const { confirmDelete } = await import('./confirm-modal.js');
        const named = row.where.teams.map((t) => `/${t.team}`).join(', ');
        if (!(await confirmDelete({ title: 'Delete agent?', body: `${row.agent.name || row.agent.id} will be removed from every client.${named ? ` ${named} will not run until the role is changed.` : ''} Its scorecard stays on the gateway.`, confirmLabel: 'Delete' }))) return;
        await persist(list.filter((_, j) => j !== i));
      },
    }));
  }
  if (!shown.length && !editing) root.append(el('p', { class: 'muted tiny', text: 'Nothing here for this filter.' }));
}
