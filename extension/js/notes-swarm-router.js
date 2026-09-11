// notes-swarm-router.js — the model-router bridge for the Notes co-writer swarm.
//
// The router itself (cowriter-router.js) is pure/portable; this thin bridge normalizes
// the user's endpoints + agents into candidates and hands back a ready-to-stream agent
// per role (cheap for the Editor's constant proofreading, stronger for Writer/Researcher/
// Fact-checker). Everything here is dependency-injected via `deps` (streamChat/getTarget/
// resolveTarget/canUseAgent from providers + store + license) and holds NO editor state,
// so it stays reusable — the same appointment logic a gateway/bridge could offer.

// The shared "which model will actually answer" ordering — the same one the panel, the
// scribe and suggestions use. Notes had its own answer, and its own answer was the bug.
import { orderTargets } from './target-choice.js';

// Role → routing preference. Consumed by the pure router's appoint().
//
// MIRRORED from @chatpanel/events/cowriter-router.js `SWARM_ROLES`, not imported from it, and
// the reason is first paint: this module IS on the Notes first-paint graph (the swarm menu is
// part of the toolbar) while the router is deliberately loaded on demand. A static import
// here would drag the router onto the graph for data that is four lines of it.
//
// Mirrored data drifts, so `tools/test-cowriter-router.mjs` asserts these agree with the
// shared list — same ids, same preferences, same names — and fails when they do not.
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

// The pure router, lazy-loaded once and cached (kept OFF the page load path). It lives in
// @chatpanel/events now — the appointment logic is the same question every client asks, and
// the desktop asks it too.
let _router = null;
export async function getRouter() {
  if (!_router) _router = await import('./events/cowriter-router.js');
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

/**
 * Every model this role could run on, best first — the appointment, then the fallbacks.
 *
 * THE CHOICE THE USER ALREADY MADE COMES FIRST. This used to hand the role straight to
 * appoint(), which ranks by inferred model TIER and knows nothing about what the user
 * selected in the panel or about what is installed on the machine. So a user whose only
 * working agent was Codex got the Editor appointed to an API card they had configured but
 * could not reach, and the only lever they had was to DISABLE the card — which is exactly
 * how it was reported. Tier routing is a real feature and it is kept, but it is now an
 * OPT-IN one: it leads only for a role the user has explicitly pinned (swarmOverrides()).
 * Unpinned, the panel's active model leads and appointment is a fallback behind it.
 *
 * Returns a LIST rather than one answer so callers can rotate past a model that will not
 * answer — "at least it should rotate to the model that is working" — using the shared
 * chain in js/model-fallback.js.
 */
export async function roleAgents(deps, settings, license, roleId, { bridgeAgents = null } = {}) {
  const router = await getRouter();
  // Never route to a DISABLED model (enabled:false is "hidden from pickers"); appoint()
  // further drops license-gated ones (usable:false).
  const cands = swarmCandidates(deps, settings, license).filter((c) => c.enabled !== false);
  const pinned = swarmOverrides()[roleId] || '';
  const appt = router.appoint(SWARM_ROLES[roleId], cands, { overrides: swarmOverrides() });

  // One ordered list of ids: the pin (if any), then the panel's active model, then the
  // appointment, then everything else that could answer — reachable CLIs before missing ones.
  const ordered = orderTargets(settings, {
    prefer: pinned,
    license,
    canUseAgent: deps.canUseAgent,
    bridgeAgents,
  });
  const ids = [...new Set([
    ...(pinned ? [pinned] : []),
    settings?.activeAgentId || '',
    ...(appt ? [appt.id] : []),
    ...ordered.map((t) => t.id),
  ].filter(Boolean))];

  const out = [];
  for (const id of ids) {
    const target = deps.getTarget(settings, id);
    // getTarget substitutes on a miss, so check we got the id we asked for — otherwise a
    // deleted pin would silently re-add whatever the substitute happens to be.
    if (!target || target.id !== id) continue;
    if (!deps.canUseAgent(license, settings, target)) continue;
    if (target.enabled === false) continue;
    out.push({
      resolved: deps.resolveTarget(target, settings),
      mode: (appt && appt.id === id && appt.mode) || 'api',
      label: target.name || (appt && appt.id === id ? appt.model : '') || '',
    });
  }
  return out;
}

// → { resolved, mode, label } for a role, or null. The head of roleAgents(); kept because
// most callers want one model and the rotation belongs at the ones that stream.
export async function roleAgent(deps, settings, license, roleId, opts = {}) {
  return (await roleAgents(deps, settings, license, roleId, opts))[0] || null;
}
