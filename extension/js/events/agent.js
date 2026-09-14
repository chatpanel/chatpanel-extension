// GENERATED — do not edit.
// Source of truth: chatpanel-events/agent.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// An AGENT, as data — the pool an org recruits from. Nothing runs here.
//
// A team's roles were inlined: each carried its own prompt, tier and grants, so the same
// "researcher" existed once per team and an edit landed in one of them. An agent is the role
// definition promoted out of the team (F8 §8 A1, architecture-pillars.md §9): a persistent
// identity — name, purpose, prompt, skills, grants, egress class, ENGINE, memory namespace —
// with a scorecard the runner writes and the store attests (scorecard.js). One agent stands
// in many teams; a team's role says `agent: <id>` and `resolveTeam` fills the role from the
// pool at run time, so the runner (team-run.js) is unchanged.
//
// The engine is a field on the card, never a nav item: `model` / `harness` / `auto` /
// `assistant` (engine.js). The built-in ASSISTANT is the agent behind every plain chat: its
// engine is whichever model the chat is on, which is why `engineOf` takes the chat's model.
//
// Trust is derived, never declared (the team.js rule): `builtin` only when the host says so.
// Grants are the team's vocabulary (team.js GRANT_RE), including the work grants a harness
// engine may hold; `page` is never grantable. The pool is shared through the client-prefs
// document (`agents` section) like teams, skills and recipes.

import { normalizeGrants, GRANT_RE, TeamError, normalizeTeam, slugTeamName } from './team.js';
import { normalizeEngineSpec, validateEngineSpec, describeEngine, engineRef, tierOf } from './engine.js';

export const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const APPLIES_TO = Object.freeze(['jobs', 'meetings', 'notes']);
export const EGRESS_CLASSES = Object.freeze(['redacted', 'delegated']);
export const MAX_SKILLS = 32;
export const ASSISTANT_ID = 'assistant';

export class AgentError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentError'; this.code = code; }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (xs, n, max) => [...new Set((Array.isArray(xs) ? xs : typeof xs === 'string' ? xs.split(/[,\s]+/) : []).map((x) => String(x || '').trim().slice(0, n)).filter(Boolean))].slice(0, max);

export function validateAgent(agent) {
  const errors = [];
  if (!isRecord(agent)) return { ok: false, errors: ['agent must be an object'] };
  if (!AGENT_ID_RE.test(String(agent.id || ''))) errors.push('id: a short identifier (letters, digits, _ -)');
  if (!String(agent.name || agent.id || '').trim()) errors.push('name: what to call it');
  if (!String(agent.prompt || '').trim() && String(agent.id) !== ASSISTANT_ID) errors.push('prompt: what this agent does');
  errors.push(...validateEngineSpec(agent.engine, 'engine'));
  const bad = (Array.isArray(agent.grants) ? agent.grants : []).filter((g) => !GRANT_RE.test(String(g)));
  if (bad.length) errors.push(`grants: not grantable: ${bad.join(', ')}${bad.some((g) => /^page/.test(String(g))) ? ' (a tab is one person\'s; an agent may not act on it)' : ''}`);
  if (agent.egress !== undefined && agent.egress !== null && !EGRESS_CLASSES.includes(agent.egress)) errors.push(`egress: one of ${EGRESS_CLASSES.join(', ')}`);
  if (agent.appliesTo !== undefined && (!Array.isArray(agent.appliesTo) || agent.appliesTo.some((a) => !APPLIES_TO.includes(a)))) errors.push(`appliesTo: a list of ${APPLIES_TO.join(', ')}`);
  if (agent.skills !== undefined && !Array.isArray(agent.skills) && typeof agent.skills !== 'string') errors.push('skills: a list of skill names');
  return { ok: errors.length === 0, errors };
}

/**
 * The stored form. Defaults filled, grants normalized, engine normalized, trust derived. The
 * memory namespace defaults to the agent's own (`agent:<id>`); a team may point several
 * agents at one shared namespace by naming it.
 */
export function normalizeAgent(agent, { builtin = false } = {}) {
  const v = validateAgent(agent);
  if (!v.ok) throw new AgentError('INVALID', v.errors.join('; '));
  const id = String(agent.id);
  return {
    id,
    name: String(agent.name || id).trim().slice(0, 60),
    purpose: String(agent.purpose || '').trim().slice(0, 300),
    prompt: String(agent.prompt || '').trim().slice(0, 8000),
    skills: list(agent.skills, 80, MAX_SKILLS),
    grants: normalizeGrants(agent.grants),
    engine: normalizeEngineSpec(agent.engine),
    ...(EGRESS_CLASSES.includes(agent.egress) ? { egress: agent.egress } : {}),
    appliesTo: Array.isArray(agent.appliesTo) && agent.appliesTo.length ? [...new Set(agent.appliesTo.filter((a) => APPLIES_TO.includes(a)))] : ['jobs'],
    memoryScope: String(agent.memoryScope || '').trim().slice(0, 120) || `agent:${id}`,
    ...(agent.workdir ? { workdir: String(agent.workdir).trim().slice(0, 400) } : {}),
    createdBy: String(agent.createdBy || 'person').slice(0, 80),
    enabled: agent.enabled !== false,
    ...(agent.origin && isRecord(agent.origin) ? { origin: { ...agent.origin } } : {}),
    ...(builtin ? { builtin: true } : {}),
    ...(agent.createdAt ? { createdAt: agent.createdAt } : {}),
  };
}

export function defineAgent(agent, opts) { return Object.freeze(normalizeAgent(agent, opts)); }

/**
 * The built-in Assistant — the agent behind every plain chat. Its engine is the chat's model
 * (`engineOf` resolves it); its grants are whatever the chat has; it applies everywhere.
 */
export function assistantAgent({ grants = ['data', 'web', 'history', 'mcp'] } = {}) {
  return defineAgent({
    id: ASSISTANT_ID, name: 'Assistant', purpose: 'The chat itself: answers, uses the tools you connected, remembers what you tell it.',
    prompt: '', engine: 'assistant', grants, appliesTo: ['jobs', 'meetings', 'notes'], createdBy: 'chatpanel',
  }, { builtin: true });
}

/**
 * WHAT RUNS this agent's turns, resolved: the Assistant's engine is the chat's model (the
 * host passes `chatModel` as `{ providerId?, model }` or a string), which is why the
 * Assistant has no engine of its own. Everything else returns its normalized spec. A legacy
 * role (no `engine`) reads as `model` when it pins one, else `auto` at its tier.
 */
export function engineOf(agentOrRole, { chatModel = null } = {}) {
  const a = agentOrRole || {};
  if (a.engine !== undefined && a.engine !== null) {
    const s = normalizeEngineSpec(a.engine);
    if (s.kind !== 'assistant') return s;
    if (chatModel) return normalizeEngineSpec(typeof chatModel === 'string' ? chatModel : { kind: 'model', providerId: chatModel.providerId, model: chatModel.model || chatModel.id });
    return { kind: 'auto', policy: { prefer: 'balanced' } };
  }
  if (a.model) return normalizeEngineSpec({ kind: 'model', model: a.model });
  const prefer = { cheap: 'cheapest-that-clears', strong: 'best-quality', balanced: 'balanced' }[a.prefer] || 'balanced';
  return { kind: 'auto', policy: { prefer } };
}

/** The capability strip's first column (§8): what kind of thing this agent is, in a word. */
export function describeAgent(agent, opts) {
  const a = agent || {};
  return `${a.name || a.id} — ${describeEngine(a.engine, opts)} · tools: ${(a.grants || ['none']).join(', ')}${a.skills?.length ? ` · skills: ${a.skills.join(', ')}` : ''}`;
}

export function slugAgentId(name) { return slugTeamName(name); }

/**
 * A team as the runner needs it: every role that says `agent` is filled from the pool —
 * prompt, grants, skills, engine, working directory — and the role's own fields narrow it.
 *
 *   • prompt   the agent's, then the role's ("In this team: …") when the role adds one
 *   • grants   the agent's, narrowed to the role's when the role lists any (a team may not
 *              widen an agent; it may lend less)
 *   • engine   the role's override when it has one, else the agent's, with the Assistant
 *              resolved to `chatModel`; `prefer` follows for today's appointers
 *   • model    what `callModel` is handed — `targetFor(engine)` when the host maps engines
 *              to its target ids (the extension's endpoint ids, the desktop's gateway ids),
 *              else the harness id or the model name
 *
 * A role naming an agent not in the pool throws NO_AGENT: a team is not run with a hole in
 * it. Returns the normalized team plus `agents` — the resolved cards, by role id.
 */
export function resolveTeam(team, pool = [], { chatModel = null, targetFor = null } = {}) {
  const t = normalizeTeam(team);
  const byId = new Map((Array.isArray(pool) ? pool : []).filter((a) => a && a.id).map((a) => [String(a.id), a]));
  const agents = {};
  const roles = t.roles.map((r) => {
    if (!r.agent) return r;
    const raw = byId.get(r.agent) || (r.agent === ASSISTANT_ID ? assistantAgent() : null);
    if (!raw) throw new TeamError('NO_AGENT', `role "${r.id}" names agent "${r.agent}", which is not in the pool`);
    const a = normalizeAgent(raw, { builtin: !!raw.builtin });
    if (a.enabled === false) throw new TeamError('NO_AGENT', `agent "${a.id}" is disabled`);
    agents[r.id] = a;
    const engine = engineOf(r.engine ? { engine: r.engine } : a, { chatModel });
    const ref = engineRef(engine);
    const target = ref ? (targetFor ? targetFor(engine, a) : (engine.kind === 'harness' ? engine.harnessId : engine.model)) : null;
    const grants = !Array.isArray(r.grants) ? a.grants
      : a.grants.includes('none') ? ['none']
        : normalizeGrants(r.grants.filter((g) => a.grants.includes(g) || (g.startsWith('mcp:') && a.grants.includes('mcp'))));
    const prompt = [a.prompt, r.prompt ? `In this team: ${r.prompt}` : ''].filter(Boolean).join('\n\n').slice(0, 8000);
    return {
      ...r,
      name: r.name === r.id ? a.name : r.name,
      prompt,
      grants,
      engine,
      prefer: engine.kind === 'auto' ? tierOf(engine) : r.prefer,
      ...(target ? { model: r.model || target } : {}),
      ...(a.skills.length ? { skills: [...a.skills] } : {}),
      ...(a.workdir ? { workdir: a.workdir } : {}),
      ...(a.egress ? { egress: a.egress } : {}),
      ...(a.memoryScope ? { memoryScope: a.memoryScope } : {}),
    };
  });
  return { ...t, roles, agents };
}

// ── The standing org and the editor's form ────────────────────────────────────────────────
//
// "ChatPanel Engineering" (architecture-pillars.md §12.2) — the first standing agents,
// offered as starters the way `research` and `review` are for teams. Every Implementer is
// this ONE card with a different working directory: the org repo's `agents/*.json` (§14.3)
// is where a company keeps one per repo. Engines are `auto` / `harness:<id>` so a starter
// does not name a provider a person may not have; the Harness engines say `claude` because
// that is the bridge's id for Claude Code and the pilot's choice — change it on the card.

export const STARTER_AGENTS = Object.freeze([
  { id: 'architect', name: 'Architect', purpose: 'Reads the docs and the repos; writes the project page and the jobs.',
    prompt: 'You are the Architect. Read the feature doc, ROADMAP.md, naming-revamp.md and architecture-pillars.md before deciding anything. Write the project page (goal, done-when, budget) and post one job per repo that must change, saying which repo and what the guard is. Propose a new agent type only when no one in the pool fits. Never run a shell.',
    skills: [], grants: ['data', 'history'], engine: { kind: 'auto', policy: { prefer: 'best-quality' } }, appliesTo: ['jobs'] },
  { id: 'implementer', name: 'Implementer', purpose: 'Builds one job on a branch in one repo; runs the guard; posts on the thread. Never pushes to main, never publishes.',
    prompt: 'You are an Implementer. Work only in the repository you were given, on the branch named for this job. Read the job thread first. Make the change, run the repository\'s guard (tools/test-*.mjs or npm test) until it passes, commit with a message that says what and why, and post a summary with the diff stat on the job thread. Do not push to main, do not publish, do not touch another repository.',
    skills: [], grants: ['shell', 'fs:write', 'scm:read', 'scm:push', 'scm:pr'], engine: { kind: 'harness', harnessId: 'claude' }, appliesTo: ['jobs'] },
  { id: 'reviewer', name: 'Reviewer', purpose: 'Reads the branch diff; posts findings on the thread. Approve or reject is a person\'s.',
    prompt: 'You are the Reviewer. Read the diff of the job\'s branch against its base. Post each finding as a reply on the job thread: what, where (file:line), why it matters, what to do instead. Do not edit files. Do not approve or reject — say what you found and let a person decide.',
    skills: ['review'], grants: ['shell', 'scm:read'], engine: { kind: 'harness', harnessId: 'claude' }, appliesTo: ['jobs'] },
  { id: 'tester', name: 'Tester', purpose: 'Runs the repository\'s guard on the branch; reports the result. No writes.',
    prompt: 'You are the Tester. Check out the job\'s branch in its worktree and run the repository\'s guard (tools/test-*.mjs, npm test, the build). Report pass/fail with the failing output verbatim. Do not change any file.',
    skills: [], grants: ['shell', 'scm:read'], engine: { kind: 'harness', harnessId: 'claude' }, appliesTo: ['jobs'] },
  { id: 'librarian', name: 'Librarian', purpose: 'Before every job: what was already done for this, and where.',
    prompt: 'You are the Librarian. Before a job starts, search the runs, boards, briefs and docs for work that already covers it. Reply on the job thread with "already done in …" pointers and what could be reused or extended. Never do the job yourself.',
    skills: [], grants: ['data', 'history'], engine: { kind: 'auto', policy: { prefer: 'cheapest-that-clears' } }, appliesTo: ['jobs'] },
  { id: 'scribe', name: 'Scribe', purpose: 'Writes what the run taught into the roadmap and the status row — proposed, a person lands it.',
    prompt: 'You are the Scribe. From the run\'s board and scorecards, write the "what this run taught" paragraph for the feature doc, the ROADMAP.md entry and the IMPLEMENTATION-STATUS.md row. Post them as a proposal on the thread; a person lands them. Say plainly what did not work.',
    skills: [], grants: ['data', 'history'], engine: { kind: 'auto', policy: { prefer: 'balanced' } }, appliesTo: ['jobs', 'notes'] },
  { id: 'release', name: 'Release', purpose: 'Version bump and changelog on the merged branch; asks before publish or push.',
    prompt: 'You are Release. On the merged branch: bump the version, write the changelog line, run the guard. Before `npm publish` or any `git push`, stop and ask on the thread — a person answers. Never publish or push without that answer.',
    skills: [], grants: ['shell', 'fs:write', 'scm:read', 'scm:push'], engine: { kind: 'harness', harnessId: 'claude' }, appliesTo: ['jobs'] },
]);

/** Fresh copies — a starter is a template, never the stored record. */
export function starterAgents() {
  return STARTER_AGENTS.map((a) => JSON.parse(JSON.stringify(a)));
}

/** A blank agent for the editor. */
export function blankAgent() {
  return { id: '', name: '', purpose: '', prompt: '', skills: [], grants: ['none'], engine: { kind: 'auto', policy: { prefer: 'balanced' } }, appliesTo: ['jobs'], memoryScope: '' };
}

/**
 * The editor's form → an agent, or the errors. Grants and skills come as text ("web, data",
 * "review, graphify"); the engine as the form's own shape (`{ kind, model, providerId,
 * harnessId, prefer }`) or a string; a blank id is slugged from the name.
 */
export function agentFromForm(form) {
  const f = form || {};
  const id = String(f.id || '').trim() || slugAgentId(f.name);
  const engine = isRecord(f.engine)
    ? (f.engine.kind === 'auto' ? { kind: 'auto', policy: { prefer: f.engine.prefer || f.engine.policy?.prefer || 'balanced', ...(f.engine.policy || {}) } } : f.engine)
    : f.engine;
  const agent = {
    id,
    name: String(f.name || '').trim() || id,
    purpose: String(f.purpose || '').trim(),
    prompt: String(f.prompt || ''),
    skills: list(f.skills, 80, MAX_SKILLS),
    grants: list(f.grants, 80, 32).length ? list(f.grants, 80, 32) : ['none'],
    engine,
    ...(f.egress ? { egress: f.egress } : {}),
    appliesTo: Array.isArray(f.appliesTo) && f.appliesTo.length ? f.appliesTo : ['jobs'],
    ...(f.memoryScope ? { memoryScope: f.memoryScope } : {}),
    ...(f.workdir ? { workdir: f.workdir } : {}),
    createdBy: f.createdBy || 'person',
    enabled: f.enabled !== false,
    ...(f.origin && isRecord(f.origin) ? { origin: f.origin } : {}),
    ...(f.createdAt ? { createdAt: f.createdAt } : {}),
  };
  const v = validateAgent(agent);
  return v.ok ? { ok: true, agent: normalizeAgent(agent) } : { ok: false, errors: v.errors };
}

/** Which agents apply to jobs — the pool a job board recruits from. */
export function poolFor(agents, surface = 'jobs') {
  return (Array.isArray(agents) ? agents : []).filter((a) => a && a.enabled !== false && (Array.isArray(a.appliesTo) ? a.appliesTo : ['jobs']).includes(surface));
}
