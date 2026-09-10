// The knowledge layer's BACKUP half — export and import, and nothing else.
//
// It lives apart from store-briefs.js for the same reason js/backup-payload.js exists at
// all: store-briefs.js is on the first-paint graph of every surface that shows a brief
// (warm-sync, brief-source, the panel), and code that only runs when somebody presses
// Export or Restore must not be weighed on the way to painting a page. Adding these two
// functions inline pushed settings.js 4.8 KB over its budget, which is the guard doing
// exactly its job.
//
// Reached only through `backupExtras` — see js/backup-payload.js.

import {
  briefKey, indexEntry, K_INDEX, PROPOSALS_KEY, MERGES_KEY,
  getBriefIndex, getBrief, getProposals, getBriefMerges,
  getBriefSettings, saveBriefSettings, clearAllBriefs,
} from './store-briefs.js';
import { encryptJSON } from './meeting-crypto.js';

/**
 * Briefs + the decisions behind them, for a backup.
 *
 * WHY BACK UP SOMETHING DERIVED. The briefs themselves can be rebuilt from the corpus, so on
 * their own they would not earn the bytes. Two things travelling with them cannot be rebuilt:
 * the PROPOSALS the user accepted or rejected, and the SUBJECT MERGES they made. Those are
 * judgements about the corpus, not facts in it — a rebuild re-applies them (see writeBriefs)
 * and has no way to invent them. Losing them means reviewing everything again.
 *
 * And a second client changes the calculus for the briefs too: the desktop READS this layer
 * and does not derive it, so without them in the backup its knowledge view can only ever show
 * the gateway's flattened index copy, whatever the user restores.
 */
export async function exportBriefs() {
  const briefs = [];
  for (const entry of await getBriefIndex()) {
    const brief = await getBrief(entry.id);
    if (brief) briefs.push(brief);
  }
  return {
    briefs,
    proposals: await getProposals(),
    merges: await getBriefMerges(),
    settings: await getBriefSettings(),
  };
}

/**
 * Restore briefs and the decisions behind them.
 *
 * `mode: 'replace'` drops what is here first; 'merge' (the default) writes over matching ids
 * and leaves the rest. Anything malformed is skipped rather than failing the restore — a
 * derived layer is not worth losing a backup over, and a rebuild can recreate it.
 */
export async function importBriefs(data, { mode = 'merge', now = Date.now() } = {}) {
  if (!data || typeof data !== 'object') return 0;
  const incoming = Array.isArray(data.briefs) ? data.briefs : [];

  if (mode === 'replace') await clearAllBriefs();

  // The user's judgements go back FIRST, so a later rebuild re-applies them to whatever it
  // derives rather than to nothing.
  if (data.proposals && typeof data.proposals === 'object') {
    const have = await getProposals();
    await chrome.storage.local.set({ [PROPOSALS_KEY]: await encryptJSON(
      mode === 'replace' ? data.proposals : { ...have, ...data.proposals },
    ) });
  }
  // Merges are a MAP of `from → into`, not a list. Written as one so a later reader never
  // has to walk a chain (see mergeSubjects), and restored the same way.
  if (data.merges && typeof data.merges === 'object' && !Array.isArray(data.merges)) {
    const have = mode === 'replace' ? {} : await getBriefMerges();
    await chrome.storage.local.set({ [MERGES_KEY]: await encryptJSON({ ...have, ...data.merges }) });
  }
  if (data.settings && typeof data.settings === 'object') await saveBriefSettings(data.settings);

  if (!incoming.length) return 0;

  const writes = {};
  const kept = [];
  for (const b of incoming) {
    if (!b?.id || !b?.subject?.name || !Array.isArray(b.claims)) continue;
    writes[briefKey(b.id)] = await encryptJSON(b);
    kept.push(b);
  }
  if (!kept.length) return 0;

  // The index is rebuilt from what we just wrote plus whatever was already there, so a
  // merge restore does not drop the briefs the backup happens not to contain.
  const previous = mode === 'replace' ? [] : await getBriefIndex();
  const byId = new Map(previous.map((e) => [e.id, e]));
  for (const b of kept) byId.set(b.id, indexEntry(b));
  writes[K_INDEX] = await encryptJSON(
    [...byId.values()].sort((a, b) => (b.stats.records - a.stats.records) || a.name.localeCompare(b.name)),
  );
  await chrome.storage.local.set(writes);
  await saveBriefSettings({ lastBuiltAt: now });
  return kept.length;
}

