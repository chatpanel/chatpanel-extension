// Model router for the co-writer swarm. Given the user's configured agents and each
// role's preference, it APPOINTS a model to every role — cheap for frequent work,
// strong for hard work — honoring explicit per-role overrides, and reports whether the
// role should run as a native SUBAGENT (Claude Code / Codex) or a plain API call.
//
// Pure + dependency-free on purpose: no settings/license/DOM imports. The caller
// normalizes agents → candidates; this file just decides. That keeps it portable
// (extension / gateway / bridge) and fully unit-testable.
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
