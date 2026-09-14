// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-tool.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The `team` tool — a team invoked from any chat: run, dry_run, save — and `project`, a goal
// handed to the executive (project-run.js): jobs, recruiting, rounds run as teams, a review,
// follow-ups, done-when, every step on the project record a person reads on the board.
//
// The recipe tool's twin, on purpose: one registered tool whose description is the
// catalogue, `dry_run` showing what a person would approve, `save` proposing a team from the
// conversation and storing it only on the card's Allow, `run` executing through the host's
// own runner. A team run is a tool call inside an ordinary turn, so it streams, can be
// stopped, and is queued and steered like anything else the model does.
//
// Everything the model sees is here; the card, the store and the runner's `callModel` are
// the host's, injected. Bound late (`bind`) to the toolset it lives in: a team's members
// receive the host's toolset narrowed to their grants, and the host builds that from the
// same providers this tool is a member of.

import { validateTeam, normalizeTeam, describeRole, slugTeamName } from './team.js';
import { dryRunTeam } from './team-run.js';

export const TEAM_TOOL_NAME = 'team';

// The teams the model may see and run: enabled, named, and whole. A record another client
// half-wrote (a name and nothing else) is not a team — Settings shows it for deleting.
const usable = (teams) => (teams || []).filter((t) => t?.name && t.enabled !== false && validateTeam(t).ok);

function catalogue(teams) {
  const list = usable(teams);
  if (!list.length) return 'No teams saved yet.';
  return `Saved teams: ${list.map((t) => `${t.name} (${(t.roles || []).map((r) => r.id).join(', ')})${t.description ? ` — ${t.description}` : ''}`).join('; ')}.`;
}

/**
 * How long one call of the tool may take: the longest budget among the teams plus the merge,
 * never under two minutes. A relay between a CLI agent and this tool (the bridge's MCP
 * server) times a call by this; without it a 300 s team hit the relay's 120 s default,
 * Claude Code was told "tool call timed out" and ran the team AGAIN while the first run was
 * still working.
 */
export function teamToolTimeoutMs(teams) {
  const longest = Math.max(0, ...(teams || []).map((t) => Number(t?.budget?.ms) || 0));
  return Math.max(120_000, (longest || 10 * 60_000) + 60_000);
}

export function teamToolSpec(teams) {
  return {
    name: TEAM_TOOL_NAME,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    timeoutMs: teamToolTimeoutMs(teams),
    description:
      `Saved agent teams — several roles working a request in parallel, merged into one answer. ${catalogue(teams)} `
      + 'Actions: {"action":"run","name":"<team>","request":"<what to do>"} runs one (streams; may take a while); '
      + '{"action":"dry_run","name":"<team>","request":"…"} shows roles, models, tools and budget without running; '
      + '{"action":"save","team":{…}} proposes a NEW team after a task that would benefit from several roles — the user approves it on a card. '
      + '{"action":"project","goal":"<what done looks like>","title":"<short name>","doneWhen":"<a check the result can be held to>","budget":{"tokens":200000,"ms":3600000}} hands a GOAL to the executive: it posts jobs, recruits agents from the pool for each, runs them as teams in rounds, reviews the results against done-when, posts follow-ups, asks the user before spending or changing scope, and closes when done-when holds (may take a long while; use it for a goal with several parts, not a question). '
      + 'A team: {"name":"research" (a short identifier: letters, digits, - _; used as /research),"description":"…","roles":[{"id":"researcher","prompt":"…","prefer":"balanced","grants":["data","web"]},{"id":"writer","prompt":"…","prefer":"strong","grants":["none"]}],"merge":"judge","judge":"writer","budget":{"tokens":40000,"ms":300000}}. '
      + 'grants: none | data | web | history | mcp | mcp:<server> | shell | fs:write | scm:read | scm:push | scm:pr. A role may say "agent":"<id>" instead of a prompt to stand for an agent from the pool. merge: judge | converge | concat | first. A budget is required. '
      + 'Order the work with "dependsOn": a role that builds on another\'s findings (a budget checker on a researcher) lists it, so it runs after and reads the board instead of searching again. The judge does not need a task of its own - the merge is its work.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'dry_run', 'save', 'project'] },
        goal: { type: 'string', description: 'For project: the goal, in the user\'s words — what done looks like.' },
        title: { type: 'string', description: 'For project: a short name.' },
        doneWhen: { type: 'string', description: 'For project: the check the result is held to.' },
        budget: { type: 'object', description: 'For project: {"tokens","ms","usd"} for the whole project.', additionalProperties: true },
        name: { type: 'string', description: 'Team name, for run / dry_run.' },
        request: { type: 'string', description: 'What the team should do, for run / dry_run.' },
        team: { type: 'object', description: 'The team to save, for save.', additionalProperties: true },
      },
      required: ['action'],
    },
  };
}

/** The card a person approves a new team on. */
export function describeTeamForApproval(team, dry) {
  const lines = [`${team.name}${team.description ? ` — ${team.description}` : ''}`, `Plan: ${team.plan || 'fixed'} · merge: ${team.merge || 'concat'}${team.judge ? ` (judge: ${team.judge})` : ''}`];
  for (const r of dry?.roles || team.roles || []) lines.push(`• ${describeRole({ ...r, model: r.label || r.model || undefined })}${r.appointed === false ? ' — NO MODEL AVAILABLE' : ''}`);
  const b = team.budget || {};
  lines.push(`Budget: ${Object.entries(b).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push('Runs go through your own models and tools; a team may not act on a page. Nothing a team produces lands without you.');
  return lines.join('\n');
}

const json = (v) => JSON.stringify(v);

/**
 * @param teams        the saved list (the `teams` prefs section)
 * @param run          `async ({ team, request, onEvent }) => runResult` — the host's runTeam binding
 * @param appoint      `(role) => { model, mode } | null` for the dry run
 * @param confirmSave  `async (detail, team) => 'allow' | 'deny'`; absent = save refused
 * @param saveTeam     `async (team) => void`
 * @param runProject   `async ({ goal, title, doneWhen, budget, toolset }) => project result` — the
 *                     host's executive loop (project-run.js runProject with its own deps);
 *                     absent, the action is refused
 */
/**
 * `resolve` is the host's `(team) => team` that fills roles standing for agents from the
 * pool (agent.js resolveTeam) — applied before a dry run and before a run, never to what is
 * saved: the stored team keeps its references, the run gets the cards as they are now.
 */
export function teamToolProvider({ teams = [], run = null, appoint = null, confirmSave = null, saveTeam = null, resolve = null, runProject = null } = {}) {
  const byName = new Map(usable(teams).map((t) => [t.name, t]));
  // A team whose roles stand for agents is filled from the pool on the way to a run; a
  // resolver that throws (an agent missing from the pool) is the tool's error, not a crash.
  const resolved = (t) => (typeof resolve === 'function' ? resolve(t) : t);
  let bound = null;
  // One run per team+request per turn. A run that failed, answered with nothing, or ran
  // out of budget comes back as a result the model must REPORT — asking for it again in the
  // same turn is the circle a person had to break by hand.
  const ran = new Map();
  return {
    id: 'team',
    specs: [teamToolSpec(teams)],
    system: [
      byName.size ? 'Saved agent teams exist (see the `team` tool). When a request is broad enough that several roles would do it better — research plus writing, several sources to reconcile — run the matching team rather than doing it all in one turn.' : '',
      runProject ? 'A GOAL with several parts (a project, not a question) goes to the executive: call the `team` tool with {"action":"project","goal":…,"doneWhen":…} and report what it produced.' : '',
      (confirmSave && saveTeam) ? 'When the user asks to create, make, set up or save a team (of agents / roles), do not run one: call the `team` tool with {"action":"save","team":{…}} — pick roles, prompts, grants and a budget from what they said, and ask only for what you cannot infer. The user approves it on a card.' : '',
    ].filter(Boolean).join(' '),
    bind(toolset) { bound = toolset; },
    async execute(name, input) {
      if (name !== TEAM_TOOL_NAME) return json({ error: `Unknown tool: ${name}` });
      const action = String(input?.action || '');

      if (action === 'save') {
        // A name in prose ("Research Team") becomes the /command it will be run by.
        const team = input?.team && typeof input.team === 'object' ? { ...input.team, name: slugTeamName(input.team.name) } : input?.team;
        const v = validateTeam(team);
        if (!v.ok) return json({ error: 'The team is not valid.', problems: v.errors, hint: 'A team needs a name (letters, digits, - _), roles with prompts and grants, and a budget such as {"tokens":40000,"ms":300000}.' });
        if (byName.has(team.name)) return json({ error: `A team named "${team.name}" already exists. Pick another name.` });
        if (!confirmSave || !saveTeam) return json({ error: 'Saving a team needs the user\'s approval, which this surface cannot ask for. Describe the team and suggest saving it from the side panel or the desktop.' });
        const norm = normalizeTeam(team);
        const dry = dryRunTeam(resolved(norm), '', { appoint });
        const decision = await confirmSave(describeTeamForApproval(norm, dry), norm);
        if (decision !== 'allow') return json({ error: `The user did not save "${norm.name}". Do not propose it again this turn.`, declined: true });
        const stored = { ...norm, createdAt: Date.now() };
        await saveTeam(stored);
        byName.set(stored.name, stored);
        return json({ saved: stored.name, roles: stored.roles.map((r) => r.id), hint: `Run it with {"action":"run","name":"${stored.name}","request":"…"} or by typing /${stored.name}.` });
      }

      if (action === 'project') {
        const goal = String(input?.goal || '').trim();
        if (!goal) return json({ error: 'project needs a goal — what does done look like?' });
        if (typeof runProject !== 'function') return json({ error: 'This surface cannot run a project. Run a team instead, or describe the jobs.' });
        // One project per turn, like one run per team: a loop that asks the person and gets
        // "stop" is not started again with a rephrased goal.
        if (ran.has('project')) { const p = ran.get('project'); return json({ error: `A project already ran in this turn (${p.projectId}, ${p.status}). Report its result and ask the user how to proceed.`, ...p }); }
        let result;
        try {
          result = await runProject({ goal, title: String(input?.title || '').trim(), doneWhen: String(input?.doneWhen || '').trim(), budget: input?.budget && typeof input.budget === 'object' ? input.budget : null, toolset: bound });
        } catch (e) { return json({ error: e?.message || String(e) }); }
        const out = { projectId: result.projectId, status: result.status, rounds: result.rounds, jobs: result.jobs, runs: result.runs, report: result.report, spend: result.spend, why: result.why || undefined };
        ran.set('project', out);
        const hint = result.status === 'done' ? 'Done-when holds and the project is closed. Present the report as the answer; the jobs and their runs are on the board.'
          : result.status === 'over-budget' ? 'The project stopped at its budget; the report so far stands. Say so and ask whether to raise it.'
          : result.status === 'failed' ? `The project FAILED — ${result.why || 'see the jobs'}. Do not start it again this turn; tell the user which job failed and why.`
          : `The project is ${result.status}${result.why ? ` — ${result.why}` : ''}. Present the report so far and say what is left; do not start it again this turn.`;
        return json({ ...out, hint });
      }

      const team = byName.get(String(input?.name || ''));
      if (!team) return json({ error: `No team named "${input?.name}".`, available: [...byName.keys()] });
      const request = String(input?.request || '').trim();

      if (action === 'dry_run') {
        let dry;
        try { dry = dryRunTeam(resolved(team), request, { appoint }); } catch (e) { return json({ error: e?.message || String(e) }); }
        return json({ name: team.name, ok: dry.ok, missing: dry.missing, roles: dry.roles, plan: dry.plan, tasks: dry.tasks, merge: dry.merge, budget: dry.budget });
      }
      if (action === 'run') {
        if (!request) return json({ error: 'run needs a request — what should the team do?' });
        if (typeof run !== 'function') return json({ error: 'This surface cannot run a team.' });
        // ONE run per team per turn — keyed by the team, not the request: a model that
        // re-runs after a partial result rephrases the request each time, and that was a
        // second circle. Its partial result stands; the person decides what happens next.
        const key = team.name;
        const prior = ran.get(key);
        if (prior) return json({ error: `The "${team.name}" team already ran in this turn (run ${prior.runId}, ${prior.status}). Do not run it again, even with a different request: report what it produced — ${prior.summary} — with its proposal, and ask the user how to proceed.`, runId: prior.runId, status: prior.status, tasks: prior.tasks, proposal: prior.proposal });
        let dry;
        try { dry = dryRunTeam(resolved(team), request, { appoint }); } catch (e) { return json({ error: e?.message || String(e) }); }
        if (!dry.ok) return json({ error: `No model is available for role(s): ${dry.missing.join(', ')}.`, roles: dry.roles });
        const result = await run({ team: resolved(team), request, toolset: bound });
        const findings = (result.board || []).map((f) => ({ role: f.role, kind: f.kind, text: f.text, refs: f.refs }));
        const tasks = (result.tasks || []).map((x) => ({ id: x.id, role: x.role, status: x.status, ms: x.ms, findings: (x.findings || []).length, error: x.error || undefined }));
        const failed = tasks.filter((x) => x.status !== 'ok');
        const summary = failed.length ? failed.map((x) => `${x.role} ${x.status}${x.error ? ` (${x.error})` : ''}`).join('; ') : `${findings.length} findings`;
        ran.set(key, { runId: result.runId, status: result.status, summary, tasks, proposal: result.proposal });
        const hint = result.status === 'over-budget' ? 'The team stopped at its budget; the proposal is what it had. Say so.'
          : result.status === 'failed' ? `The run FAILED — ${summary}. Do not run the team again this turn. Tell the user exactly which role failed and why, and ask whether to retry, change the team\'s models in Settings → Teams, or answer without the team.`
          : failed.length ? `Some roles did not finish — ${summary}. Present the proposal as the team's answer and say which role did not finish; do NOT run the team again this turn.` : undefined;
        return json({ name: team.name, runId: result.runId, status: result.status, proposal: result.proposal, tasks, findings, usage: result.usage, hint });
      }
      return json({ error: `Unknown action "${action}". Use run, dry_run, save or project.` });
    },
  };
}
