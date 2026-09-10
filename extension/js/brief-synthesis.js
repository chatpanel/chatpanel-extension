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
import { createFallbackChain } from './model-fallback.js';
import { SYNTHESIS_SCHEMA, synthesisPrompt, claimsFromSynthesis, MAX_EXCERPTS } from './events/synthesis.js';
import { propose } from './events/promotion.js';
import { contentHash } from './events/knowledge.js';
import { runStructured } from './structured-call.js';

const targetKey = (t) => `${t.kind || ''}:${t.id || ''}:${t.model || ''}:${t.baseUrl || ''}`;
// Shared across calls, so a local model that refused the connection once is not re-dialled
// on the next brief — the same reason suggestions.js keeps one chain at module scope.
const chain = createFallbackChain({ key: targetKey });

/**
 * WHO ANSWERS, as a ladder rather than a pick.
 *
 * The first cut resolved one target and called it. The active agent was a local endpoint
 * that was not running, so the button produced ERR_CONNECTION_REFUSED and nothing else —
 * for a feature that had four other configured models it could have used. suggestions.js
 * had already learned the ladder. One difference from suggestions, on purpose: THE ACTIVE
 * AGENT LEADS WHATEVER ITS KIND. Suggestions demote a bridge CLI because a few short strings
 * are not worth a CLI round-trip; a synthesis is the user's chosen agent doing real work, and
 * "similar to other features" means it answers with the model they picked — Codex through
 * the bridge included — with the configured endpoints as fallback, not the other way round.
 *
 * This ladder is also the pool a swarm (W7) draws drafters from: same list, N appointments,
 * converge() deciding what to propose.
 */
export function synthesisCandidates(settings = {}) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!t) return;
    if (t.kind !== 'bridge' && !t.model) return; // an endpoint with no model cannot answer
    const key = targetKey(t);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  add(resolveTarget(getTarget(settings, settings?.activeAgentId), settings)); // the user's choice, first
  for (const ep of settings?.endpoints || []) add(resolveTarget(ep, settings));
  return out;
}

/** "localhost:8080 · gpt-x · Codex" — what was tried, so a failure is legible. */
function describeTarget(t) {
  try {
    if (t.kind === 'bridge') return t.name || t.agentId || 'bridge agent';
    const host = t.baseUrl ? new URL(t.baseUrl).host : '';
    return [host, t.model].filter(Boolean).join(' · ') || t.name || 'endpoint';
  } catch { return t.name || t.model || 'endpoint'; }
}

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
  const candidates = synthesisCandidates(settings);
  if (!candidates.length) throw new Error('no model is configured — add an endpoint or pick an agent in the side panel first');

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
  const value = await runStructured({ candidates, chain, schema: SYNTHESIS_SCHEMA, prompt, settings, signal, onPartial, maxTokens: 900 });
  if (!value) {
    // runStructured never throws, and a null is EITHER the schema's legitimate empty answer
    // ("the records establish nothing new") OR every candidate failed. The chain marks
    // failures for its own next run but does not expose them, so rather than guess, the
    // caller is told what was tried and can say both possibilities in one sentence.
    return { proposal: null, refused: [], tried: candidates.map(describeTarget) };
  }

  const now = Date.now();
  const { claims, summary, refused } = claimsFromSynthesis(value, {
    knownIds: new Set(excerpts.map((e) => e.id)),
    hashOf: (id) => contentHash(byId.get(id)?.text || ''),
    now,
  });
  if (!claims.length) return { proposal: null, refused, tried: candidates.map(describeTarget) };
  const proposal = propose({
    briefId, claims, summary,
    // The chain answered from whichever candidate was healthy; the first is the best guess
    // at attribution and the only one this call can name without a return channel.
    by: describeTarget(candidates[0]),
    now,
    newId: () => `p-${briefId.replace(/^brief:/, '')}-${now.toString(36)}`,
  });
  await putProposal(proposal);
  return { proposal, refused, tried: candidates.map(describeTarget) };
}

/** Is synthesis available at all — a model selected and briefs switched on. */
export async function canSynthesise(settings) {
  const s = await getBriefSettings();
  return !!(s.enabled && synthesisCandidates(settings).length);
}
