// Building briefs — the pass, and the only place derivation is imported.
//
// Split from js/store-briefs.js for a load-time reason with teeth: store-briefs is on the
// MV3 service worker's graph, because warm sync reads stored briefs and forwards them to
// the gateway. The worker never BUILDS one — deriving decrypts the whole corpus and runs
// whole-corpus passes, which is page work by the same argument js/jobs.js already makes for
// anything heavy. Keeping the derivation import here means the worker's cold start never
// pays for it, and the first-paint budget is what proves it rather than a comment.

import { deriveBriefs, driftedRefs } from './events/knowledge-derive.js';
import { resolveSubjects, suggestMerges } from './events/entity.js';
import { mentionsFrom } from './events/curate.js';
import {
  getBriefIndex, getBrief, getBriefSettings, getBriefMerges, writeBriefs,
} from './store-briefs.js';

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
    // The user's corrections, re-applied on every pass rather than baked into the output.
    merges: await getBriefMerges(),
    self: settings.selfName || selfNameFrom(memories),
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
 * Who "You" is, if the user has ever told ChatPanel their name.
 *
 * An `identity` memory is exactly that statement ("call me …"), already reviewed and already
 * durable, so reading it here is reuse rather than a second place to store the same fact. A
 * plain first-person sentence is not enough — this only picks up an explicit naming, because
 * folding every meeting's "You" into the wrong person is worse than not folding it at all.
 */
export function selfNameFrom(memories = []) {
  for (const m of memories) {
    if (m?.kind !== 'identity' || !m.text) continue;
    const hit = /\b(?:call me|my name is|i am|i'm|name:)\s+([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3})/iu.exec(m.text);
    if (hit) return hit[1].replace(/[.,;]$/, '').trim();
  }
  return '';
}

/**
 * Merge candidates the user could confirm — the nudge, not the decision.
 *
 * Deterministic and model-free: pairs the alias rule refuses to decide on its own, because
 * deciding wrongly merges two people permanently and silently. Already-merged names are
 * filtered out, so a confirmed answer stops being asked.
 */
export async function suggestBriefMerges(records = [], { memories = [] } = {}) {
  const settings = await getBriefSettings();
  const merges = await getBriefMerges();
  const subjects = resolveSubjects(mentionsFrom(records), {
    merges,
    self: settings.selfName || selfNameFrom(memories),
  });
  const done = new Set(Object.keys(merges).map((k) => k.toLowerCase()));
  // A real total, not the ranker's default cap. The UI pages through these and says
  // "showing N of M" — with the default limit of 40, M was always 40, which is a number
  // that looks like a count and is not one.
  return suggestMerges(subjects, { limit: 500 }).filter((m) => !done.has(m.dropName.toLowerCase()));
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
