// BRIEFS AS A SOURCE — the single registration that puts the derived layer everywhere.
//
// `source-registry.js` says what this buys, and it is the reason this file is three
// screens rather than thirty:
//
//   "register one and history search, RAG, the omni palette, the context assembler and
//    the graph all gain it at once, because each consumes the registry rather than a list."
//
// So ⌘K, the `find` dispatcher, the relationship graph, a turn's retrieved context, warm
// sync to the gateway — and therefore every CLI agent's `search_history` over MCP — all
// gain briefs with no edit to any of those call sites. This is also the milestone F3.2 has
// been waiting for: one real new source, end to end, proving the contract F3.1 asserted.
//
// A brief is ranked by the SAME engine as the records under it. If a brief loses to its own
// sources that is a ranking bug, not a reason for a parallel index — the design is explicit
// that a second retrieval stack is the thing not to build.

import { registerSource } from './source-registry.js';
import { getBriefIndex, getBrief } from './store-briefs.js';
import { briefToText } from './events/knowledge.js';

/** A stored brief → the Source shape chats, meetings and notes already produce. */
export function briefSource(entry, brief) {
  const id = entry?.id || brief?.id;
  if (!id || !brief) return null;
  const text = briefToText(brief);
  if (!text) return null;
  const name = brief.subject?.name || entry?.name || 'Brief';
  return {
    // Already `brief:<slug>-<hash>`, so it is addressable by `get_record` the day it exists.
    id,
    type: 'brief',
    // The subject IS the title. A brief has no other name, and the graph and ⌘K show titles.
    title: name,
    date: brief.updatedAt || entry?.updatedAt || 0,
    url: briefUrl(id),
    text,
    contentText: text,
    meta: {
      id,
      kind: brief.kind,
      state: brief.state,
      aliases: brief.subject?.aliases || [],
      // The graph weights `terms` — a brief's neighbours are the subjects it co-occurs with,
      // which makes it a hub rather than a leaf, which is the point of having one.
      terms: entry?.terms || [],
      tags: [],
      records: brief.stats?.records || 0,
    },
  };
}

export function briefUrl(id) {
  const path = `briefs.html#${encodeURIComponent(id || '')}`;
  try { if (globalThis.chrome?.runtime?.getURL) return chrome.runtime.getURL(path); } catch { /* not in an extension page */ }
  return path;
}

async function loadBriefSources() {
  const out = [];
  for (const entry of await getBriefIndex()) {
    try {
      const brief = await getBrief(entry.id);
      const source = briefSource(entry, brief);
      if (source) out.push(source);
    } catch (e) {
      console.warn('[chatpanel] brief source load failed for', entry?.id, e);
    }
  }
  return out;
}

/**
 * `enabledByDefault: true` — unlike meetings, which are off by default because a transcript
 * is other people's words. A brief is a synthesis of the user's OWN corpus and is the
 * cheapest thing in the index to read: it is the compaction, so leaving it out of a search
 * would mean paying for the records it summarises instead.
 */
export function registerBriefSource() {
  return registerSource({
    kind: 'brief',
    label: 'Briefs',
    reads: ['briefs'],
    load: loadBriefSources,
    builtIn: true,
    enabledByDefault: true,
  });
}
