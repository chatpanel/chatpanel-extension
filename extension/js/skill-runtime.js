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
  };
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
