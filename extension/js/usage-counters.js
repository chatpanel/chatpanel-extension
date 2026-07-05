// usage-counters.js — per-kind lifetime usage counters, stored as one object in
// chrome.storage.local. Each counter is seeded once from existing content, then
// incremented on create; counters are increment-only and are not cleared by
// content-delete or data-wipe paths. A shared primitive reused across notes,
// meetings, and other counted capabilities.

const K_USAGE = 'chatpanel:usage';

async function readUsage() {
  const got = await chrome.storage.local.get(K_USAGE);
  const u = got[K_USAGE];
  return u && typeof u === 'object' ? { ...u } : {};
}

// Lifetime count for `kind`. The FIRST time a counter is read it is seeded from
// `seed` — the current live count of existing items — so a long-time user's
// history is treated as already-created instead of resetting them to zero. Once
// seeded, the stored value is authoritative and `seed` is ignored.
export async function usageCount(kind, seed = 0) {
  const u = await readUsage();
  if (typeof u[kind] === 'number' && u[kind] >= 0) return u[kind];
  const seeded = Math.max(0, Math.floor(Number(seed) || 0));
  u[kind] = seeded;
  await chrome.storage.local.set({ [K_USAGE]: u });
  return seeded;
}

// Increment the lifetime count for `kind` by one and return the new value. Seeds a
// never-before-seen counter from `seed` first, so the +1 lands on top of any
// pre-existing content rather than starting from zero.
export async function bumpUsage(kind, seed = 0) {
  const u = await readUsage();
  const base = typeof u[kind] === 'number' && u[kind] >= 0 ? u[kind] : Math.max(0, Math.floor(Number(seed) || 0));
  u[kind] = base + 1;
  await chrome.storage.local.set({ [K_USAGE]: u });
  return u[kind];
}
