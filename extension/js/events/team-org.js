// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-org.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The org, derived — what the Agent Teams surface draws (F8 §17), computed once here so the
// desktop, the extension and a phone render the same roster, the same shape and the same
// colours from the same two sections (`agents`, `teams`) and the same records.
//
// Why this exists: the Agents tab and the Teams tab disagreed. `research` and `review` kept
// their roles INLINE — prompt, tier and grants written into the team — so the roles ran, were
// scored, and were never in the pool; `feature` and friends referenced `agent: architect` by
// id, which existed only after "+ the engineering org" was clicked, so a team could be saved
// full of holes and the only place that was said was a `<select>` option. Both are answered
// by the same rule: EVERY ROLE THAT CAN RUN IS A CARD IN THE POOL, a hole is a state a client
// draws, and a starter team brings the agents it stands on.
//
// Nothing here renders. A client maps `columns` to boxes and arrows, `hue` to a colour, and
// `kind` to a word; the SVG is its own.

import { normalizeTeam, validateTeam, starterTeams, TeamError } from './team.js';
import { normalizeAgent, engineOf, starterAgents, STARTER_AGENTS, ASSISTANT_ID } from './agent.js';

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const poolList = (pool) => (Array.isArray(pool) ? pool : []).filter((a) => a && a.id);

/** The card a team's inline role becomes: `<team>-<role>`, an id the pool and the gateway's routes accept. */
export function roleCardId(teamName, roleId) {
  return `${String(teamName || '').toLowerCase()}-${String(roleId || '').toLowerCase()}`.replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 64);
}

const titleCase = (id) => String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
const firstSentence = (text) => String(text || '').trim().split(/(?<=[.!?])\s+/)[0]?.slice(0, 300) || '';

/**
 * A team as it is SAVED: every inline `model` role becomes a pool card (`agents` to upsert —
 * the role's prompt, grants, engine, skills and working directory move onto it, stamped
 * `createdBy: team:<name>` and `origin: { team, role }`) and the role is rewritten to
 * `agent: <card id>` keeping only what is the team's — its id, name, dependencies. A role
 * that already names an agent, a `recipe` or `subagent` role, is left as it is.
 *
 * Idempotent: saving the same team again yields the same cards (a card's `createdAt` is kept
 * from the pool). The caller writes BOTH sections; this is what both clients' save paths
 * — the form and the chat card — call, so a role can never again run without being seen.
 */
export function promoteRoles(team, pool = [], { now = Date.now } = {}) {
  const t = normalizeTeam(team);
  const byId = new Map(poolList(pool).map((a) => [String(a.id), a]));
  const agents = [];
  const roles = t.roles.map((r) => {
    if (r.agent || r.mode !== 'model') return r;
    const id = roleCardId(t.name, r.id);
    const existing = byId.get(id);
    const card = normalizeAgent({
      id,
      name: r.name && r.name !== r.id ? r.name : titleCase(r.id),
      purpose: firstSentence(r.prompt),
      prompt: r.prompt || `You are the ${r.id} of the ${t.name} team.`,
      skills: r.skills || [],
      grants: r.grants || ['none'],
      engine: r.engine || engineOf(r),
      ...(r.workdir ? { workdir: r.workdir } : {}),
      ...(r.egress ? { egress: r.egress } : {}),
      ...(r.memoryScope ? { memoryScope: r.memoryScope } : {}),
      appliesTo: ['jobs'],
      createdBy: `team:${t.name}`,
      origin: { team: t.name, role: r.id },
      createdAt: existing?.createdAt || now(),
      enabled: true,
    });
    agents.push(card);
    return {
      id: r.id,
      ...(r.name && r.name !== r.id ? { name: r.name } : {}),
      mode: r.mode,
      agent: id,
      ...(r.dependsOn?.length ? { dependsOn: [...r.dependsOn] } : {}),
      ...(r.model ? { model: r.model } : {}),
    };
  });
  return { team: normalizeTeam({ ...t, roles }), agents };
}

/**
 * A starter team WITH the agents it stands on: the inline roles promoted, plus every
 * built-in agent it references that the pool lacks. "+ research starter" adds two cards
 * and a team; "+ feature starter" adds the team and the Architect, Implementer, Reviewer,
 * Tester and Scribe if they are not there yet. Never half-installed.
 */
export function starterTeam(name, pool = [], opts = {}) {
  const src = starterTeams().find((t) => t.name === name);
  if (!src) return null;
  const { team, agents } = promoteRoles(src, pool, opts);
  const have = new Set([...poolList(pool).map((a) => String(a.id)), ...agents.map((a) => a.id)]);
  const builtins = starterAgents().filter((a) => team.roles.some((r) => r.agent === a.id) && !have.has(a.id));
  return { team, agents: [...agents, ...builtins] };
}

/** Which built-in agents a team names that the pool lacks — what "Add the built-in Tester" adds. */
export function missingStarters(team, pool = []) {
  const have = new Set(poolList(pool).map((a) => String(a.id)));
  return starterAgents().filter((a) => (team?.roles || []).some((r) => r.agent === a.id) && !have.has(a.id));
}

/**
 * Can this team run as it stands? A hole is a role naming an agent that is not in the pool
 * (`fix: 'add-builtin'` when a starter has that id, else `'pick'`); a disabled agent is its
 * own row. `resolveTeam` still throws NO_AGENT beneath — this is the state a client draws
 * BEFORE the run button, with the reason in one line.
 */
export function teamHealth(team, pool = []) {
  const byId = new Map(poolList(pool).map((a) => [String(a.id), a]));
  const holes = [];
  const disabled = [];
  const valid = validateTeam(team).ok;
  for (const r of team?.roles || []) {
    if (!r?.agent || r.agent === ASSISTANT_ID) continue;
    const a = byId.get(String(r.agent));
    if (!a) holes.push({ role: r.id, agent: r.agent, fix: STARTER_AGENTS.some((s) => s.id === r.agent) ? 'add-builtin' : 'pick' });
    else if (a.enabled === false) disabled.push({ role: r.id, agent: r.agent });
  }
  // Roles written into the team before §17.1 (or by an older client): they run, they are
  // scored, and they are not on the roster. Not a hole — a save promotes them.
  const inline = (team?.roles || []).filter((r) => r && !r.agent && (r.mode || 'model') === 'model').map((r) => r.id);
  const off = team?.enabled === false;
  const ready = valid && !off && !holes.length && !disabled.length;
  const reason = !valid ? 'the team is not complete'
    : off ? 'the team is off'
      : holes.length ? `${holes.length === 1 ? 'a role names an agent' : `${holes.length} roles name agents`} not in the pool: ${holes.map((h) => h.agent).join(', ')}`
        : disabled.length ? `${disabled.map((d) => d.agent).join(', ')} ${disabled.length === 1 ? 'is' : 'are'} off`
          : '';
  return { ready, valid, holes, disabled, inline, reason };
}

/** A role's depth: 0 with no dependencies, else one past the deepest; a cycle or an unknown dependency counts as 0. */
function depths(roles) {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const memo = new Map();
  const depth = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 0;
    const r = byId.get(id);
    const deps = (r?.dependsOn || []).filter((d) => byId.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, new Set([...seen, id])))) : 0;
    memo.set(id, d);
    return d;
  };
  for (const r of roles) depth(r.id, new Set());
  return memo;
}

export const TEAM_SHAPES = Object.freeze(['solo', 'quorum', 'sequence', 'hierarchy']);

/**
 * The shape of a team, from its roles — the one drawing both clients make:
 *   • `columns` — roles grouped by dependency depth; one column runs in parallel, the next
 *     waits for it. The judge (merge: judge) is not in them: the merge IS its task, so it
 *     stands as the last column on its own (`judge`).
 *   • `kind` — `solo` (one role), `quorum` (one parallel column, merged), `sequence` (more
 *     than one column), `hierarchy` (a role whose engine is another team — A2, not built;
 *     read from `mode: 'team'` so the word is ready when the mode is).
 *   • `lands: 'person'` — always. Nothing lands without one; the drawing ends on you.
 * Node fields are the team's own (`id`, `agent`, `name`, `dependsOn`); a client joins the
 * pool for the card and `agentHue` for the colour.
 */
export function teamShape(team) {
  const roles = (team?.roles || []).filter((r) => r && r.id);
  const judgeId = team?.merge === 'judge' ? (team.judge || roles[roles.length - 1]?.id || null) : null;
  const working = roles.filter((r) => r.id !== judgeId);
  const d = depths(working);
  const byDepth = new Map();
  for (const r of working) {
    const k = d.get(r.id) || 0;
    if (!byDepth.has(k)) byDepth.set(k, []);
    byDepth.get(k).push({ id: r.id, name: r.name || r.id, agent: r.agent || null, mode: r.mode || 'model', dependsOn: [...(r.dependsOn || [])] });
  }
  const columns = [...byDepth.keys()].sort((a, b) => a - b).map((depth) => ({ depth, parallel: byDepth.get(depth).length > 1, roles: byDepth.get(depth) }));
  const j = roles.find((r) => r.id === judgeId);
  const judge = j ? { id: j.id, name: j.name || j.id, agent: j.agent || null } : null;
  const kind = roles.some((r) => r.mode === 'team') ? 'hierarchy'
    : roles.length <= 1 ? 'solo'
      : columns.length <= 1 ? 'quorum'
        : 'sequence';
  return { kind, columns, judge, merge: team?.merge || 'concat', lands: 'person' };
}

/** A shape in a sentence — the card's subtitle, the same on every client. */
export function describeTeamShape(shape) {
  const s = shape || {};
  const n = (s.columns || []).reduce((a, c) => a + c.roles.length, 0) + (s.judge ? 1 : 0);
  if (s.kind === 'solo') return 'one role';
  if (s.kind === 'quorum') return `${n} roles in parallel${s.judge ? `, ${s.judge.name} judges` : s.merge === 'converge' ? ', reconciled' : ''}`;
  if (s.kind === 'hierarchy') return `${n} roles, one delegates to a team`;
  return `${n} roles in ${s.columns.length} steps${s.judge ? `, ${s.judge.name} judges` : ''}`;
}

/**
 * Where an agent works: the teams whose roles name it and the project jobs it was recruited
 * for or holds. `projects` are project records (`foldProject`); a job's `recruited.agentId`
 * or `takenBy.agentId` is the link.
 */
export function whereItWorks(agentId, { teams = [], projects = [] } = {}) {
  const id = String(agentId || '');
  const onTeams = (Array.isArray(teams) ? teams : []).filter((t) => t && (t.roles || []).some((r) => r?.agent === id)).map((t) => ({ team: t.name, role: (t.roles || []).find((r) => r?.agent === id)?.id || null }));
  const jobs = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const j of p?.jobs || []) {
      const who = j?.recruited?.agentId || j?.takenBy?.agentId || null;
      if (who === id) jobs.push({ project: p.id, title: p.page?.title || p.id, job: j.id, status: j.status || 'open' });
    }
  }
  return { teams: onTeams, jobs };
}

export const ROSTER_KINDS = Object.freeze(['builtin', 'mine', 'team-role', 'created', 'proposed', 'missing']);

/** What kind of card this is, from how it came to be — never declared by the card. */
export function agentKind(agent) {
  const a = agent || {};
  if (a.id === ASSISTANT_ID || a.builtin || STARTER_AGENTS.some((s) => s.id === a.id)) return 'builtin';
  const by = String(a.createdBy || 'person');
  if (by.startsWith('team:')) return 'team-role';
  if (by !== 'person') return 'created';
  return 'mine';
}

/**
 * The roster — one row per thing the Agents tab shows: every pool card with its kind and
 * where it works; every PROPOSED card (from a run's `proposal` decisions or a project's —
 * pass them as `proposals: [{ agent, from }]`), and every MISSING agent a team names,
 * deduplicated, with the fix. Sorted: what needs a decision first, then holes, then the
 * pool by name. `counts` is the filter bar.
 */
export function rosterRows(pool = [], { teams = [], projects = [], proposals = [] } = {}) {
  const rows = [];
  for (const a of poolList(pool)) {
    rows.push({ kind: agentKind(a), agent: a, where: whereItWorks(a.id, { teams, projects }), hue: agentHue(a.id) });
  }
  const seen = new Set(rows.map((r) => r.agent.id));
  for (const p of Array.isArray(proposals) ? proposals : []) {
    const a = p?.agent && isRecord(p.agent) ? p.agent : null;
    if (!a?.id || seen.has(a.id)) continue;
    seen.add(a.id);
    rows.push({ kind: 'proposed', agent: a, from: p.from || null, where: { teams: [], jobs: [] }, hue: agentHue(a.id) });
  }
  for (const t of Array.isArray(teams) ? teams : []) {
    for (const h of teamHealth(t, pool).holes) {
      if (seen.has(h.agent)) { rows.find((r) => r.agent.id === h.agent)?.namedBy?.push(t.name); continue; }
      seen.add(h.agent);
      rows.push({ kind: 'missing', agent: { id: h.agent, name: h.agent }, fix: h.fix, namedBy: [t.name], where: { teams: [{ team: t.name, role: h.role }], jobs: [] }, hue: agentHue(h.agent) });
    }
  }
  const order = { proposed: 0, missing: 1, builtin: 3, 'team-role': 3, created: 3, mine: 3 };
  rows.sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.agent.name || a.agent.id).localeCompare(String(b.agent.name || b.agent.id)));
  const counts = { all: rows.length };
  for (const k of ROSTER_KINDS) counts[k] = rows.filter((r) => r.kind === k).length;
  counts.onTeam = rows.filter((r) => r.where.teams.length).length;
  return { rows, counts };
}

/**
 * An agent's colour is data: one hue per id, the same on every client and every tab, so a
 * team's shape reads without labels. FNV-1a over the id → 0..359; the built-in org keeps
 * fixed, well-separated hues so the seven starters never land next to each other.
 */
const FIXED_HUES = Object.freeze({ assistant: 240, executive: 262, architect: 212, implementer: 158, reviewer: 38, tester: 330, librarian: 190, scribe: 0, release: 280 });
export function agentHue(id) {
  const key = String(id || '');
  if (FIXED_HUES[key] !== undefined) return FIXED_HUES[key];
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 360;
}

/** The CSS colour for a hue — muted on a light ground, lifted on a dark one; the scribe's 0 is a grey, not a red. */
export function agentColor(id, { dark = false } = {}) {
  const h = agentHue(id);
  if (id === 'scribe') return dark ? 'hsl(220 8% 62%)' : 'hsl(220 8% 45%)';
  return dark ? `hsl(${h} 58% 62%)` : `hsl(${h} 60% 44%)`;
}

/** Two letters for the avatar: "Budget checker" → "Bc", "researcher" → "Re". */
export function agentInitials(agentOrId) {
  const name = typeof agentOrId === 'string' ? agentOrId : (agentOrId?.name || agentOrId?.id || '');
  const words = String(name).trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return (words[0][0].toUpperCase() + (words[0][1] || '')).slice(0, 2);
  return (words[0][0] + words[1][0].toLowerCase()).slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

export { TeamError };

/**
 * The four numbers on an agent's card, from the gateway's scorecard (`summarize()` +
 * `attested`) — the same four on every client, "—" where nothing is known. A run through an
 * agent tool reports no tokens, so cost is never one of them; time and count always are.
 */
export function cardNumbers(summary, { attested = null } = {}) {
  const s = summary && typeof summary === 'object' ? summary : null;
  const n = s?.entries || 0;
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');
  const tasks = (s?.jobsDone || 0) + (s?.jobsFailed || 0);
  return [
    { key: 'tasks', label: 'tasks', value: n ? String(tasks) : '—', detail: n ? `${s.jobsDone} done · ${s.jobsFailed} failed` : 'nothing yet' },
    { key: 'rating', label: 'rating', value: n ? pct(s.rating?.avg) : '—', detail: n && s.rating?.count ? `${s.rating.count} rating${s.rating.count === 1 ? '' : 's'}` : 'not rated' },
    { key: 'engines', label: 'engines', value: n ? String((s.byEngine || []).length) : '—', detail: s?.engineIndependence != null ? `independence ${pct(s.engineIndependence)}` : 'one so far' },
    { key: 'record', label: 'record', value: n ? (attested?.ok ? '✓' : n ? '·' : '—') : '—', detail: n ? `${n} entr${n === 1 ? 'y' : 'ies'}${attested?.ok ? ', attested' : ''}${s.scm?.commits ? ` · ${s.scm.commits} commits` : ''}` : 'nothing yet' },
  ];
}

/** Cards onto the pool: an existing id is replaced in place, a new one appended — the order a person made stays. */
export function upsertAgents(pool, cards) {
  const list = poolList(pool);
  const add = (Array.isArray(cards) ? cards : []).filter((c) => c && c.id);
  return [...list.map((a) => add.find((c) => c.id === a.id) || a), ...add.filter((c) => !list.some((a) => a.id === c.id))];
}

/**
 * An agent, INVOKABLE on its own: a one-role team named after it (`/researcher`, "ask the
 * researcher to…"), the role standing for the card, the answer the role's own (`merge:
 * first`), under a default budget since a team without one does not run (O1). `origin.agent`
 * marks it so a client can draw it as an agent, not a team. Never stored — derived from the
 * pool every time, so a card edit lands at once and a deleted card takes its command with it.
 */
export const SOLO_BUDGET = Object.freeze({ tokens: 40000, ms: 300000 });
export function soloTeam(agent, { budget = SOLO_BUDGET } = {}) {
  const a = agent && agent.id ? agent : null;
  if (!a || a.id === ASSISTANT_ID || a.enabled === false) return null;
  return normalizeTeam({
    name: String(a.id).toLowerCase(),
    description: `Just ${a.name || a.id}${a.purpose ? ` — ${a.purpose}` : ''}`,
    plan: 'fixed', merge: 'first',
    roles: [{ id: String(a.id).toLowerCase().slice(0, 32), agent: a.id }],
    budget: { ...budget },
    origin: { agent: a.id },
  });
}

/**
 * The teams a chat can run: the saved ones, then a solo team per enabled pool agent whose
 * id no saved team already claims. What the slash menu, the `team` tool and "run …" all read.
 */
export function teamsWithSolos(teams = [], pool = [], opts = {}) {
  const saved = (Array.isArray(teams) ? teams : []).filter((t) => t && t.name);
  const taken = new Set(saved.map((t) => String(t.name).toLowerCase()));
  const solos = [];
  for (const a of poolList(pool)) {
    if (taken.has(String(a.id).toLowerCase()) || !(Array.isArray(a.appliesTo) ? a.appliesTo : ['jobs']).includes('jobs')) continue;
    const t = soloTeam(a, opts);
    if (t) { solos.push(t); taken.add(t.name); }
  }
  return [...saved, ...solos];
}
