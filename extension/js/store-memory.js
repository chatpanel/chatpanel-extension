// Persistence for MEMORY — the small set of durable facts about the user.
//
// ONE KEY, not an index plus a record per row. Notes and meetings are split that way because
// a corpus must never be loaded whole; memory is the opposite by design — capped at
// DEFAULT_MAX_MEMORIES short lines (~50 KB at the limit, and a tenth of that in practice), and
// EVERY TURN needs all of it to decide what to recall. A split store would turn one read into
// two hundred, on the hot path, to save nothing.
//
//   chatpanel:memory → the whole set, encrypted at rest
//
// The decisions all live in @chatpanel/events/memory.js (what a memory is, whether a write
// supersedes, what the model is told). This file is the chrome.storage binding and nothing
// else — the split the repo applies everywhere: semantics in the shared package, storage in
// the client.

import { encryptJSON, decryptJSON, isEncrypted } from './meeting-crypto.js';
import {
  normalizeMemory, reconcile, matchForForget, pruneMemories, markUsed,
  isValidMemory, upcastMemory, DEFAULT_MAX_MEMORIES,
} from './events/memory.js';

const K_MEMORY = 'chatpanel:memory';

const uid = () => `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// A single in-memory copy, so the ambient recall on every turn is a map lookup rather than a
// storage read + decrypt. Every turn needs the whole set, so this is the difference between
// one decrypt per session and one per message.
let cache = null;

// Storage events fire for changes made by ANY context — INCLUDING THIS ONE. Without this
// counter the cache was worthless: writeAll() populated it, its own write came straight back
// as an onChanged event, and the next read went to storage anyway. Events arrive in order, so
// counting our own writes and skipping exactly that many is enough to tell "I did this" from
// "the settings page did this" without comparing encrypted blobs (whose IVs differ per write).
let selfWrites = 0;

if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[K_MEMORY]) return;
    if (selfWrites > 0) { selfWrites -= 1; return; }
    cache = null; // another context edited memory — re-read on next use
  });
}

// The one place memory is written, so the self-write bookkeeping cannot be forgotten at a
// call site. Returns nothing; callers set `cache` themselves before calling.
async function put(list) {
  selfWrites += 1;
  try {
    await chrome.storage.local.set({ [K_MEMORY]: await encryptJSON(list) });
  } catch (e) {
    selfWrites = Math.max(0, selfWrites - 1); // no event will come for a write that failed
    throw e;
  }
}

// Decrypt-on-read with a best-effort repair of any legacy plaintext value — the same pattern
// as store-notes.js, so one storage convention covers every source.
async function readAll() {
  const got = await chrome.storage.local.get(K_MEMORY);
  const raw = got[K_MEMORY];
  const value = await decryptJSON(raw);
  if (raw !== undefined && !isEncrypted(raw) && value != null) {
    try { await chrome.storage.local.set({ [K_MEMORY]: await encryptJSON(value) }); } catch { /* read still works */ }
  }
  return Array.isArray(value) ? value : [];
}

/**
 * Every memory, newest-updated first. Records that fail validation are DROPPED rather than
 * repaired: a malformed memory would be injected into every future turn, so the failure mode
 * has to be losing one line, never carrying a corrupt one.
 */
export async function getMemories() {
  if (cache) return cache;
  const raw = await readAll();
  cache = raw
    .map((m) => { try { return upcastMemory(m); } catch { return null; } })
    .filter((m) => m && isValidMemory(m))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return cache;
}

async function writeAll(list) {
  const { kept, dropped } = pruneMemories(list, { now: Date.now(), max: DEFAULT_MAX_MEMORIES });
  cache = kept.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  await put(cache);
  return { memories: cache, dropped };
}

/**
 * Save one memory, reconciling against what is already stored — the ONLY write path, so
 * "call me Alex" twice can never leave two rows and a correction can never leave both values.
 *
 * @returns {{ action: 'create'|'update'|'duplicate', record, replaces, dropped }}
 */
export async function rememberMemory(input) {
  const all = await getMemories();
  const now = Date.now();
  const { action, record, replaces } = reconcile(all, input, { now, newId: uid });
  const rest = replaces ? all.filter((m) => m.id !== replaces.id) : all;
  const { dropped } = await writeAll([record, ...rest]);
  return { action, record, replaces, dropped };
}

/**
 * Drop memories by id, or by however the user named them ("forget the Frankfurt thing").
 * Returns what actually went, so the caller can say so rather than claiming success blindly.
 */
export async function forgetMemory(query) {
  const all = await getMemories();
  const q = String(query || '').trim();
  const hits = all.some((m) => m.id === q) ? all.filter((m) => m.id === q) : matchForForget(all, q);
  if (!hits.length) return { removed: [] };
  const gone = new Set(hits.map((m) => m.id));
  await writeAll(all.filter((m) => !gone.has(m.id)));
  return { removed: hits };
}

/** Edit one memory in place from the management UI. Re-derives key and slot from the text. */
export async function updateMemory(id, patch = {}) {
  const all = await getMemories();
  const existing = all.find((m) => m.id === id);
  if (!existing) return null;
  const next = normalizeMemory(
    { ...existing, ...patch, id, slot: patch.text != null ? '' : existing.slot, updatedAt: Date.now() },
    { now: Date.now() },
  );
  await writeAll([next, ...all.filter((m) => m.id !== id)]);
  return next;
}

/** Record that these memories were carried into a turn — recall ranking depends on it. */
export async function touchMemories(ids) {
  if (!ids?.length) return;
  const all = await getMemories();
  cache = markUsed(all, ids, { now: Date.now() });
  try { await put(cache); } catch { /* stats are not worth failing a turn */ }
}

export async function clearAllMemories() {
  cache = [];
  await put([]);
}

// --------------------------------------------------------------------------
// Backup — memory rides the same export/import as every other source
// --------------------------------------------------------------------------

export async function exportMemories() {
  return getMemories();
}

export async function importMemories(list, { mode = 'merge' } = {}) {
  if (!Array.isArray(list)) return 0;
  const incoming = list
    .map((m) => { try { return normalizeMemory(m, { now: Date.now(), newId: uid }); } catch { return null; } })
    .filter(Boolean);
  if (mode === 'replace') {
    await writeAll(incoming);
    return incoming.length;
  }
  // Merge goes through reconcile one at a time so an import cannot duplicate what is already
  // known — restoring a backup twice must be a no-op, not a doubled memory.
  let n = 0;
  for (const rec of incoming) {
    const all = await getMemories();
    const { action, record, replaces } = reconcile(all, rec, { now: Date.now(), newId: uid });
    if (action === 'duplicate') continue;
    await writeAll([record, ...(replaces ? all.filter((m) => m.id !== replaces.id) : all)]);
    n += 1;
  }
  return n;
}
