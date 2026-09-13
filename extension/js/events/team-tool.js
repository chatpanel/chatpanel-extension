// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-tool.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The `team` tool — a team invoked from any chat: run, dry_run, save.
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

import { validateTeam, normalizeTeam, describeRole, TEAM_NAME_RE } from './team.js';
import { dryRunTeam } from './team-run.js';

export const TEAM_TOOL_NAME = 'team';

function catalogue(teams) {
  const list = (teams || []).filter((t) => t && t.enabled !== false && t.name);
  if (!list.length) return 'No teams saved yet.';
  return `Saved teams: ${list.map((t) => `${t.name} (${(t.roles || []).map((r) => r.id).join(', ')})${t.description ? ` — ${t.description}` : ''}`).join('; ')}.`;
}

export function teamToolSpec(teams) {
  return {
    name: TEAM_TOOL_NAME,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description:
      `Saved agent teams — several roles working a request in parallel, merged into one answer. ${catalogue(teams)} `
      + 'Actions: {"action":"run","name":"<team>","request":"<what to do>"} runs one (streams; may take a while); '
      + '{"action":"dry_run","name":"<team>","request":"…"} shows roles, models, tools and budget without running; '
      + '{"action":"save","team":{…}} proposes a NEW team after a task that would benefit from several roles — the user approves it on a card. '
      + 'A team: {"name":"research","description":"…","roles":[{"id":"researcher","prompt":"…","prefer":"balanced","grants":["data","web"]},{"id":"writer","prompt":"…","prefer":"strong","grants":["none"]}],"merge":"judge","judge":"writer","budget":{"tokens":40000,"ms":300000}}. '
      + 'grants: none | data | web | history | mcp | mcp:<server>. merge: judge | converge | concat | first. A budget is required.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'dry_run', 'save'] },
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
 */
export function teamToolProvider({ teams = [], run = null, appoint = null, confirmSave = null, saveTeam = null } = {}) {
  const byName = new Map((teams || []).filter((t) => t?.name && t.enabled !== false).map((t) => [t.name, t]));
  let bound = null;
  return {
    id: 'team',
    specs: [teamToolSpec(teams)],
    system: byName.size ? 'Saved agent teams exist (see the `team` tool). When a request is broad enough that several roles would do it better — research plus writing, several sources to reconcile — run the matching team rather than doing it all in one turn.' : '',
    bind(toolset) { bound = toolset; },
    async execute(name, input) {
      if (name !== TEAM_TOOL_NAME) return json({ error: `Unknown tool: ${name}` });
      const action = String(input?.action || '');

      if (action === 'save') {
        const team = input?.team;
        const v = validateTeam(team);
        if (!v.ok) return json({ error: 'The team is not valid.', problems: v.errors, hint: 'A team needs a name, roles with prompts and grants, and a budget.' });
        if (!TEAM_NAME_RE.test(team.name)) return json({ error: 'name must be a short identifier.' });
        if (byName.has(team.name)) return json({ error: `A team named "${team.name}" already exists. Pick another name.` });
        if (!confirmSave || !saveTeam) return json({ error: 'Saving a team needs the user\'s approval, which this surface cannot ask for. Describe the team and suggest saving it from the side panel or the desktop.' });
        const norm = normalizeTeam(team);
        const dry = dryRunTeam(norm, '', { appoint });
        const decision = await confirmSave(describeTeamForApproval(norm, dry), norm);
        if (decision !== 'allow') return json({ error: `The user did not save "${norm.name}". Do not propose it again this turn.`, declined: true });
        const stored = { ...norm, createdAt: Date.now() };
        await saveTeam(stored);
        byName.set(stored.name, stored);
        return json({ saved: stored.name, roles: stored.roles.map((r) => r.id), hint: `Run it with {"action":"run","name":"${stored.name}","request":"…"} or by typing /${stored.name}.` });
      }

      const team = byName.get(String(input?.name || ''));
      if (!team) return json({ error: `No team named "${input?.name}".`, available: [...byName.keys()] });
      const request = String(input?.request || '').trim();

      if (action === 'dry_run') {
        const dry = dryRunTeam(team, request, { appoint });
        return json({ name: team.name, ok: dry.ok, missing: dry.missing, roles: dry.roles, plan: dry.plan, tasks: dry.tasks, merge: dry.merge, budget: dry.budget });
      }
      if (action === 'run') {
        if (!request) return json({ error: 'run needs a request — what should the team do?' });
        if (typeof run !== 'function') return json({ error: 'This surface cannot run a team.' });
        const dry = dryRunTeam(team, request, { appoint });
        if (!dry.ok) return json({ error: `No model is available for role(s): ${dry.missing.join(', ')}.`, roles: dry.roles });
        const result = await run({ team, request, toolset: bound });
        const findings = (result.board || []).map((f) => ({ role: f.role, kind: f.kind, text: f.text, refs: f.refs }));
        return json({
          name: team.name, runId: result.runId, status: result.status,
          proposal: result.proposal,
          tasks: (result.tasks || []).map((x) => ({ id: x.id, role: x.role, status: x.status, ms: x.ms, findings: (x.findings || []).length, error: x.error || undefined })),
          findings,
          usage: result.usage,
          hint: result.status === 'over-budget' ? 'The team stopped at its budget; the proposal is what it had. Say so.' : undefined,
        });
      }
      return json({ error: `Unknown action "${action}". Use run, dry_run or save.` });
    },
  };
}
