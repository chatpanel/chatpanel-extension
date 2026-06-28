export const MCP_TURN_MODES = Object.freeze({
  AUTO: 'auto',
  OFF: 'off',
  ON: 'on',
});

// In AUTO mode, arm only the top-K most-relevant remote (MCP) tools per turn — the
// whole point of "auto" (fewer tools = faster, less confused model). Local
// page/history tools are always kept and don't count. A user-set
// ui.maxToolsPerTurn overrides this; ON mode arms everything (no cap unless set).
export const DEFAULT_AUTO_TOOL_CAP = 8;

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
  // AUTO: expose MCP tools — they're narrowed to the top-K most relevant per turn
  // (see DEFAULT_AUTO_TOOL_CAP), so arming them broadly is cheap. A skill that
  // configures MCP still forces it on regardless. (Previously AUTO armed MCP ONLY
  // for skills, so plain chat turns got NO tools — the "auto mode passed nothing" bug.)
  return true;
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
