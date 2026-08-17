// The user's connected MCP servers.
//
// The largest resident cost by far — a full JSON schema per tool per server plus a ~600
// token shared rulebook — so it is collapsed behind one `mcp` dispatcher. Behind that, the
// per-turn cap stops being a CAPABILITY decision (a tool that ranked low was simply absent)
// and becomes a menu-length one.

import { defineToolGroup } from '../events/tool-groups.js';
import { buildToolset } from '../toolset.js';
import { narrowToolset } from '../tool-select.js';
import { mcpDispatchProvider } from '../mcp-dispatch.js';
import { getMcpProviders } from '../mcp-manager.js';
import { isPro, FREE_LIMITS } from '../license.js';
import { MCP_TURN_MODES, DEFAULT_AUTO_TOOL_CAP, normalizeMcpTurnMode, shouldExposeMcpForTurn } from '../tool-policy.js';
import { filterMcpServersForSkill } from '../skill-runtime.js';

/** Which servers this turn may use — the whole decision, with no connecting. */
export function usableServers(ctx) {
  const { settings = {}, license = null, skillRun = null } = ctx;
  const turnMcpMode = normalizeMcpTurnMode(ctx.mcpMode);
  if (ctx.includeMcp === false) return { usable: [], turnMcpMode };
  if (!shouldExposeMcpForTurn({ turnMcpMode, skillRun, userText: ctx.userText || '', attachments: ctx.attachments || [] })) {
    return { usable: [], turnMcpMode };
  }
  const all = settings?.mcpServers || [];
  const limit = isPro(license) ? Infinity : FREE_LIMITS.mcpServers;
  const isSet = (s) => s?.enabled !== false && (s?.url || s?.command);
  let usable = all.slice(0, limit).filter(isSet);
  if (skillRun && turnMcpMode !== MCP_TURN_MODES.ON) usable = filterMcpServersForSkill(usable, skillRun);
  return { usable, turnMcpMode };
}

export const mcpGroup = defineToolGroup({
  id: 'mcp',
  label: 'MCP servers',
  priority: 10,   // after the user's own data: their notes should outrank a third party
  // Answered WITHOUT connecting. Connecting is what made a first turn wait 45 seconds, and
  // "should this be offered" must never cost that.
  applies: (ctx) => !!ctx.resolvedAgent && usableServers(ctx).usable.length > 0,
  async build(ctx) {
    const { settings = {} } = ctx;
    const { usable, turnMcpMode } = usableServers(ctx);
    if (!usable.length) return null;

    // Timed, because connecting is what once made a first turn wait 45 seconds and the
    // activity log has to be able to attribute that. The group reports it; it does not
    // decide what to do with it.
    const t0 = Date.now();
    const mcps = await getMcpProviders(usable, {
      bridgeUrl: ctx.bridgeUrl,
      bridgeAvailable: ctx.bridgeAvailable,
      onError: ctx.onMcpError,
    });
    ctx.markMcpMs?.(Date.now() - t0);
    let inner = buildToolset(mcps);
    if (!inner) return null;

    const userCap = Number(settings?.ui?.maxToolsPerTurn) || 0;
    const cap = userCap || (turnMcpMode === MCP_TURN_MODES.AUTO ? DEFAULT_AUTO_TOOL_CAP : 0);
    // Rank BEFORE collapsing so the menu leads with what this turn is likely to need.
    // `keep: () => false` because every tool here is remote — the local exemption used by
    // the outer narrow would exempt the entire set.
    if (cap) inner = narrowToolset(inner, ctx.userText || '', { cap, keep: () => false });

    if (settings?.ui?.mcpDispatch === false) return { specs: inner.specs, system: inner.system, remote: true, execute: inner.execute };
    return mcpDispatchProvider(inner);
  },
});
