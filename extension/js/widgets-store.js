// Where a user's own widgets live.
//
// A widget the model built is only a feature if it is still there tomorrow — otherwise it is
// a message that scrolled away. This is the persistence half: the manifests the user kept,
// and each widget's private state, stored separately so that clearing a stuck timer never
// deletes the timer itself.
//
// Storage is chrome.storage.local (survives restarts, not synced — a widget's state is
// device-local by nature: a running timer means nothing on another machine). Everything here
// is small and JSON; the contract's size caps are what keep it that way.

import { validateWidget, effectiveGrants } from './events/widget.js';

const KEY = 'chatpanel:widgets';        // id -> { manifest, grants, addedAt, pinned }
const STATE_KEY = 'chatpanel:widgetState'; // id -> arbitrary JSON, written by the widget itself

async function read(key) {
  try {
    const got = await chrome.storage.local.get(key);
    return got?.[key] && typeof got[key] === 'object' ? got[key] : {};
  } catch {
    return {}; // storage unavailable → behave like an empty shelf rather than throwing
  }
}
const write = (key, value) => chrome.storage.local.set({ [key]: value });

/** Every widget the user has kept, newest first. */
export async function listWidgets() {
  const all = await read(KEY);
  return Object.values(all).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export async function getWidget(id) {
  return (await read(KEY))[id] || null;
}

/**
 * Keep a widget. `approved` is what the USER agreed to, and it is intersected with what the
 * widget asks for — so re-saving a widget that quietly added a request grants nothing new.
 */
export async function saveWidget(manifest, { approved = [] } = {}) {
  validateWidget(manifest);
  const all = await read(KEY);
  const prev = all[manifest.id];
  all[manifest.id] = {
    manifest,
    grants: effectiveGrants(manifest, approved),
    addedAt: prev?.addedAt || Date.now(),
    updatedAt: Date.now(),
    pinned: prev?.pinned ?? false,
  };
  await write(KEY, all);
  return all[manifest.id];
}

/** Remove a widget AND its state — leaving orphaned state behind would be a quiet leak. */
export async function deleteWidget(id) {
  const all = await read(KEY);
  delete all[id];
  await write(KEY, all);
  const states = await read(STATE_KEY);
  delete states[id];
  await write(STATE_KEY, states);
}

export async function pinWidget(id, pinned) {
  const all = await read(KEY);
  if (!all[id]) return null;
  all[id].pinned = !!pinned;
  await write(KEY, all);
  return all[id];
}

// --- widget-private state -------------------------------------------------------------
// Keyed by widget id, and only ever reached through the host, which knows which frame asked.

export async function getWidgetState(id) {
  const states = await read(STATE_KEY);
  return states[id] ?? null;
}

export async function setWidgetState(id, state) {
  const states = await read(STATE_KEY);
  states[id] = state;
  await write(STATE_KEY, states);
  return state;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Widgets are the clearest case of "data a backup must carry": a widget the user asked for
 * and kept is a feature of THEIR ChatPanel that exists nowhere else — no release contains
 * it, and re-asking a model produces a different app. Its state travels too, because a habit
 * tracker without its history is a new habit tracker.
 */
export async function exportWidgets() {
  return { widgets: await read(KEY), state: await read(STATE_KEY) };
}

/**
 * Grants ride along. A grant is consent this user already gave to this widget, and it is
 * still intersected with what the manifest asks for on the way in — so a backup edited to
 * request more gains nothing.
 */
export async function importWidgets(data, { mode = 'merge' } = {}) {
  if (!data || typeof data !== 'object') return 0;
  const incoming = data.widgets && typeof data.widgets === 'object' ? data.widgets : {};
  const incomingState = data.state && typeof data.state === 'object' ? data.state : {};
  const current = mode === 'replace' ? {} : await read(KEY);
  const currentState = mode === 'replace' ? {} : await read(STATE_KEY);
  let n = 0;
  for (const [id, rec] of Object.entries(incoming)) {
    if (!rec?.manifest?.id) continue;
    try {
      validateWidget(rec.manifest);
    } catch {
      continue; // a manifest that cannot be validated cannot be mounted, so it is not kept
    }
    current[id] = { ...rec, grants: effectiveGrants(rec.manifest, rec.grants || []) };
    if (incomingState[id] !== undefined) currentState[id] = incomingState[id];
    n += 1;
  }
  await write(KEY, current);
  await write(STATE_KEY, currentState);
  return n;
}
