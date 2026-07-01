// notes-swarm-router.js — the model-router bridge for the Notes co-writer swarm.
//
// The router itself (cowriter-router.js) is pure/portable; this thin bridge normalizes
// the user's endpoints + agents into candidates and hands back a ready-to-stream agent
// per role (cheap for the Editor's constant proofreading, stronger for Writer/Researcher/
// Fact-checker). Everything here is dependency-injected via `deps` (streamChat/getTarget/
// resolveTarget/canUseAgent from providers + store + license) and holds NO editor state,
// so it stays reusable — the same appointment logic a gateway/bridge could offer.

// Role → routing preference. Consumed by the pure router's appoint().
export const SWARM_ROLES = {
  editor: { id: 'editor', prefer: 'cheap' },
  researcher: { id: 'researcher', prefer: 'balanced' },
  writer: { id: 'writer', prefer: 'strong' },
  factcheck: { id: 'factcheck', prefer: 'strong' },
};

// Display metadata for the team panel (icon / name / one-line description).
export const SWARM_ROLE_META = [
  { id: 'editor', icon: '✍️', name: 'Editor', desc: 'Proofreads as you type' },
  { id: 'researcher', icon: '🔎', name: 'Researcher', desc: 'Finds related material' },
  { id: 'writer', icon: '✨', name: 'Writer', desc: 'Drafts ahead on ⌘↵' },
  { id: 'factcheck', icon: '⚠️', name: 'Fact-checker', desc: 'Flags shaky claims (Focus)' },
];

// The pure router, lazy-loaded once and cached (kept OFF the page load path).
let _router = null;
export async function getRouter() {
  if (!_router) _router = await import('./cowriter-router.js');
  return _router;
}

export function swarmOverrides() {
  try { return JSON.parse(localStorage.getItem('chatpanel.notes.cowriter.roles') || '{}'); } catch { return {}; }
}

function candidateModel(ag, settings) {
  return ag.model || (ag.endpointId && (settings.endpoints || []).find((e) => e.id === ag.endpointId)?.model) || ag.bridgeAgent || '';
}

// Normalize the user's configured endpoints + agents into router candidates.
export function swarmCandidates(deps, settings, license) {
  const out = [];
  for (const ep of settings.endpoints || []) {
    if (ep?.model) out.push({ id: ep.id, name: ep.name || ep.model, kind: ep.kind || 'openai', model: ep.model, enabled: ep.enabled !== false, usable: deps.canUseAgent(license, settings, ep) });
  }
  for (const ag of settings.agents || []) {
    const model = candidateModel(ag, settings);
    if (!model) continue;
    out.push({ id: ag.id, name: ag.name || ag.bridgeAgent || model, kind: ag.kind || 'bridge', bridgeAgent: ag.bridgeAgent, model, enabled: ag.enabled !== false, usable: deps.canUseAgent(license, settings, ag) });
  }
  return out;
}

// → { resolved, mode, label } for a role, or null. Falls back to the active agent so a
// single-model user still gets every co-writer.
export async function roleAgent(deps, settings, license, roleId) {
  const router = await getRouter();
  // Never route to a DISABLED model (enabled:false is "hidden from pickers"); appoint()
  // further drops license-gated ones (usable:false).
  const cands = swarmCandidates(deps, settings, license).filter((c) => c.enabled !== false);
  const appt = router.appoint(SWARM_ROLES[roleId], cands, { overrides: swarmOverrides() });
  const target = appt ? deps.getTarget(settings, appt.id) : deps.getTarget(settings, settings.activeAgentId);
  if (!target || !deps.canUseAgent(license, settings, target)) return null;
  return { resolved: deps.resolveTarget(target, settings), mode: appt?.mode || 'api', label: target.name || appt?.model || '' };
}
