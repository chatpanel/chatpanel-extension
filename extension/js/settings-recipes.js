// Settings → Skills → Recipes: the saved workflows, readable and revocable.
//
// A recipe is authored in conversation and approved on a card (recipe-tools.js), so this
// page never edits one — a person who wants a different recipe asks for it. What a person
// needs here is the honest gallery: what each one does, step by step, with its parameters;
// a switch; and a delete. Deferred from settings.js, which is at its first-paint ceiling.

import { getSettings, saveSettings } from './store.js';
import { recipeParams } from './events/recipe.js';

function callsOf(r) {
  switch (r.mode) {
    case 'call': return [{ tool: r.tool, arguments: r.arguments || {} }];
    case 'parallel': return (r.calls || []).map((c) => ({ tool: c.tool, arguments: c.arguments || {} }));
    case 'batch': return (r.items || []).map((it) => ({ tool: r.tool, arguments: it.arguments || {} }));
    case 'pipeline': return (r.steps || []).map((s) => ({ tool: s.tool, arguments: s.arguments || {}, mapping: s.inputMapping }));
    default: return [];
  }
}

// `{"$param":"title"}` reads as `{title}` — the slot, not its encoding.
function argText(args) {
  const s = JSON.stringify(args, (k, v) => (v && typeof v === 'object' && typeof v.$param === 'string' ? `⟨${v.$param}⟩` : v));
  return s === '{}' ? '' : s.replace(/"⟨([^"]+)⟩"/g, '{$1}');
}

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

export function renderRecipes(root, { settings, onChange }) {
  root.innerHTML = '';
  const list = Array.isArray(settings.recipes) ? settings.recipes : [];
  root.append(el('div', { class: 'card-head' },
    el('h2', {}, 'Recipes ', el('span', { class: 'sub' }, `${list.length ? `${list.length} saved` : 'none yet'}`)),
  ));
  root.append(el('p', { class: 'muted' },
    'A recipe is a tool workflow the assistant did once and offered to keep — you approved it on a card. '
    + 'Run one by name (/its-name) or by asking. Runs need no re-planning; destructive steps still ask.'));
  if (!list.length) return;
  const persist = async (next) => {
    await saveSettings({ ...(await getSettings()), recipes: next });
    onChange?.(next);
  };
  list.forEach((r, i) => {
    const params = recipeParams(r);
    const card = el('div', { class: `entity s-entity${r.enabled === false ? ' is-off' : ''}` });
    const toggle = el('input', { type: 'checkbox', title: 'Enabled' });
    toggle.checked = r.enabled !== false;
    toggle.addEventListener('change', () => persist(list.map((x, j) => (j === i ? { ...x, enabled: toggle.checked } : x))));
    card.append(el('div', { class: 'entity-head' },
      el('strong', { text: `/${r.name}` }),
      el('span', { class: 'muted', text: r.description || '' }),
      el('span', { class: 'muted tiny', text: `${r.mode}${params.length ? ` · ${params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')}` : ''}` }),
      el('label', { class: 'muted tiny', style: 'margin-left:auto;display:flex;gap:6px;align-items:center' }, toggle, 'Enabled'),
      el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: async () => {
        const { confirmDelete } = await import('./confirm-modal.js');
        if (!(await confirmDelete({ title: 'Delete recipe?', body: `/${r.name} will be removed. This can't be undone.`, confirmLabel: 'Delete' }))) return;
        await persist(list.filter((_, j) => j !== i));
      } }),
    ));
    const steps = el('ol', { class: 'muted', style: 'margin:0;padding-left:20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px' });
    for (const c of callsOf(r)) {
      const mapping = c.mapping ? ` ← ${Object.entries(c.mapping).map(([k, v]) => `${k}: ${v}`).join(', ')}` : '';
      steps.append(el('li', { text: `${c.tool} ${argText(c.arguments)}${mapping}`.trim() }));
    }
    card.append(steps);
    root.append(card);
  });
}
