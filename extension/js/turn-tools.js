// Turn capability — the ONE place a "model turn" is armed with tools + PII
// redaction, shared by every ChatPanel surface (the side panel, the Notes
// dashboard, and anything that comes next).
//
// It is a clean capability, not a UI helper: PLAIN DATA IN (the resolved agent,
// settings, license flags, the MCP server list, this turn's text) → PLAIN DATA OUT
// (`{ specs, execute, system }` + a redaction config). It touches NO side-panel
// state, NO DOM, and NO chrome APIs — every surface passes its own context in.
// That contract is deliberately API-shaped so the same capability can later be
// hosted behind the gateway (api.chatpanel.net) and offered as a relayed feature
// without rewriting callers. Build features API-first (see CLAUDE.md).
//
// Reuse, don't reinvent: this is the extraction of the side panel's original
// inline `toolsetFor` + redaction wiring, so the two can never drift.

import { webSearchOpts, webSearchToolProvider } from './web-search.js';
import { isPro, can, FREE_LIMITS } from './license.js';
import { buildToolset } from './toolset.js';
import { narrowToolset, isLocalToolSpec } from './tool-select.js';
import { getMcpProviders } from './mcp-manager.js';
import { historyToolProvider } from './history-rag.js';
import { MCP_TURN_MODES, DEFAULT_AUTO_TOOL_CAP, normalizeMcpTurnMode, shouldExposeMcpForTurn } from './tool-policy.js';
import { filterMcpServersForSkill, skillToolSystem } from './skill-runtime.js';
import { redactionEnabled } from './pii-pipeline.js';
import { createVault } from './pii-redact.js';

// Assemble the toolset for one turn: history + web-search + MCP providers (plus any
// surface-specific `extraProviders`, e.g. the side panel's page-action tools),
// merged and narrowed exactly as the side panel does. Returns a
// `{ specs, execute, system }` toolset, or undefined when nothing is armed.
export async function buildTurnTools({
  resolvedAgent,
  settings = {},
  license = null,
  bridgeUrl,
  bridgeAvailable = false,
  userText = '',
  attachments = [],
  mcpMode = MCP_TURN_MODES.AUTO,
  skillRun = null,
  history = null,            // { enabled } — the /history "use these tools now" hint
  liveReader = null,         // live-meeting caption reader (side panel only)
  includeHistory = true,     // Notes/side panel: read-only search over your own data
  includeWebSearch = true,
  includeMcp = true,
  extraProviders = [],       // surface-specific providers prepended verbatim
  onMcpError = () => {},
} = {}) {
  const providers = [...extraProviders];
  const pro = isPro(license);

  // History tools — read-only search over the user's OWN chats and (Pro) meetings.
  // Locally executed, no web tab needed, so they work on every surface.
  if (resolvedAgent && includeHistory && settings?.ui?.historyTools !== false) {
    providers.push(historyToolProvider({
      includeMeetings: can(license, 'liveMeetings'),
      explicit: !!history?.enabled,
      liveReader,
      warm: (settings?.ui?.warmSearch?.enabled && settings.ui.warmSearch.url) ? { url: settings.ui.warmSearch.url } : null,
    }));
  }

  // Web search — locally executed, no tab needed; the model decides when to fire.
  if (resolvedAgent && includeWebSearch && settings?.ui?.webSearch?.enabled !== false) {
    providers.push(webSearchToolProvider(webSearchOpts(settings, pro)));
  }

  // MCP servers — Free uses the first FREE_LIMITS.mcpServers by list position; Pro
  // is unlimited. A server is usable if it has an http url OR a local command (the
  // latter runs through the bridge, hence `bridgeAvailable`).
  const turnMcpMode = normalizeMcpTurnMode(mcpMode);
  const wantMcp = includeMcp && shouldExposeMcpForTurn({ turnMcpMode, skillRun, userText, attachments });
  const all = settings?.mcpServers || [];
  const limit = pro ? Infinity : FREE_LIMITS.mcpServers;
  const isSet = (s) => s?.enabled !== false && (s?.url || s?.command);
  let usable = wantMcp ? all.slice(0, limit).filter(isSet) : [];
  if (wantMcp && skillRun && turnMcpMode !== MCP_TURN_MODES.ON) usable = filterMcpServersForSkill(usable, skillRun);
  if (resolvedAgent && usable.length) {
    const mcps = await getMcpProviders(usable, { bridgeUrl, bridgeAvailable, onError: onMcpError });
    providers.push(...mcps);
  }

  let toolset = buildToolset(providers);
  // Cap tools per turn so dozens of servers don't bloat the prompt; local
  // page/history/web tools are always kept, remote MCP beyond the cap is dropped by
  // lexical relevance. AUTO narrows to top-K; a user-set max always wins.
  const userCap = Number(settings?.ui?.maxToolsPerTurn) || 0;
  const cap = userCap || (turnMcpMode === MCP_TURN_MODES.AUTO ? DEFAULT_AUTO_TOOL_CAP : 0);
  if (toolset && cap) toolset = narrowToolset(toolset, userText, { cap, keep: isLocalToolSpec });

  const systemSkillRun =
    turnMcpMode === MCP_TURN_MODES.ON && skillRun
      ? { ...skillRun, mcp: { mode: 'default', serverIds: [] } }
      : skillRun;
  const skillSystem = skillToolSystem(systemSkillRun, usable);
  if (!toolset && skillSystem) return { specs: [], execute: async () => '', system: skillSystem };
  if (toolset && skillSystem) toolset.system = [skillSystem, toolset.system].filter(Boolean).join('\n\n');
  return toolset;
}

// The PII-redaction config for one turn: a reversible vault + the user's redaction
// settings, in the shape streamChat's harness expects. `null` when redaction is off.
// The caller may pass a persistent `vault` (e.g. one per conversation, so a
// placeholder stays stable across turns); otherwise a fresh one is minted.
export function buildRedaction({ settings = {}, license = null, vault = null } = {}) {
  const cfg = settings?.ui?.piiRedaction;
  if (!redactionEnabled(cfg)) return null;
  return {
    vault: vault || createVault(),
    cfg,
    isPro: isPro(license),
    entities: [],
    detect: cfg?.mode === 'model',
  };
}
