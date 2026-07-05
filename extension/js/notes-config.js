// notes-config.js — portable snapshot / restore of the Notes UI + co-writer config.
//
// These prefs — co-writer swarm role→model overrides (chatpanel.notes.cowriter.roles),
// co-writer on/off, gear (ambient/focus), AI prefs, editor mode, source filter, per-note
// board intent, and pane layout — live in localStorage because the Notes page reads them
// SYNCHRONOUSLY on first paint (moving them to async chrome.storage would stall first
// paint, which is a hard release gate). localStorage is shared across all extension PAGES
// (same chrome-extension://<id> origin) but is ABSENT in the service worker, where
// auto-backup runs. So this module:
//   • reads live from localStorage everywhere it exists (manual export from any page — always fresh);
//   • keeps a mirror in chrome.storage.local for the service-worker backup path;
//   • restores into localStorage (and refreshes the mirror) so the config travels machines.
// Backup (store.js exportAllData) carries whatever exportNotesConfig() returns.

const PREFIX = 'chatpanel.notes.';
const MIRROR_KEY = 'chatpanel:notesConfig';

// Every chatpanel.notes.* key from localStorage as a plain { key: string } object.
// Empty when there's no localStorage (service worker).
function snapshotLocal() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out[k] = localStorage.getItem(k);
    }
  } catch {
    /* no localStorage — service worker */
  }
  return out;
}

// Push the live localStorage snapshot into chrome.storage.local so the
// service-worker auto-backup can see it. Called from the Notes page when it hides
// / unloads — cheap, and this config changes rarely. No-op off a page.
export async function mirrorNotesConfig() {
  if (typeof localStorage === 'undefined') return {};
  const snap = snapshotLocal();
  await chrome.storage.local.set({ [MIRROR_KEY]: snap });
  return snap;
}

// Backup payload. Prefer live localStorage (fresh, any extension page); fall back to
// the mirror in the service worker.
export async function exportNotesConfig() {
  if (typeof localStorage !== 'undefined') return snapshotLocal();
  const got = await chrome.storage.local.get(MIRROR_KEY);
  const cfg = got[MIRROR_KEY];
  return cfg && typeof cfg === 'object' ? cfg : {};
}

// Restore. Writes into localStorage when available (restore is page-triggered) and
// always refreshes the mirror so a later service-worker backup round-trips the same
// values. 'replace' clears our namespace first; 'merge' (default) overlays.
export async function importNotesConfig(cfg, { mode = 'merge' } = {}) {
  if (!cfg || typeof cfg !== 'object') return { imported: 0 };
  const entries = Object.entries(cfg).filter(([k, v]) => k.startsWith(PREFIX) && typeof v === 'string');
  if (typeof localStorage !== 'undefined') {
    if (mode === 'replace') {
      for (const k of Object.keys(snapshotLocal())) localStorage.removeItem(k);
    }
    for (const [k, v] of entries) localStorage.setItem(k, v);
  }
  const base = mode === 'replace' ? {} : await exportNotesConfig();
  await chrome.storage.local.set({ [MIRROR_KEY]: { ...base, ...Object.fromEntries(entries) } });
  return { imported: entries.length };
}
