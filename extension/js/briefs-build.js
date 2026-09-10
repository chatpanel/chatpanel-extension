// Building briefs — the pass, and the only place derivation is imported.
//
// Split from js/store-briefs.js for a load-time reason with teeth: store-briefs is on the
// MV3 service worker's graph, because warm sync reads stored briefs and forwards them to
// the gateway. The worker never BUILDS one — deriving decrypts the whole corpus and runs
// whole-corpus passes, which is page work by the same argument js/jobs.js already makes for
// anything heavy. Keeping the derivation import here means the worker's cold start never
// pays for it, and the first-paint budget is what proves it rather than a comment.

import { deriveBriefs, driftedRefs } from './events/knowledge-derive.js';
import { getBriefIndex, getBrief, getBriefSettings, writeBriefs } from './store-briefs.js';

/**
 * Re-derive every brief from the corpus and replace what is stored.
 *
 * `records` and `memories` are passed IN rather than loaded here, because this runs from
 * more than one place with more than one idea of "the corpus": the dashboard (everything),
 * an idle refresh, and a test (a fixture). Loading inside would make the last impossible and
 * would put history-rag on this module's graph, which every caller would then pay for.
 *
 * Returns a report rather than nothing — the Maintenance tab is this report.
 */
export async function rebuildBriefs(records = [], { memories = [], now = Date.now() } = {}) {
  const settings = await getBriefSettings();
  if (!settings.enabled) return { ok: false, reason: 'disabled', briefs: 0 };

  const briefs = deriveBriefs(records, {
    memories,
    threshold: { records: settings.minRecords, mentions: settings.minMentions },
    limit: settings.maxBriefs,
    now,
  });
  const written = await writeBriefs(briefs, { now });
  return {
    ok: true,
    ...written,
    byKind: briefs.reduce((acc, b) => ({ ...acc, [b.kind]: (acc[b.kind] || 0) + 1 }), {}),
    now,
  };
}

/**
 * Which claims cite a record that has since changed or gone.
 *
 * Deliberately a READ, not a repair: a drifted claim is information ("this was true of a
 * meeting that has since been edited"), and silently re-deriving it would hide the very
 * thing the reader needs to see. The Maintenance tab shows it; a rebuild is the fix, and
 * the user asks for that.
 */
export async function briefDrift(records = []) {
  const out = [];
  for (const entry of await getBriefIndex()) {
    const brief = await getBrief(entry.id);
    if (!brief) continue;
    const drifted = driftedRefs(brief, records);
    if (drifted.length) out.push({ id: brief.id, name: brief.subject.name, kind: brief.kind, drifted });
  }
  return out;
}
