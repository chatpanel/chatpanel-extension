// SYNTHESISE ONE BRIEF, on the user's click — the first class-C claims in the product.
//
// The design gated synthesis behind two things: Stage 3, and a spend cap for the NIGHTLY
// curator (W4), because a job that starts model turns on a schedule is exactly the class-C
// spend nobody expected. A button is neither. You clicked it, it costs one call, and it
// lands in the Proposed queue — nothing self-promotes (I-K3). This is the wiki, made safe
// the boring way.
//
// `await import()`ed from the Briefs page at the click, never statically: it reaches
// events/structured.js (~50 KB) and the store, and a page whose first job is to LIST briefs
// must not pay for the one that WRITES them.
//
// Written as a single appointment so a team appointment (W7: N drafters, converge, a judge)
// has the same contract — swap `runStructured` for a routeTeam call and `propose` for
// `converge`, and nothing on either side of this file changes.

import { getBrief, putProposal, getBriefSettings } from './store-briefs.js';
import { getTarget, resolveTarget } from './store.js';
import { SYNTHESIS_SCHEMA, synthesisPrompt, claimsFromSynthesis, MAX_EXCERPTS } from './events/synthesis.js';
import { propose } from './events/promotion.js';
import { contentHash } from './events/knowledge.js';
import { runStructured } from './structured-call.js';

/**
 * Build a proposal for `briefId` from its most recent records. Returns the proposal, or
 * `null` when the model had nothing to add — which is an answer, not a failure.
 *
 * `records` is the loaded corpus (the caller has it; loading it here would decrypt
 * everything twice). `onPartial` streams the claims as they arrive, so the user watches the
 * synthesis form instead of a spinner.
 */
export async function synthesiseBrief(briefId, { settings, records, onPartial = null, signal } = {}) {
  const brief = await getBrief(briefId);
  if (!brief) throw new Error('that brief is gone — rebuild first');
  const target = resolveTarget(getTarget(settings, settings?.activeAgentId), settings);
  if (!target) throw new Error('no model is selected — pick an agent in the side panel first');

  // The records BEHIND this brief, newest first, capped. The cap is the design's I-K4 in
  // practice: a subject with two hundred records gets a bounded call, and a later pass can
  // take the next page.
  const byId = new Map((records || []).map((r) => [r.id, r]));
  const recent = [...brief.records].reverse().map((r) => byId.get(r.id)).filter(Boolean).slice(0, MAX_EXCERPTS);
  if (!recent.length) throw new Error('none of this brief\'s records are loaded');
  const excerpts = recent.map((r) => ({
    id: r.id, title: r.title, date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '',
    text: String(r.contentText || r.text || ''),
  }));

  const prompt = synthesisPrompt({
    subject: { name: brief.subject.name, kind: brief.kind, aliases: brief.subject.aliases },
    existing: brief.claims.map((c) => c.text),
    excerpts,
  });
  const value = await runStructured({ target, schema: SYNTHESIS_SCHEMA, prompt, settings, signal, onPartial, maxTokens: 900 });
  if (!value) return null;

  const now = Date.now();
  const { claims, summary, refused } = claimsFromSynthesis(value, {
    knownIds: new Set(excerpts.map((e) => e.id)),
    hashOf: (id) => contentHash(byId.get(id)?.text || ''),
    now,
  });
  if (!claims.length) return { proposal: null, refused };
  const proposal = propose({
    briefId, claims, summary,
    by: target.model || target.name || target.agentId || 'model',
    now,
    newId: () => `p-${briefId.replace(/^brief:/, '')}-${now.toString(36)}`,
  });
  await putProposal(proposal);
  return { proposal, refused };
}

/** Is synthesis available at all — a model selected and briefs switched on. */
export async function canSynthesise(settings) {
  const s = await getBriefSettings();
  return !!(s.enabled && resolveTarget(getTarget(settings, settings?.activeAgentId), settings));
}
