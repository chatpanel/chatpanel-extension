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

import { buildToolset } from './toolset.js';
import { narrowToolset, isLocalToolSpec } from './tool-select.js';
import { buildToolGroups } from './tool-groups/index.js';
import { usableServers } from './tool-groups/mcp.js';
import { MCP_TURN_MODES, DEFAULT_AUTO_TOOL_CAP, normalizeMcpTurnMode } from './tool-policy.js';
import { skillToolSystem } from './skill-runtime.js';
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
  const startedAt = Date.now();
  const providers = [...extraProviders];

  // TOOL GROUPS ARE REGISTERED, NOT WRITTEN OUT HERE.
  //
  // This function used to assemble three hardcoded blocks — the user's own data, their MCP
  // servers, the page — each the same shape, so a fourth meant editing this function and no
  // other client could contribute one. The duplicated search-engine list showed where that
  // ends: two implementations of one decision disagree eventually.
  //
  // The page arrives as `extraProviders` because only the side panel can build it (it needs
  // confirm dialogs and per-site trust), so it is passed in rather than registered.
  let mcpMs = 0;
  const groups = await buildToolGroups({
    resolvedAgent, settings, license, bridgeUrl, bridgeAvailable,
    userText, attachments, mcpMode, skillRun, history, liveReader,
    includeHistory, includeWebSearch, includeMcp,
    onMcpError,
    // Timing the connect stays here: it is a fact about this TURN, and a group should not
    // have to know it is being measured.
    markMcpMs: (ms) => { mcpMs = ms; },
  }, {
    onError: (id, err) => console.warn(`[chatpanel] tool group "${id}" failed:`, err),
  });
  for (const g of groups) providers.push(g.provider);

  const turnMcpMode = normalizeMcpTurnMode(mcpMode);
  const userCap = Number(settings?.ui?.maxToolsPerTurn) || 0;
  const cap = userCap || (turnMcpMode === MCP_TURN_MODES.AUTO ? DEFAULT_AUTO_TOOL_CAP : 0);

  let toolset = buildToolset(providers);
  if (toolset && cap) toolset = narrowToolset(toolset, userText, { cap, keep: isLocalToolSpec });
  if (toolset) { toolset.mcpMs = mcpMs; toolset.prepMs = Date.now() - startedAt; }

  const systemSkillRun =
    turnMcpMode === MCP_TURN_MODES.ON && skillRun
      ? { ...skillRun, mcp: { mode: 'default', serverIds: [] } }
      : skillRun;
  // Which servers this turn may use — the same decision the MCP group makes, asked here
  // for the skill system prompt. Cheap and connection-free by design, which is exactly why
  // it can be asked twice without costing anything.
  const { usable } = usableServers({ settings, license, skillRun, mcpMode, userText, attachments, includeMcp });
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
