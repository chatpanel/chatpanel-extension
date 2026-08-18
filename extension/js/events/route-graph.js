// GENERATED — do not edit.
// Source of truth: chatpanel-events/route-graph.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The routing decision, as something you can LOOK at.
//
// A route currently explains itself in three lines of prose — which model, and two reasons.
// That is enough to read one decision and not nearly enough to find a wrong one: it cannot
// say what the alternatives were, how close they came, what was eliminated and why, or where
// the turn would go next if this model declined. Those are exactly the questions asked when
// the router picks something surprising, and answering them meant reading the code.
//
// So this derives the whole picture from one decision: every candidate with the numbers that
// decided it, and the failover chain the turn WOULD walk. It is a derivation, not a renderer
// — no DOM, no colours, no layout — so the side panel, the settings viewer, a desktop app or
// a CLI can each draw the same graph their own way.
//
// THE CHAIN IS COMPUTED BY THE SAME CODE THAT WILL WALK IT (failoverOrder). A projection with
// its own copy of the ordering would drift from the real thing, and a picture that lies about
// what the router is going to do is worse than no picture at all.
//
// Class R: arithmetic over a decision that has already been made. No model call, no I/O.

import { failoverOrder } from './router.js';

const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * @param decision the object returned by route()/routeWith().
 * @param models   every candidate considered, eligible or not (the router's full model list).
 * @param hops     how far to project the failover chain. The default matches what a user can
 *                 actually sit through rather than the attempt cap.
 * @returns { chosen, strategy, reasons, nodes, chain, eliminated }
 *   nodes   — every candidate, ranked, with why it was eliminated when it was.
 *   chain   — [chosen, ...replacements], the walk each subsequent decline would take.
 */
export function routeGraph({ decision = null, models = [], hops = 4 } = {}) {
  if (!decision) return { chosen: null, strategy: null, reasons: [], constraints: [], nodes: [], chain: [], eliminated: 0 };

  const eligible = decision.eligible || [];
  const eligibleIds = new Set(eligible.map((m) => m.id));
  const why = new Map((decision.rejected || []).map((r) => [r.id, r.why]));
  // Rank is position in the router's own ordering — the thing that decided — so a node's
  // place in the picture is the place it had in the decision, not a re-sort of our own.
  const rankOf = new Map(eligible.map((m, i) => [m.id, i]));

  const nodes = [...models]
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      reach: m.reach,
      classUsed: m.classUsed,
      quality: num(m.quality),
      costPer1k: num(m.costPer1k),
      latencyMs: num(m.latencyMs),
      // An order the user PINNED is a statement; one we inferred is a guess, and a picture
      // that shows them identically hides why a model won.
      order: num(m.providerRank),
      orderPinned: !!m.orderPinned,
      eligible: eligibleIds.has(m.id),
      rank: rankOf.has(m.id) ? rankOf.get(m.id) : null,
      chosen: m.id === decision.model?.id,
      // Present only when it was ruled out — the whole point of showing the losers.
      why: eligibleIds.has(m.id) ? null : (why.get(m.id) || 'not eligible'),
    }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.eligible) return (a.rank ?? 0) - (b.rank ?? 0);
      return String(a.label).localeCompare(String(b.label));
    });

  return {
    chosen: decision.model?.id || null,
    strategy: decision.strategy || null,
    reasons: decision.reasons || [],
    // WHY the constraints are what they are — which page capped the reach, what set the
    // quality floor. "reach 'trusted' within 'trusted'" says a ceiling applied and not what
    // imposed it, and an unexplained restriction is one people switch off wholesale.
    constraints: decision.constraints || [],
    nodes,
    chain: projectChain(decision, hops),
    eliminated: nodes.filter((n) => !n.eligible).length,
  };
}

/**
 * Where the turn goes if this model declines, and the one after that.
 *
 * Walked hop by hop rather than read off the ranking, because that is what actually happens:
 * each replacement is chosen relative to the model that JUST failed, not to the original. A
 * chain read off `eligible` order would be a plausible-looking fiction — it is the ordering
 * for the first choice, not for the fourth.
 */
export function projectChain(decision, hops = 4) {
  const first = decision?.model;
  if (!first) return [];
  const chain = [{ id: first.id, label: first.label || first.id, reason: null }];
  const tried = new Set([first.id]);
  let current = first;

  for (let i = 0; i < hops; i++) {
    const rest = (decision.eligible || []).filter((m) => !tried.has(m.id));
    if (!rest.length) break;
    // 'server' — a provider saying no, which is the ordinary case. A retired model reorders
    // this, but that is a fact discovered at failure time and cannot be known in advance.
    const next = failoverOrder(rest, {
      model: current.model,
      quality: current.quality,
      capabilities: current.capabilities,
      classUsed: current.classUsed,
      reason: 'server',
    })[0];
    if (!next) break;
    chain.push({ id: next.id, label: next.label || next.id, reason: `closest to ${current.label || current.id}` });
    tried.add(next.id);
    current = next;
  }
  return chain;
}
