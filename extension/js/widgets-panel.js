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

import { listWidgets, deleteWidget, pinWidget, getWidget } from './widgets-store.js';
import { mountWidget } from './widget-host.js';

export const MAX_PINNED = 4; // the rail is a strip, not a dock — past this it stops scanning

let mounted = null;   // the live widget instance, so we can tear it down
let onChange = null;  // told when pins change, so the rail can re-render

const $ = (id) => document.getElementById(id);

function showList() {
  if (mounted) { mounted.destroy(); mounted = null; } // stop a running timer's frame
  $('widgets-list-view')?.classList.remove('hidden');
  $('widget-view')?.classList.add('hidden');
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
  mounted = mountWidget(mount, rec);
  if (!mounted) {
    // No sandbox page on this engine (Firefox). Say so rather than showing an empty box.
    mount.textContent = 'Widgets need the sandboxed renderer, which this browser does not provide.';
  }

  const pin = $('widget-pin');
  const paint = () => { pin.textContent = rec.pinned ? '★' : '☆'; pin.title = rec.pinned ? 'Unpin from the rail' : 'Pin to the rail'; };
  paint();
  pin.onclick = async () => {
    const pinnedNow = !rec.pinned;
    if (pinnedNow && (await listWidgets()).filter((w) => w.pinned).length >= MAX_PINNED) {
      pin.title = `Unpin one first — the rail holds ${MAX_PINNED}`;
      return;
    }
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
  return (await listWidgets()).filter((w) => w.pinned).slice(0, MAX_PINNED);
}

export function wireWidgetsPanel({ onPinsChanged } = {}) {
  onChange = onPinsChanged || null;
  $('widgets-close')?.addEventListener('click', closeWidgets);
  $('widget-back')?.addEventListener('click', async () => { showList(); await renderWidgetsList(); });
}
