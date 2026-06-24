export const MCP_TURN_MODES = Object.freeze({
  AUTO: 'auto',
  OFF: 'off',
  ON: 'on',
});

const MCP_TOOL_RE = /^mcp_.+?__.+/;

export function normalizeMcpTurnMode(value) {
  const v = String(value || '').toLowerCase();
  if (v === MCP_TURN_MODES.OFF || v === 'none' || v === 'disabled') return MCP_TURN_MODES.OFF;
  if (v === MCP_TURN_MODES.ON || v === 'enabled' || v === 'all') return MCP_TURN_MODES.ON;
  return MCP_TURN_MODES.AUTO;
}

export function shouldIncludeMcpTools({ turnMcpMode = MCP_TURN_MODES.AUTO, skillRun = null } = {}) {
  const mode = normalizeMcpTurnMode(turnMcpMode);
  if (mode === MCP_TURN_MODES.OFF) return false;
  if (mode === MCP_TURN_MODES.ON) return true;
  const skillMode = skillRun?.mcp?.mode || 'none';
  return skillMode === 'selected' || skillMode === 'default';
}

const SELF_CONTAINED_TASK_RE =
  /\b(summarize|summarise|summary|tl;?dr|tldr|key points?|explain|review|extract|analy[sz]e|compare|rewrite|classify|translate|attached (page|content|document|article|transcript)|this (page|content|document|article|transcript))\b/i;

const EXPLICIT_MCP_INTENT_RE =
  /\b(mcp|use (the )?(mcp|tools?)|with (the )?(mcp|tools?)|(search|check|query|fetch|retrieve|lookup|look up|find in|read from|ask) (the )?(mcp|tools?|jira|confluence|slack|github|gitlab|sharepoint|outlook|calendar|email|wiki|knowledge base|docs|tickets?|issues?|pull requests?|prs?))\b/i;

function hasReadableAttachment(attachments) {
  return (attachments || []).some((a) => a && a.kind !== 'image' && String(a.text || '').trim());
}

export function shouldExposeMcpForTurn({
  turnMcpMode = MCP_TURN_MODES.AUTO,
  skillRun = null,
  userText = '',
  attachments = [],
} = {}) {
  if (!shouldIncludeMcpTools({ turnMcpMode, skillRun })) return false;

  const skillMode = skillRun?.mcp?.mode || 'none';
  if (skillMode === 'selected' || skillMode === 'default') return true;

  const text = String(userText || '');
  if (
    hasReadableAttachment(attachments) &&
    SELF_CONTAINED_TASK_RE.test(text) &&
    !EXPLICIT_MCP_INTENT_RE.test(text)
  ) {
    return false;
  }

  return true;
}

export function isMcpToolName(name) {
  return MCP_TOOL_RE.test(String(name || ''));
}

export function cancelledToolResult(name) {
  return JSON.stringify({
    ok: true,
    skipped: true,
    tool: name || 'tool',
    note: 'skipped by user',
    reason: 'User skipped this tool call. Continue from the already available conversation context and do not wait for this tool result.',
  });
}
