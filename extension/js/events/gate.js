// GENERATED — do not edit.
// Source of truth: chatpanel-events/gate.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The gate — how far a team may go without a person, as data an organisation configures.
//
// ChatPanel's own gate is the strictest setting; an organisation that trusts its pool more
// flips a flag. Nothing in the runner changes: project-run.js reads the gate at every step
// where it would otherwise ask, and `gateAllows` is the one question it asks. Lives in
// `.chatpanel/gate.json` in the org repo (pillars §14.3), optionally overridden per project.

export const AUTONOMY = Object.freeze(['propose', 'push', 'merge']);
export const HUMAN_FLAGS = Object.freeze(['merge', 'push', 'publish', 'budgetRaise', 'newAgent', 'newTool', 'writeBack', 'recruit']);
export const CHECKS = Object.freeze(['guard', 'review', 'tester', 'scan']);

/** ChatPanel's own: a branch push is not a release; everything else waits for a person. */
export const DEFAULT_GATE = Object.freeze({
  autonomy: 'push',
  human: Object.freeze({ merge: true, push: false, publish: true, budgetRaise: true, newAgent: true, newTool: true, writeBack: true, recruit: false }),
  requiredBeforeMerge: Object.freeze(['guard', 'review', 'tester']),
  branches: Object.freeze({ base: 'main', protected: Object.freeze(['main']) }),
  budget: Object.freeze({ perProjectCap: null, perJobCap: null }),
});

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateGate(g, { partial = false } = {}) {
  const errors = [];
  if (!isRecord(g)) return { ok: false, errors: ['gate must be an object'] };
  if (g.autonomy !== undefined && !AUTONOMY.includes(g.autonomy)) errors.push(`autonomy: one of ${AUTONOMY.join(', ')}`);
  if (g.human !== undefined) {
    if (!isRecord(g.human)) errors.push('human: an object of flags');
    else for (const [k, v] of Object.entries(g.human)) { if (!HUMAN_FLAGS.includes(k)) errors.push(`human.${k}: unknown flag`); else if (typeof v !== 'boolean') errors.push(`human.${k}: true or false`); }
  }
  if (g.requiredBeforeMerge !== undefined && (!Array.isArray(g.requiredBeforeMerge) || g.requiredBeforeMerge.some((c) => !CHECKS.includes(c)))) errors.push(`requiredBeforeMerge: a list of ${CHECKS.join(', ')}`);
  if (g.branches !== undefined && (!isRecord(g.branches) || (g.branches.protected !== undefined && !Array.isArray(g.branches.protected)))) errors.push('branches: { base, protected[] }');
  if (g.budget !== undefined && !isRecord(g.budget)) errors.push('budget: { perProjectCap, perJobCap }');
  if (!partial && g.autonomy === undefined) errors.push('autonomy: required');
  return { ok: errors.length === 0, errors };
}

/** A gate over the default: a partial gate fills in from ChatPanel's own; a full one stands alone. */
export function normalizeGate(g, { partial = false, base = DEFAULT_GATE } = {}) {
  const v = validateGate(g || {}, { partial: true });
  if (!v.ok) throw new Error(`gate: ${v.errors.join('; ')}`);
  const src = g || {};
  const b = partial ? base : DEFAULT_GATE;
  return {
    autonomy: AUTONOMY.includes(src.autonomy) ? src.autonomy : b.autonomy,
    human: { ...b.human, ...(isRecord(src.human) ? src.human : {}) },
    requiredBeforeMerge: Array.isArray(src.requiredBeforeMerge) ? [...new Set(src.requiredBeforeMerge)] : [...b.requiredBeforeMerge],
    branches: { base: String(src.branches?.base || b.branches.base), protected: Array.isArray(src.branches?.protected) ? [...new Set(src.branches.protected.map(String))] : [...b.branches.protected] },
    budget: { perProjectCap: src.budget?.perProjectCap ?? b.budget.perProjectCap, perJobCap: src.budget?.perJobCap ?? b.budget.perJobCap },
  };
}

/** The org's gate with a project's partial one over it. */
export function effectiveGate(orgGate = null, projectGate = null) {
  const org = normalizeGate(orgGate || {}, { partial: true });
  return projectGate ? normalizeGate(projectGate, { partial: true, base: org }) : org;
}

/**
 * The one question the executive loop asks: may a team do `action` on its own?
 *   push · merge · publish · budgetRaise · newAgent · newTool · writeBack · recruit
 * Returns `{ allowed, reason }`; a false answer is where the loop asks a person instead.
 */
export function gateAllows(gate, action, { branch = null } = {}) {
  const g = normalizeGate(gate || {}, { partial: true });
  if (action === 'push' || action === 'merge') {
    if (branch && g.branches.protected.includes(branch)) return { allowed: false, reason: `${branch} is protected — a person merges` };
    const far = AUTONOMY.indexOf(g.autonomy);
    if (action === 'push' && far < AUTONOMY.indexOf('push')) return { allowed: false, reason: 'the gate allows proposing only' };
    if (action === 'merge' && far < AUTONOMY.indexOf('merge')) return { allowed: false, reason: `the gate allows up to ${g.autonomy}` };
  }
  if (HUMAN_FLAGS.includes(action) && g.human[action]) return { allowed: false, reason: `a person decides ${action}` };
  return { allowed: true, reason: `the gate allows ${action}` };
}
