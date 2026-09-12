// SETTINGS THAT TRAVEL — keeping the shareable sections of this extension's settings in
// step with the gateway's client-preferences document, so the desktop app sees the same
// MCP servers, skills, search engines and tool policy, and its edits arrive here.
//
// Two moves, both driven by the shared rules in events/client-prefs.js:
//   push — after a save, the sections whose value changed since the last push are stamped
//          now and sent. The gateway keeps the newer stamp per section and hands back any it
//          kept; those are the other client's newer edits, and they are applied here.
//   pull — at open, the document is fetched and any section stamped newer than what was
//          last pushed or pulled is applied.
// A section applied FROM the gateway has its stamp recorded with its value's fingerprint,
// so the save that writes it does not push it back — that is what keeps two clients from
// ping-ponging one edit forever.
//
// Never loaded on first paint: store.js reaches for it with a dynamic import after a save,
// and the panel at idle. Without a gateway every call is a quiet no-op — the extension works
// alone, as it always has.

import { pickSections, applySections, changedSections, sectionHash, mergeStamped } from './events/client-prefs.js';
import { normalizeGatewayUrl, handshakeGatewayToken, getGatewayToken } from './gateway.js';

const K_STAMPS = 'chatpanel:prefsStamps'; // { [sectionId]: { hash, updatedAt } }
const TIMEOUT_MS = 4000;
const BY = 'extension';

async function readStamps() {
  try { return (await chrome.storage.local.get(K_STAMPS))?.[K_STAMPS] || {}; } catch { return {}; }
}
async function writeStamps(stamps) {
  try { await chrome.storage.local.set({ [K_STAMPS]: stamps }); } catch { /* best effort */ }
}

async function jfetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const token = getGatewayToken();
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error?.message || json?.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function baseOf(settings) {
  return normalizeGatewayUrl(settings?.gatewayUrl || 'http://127.0.0.1:4320');
}

/**
 * Push what changed since the last push. Returns `{ pushed: [ids], took: { id: value } }` —
 * `took` are sections the gateway held a NEWER copy of, already merged into the settings
 * object passed in (mutated) so the caller can save them once.
 */
export async function pushPrefs(settings) {
  const base = baseOf(settings);
  if (!base) return { pushed: [], took: {} };
  const stamps = await readStamps();
  const sections = changedSections(pickSections(settings), stamps);
  if (!Object.keys(sections).length) return { pushed: [], took: {} };
  let res;
  try {
    // A POST carries the extension Origin, which is what authorizes it — no token needed.
    res = await jfetch(`${base}/v1/prefs`, { method: 'POST', body: JSON.stringify({ sections, by: BY }) });
  } catch {
    return { pushed: [], took: {} }; // no gateway, or an old one — nothing to sync with
  }
  const took = {};
  const next = { ...stamps };
  for (const id of res.applied || []) next[id] = { hash: sectionHash(sections[id].value), updatedAt: sections[id].updatedAt };
  for (const id of res.kept || []) {
    const held = res.sections?.[id];
    if (!held) continue;
    took[id] = held.value;
    next[id] = { hash: sectionHash(held.value), updatedAt: held.updatedAt };
  }
  if (Object.keys(took).length) Object.assign(settings, applySections(settings, took));
  await writeStamps(next);
  return { pushed: res.applied || [], took };
}

/**
 * Pull the document and apply any section newer than what this extension last saw.
 * Returns `{ changed: [ids], settings }` — `settings` is a NEW object when something changed,
 * the same object otherwise, so a caller can `if (changed.length) save(settings)`.
 */
export async function pullPrefs(settings) {
  const base = baseOf(settings);
  if (!base) return { changed: [], settings };
  let res;
  try {
    await handshakeGatewayToken(base); // GETs need the token: Chrome omits Origin on them
    res = await jfetch(`${base}/v1/prefs`);
  } catch {
    return { changed: [], settings };
  }
  const stamps = await readStamps();
  const local = {};
  const mine = pickSections(settings);
  for (const [id, value] of Object.entries(mine)) local[id] = { value, updatedAt: stamps[id]?.updatedAt || 0 };
  const { fromRemote } = mergeStamped(local, res.sections || {});
  if (!fromRemote.length) return { changed: [], settings };
  const took = {};
  const next = { ...stamps };
  for (const id of fromRemote) {
    const held = res.sections[id];
    took[id] = held.value;
    next[id] = { hash: sectionHash(held.value), updatedAt: held.updatedAt };
  }
  await writeStamps(next);
  return { changed: fromRemote, settings: applySections(settings, took) };
}

/** Forget what was pushed — the next save sends everything, e.g. after a restore. */
export async function resetPrefsSync() {
  await writeStamps({});
}

let pushTimer = null;
/**
 * Debounced push after a save. When the gateway held a newer copy of something, it was
 * merged into `settings` and is written once more through `write` — its stamps already
 * match, so that write does not push it again.
 */
export function schedulePush(settings, write) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const { took } = await pushPrefs(settings);
      if (Object.keys(took).length && typeof write === 'function') await write(settings);
    } catch { /* no gateway — the extension works alone */ }
  }, 800);
}
