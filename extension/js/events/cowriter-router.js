// GENERATED — do not edit.
// Source of truth: chatpanel-events/cowriter-router.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Who does which job: appointing a model to each role of the co-writer team.
//
// A co-writer is not one model. Proofreading runs constantly and must be cheap; drafting
// ahead runs rarely and should be the best thing available; research sits between them. Using
// one model for all three means either paying strong-model prices to catch "the the", or
// asking a small model to write prose. So each ROLE states a preference and this appoints the
// nearest candidate to it.
//
// Pure and dependency-free on purpose — no settings, no license, no DOM. The caller
// normalizes whatever roster it holds (the extension's configured endpoints and agents, the
// desktop's gateway model list) into candidates; this only decides. That is what makes the
// same appointment logic available to a gateway or a bridge that wanted to offer it.
//
// candidate: { id, name, kind, model, tier?, subagents?, usable? }
// role:      { id, prefer: 'cheap' | 'balanced' | 'strong' }

const TIER_RANK = { cheap: 0, balanced: 1, strong: 2 };

// Infer a capability tier from a model id (best-effort, provider-agnostic).
export function classifyModel(model = '') {
  const m = String(model).toLowerCase();
  if (/haiku|mini|flash|nano|lite|small|instant|\b[1-9]b\b|8b|7b|3b/.test(m)) return 'cheap';
  if (/opus|ultra|o1|o3|405b|70b|72b|large|gpt-4(?!o)|gpt-5/.test(m)) return 'strong';
  if (/sonnet|gpt-4o|mixtral|medium|32b|command-r/.test(m)) return 'balanced';
  return 'balanced'; // unknown → treat as mid so it's never wrongly picked as "cheapest"
}

// Native-subagent capable = bridge CLIs that orchestrate their own subagents.
export function supportsSubagents(candidate) {
  return candidate?.kind === 'bridge' && /^(claude|codex)$/i.test(candidate.bridgeAgent || candidate.model || '');
}

function withTierAndMode(c) {
  const tier = c.tier || classifyModel(c.model);
  return { ...c, tier, mode: (c.subagents ?? supportsSubagents(c)) ? 'subagent' : 'api' };
}

// Appoint one role → the best available candidate (or null if none usable).
export function appoint(role, candidates, { overrides = {} } = {}) {
  const usable = (candidates || []).filter((c) => c && c.usable !== false && c.model);
  if (!usable.length) return null;
  const ovId = overrides[role.id];
  if (ovId) {
    const m = usable.find((c) => c.id === ovId);
    if (m) return withTierAndMode(m);
  }
  const want = TIER_RANK[role.prefer] ?? 1;
  const best = usable
    .map((c) => ({ c: withTierAndMode(c), d: Math.abs((TIER_RANK[classifyModel(c.model)] ?? 1) - want) }))
    .sort((a, b) => a.d - b.d || (a.c.name || a.c.id).localeCompare(b.c.name || b.c.id))[0];
  return best.c;
}

// Appoint a whole team → { [roleId]: appointment | null }.
export function routeTeam(roles, candidates, opts = {}) {
  const out = {};
  for (const role of roles || []) out[role.id] = appoint(role, candidates, opts);
  return out;
}

/**
 * The team, and what each member is for.
 *
 * Here rather than in a client because a role is a CONTRACT — "the editor proofreads as you
 * type, cheaply, constantly" — and a second client inventing its own list is a client whose
 * Writer is not the same job as everyone else's. The icons and descriptions travel with it so
 * two products describe the team in one voice.
 */
export const SWARM_ROLES = Object.freeze([
  Object.freeze({ id: 'editor', prefer: 'cheap', icon: '\u270d\ufe0f', name: 'Editor', desc: 'Proofreads as you type' }),
  Object.freeze({ id: 'researcher', prefer: 'balanced', icon: '\ud83d\udd0e', name: 'Researcher', desc: 'Finds related material' }),
  Object.freeze({ id: 'writer', prefer: 'strong', icon: '\u2728', name: 'Writer', desc: 'Drafts ahead and rewrites' }),
  Object.freeze({ id: 'factcheck', prefer: 'strong', icon: '\u26a0\ufe0f', name: 'Fact-checker', desc: 'Flags shaky claims' }),
]);

/** A role by id, or null — so a stored override naming a role this build dropped is ignored. */
export const roleById = (id) => SWARM_ROLES.find((r) => r.id === id) || null;
