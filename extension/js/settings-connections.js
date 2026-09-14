// Settings → Agent Tools → Source control: the SCM connections the bridge holds — GitHub
// first; GitHub Enterprise, GitLab, Bitbucket, Gitea, Azure DevOps and plain git by kind.
//
// The RECORD (kind, host, reach) is shared with the desktop through the `connections`
// prefs section; the TOKEN is typed here once, goes to the bridge, and from there to the
// machine's keychain. It never comes back: the bridge reports only `hasSecret`, and hands
// the token to git for one agent run at a time, scoped to the host (bridge 0.11.19+).
// Deferred from settings.js.

import { getSettings, saveSettings } from './store.js';
import { SCM_KINDS, blankConnection, connectionFromForm, describeConnection } from './events/scm-connection.js';

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
const KIND_LABEL = { github: 'GitHub', 'github-enterprise': 'GitHub Enterprise', gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Gitea', 'azure-devops': 'Azure DevOps', git: 'Git (any remote)' };
const NEEDS_HOST = new Set(['github-enterprise', 'gitea', 'git']);

/** The bridge's /connections — reads open, writes with the token when one is set. */
export function bridgeConnections({ url, token }) {
  const base = String(url || 'http://127.0.0.1:4319').replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const call = async (path, body = null) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), body?.remote !== undefined ? 20000 : 6000);
    try {
      const res = await fetch(`${base}${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal } : { headers, signal: ctrl.signal });
      const json = await res.json().catch(() => null);
      return res.ok ? { ok: true, data: json } : { ok: false, error: json?.error || `HTTP ${res.status}` };
    } catch (e) { return { ok: false, error: e?.message || String(e) }; } finally { clearTimeout(t); }
  };
  return {
    list: () => call('/connections'),
    put: (connection, secret) => call('/connections', { connection, ...(secret ? { token: secret } : {}) }),
    remove: (id) => call(`/connections/${encodeURIComponent(id)}/delete`, {}),
    test: (id, remote) => call(`/connections/${encodeURIComponent(id)}/test`, { remote: remote || '' }),
  };
}

function editor({ initial, existingIds, onSave, onCancel }) {
  const f = { ...initial, reach: (initial.reach || []).join(', ') };
  let secret = '';
  const root = el('div', { class: 'entity s-entity' });
  const errors = el('ul', { style: 'margin:4px 0;padding-left:18px;font-size:12.4px;color:var(--danger)' });
  const render = () => {
    root.innerHTML = '';
    root.append(el('div', { class: 'entity-head', style: 'gap:8px;flex-wrap:wrap' },
      sel(SCM_KINDS.map((k) => [k, KIND_LABEL[k] || k]), f.kind || 'github', (v) => { f.kind = v; render(); }),
      inp({ placeholder: 'Label (optional)', style: 'width:150px' }, f.label, (v) => { f.label = v; }),
      NEEDS_HOST.has(f.kind) || f.baseUrl ? inp({ placeholder: 'https://git.example.com', style: 'width:220px' }, f.baseUrl || '', (v) => { f.baseUrl = v; }) : null,
      inp({ placeholder: 'reach: owner/* or owner/repo, comma-separated (blank = any on the host)', style: 'flex:1;min-width:240px' }, f.reach, (v) => { f.reach = v; }),
    ));
    const tok = el('input', { type: 'password', placeholder: initial.hasSecret ? 'token stored — paste a new one to replace it' : 'token — a fine-grained PAT with contents: read/write and pull requests: write on the repos in reach', autocomplete: 'off', spellcheck: 'false', style: 'flex:1;min-width:260px' });
    tok.addEventListener('input', () => { secret = tok.value; });
    root.append(el('div', { style: 'display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap' },
      tok,
      f.kind === 'gitlab' || f.kind === 'bitbucket' || f.kind === 'git' ? inp({ placeholder: 'username (optional)', style: 'width:150px' }, f.username || '', (v) => { f.username = v; }) : null,
    ));
    root.append(el('p', { class: 'muted tiny', text: 'The token goes to the bridge on this machine and into its keychain. It is never shown again, never synced, never put in a prompt; an agent run gets it for one process, scoped to this host, and can push only its own branch.' }));
    root.append(errors);
    root.append(el('div', { style: 'display:flex;gap:8px;align-items:center' },
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: onCancel }),
      el('button', { class: 'btn primary', type: 'button', text: 'Save connection', onclick: () => {
        const r = connectionFromForm(f);
        errors.innerHTML = '';
        if (!r.ok) { for (const e of r.errors) errors.append(el('li', { text: e })); return; }
        if (existingIds.has(r.connection.id)) { errors.append(el('li', { text: `A connection with the id "${r.connection.id}" already exists.` })); return; }
        if (!initial.hasSecret && !secret && r.connection.kind !== 'git') { errors.append(el('li', { text: 'A token is needed for the hub to accept a push or a pull request.' })); return; }
        onSave(r.connection, secret);
      } }),
    ));
  };
  render();
  return root;
}

export function renderConnections(root, { settings, bridge, onChange, editing = null }) {
  root.innerHTML = '';
  const local = (Array.isArray(settings.connections) ? settings.connections : []).filter((c) => c && c.id);
  const api = bridgeConnections(bridge);
  const persist = async (next) => { await saveSettings({ ...(await getSettings()), connections: next }); onChange?.(next); };
  root.append(el('div', { class: 'card-head' },
    el('h2', {}, 'Source control ', el('span', { class: 'sub', text: '— where an Implementer pushes its branch and opens its pull request' })),
    el('div', { class: 'card-actions' }, el('button', { class: 'btn primary', type: 'button', text: '+ Connection', ...(editing ? { disabled: '' } : {}), onclick: () => renderConnections(root, { settings, bridge, onChange, editing: { index: -1, connection: blankConnection() } }) })),
  ));
  root.append(el('p', { class: 'muted', text: 'The repository is the source of truth for a project that is code: an agent with an agent-tool engine works in a worktree of it, on a branch of its own, and what it did is the branch, the commits and the pull request — under a connection here. ChatPanel is not a git host: it brings the credential, the worktree, the branch name and the record.' }));
  const status = el('div', { class: 'muted tiny' });
  root.append(status);
  if (editing) {
    root.append(editor({
      initial: editing.connection,
      existingIds: new Set(local.filter((_, j) => j !== editing.index).map((c) => c.id)),
      onCancel: () => renderConnections(root, { settings, bridge, onChange }),
      onSave: async (connection, secret) => {
        const r = await api.put(connection, secret);
        if (!r.ok) { status.textContent = `The bridge did not save it: ${r.error}`; return; }
        const stamped = { ...connection, createdAt: editing.connection.createdAt || Date.now() };
        await persist(editing.index < 0 ? [...local, stamped] : local.map((x, j) => (j === editing.index ? stamped : x)));
      },
    }));
  }
  const listBox = el('div');
  root.append(listBox);
  api.list().then((r) => {
    const held = new Map(r.ok ? (r.data?.connections || []).map((c) => [c.id, c]) : []);
    status.textContent = r.ok ? `Tokens are kept in the bridge's ${r.data?.secretBackend === 'keychain' ? 'keychain' : 'secret file (0600)'} on this machine.` : `The bridge did not answer (${r.error}) — connections need bridge 0.11.19+. Records below are what this client knows; tokens live with the bridge.`;
    // Everything: what this client knows, and what the bridge holds that it does not (made in the desktop).
    const all = [...local, ...[...held.values()].filter((c) => !local.some((x) => x.id === c.id))];
    if (!all.length && !editing) listBox.append(el('p', { class: 'muted tiny', text: 'No connections yet. Add GitHub with a fine-grained token on the repositories your agents may work in.' }));
    all.forEach((c) => {
      const h = held.get(c.id);
      const i = local.findIndex((x) => x.id === c.id);
      const card = el('div', { class: `entity s-entity${c.enabled === false ? ' is-off' : ''}` });
      const res = el('span', { class: 'muted tiny' });
      card.append(el('div', { class: 'entity-head', style: 'gap:8px' },
        el('strong', { text: c.label || describeConnection(c) }),
        el('span', { class: 'muted', text: describeConnection(c) }),
        el('span', { class: `chip ${h?.hasSecret ? 'good' : 'warn'}`, text: h ? (h.hasSecret ? 'token held' : 'no token') : 'not on this bridge' }),
        res,
        el('button', { class: 'btn', type: 'button', text: 'Test', style: 'margin-left:auto', onclick: async () => {
          const { promptText } = await import('./confirm-modal.js');
          const asked = await promptText({ title: 'Test the connection', body: 'A repository this connection should be able to read — the bridge runs git ls-remote with the stored token.', label: 'Repository', placeholder: 'owner/name or a URL', value: c.reach?.find((x) => !x.endsWith('/*')) || '', confirmLabel: 'Test' });
          if (!asked) return;
          const remote = String(asked.text || '').trim();
          res.textContent = 'testing…';
          const t = await api.test(c.id, /^https?:|^git@/.test(remote) ? remote : `https://${c.baseUrl ? c.baseUrl.replace(/^https?:\/\//, '') : ({ github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', 'azure-devops': 'dev.azure.com' }[c.kind] || '')}/${remote}`);
          res.textContent = t.ok && t.data?.ok ? `ok · default branch ${t.data.defaultBranch || '?'}` : `failed: ${t.data?.reason || t.error}`;
        } }),
        el('button', { class: 'btn', type: 'button', text: 'Edit', ...(editing ? { disabled: '' } : {}), onclick: () => renderConnections(root, { settings, bridge, onChange, editing: { index: i, connection: { ...c, hasSecret: !!h?.hasSecret } } }) }),
        el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: async () => {
          const { confirmDelete } = await import('./confirm-modal.js');
          if (!(await confirmDelete({ title: 'Delete connection?', body: `${c.label || c.id} and its token will be removed from this bridge and from every client.`, confirmLabel: 'Delete' }))) return;
          await api.remove(c.id);
          await persist(local.filter((x) => x.id !== c.id));
        } }),
      ));
      listBox.append(card);
    });
  });
}
