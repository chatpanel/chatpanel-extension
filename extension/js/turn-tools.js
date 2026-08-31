import { widgetAuthoringSystem } from './tool-hints.js';
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
import { toolNeedFor } from './events/tool-need.js';
import { ownToolsSystem } from './agent-capabilities.js';
import { narrowToolset, isLocalToolSpec } from './tool-select.js';
import { buildToolGroups } from './tool-groups/index.js';
import { usableServers } from './tool-groups/mcp.js';
import { MCP_TURN_MODES, DEFAULT_AUTO_TOOL_CAP, normalizeMcpTurnMode } from './tool-policy.js';
import { skillCatalogSystem, skillToolSystem } from './skill-runtime.js';
import { redactionEnabled } from './pii-pipeline.js';
import { createVault } from './pii-redact.js';
import { isPro } from './license.js';

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
  connectors = [],           // a relayed agent's OWN MCP server names, from the bridge's /health
  noteWriter = null,         // surface-built provider for WRITING notes (needs confirm + a window)
  memoryWriter = null,       // surface-built provider for WRITING memory (same: every write is confirmed)
  extraProviders = [],       // surface-specific providers prepended verbatim
  onMcpError = () => {},
} = {}) {
  const startedAt = Date.now();

  // DOES THIS TURN NEED TOOLS AT ALL — asked of the message, before anything is built.
  //
  // Every turn used to be armed identically whatever was said, so "hi" reached the model
  // carrying a history dispatcher, an MCP dispatcher and ~1,200 tokens of rulebook. That is
  // not only waste: a turn that CARRIES tools requires a model that can CALL them, so a
  // greeting eliminated every model without the capability and then paid a CLI agent two
  // seconds to spawn a process in order to wave back. Equipment is not demand.
  //
  // The rule lives in @chatpanel/events beside the router's own signals — the gateway and
  // the bridge arm turns too, and a second definition of "asks for nothing" would drift from
  // the one the router uses. It is deliberately narrow: pleasantries only, everything else
  // armed, because withholding history tools from a real question is the worse error by far.
  //
  // Explicit intent is never second-guessed: MCP mode 'on', the /history hint, or a running
  // skill all mean the user or a skill already answered this question.
  const need = toolNeedFor({
    request: { text: userText },
    attachments,
    explicit: normalizeMcpTurnMode(mcpMode) === MCP_TURN_MODES.ON || !!skillRun || !!history?.enabled,
  });
  // Nothing built means no MCP connect either — the 'setup' seconds a greeting used to spend
  // were mostly that.
  if (!need.tools) return undefined;

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
    includeHistory, includeWebSearch, includeMcp, noteWriter, memoryWriter,
    onMcpError,
    // Timing the connect stays here: it is a fact about this TURN, and a group should not
    // have to know it is being measured.
    markMcpMs: (ms) => { mcpMs = ms; },
  }, {
    onError: (id, err) => console.warn(`[chatpanel] tool group "${id}" failed:`, err),
  });
  for (const g of groups) providers.push(g.provider);

  // Level 2 of the skill's progressive disclosure. Dynamic, and only when the running
  // skill actually ships files: an unused tool spec is per-turn token cost on every turn
  // that does not need it.
  if (skillRun?.files?.length && skillRun.origin?.source) {
    const [{ skillFileProvider }, { readSkillFile }] = await Promise.all([
      import('./skill-files.js'),
      import('./skill-source-bridge.js'),
    ]);
    const p = skillFileProvider({
      skillRun,
      read: (origin, path) => readSkillFile({ bridgeUrl, origin, path }),
    });
    if (p) providers.push(p);
  }

  // SKILL DISCOVERY. When the user did not invoke a skill explicitly (no /command, no menu
  // pick), let the model SEE every skill on the machine and pull one in on demand — the
  // user's own added skills AND everything installed under any agent harness the bridge can
  // read. This is what makes Add optional: you add a skill to pin or edit it, not to use it.
  // Only reached because need.tools was true above, so a greeting carries none of it. An
  // invoked skill (skillRun) already has its prompt inlined and its own skill_file, so this
  // whole block is skipped then, and the two skill_file tools never collide.
  let catalogEntries = [];
  if (!skillRun) {
    const { skillEntry, skillDiscoveryProvider } = await import('./skill-files.js');
    const { readSkillFile, listBridgeSkills, readBridgeSkill } = await import('./skill-source-bridge.js');
    const { enabledSkills } = await import('./skill-runtime.js');

    // Added skills carry their body inline; installed ones are name+description now and are
    // fetched on open. The bridge list is a cheap local call, and its failure (bridge down)
    // just means the catalog is the added skills — never an error the turn has to handle.
    const skillDirs = Array.isArray(settings.ui?.skillDirs) ? settings.ui.skillDirs : [];
    const added = enabledSkills(settings.skills).map((s) => skillEntry(s));
    let installed = [];
    if (bridgeAvailable) {
      installed = (await listBridgeSkills(bridgeUrl, skillDirs).catch(() => []))
        .map((s) => skillEntry(s, { prompt: null }));
    }
    // The user's own version wins a handle clash — an added skill they edited beats the
    // installed copy it came from.
    const seen = new Set(added.map((e) => e.command));
    catalogEntries = [...added, ...installed.filter((e) => e.command && !seen.has(e.command))];

    const disc = skillDiscoveryProvider({
      entries: catalogEntries,
      loadPrompt: async (e) => (e.prompt != null ? e.prompt : (await readBridgeSkill(bridgeUrl, e.origin?.id, skillDirs))?.prompt || ''),
      read: (origin, path) => readSkillFile({ bridgeUrl, origin, path, dirs: skillDirs }),
    });
    if (disc) providers.push(disc);
  }

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
  // The level-0 catalog rides along ONLY when discovery is active (no invoked skill) and
  // the model got a toolset it can call skill_open with. Ranked and capped in the helper.
  const catalogSystem = !skillRun && toolset && catalogEntries.length ? skillCatalogSystem(catalogEntries, { userText }) : '';
  // HOW TO BUILD SOMETHING THE USER CAN KEEP. Nobody should have to know an API to ask for a
  // timer — the user says what they want, and the MODEL is the thing that should know
  // ChatPanel renders a self-contained HTML file in a sandbox, offers to keep it, and that a
  // widget which remembers anything has to save it through chatpanel.setState. Nothing else
  // told the model any of that, so the whole surface was undiscoverable: a model that doesn't
  // know it can emit a runnable widget writes a paragraph describing one instead.
  const widgetSystem = widgetAuthoringSystem();
  if (!toolset) {
    const system = [skillSystem, widgetSystem].filter(Boolean).join('\n\n');
    return { specs: [], execute: async () => '', system };
  }
  toolset.system = [skillSystem, catalogSystem, widgetSystem, toolset.system].filter(Boolean).join('\n\n');
  // WHAT THE AGENT MAY STILL DO ON ITS OWN. Everything this harness says about the relayed
  // tools is a restriction — each written to stop a specific substitution — and read together
  // by an agent that also carries its own connectors they add up to "do not use your own
  // tools", which nobody meant. Added last so it qualifies the rules above rather than being
  // qualified by them.
  const own = ownToolsSystem(resolvedAgent, connectors);
  if (toolset && own) toolset.system = [toolset.system, own].filter(Boolean).join('\n\n');
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
