// GENERATED — do not edit.
// Source of truth: chatpanel-events/team.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A team, as data — roles with grants, a merge policy, a budget. Nothing runs here.
//
// The Notes co-writer swarm was one team, hard-wired: a planner, four roles appointed per
// model, a shared board. The desktop was about to copy it, and every client would then hold
// its own answer to "what is a researcher allowed to touch". So a team is declared once, in
// this shape, and shared through the client-prefs document like a skill or a recipe: defined
// in one client, invokable in the other at its next open.
//
// Two invariants are enforced here rather than trusted:
//   • A role's GRANTS name tool groups, never tools — and `page` is not grantable. A tab is
//     one person's; a team member acting on it is the one thing every guard was written to
//     stop. `none` is a legitimate grant: a writer needs no tools.
//   • A team has a BUDGET, or it is not a team (F8 O1). `validateTeam` refuses one without.
//
// Trust is derived, never declared (the skill-manifest rule): a stored `builtin` cannot
// survive an `origin`, and a team a client stores as trusted is stored as nothing of the kind.

import { validateBudget, normalizeBudget } from './budget.js';

export const TEAM_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
export const ROLE_MODES = Object.freeze(['model', 'subagent', 'recipe']);
export const ROLE_PREFERS = Object.freeze(['cheap', 'balanced', 'strong']);
export const MERGE_POLICIES = Object.freeze(['judge', 'converge', 'concat', 'first']);
export const PLAN_MODES = Object.freeze(['fixed', 'planner']);
/** The tool groups a role may hold. `mcp:<server>` narrows to one server; `mcp` is all of them. */
export const GRANTABLE = Object.freeze(['none', 'data', 'web', 'mcp', 'history']);
export const GRANT_RE = /^(none|data|web|history|mcp|mcp:[a-zA-Z0-9_.:-]{1,64})$/;
export const MAX_ROLES = 8;

export class TeamError extends Error {
  constructor(code, message) { super(message); this.name = 'TeamError'; this.code = code; }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A role's grants, normalized: `none` alone means no tools; duplicates and `page` are dropped. */
export function normalizeGrants(grants) {
  const list = (Array.isArray(grants) ? grants : typeof grants === 'string' ? [grants] : []).map((g) => String(g || '').trim()).filter(Boolean);
  const ok = [...new Set(list.filter((g) => GRANT_RE.test(g)))];
  if (!ok.length || ok.includes('none')) return ['none'];
  return ok;
}

export function validateTeam(team) {
  const errors = [];
  if (!isRecord(team)) return { ok: false, errors: ['team must be an object'] };
  if (!TEAM_NAME_RE.test(String(team.name || ''))) errors.push('name: a short identifier (letters, digits, _ -)');
  if (!Array.isArray(team.roles) || !team.roles.length) errors.push('roles: a non-empty array');
  else {
    if (team.roles.length > MAX_ROLES) errors.push(`roles: at most ${MAX_ROLES}`);
    const seen = new Set();
    team.roles.forEach((r, i) => {
      const w = `roles[${i}]`;
      if (!isRecord(r)) { errors.push(`${w}: must be an object`); return; }
      if (!ROLE_ID_RE.test(String(r.id || ''))) errors.push(`${w}.id: a short identifier`);
      else if (seen.has(r.id)) errors.push(`${w}.id: duplicate "${r.id}"`);
      seen.add(r.id);
      if (r.mode !== undefined && !ROLE_MODES.includes(r.mode)) errors.push(`${w}.mode: one of ${ROLE_MODES.join(', ')}`);
      if (r.prefer !== undefined && !ROLE_PREFERS.includes(r.prefer)) errors.push(`${w}.prefer: one of ${ROLE_PREFERS.join(', ')}`);
      if ((r.mode || 'model') === 'recipe' && !r.recipe) errors.push(`${w}.recipe: a recipe name is required in recipe mode`);
      if ((r.mode || 'model') !== 'recipe' && !String(r.prompt || '').trim()) errors.push(`${w}.prompt: what this role does`);
      const bad = (Array.isArray(r.grants) ? r.grants : []).filter((g) => !GRANT_RE.test(String(g)));
      if (bad.length) errors.push(`${w}.grants: not grantable: ${bad.join(', ')}${bad.some((g) => /^page/.test(String(g))) ? ' (a tab is one person\'s; a team may not act on it)' : ''}`);
    });
  }
  if (team.merge !== undefined && !MERGE_POLICIES.includes(team.merge)) errors.push(`merge: one of ${MERGE_POLICIES.join(', ')}`);
  if (team.plan !== undefined && !PLAN_MODES.includes(team.plan)) errors.push(`plan: one of ${PLAN_MODES.join(', ')}`);
  if (team.judge !== undefined && team.judge !== null && !(Array.isArray(team.roles) && team.roles.some((r) => r?.id === team.judge))) errors.push('judge: must name one of the roles');
  const b = validateBudget(team.budget);
  if (!b.ok) errors.push(...b.errors.map((e) => `budget: ${e}`));
  return { ok: errors.length === 0, errors };
}

/**
 * The stored form. Defaults filled, grants normalized, trust derived: `builtin` only when the
 * host says so, never from the record.
 */
export function normalizeTeam(team, { builtin = false } = {}) {
  const v = validateTeam(team);
  if (!v.ok) throw new TeamError('INVALID', v.errors.join('; '));
  return {
    name: String(team.name),
    description: String(team.description || '').trim().slice(0, 300),
    plan: PLAN_MODES.includes(team.plan) ? team.plan : 'fixed',
    merge: MERGE_POLICIES.includes(team.merge) ? team.merge : (team.judge ? 'judge' : 'concat'),
    judge: team.judge || null,
    roles: team.roles.map((r) => ({
      id: String(r.id),
      name: String(r.name || r.id).slice(0, 60),
      mode: ROLE_MODES.includes(r.mode) ? r.mode : 'model',
      prefer: ROLE_PREFERS.includes(r.prefer) ? r.prefer : 'balanced',
      ...(r.model ? { model: String(r.model) } : {}),
      prompt: String(r.prompt || '').trim().slice(0, 4000),
      grants: normalizeGrants(r.grants),
      ...(r.recipe ? { recipe: String(r.recipe) } : {}),
      ...(Array.isArray(r.dependsOn) ? { dependsOn: r.dependsOn.map(String).filter((d) => d !== r.id) } : {}),
    })),
    budget: normalizeBudget(team.budget),
    enabled: team.enabled !== false,
    ...(team.origin && isRecord(team.origin) ? { origin: { ...team.origin } } : {}),
    ...(builtin ? { builtin: true } : {}),
    ...(team.createdAt ? { createdAt: team.createdAt } : {}),
  };
}

export function defineTeam(team) { return Object.freeze(normalizeTeam(team)); }

/** Which of a client's tool groups a role may hold — `(groupId, serverId?) => boolean`. */
export function grantAllows(grants, groupId, serverId = '') {
  const g = normalizeGrants(grants);
  if (g.includes('none')) return false;
  if (groupId === 'page') return false;
  if (groupId === 'mcp') return g.includes('mcp') || (!!serverId && g.includes(`mcp:${serverId}`));
  return g.includes(groupId);
}

/** One line a person reads per role: name · tier/model · grants · mode. */
export function describeRole(r) {
  const who = r.model || r.prefer || 'balanced';
  const grants = (r.grants || ['none']).join(', ');
  return `${r.name || r.id} — ${who}${r.mode && r.mode !== 'model' ? ` (${r.mode})` : ''} · tools: ${grants}`;
}
