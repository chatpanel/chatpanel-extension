// The Widgets drawer — where the small apps a user kept actually live.
//
// Placement matters more than it looks. A widget that only exists inside the message that
// created it is not a feature; it is a message. The right rail is where ChatPanel already
// keeps its persistent surfaces (Meet, Watch), so a kept widget belongs there — reachable
// whatever the conversation is doing, and gone from the transcript entirely.
//
// PINNING keeps the rail honest. Every widget getting its own icon would grow an unbounded
// list in a narrow strip, so the rail shows the ones the user pinned (capped) plus one
// Widgets entry for the rest.

import { listWidgets, deleteWidget, pinWidget, getWidget, saveWidget } from './widgets-store.js';
import { mountWidget } from './widget-host.js';

// No cap. The rail scrolls, so pinning as many as you like is the user's call rather than
// ours — and each pinned widget carries its own icon, which is what actually keeps a long
// strip scannable.

let mounted = null;   // the live widget instance, so we can tear it down
let onChange = null;  // told when pins change, so the rail can re-render

const $ = (id) => document.getElementById(id);

function showList() {
  if (mounted) { mounted.destroy(); mounted = null; } // stop a running timer's frame
  $('widgets-list-view')?.classList.remove('hidden');
  $('widget-view')?.classList.add('hidden');
}

// What each capability means, in a line a person can refuse. A permission nobody can read is
// a permission nobody can decline.
const CAPABILITY_WORDS = {
  'vault.status': 'see whether your vault is locked',
  'vault.unlock': 'ask you to unlock your vault',
  'vault.lock': 'lock your vault',
  'vault.list': 'list the titles in your vault',
  'vault.add': 'add entries to your vault',
  'vault.reveal': 'read a secret (asks you every time)',
  'vault.remove': 'delete an entry (asks you every time)',
};

/**
 * The permission row for one widget.
 *
 * Consent lives HERE rather than at Keep time on purpose: clicking "Keep" means "I want
 * this", not "I trust this with my passwords", and a permission granted in the same click as
 * the thing you wanted is a permission nobody read. Here it is a separate decision, next to
 * the widget it belongs to, and — the half that matters more — it can be taken back.
 */
async function renderPermissions(rec) {
  let row = $('widget-perms');
  if (!row) {
    const host = $('widget-mount')?.parentElement;
    if (!host) return;
    row = document.createElement('div');
    row.id = 'widget-perms';
    row.className = 'widget-perms';
    host.insertBefore(row, $('widget-mount'));
  }
  const wants = (rec.manifest.requests || []).filter((c) => CAPABILITY_WORDS[c]);
  row.innerHTML = '';
  row.hidden = !wants.length;
  if (!wants.length) return;
  const granted = (rec.grants || []).length > 0;
  const what = document.createElement('span');
  what.className = 'widget-perm-what';
  what.textContent = granted
    ? `Allowed to: ${wants.map((c) => CAPABILITY_WORDS[c]).join(', ')}`
    : `Wants to: ${wants.map((c) => CAPABILITY_WORDS[c]).join(', ')}`;
  const btn = document.createElement('button');
  btn.className = 'mon-skill-btn';
  btn.textContent = granted ? 'Revoke' : 'Allow';
  btn.onclick = async () => {
    const next = granted ? [] : wants;
    // saveWidget intersects with what the manifest asks for, so this can only ever narrow.
    await saveWidget(rec.manifest, { approved: next });
    rec.grants = next;
    await renderPermissions(rec);
    // The frame holds the OLD grant list, and a revoked widget that keeps working until the
    // panel is reopened is a revoke that did not happen.
    openOne(rec.manifest.id);
  };
  row.append(what, btn);
}

/**
 * The capabilities a widget may reach, and the only path to them.
 *
 * The grant check already happened in widget-host (against the shared contract) before this
 * is called — this decides what a granted call actually DOES, and it is deliberately a small
 * explicit table rather than a lookup into everything ChatPanel can do. A widget is
 * model-built code the user accepted on a whim; the list of things it can reach should be
 * readable in one screen.
 *
 * Everything here is loaded on FIRST USE, so a browser where no widget was ever granted a
 * capability never pays for the vault, its crypto, or the modal.
 */
async function invokeForWidget(rec, capability, args) {
  if (!String(capability || '').startsWith('vault.')) throw new Error(`unknown capability: ${capability}`);
  const [{ vaultCapabilities }, { confirmDelete, promptSecret }] = await Promise.all([
    import('./vault.js'), import('./confirm-modal.js'),
  ]);
  const name = rec?.manifest?.name || 'A widget';
  const caps = vaultCapabilities({
    // The widget cannot draw this dialog, cannot pre-answer it, and cannot make it look like
    // its own UI — which is the entire reason a reveal goes through the host.
    confirm: (q) => confirmDelete({ ...q, body: `${q.body}\n\nAsked for by “${name}”.` }),
    askPassphrase: ({ create }) => promptSecret({
      title: create ? 'Create your vault' : 'Unlock your vault',
      body: create
        ? 'Everything in the vault is encrypted with this passphrase, and it is never stored. If you forget it, the entries cannot be recovered — by us or by anyone.'
        : `“${name}” is asking to use your vault.`,
      confirmLabel: create ? 'Create vault' : 'Unlock',
      verify: !!create,
    }),
  });
  const fn = caps[capability];
  if (!fn) throw new Error(`unknown capability: ${capability}`);
  return fn(args || {});
}

async function openOne(id) {
  const rec = await getWidget(id);
  if (!rec) return;
  $('widgets-list-view')?.classList.add('hidden');
  $('widget-view')?.classList.remove('hidden');
  $('widget-view-title').textContent = rec.manifest.name;

  const mount = $('widget-mount');
  mount.innerHTML = '';
  if (mounted) mounted.destroy();
  mounted = mountWidget(mount, rec, { invokeCapability: (capability, args) => invokeForWidget(rec, capability, args) });
  if (!mounted) {
    // No sandbox page on this engine (Firefox). Say so rather than showing an empty box.
    mount.textContent = 'Widgets need the sandboxed renderer, which this browser does not provide.';
  }

  renderPermissions(rec);

  const pin = $('widget-pin');
  const paint = () => { pin.textContent = rec.pinned ? '★' : '☆'; pin.title = rec.pinned ? 'Unpin from the rail' : 'Pin to the rail'; };
  paint();
  pin.onclick = async () => {
    const pinnedNow = !rec.pinned;
    await pinWidget(id, pinnedNow);
    rec.pinned = pinnedNow;
    paint();
    onChange?.();
  };
  $('widget-delete').onclick = async () => {
    if (!confirm(`Delete "${rec.manifest.name}"? Its saved state goes with it. This cannot be undone.`)) return;
    await deleteWidget(id);
    showList();
    await renderWidgetsList();
    onChange?.();
  };
}

export async function renderWidgetsList() {
  const list = $('widgets-list');
  if (!list) return;
  const all = await listWidgets();
  list.innerHTML = '';
  if (!all.length) {
    const empty = document.createElement('p');
    empty.className = 'muted tiny';
    empty.textContent = 'No widgets yet. Ask for something small — a timer, a converter, a sticky note — then press “＋ Keep” on the result.';
    list.appendChild(empty);
    return;
  }
  for (const rec of all) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'widget-row';
    row.innerHTML = `<span class="widget-row-name"></span>${rec.pinned ? '<span class="widget-row-pin">★</span>' : ''}`;
    row.querySelector('.widget-row-name').textContent = rec.manifest.name;
    row.onclick = () => openOne(rec.manifest.id);
    list.appendChild(row);
  }
}

export async function openWidgets() {
  $('widgets-drawer')?.classList.remove('hidden');
  showList();
  await renderWidgetsList();
}

export function closeWidgets() {
  if (mounted) { mounted.destroy(); mounted = null; }
  $('widgets-drawer')?.classList.add('hidden');
}

export const widgetsOpen = () => !$('widgets-drawer')?.classList.contains('hidden');

/** Open one widget directly — what a pinned rail button does. */
export async function openWidgetById(id) {
  $('widgets-drawer')?.classList.remove('hidden');
  await openOne(id);
}

export async function pinnedWidgets() {
  return (await listWidgets()).filter((w) => w.pinned);
}

export function wireWidgetsPanel({ onPinsChanged } = {}) {
  onChange = onPinsChanged || null;
  $('widgets-close')?.addEventListener('click', closeWidgets);
  $('widget-back')?.addEventListener('click', async () => { showList(); await renderWidgetsList(); });
}
