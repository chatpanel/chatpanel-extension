// GENERATED — do not edit.
// Source of truth: chatpanel-events/promotion.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// PROMOTION — the gate between "a model wrote this" and "the brief says this".
//
// The single most repeated finding in the community threads was that unreviewed agent
// writing compounds into confident nonsense (C2), and the convergent answer was to separate
// CAPTURE from PROMOTION: agents draft freely, promotion needs review. This module is that
// separation as code. Class-R claims never pass through it — a backlink is not an opinion —
// and class-C claims never get around it.
//
//   proposed  →  promoted   only via accept()
//   proposed  →  rejected   via reject()
//
// A proposal is its own object rather than a mutation of the brief, so the queue survives a
// rebuild (I-K2 throws briefs away; it must not throw away the user's pending decisions),
// and so accepting shows a DIFF against what the brief said before rather than a fait
// accompli.
//
// `converge()` is W7's rule written before W7 exists: N independent drafts agree on a claim
// ⇒ it may be auto-proposed; disagreement ⇒ the human queue. The reviewer is a different
// appointment from the drafters or convergence measures nothing.

export const PROPOSAL_STATES = Object.freeze(['proposed', 'accepted', 'rejected']);

/** A pending synthesis for one brief. Never carries `promoted`. */
export function propose({ briefId, claims = [], summary = '', by = 'model', now = 0, newId = null } = {}) {
  if (!briefId) throw new TypeError('propose: briefId required');
  const bad = claims.find((c) => c?.cls !== 'C' || !c?.refs?.length);
  if (bad) throw new TypeError('propose: only class-C claims with refs may be proposed');
  return {
    id: newId ? newId() : `p-${briefId}-${now}`,
    briefId,
    by: String(by),
    at: now,
    state: 'proposed',
    claims: claims.map((c) => ({ ...c, state: 'proposed' })),
    summary: String(summary || ''),
  };
}

/**
 * Accept: the proposal's claims join the brief as promoted class-C claims. The ONLY path.
 * Returns a new brief and the settled proposal; mutates neither input.
 */
export function accept(brief, proposal, { now = 0 } = {}) {
  if (!brief || !proposal || proposal.briefId !== brief.id) throw new TypeError('accept: proposal does not belong to this brief');
  if (proposal.state !== 'proposed') throw new TypeError(`accept: proposal is ${proposal.state}`);
  const promoted = proposal.claims.map((c) => ({ ...c, state: 'promoted', lastConfirmed: now }));
  const next = {
    ...brief,
    claims: [...brief.claims, ...promoted],
    summary: proposal.summary || brief.summary || '',
    updatedAt: now,
  };
  return { brief: next, proposal: { ...proposal, state: 'accepted', settledAt: now } };
}

export function reject(proposal, { now = 0, why = '' } = {}) {
  if (!proposal || proposal.state !== 'proposed') throw new TypeError('reject: not a pending proposal');
  return { ...proposal, state: 'rejected', settledAt: now, why: String(why || '') };
}

/**
 * The diff a reviewer sees: what is new against the brief, and what a new claim
 * contradicts or supersedes. Deterministic and cheap — same-subject, same-`when`-or-later
 * claims that share enough words are shown as "replaces", which is a suggestion the
 * reviewer confirms, never an edit.
 */
export function diffProposal(brief, proposal) {
  const existing = (brief?.claims || []).map((c) => c.text);
  const tokens = (t) => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  return proposal.claims.map((c) => {
    const mine = tokens(c.text);
    let best = null; let bestScore = 0;
    for (const e of existing) {
      const theirs = tokens(e);
      let hit = 0; for (const w of mine) if (theirs.has(w)) hit += 1;
      const score = mine.size ? hit / mine.size : 0;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return { claim: c, replaces: bestScore >= 0.5 ? best : null, overlap: bestScore };
  });
}

/**
 * W7's rule. Given several INDEPENDENT drafts of the same subject, the claims that at least
 * `minAgree` drafts made (by near-identical text) may be proposed automatically; the rest go
 * to the human queue. "Agree" is a text-overlap test, not equality — two models never phrase
 * a thing identically, and requiring it would make convergence measure nothing.
 */
export function converge(drafts = [], { minAgree = 2, threshold = 0.6 } = {}) {
  const tokens = (t) => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  const all = drafts.flatMap((d, i) => (d?.claims || []).map((c) => ({ c, draft: i, t: tokens(c.text) })));
  const agreed = [];
  const disputed = [];
  const used = new Set();
  for (let i = 0; i < all.length; i += 1) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < all.length; j += 1) {
      if (used.has(j) || all[j].draft === all[i].draft) continue;
      let hit = 0; for (const w of all[i].t) if (all[j].t.has(w)) hit += 1;
      const score = all[i].t.size ? hit / all[i].t.size : 0;
      if (score >= threshold) group.push(j);
    }
    const drafters = new Set(group.map((g) => all[g].draft));
    for (const g of group) used.add(g);
    // The union of refs across agreeing drafts: agreement on the claim is evidence, and so
    // is every record any of them cited for it.
    const refs = [...new Map(group.flatMap((g) => all[g].c.refs || []).map((r) => [`${r.kind}:${r.id}`, r])).values()];
    const merged = { ...all[i].c, refs, agreedBy: drafters.size };
    (drafters.size >= minAgree ? agreed : disputed).push(merged);
  }
  return { agreed, disputed };
}
