import { sourceCitationSystem } from './tool-hints.js';

function normalizeHistoryContext(value) {
  const v = String(value || 'none').toLowerCase();
  if (v === 'chat' || v === 'chats') return 'chats';
  if (v === 'meeting' || v === 'meetings') return 'meetings';
  if (v === 'all' || v === 'both' || v === 'history') return 'all';
  return 'none';
}

function normalizeMcpMode(value) {
  const v = String(value || 'none').toLowerCase();
  if (v === 'none' || v === 'off') return 'none';
  if (v === 'selected' || v === 'select') return 'selected';
  return 'default';
}

function enabledServers(servers) {
  return (servers || []).filter((s) => s && s.enabled !== false && (s.url || s.command || s.tools?.length));
}

// A skill can be switched OFF in settings instead of deleted — it then disappears
// from the skills menu, /commands, #mentions and meeting monitors, but keeps its
// prompt. Skills saved before this flag existed have no `enabled`, so absence
// means enabled; every surface must go through these two so "off" means off
// everywhere rather than in whichever list remembered to check.
export function isSkillEnabled(skill) {
  return !!skill && skill.enabled !== false;
}

export function enabledSkills(skills) {
  return (Array.isArray(skills) ? skills : []).filter(isSkillEnabled);
}

export function skillRunFromSkill(skill = {}, { includeMeetings = false } = {}) {
  const requested = normalizeHistoryContext(skill.historyContext);
  let history = null;
  if (requested !== 'none') {
    const wantsMeetings = requested === 'meetings' || requested === 'all';
    const blocked = wantsMeetings && !includeMeetings ? 'meetings' : '';
    history = {
      enabled: !blocked,
      scope: requested,
      includeMeetings: wantsMeetings && !!includeMeetings,
      requested,
      ...(blocked ? { blocked } : {}),
    };
  }

  return {
    skillId: skill.id || '',
    history,
    mcp: {
      mode: normalizeMcpMode(skill.mcpMode),
      serverIds: Array.isArray(skill.mcpServerIds) ? skill.mcpServerIds.filter(Boolean) : [],
    },
    // A package skill carries reference documents it deliberately does NOT inline — that
    // is what progressive disclosure means in this format. Without carrying the index the
    // prompt arrives referring to files the model has no way to open, which reads to the
    // user as the skill being broken rather than starved.
    files: skillPackageFiles(skill),
    origin: skill.origin && skill.origin.source ? { source: skill.origin.source, id: skill.origin.id || '' } : null,
  };
}

/**
 * The readable, non-executable files a skill ships, as `<kind>/<name>` paths.
 *
 * `scripts` is deliberately excluded. It is tier-3 code that runs in the bridge behind the
 * scanner, not text for a model to read — and handing a script's SOURCE to the model would
 * be the worst of both: the injection surface of running it with none of the usefulness.
 */
export function skillPackageFiles(skill) {
  const files = skill?.files;
  if (!files || typeof files !== 'object') return [];
  const out = [];
  for (const kind of ['references', 'assets', 'templates', 'examples']) {
    for (const name of Array.isArray(files[kind]) ? files[kind] : []) {
      if (typeof name === 'string' && name) out.push(`${kind}/${name}`);
    }
  }
  return out.slice(0, 60); // an index, not a manifest dump
}

export function filterMcpServersForSkill(servers, skillRun) {
  const usable = enabledServers(servers);
  const mode = skillRun?.mcp?.mode || 'none';
  if (mode === 'none') return [];
  if (mode !== 'selected') return usable;
  const ids = new Set(skillRun?.mcp?.serverIds || []);
  if (!ids.size) return [];
  return usable.filter((s) => ids.has(s.id));
}

function serverToolText(server) {
  const tools = (server.tools || []).map((t) => t.name).filter(Boolean).slice(0, 12);
  return tools.length ? `${server.name || server.id}: ${tools.join(', ')}` : `${server.name || server.id}`;
}

export function skillToolSystem(skillRun, allServers = []) {
  if (!skillRun) return '';
  const lines = [];
  if (skillRun.history?.enabled) {
    const label = skillRun.history.scope === 'all'
      ? 'chat and meeting history'
      : skillRun.history.scope === 'meetings'
        ? 'meeting history'
        : 'chat history';
    lines.push(`This skill has ${label} tools available. Use history_search first when prior local context would improve the answer, then history_get_source or history_related when useful.`);
  }
  if (skillRun.history?.blocked === 'meetings') {
    lines.push('Meeting history was requested for this skill, but it is not available for the current plan.');
  }
  // Level 0 of progressive disclosure: the model is told what exists and how to open it,
  // and pays for CONTENT only when it decides a file is worth reading.
  if (skillRun.files?.length) {
    lines.push(
      `This skill ships reference files: ${skillRun.files.join(', ')}. `
      + 'Their contents are NOT included above. Call skill_file with one of those exact paths to read one, '
      + 'and only when the task needs it — read the smallest set that answers the question.',
    );
  }
  if (skillRun.mcp?.mode === 'none') {
    lines.push('MCP tools are disabled for this skill.');
  } else if (skillRun.mcp?.mode === 'selected') {
    const selected = filterMcpServersForSkill(allServers, skillRun);
    if (selected.length) {
      lines.push(`This skill is scoped to these MCP servers/tools: ${selected.map(serverToolText).join(' | ')}. Prefer these tools when they help complete the skill.`);
    } else {
      lines.push('This skill selected MCP tools, but none of the selected MCP servers are currently enabled.');
    }
  }
  if (skillRun.history?.enabled || skillRun.mcp?.mode === 'selected' || skillRun.mcp?.mode === 'default') {
    lines.push(sourceCitationSystem());
  }
  return lines.join('\n');
}
