// ChatPanel side panel controller.
import { icon, iconForEmoji, hydrate } from './js/icons.js';
import { confirmDelete } from './js/confirm-modal.js';
import {
  getSettings,
  defaultSettings,
  getTarget,
  resolveTarget,
  getIndex,
  getConversation,
  createConversation,
  saveConversation,
  renameConversation,
  deleteConversation,
  pruneEmptyConversations,
  clearAllConversations,
  conversationToMarkdown,
  updateSettings,
  meetingNotesSkill,
} from './js/store.js';
import { streamChat as _streamChat, checkBridge, listModels, smallestModel, previewRedaction } from './js/providers.js';

// Tag side-panel model calls with the 'chat' surface for token accounting,
// keyed to the active conversation (unless a caller passes its own usage ctx).
const streamChat = (opts = {}) => _streamChat({ ...opts, usage: opts.usage || { surface: 'chat', sourceId: state?.conv?.id } });
import {
  listTabs,
  getActiveTab,
  captureActiveTab,
  captureTab,
  captureSelection,
  captureUrl,
  captureMeetingTranscript,
  isOwnDashboardUrl,
  meetingPlatform,
  probeMeeting,
  startMeeting,
  stopMeeting,
  enableMeetingCaptions,
  getMeetingRecord,
} from './js/context.js';
import { getSuggestions, getMeetingSuggestions, FALLBACK_SUGGESTIONS } from './js/suggestions.js';
// warm-sync.js is dynamic-imported in maybeWarmSync() — it drags in the history-rag subgraph.
import {
  meetingToText,
  meetingToMarkdown,
  getMeetingIndex,
  getMeeting,
  getMeetingNotes,
  getLiveNotesText,
  getMeetingNoteVersions,
  setActiveMeetingNote,
  deleteMeetingNoteVersion,
  getMeetingTopics,
  saveMeetingNotes,
  saveMeetingTopics,
  deleteMeeting,
  markMeetingEnded,
} from './js/store-meetings.js';
import {
  getMeetingMonitors,
  upsertMeetingMonitor,
  setMonitorClosed,
} from './js/store-monitors.js';
import { renderMarkdown } from './js/markdown.js';
import { combineSystemPrompt, sourceCitationSystem } from './js/tool-hints.js';
import { getLicense, isPro, planLabel, can, canUseAgent, freeAgentId, freeEndpointId, tierFor, FREE_LIMITS, subscribe } from './js/license.js';
import { createVault } from './js/pii-redact.js';
import { setPiiEntitlement, redactOnce, restore as restorePii, redactionFromSettings } from './js/pii-pipeline.js';
import { checkForUpdate, isDismissed, dismiss } from './js/update.js';
import { assistPrompt } from './js/assist.js';
// NB: page-tools.js + canvas-adapters.js (and their page-actions / draw.io / tldraw
// transitive graph, ~130KB) are heavy and only needed when "Act on page" actually
// runs — they're dynamic-imported inside pageToolProvider() to keep them OFF the
// panel's first-paint load path.
// turn-tools.js drags in web-search + history-rag + the MCP/toolset graph and is only
// needed when a turn actually runs — dynamic-imported at the send/toolset sites below.
import { upsertMeetingChatAttachment } from './js/meeting-chat-context.js';
// history-rag.js (+ its meeting/search subgraph) is dynamic-imported inside send().
import { skillRunFromSkill } from './js/skill-runtime.js';
import { slashCommandInsert, slashCommandItems } from './js/slash-commands.js';
import {
  HISTORY_CONTEXT_MODES,
  historyContextForMode,
  historyContextLabel,
  normalizeHistoryContextMode,
} from './js/history-context.js';
import {
  MCP_TURN_MODES,
  DEFAULT_AUTO_TOOL_CAP,
  cancelledToolResult,
  normalizeMcpTurnMode,
} from './js/tool-policy.js';
import { paginateEntries, rankConversationEntries } from './js/conversation-search.js';
import { rankMeetingEntries } from './js/meeting-search.js';
// topic-extraction.js is dynamic-imported inside the post-response extract* functions
// (extractTopicItems / maybeExtract*Topics) — never on the panel's first paint.

const $ = (id) => document.getElementById(id);
const HISTORY_PAGE_SIZE = 25;

// Page-action tools to hand the chat loop, IF the agent can use them: an API
// agent (bridge CLIs run their own loop), the "Act on page" opt-in is on, and we
// have a readable tab. Returns undefined otherwise (plain chat, no tools). When
// the user has explicitly toggled Act-on-page ON but a condition blocks it, we
// surface WHY — a silent no-op here is what makes the model claim it "has no
// browser automation," which is impossible to debug from the chat alone.
//
// Page-action tools for the chat loop. Requires an API agent (bridge CLIs run
// their own loop), the ▶️ Act-on-page opt-in, and a readable tab. The user's
// "High-reliability page control" setting selects the backend per turn: CDP
// trusted events (js/page-actions-cdp.js) when on, synthetic events otherwise.
// --- Page-action confirmation gate -------------------------------------------
// Browser-action tools (fill/click/type/keys) are a privileged sink: the model
// that calls them is fed page content, meeting transcripts and tool results — any
// of which can carry an injected instruction ("now click Pay"). So we pause for an
// explicit user confirmation before a state-CHANGING action, unless the user has
// trusted the site for this session or turned the gate off. Read-only tools
// (inspect/screenshot/scroll) never prompt, so the agent can still see & plan.
const trustedActionOrigins = new Set(); // origins the user OK'd this panel session
const READONLY_PAGE_TOOLS = new Set(['inspect_page', 'screenshot', 'marked_screenshot', 'scroll', 'read_canvas']);
const pageActionNeedsConfirm = (name) => !READONLY_PAGE_TOOLS.has(name);
const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };

function describePageAction(name, input = {}, host = 'this page') {
  const clip = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  switch (name) {
    case 'fill_form': { const n = Array.isArray(input.fields) ? input.fields.length : 0; return `Fill ${n || ''} field${n === 1 ? '' : 's'} (and possibly submit a form) on ${host}`; }
    case 'fill_combobox': return `Set a dropdown / combobox on ${host}`;
    case 'click_element':
    case 'click_by_text': return `Click “${clip(input.text || input.selector || 'an element')}” on ${host}`;
    case 'click_mark': return `Click marked element #${input.mark ?? '?'} on ${host}`;
    case 'click_at': return `Click at (${Math.round(input.x)}, ${Math.round(input.y)}) on ${host}`;
    case 'type_text': return `Type “${clip(input.text)}” on ${host}`;
    case 'press_key': return `Press ${clip(input.key, 24)} on ${host}`;
    case 'draw_path': return `Draw / drag on ${host}`;
    case 'structured_insert': return `Insert content into the editor on ${host}`;
    default: return `Run “${name}” on ${host}`;
  }
}

// Inline confirmation card → resolves 'allow' | 'site' | 'deny'. Inline styles
// (CSP allows style 'unsafe-inline'); CSS-var fallbacks keep it themed-or-not.
function confirmPageAction(detail) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'cp-confirm-ov';
    ov.setAttribute('role', 'alertdialog');
    ov.setAttribute('aria-label', 'Confirm page action');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.38);padding:12px';
    const card = document.createElement('div');
    card.style.cssText = 'width:100%;max-width:480px;background:var(--panel,#1b1d22);color:var(--fg,#e8e8ea);border:1px solid var(--border,#33363d);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.4);padding:14px 16px;font:13px/1.45 system-ui,-apple-system,sans-serif';
    const title = document.createElement('div');
    title.innerHTML = icon('pen') + ' Allow this page action?';
    title.style.cssText = 'font-weight:600;margin-bottom:6px';
    const body = document.createElement('div');
    body.textContent = detail;
    body.style.cssText = 'opacity:.92;margin-bottom:4px;word-break:break-word';
    const why = document.createElement('div');
    why.textContent = 'Requested by the AI based on page / tool content — review before allowing.';
    why.style.cssText = 'opacity:.6;font-size:11px;margin-bottom:12px';
    const rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end';
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('deny'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done('allow'); }
    };
    const mk = (label, val, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `cursor:pointer;border-radius:8px;padding:7px 12px;font:inherit;font-weight:600;${primary ? 'background:var(--accent,#4f7cff);color:#fff;border:1px solid transparent' : 'background:transparent;color:inherit;border:1px solid var(--border,#33363d)'}`;
      b.onclick = () => done(val);
      return b;
    };
    const denyBtn = mk('Decline', 'deny', false);
    rowEl.append(denyBtn, mk('Allow for this site', 'site', false), mk('Allow', 'allow', true));
    card.append(title, body, why, rowEl);
    ov.append(card);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done('deny'); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    denyBtn.focus(); // safe default
  });
}

// confirmDelete (branded destructive-action modal) is imported from ./js/confirm-modal.js
// at the top of this file — one shared implementation across every ChatPanel surface.

async function pageToolProvider(resolvedAgent) {
  if (!state.settings.ui?.pageActions) return null; // feature off — stay silent
  // API agents run the in-extension tool loop; bridge/CLI agents (Claude Code,
  // Codex) get the SAME tools relayed through the bridge's MCP server. Both need
  // a readable web tab to act on.
  if (!resolvedAgent) return null;
  if (!state.activeTab?.id) {
    console.warn('[chatpanel] page actions NOT attached — no readable web tab is active');
    toast('▶️ Act on page can’t run: no readable web tab is active');
    return null;
  }
  const cdp = !!state.settings.ui?.pageActionsCdp;
  console.info('[chatpanel] page actions attached for', resolvedAgent.kind, 'on tab', state.activeTab.id, cdp ? '(trusted/CDP)' : '(synthetic)');

  // Load the heavy page-automation + canvas-adapter modules on first use only (they
  // and their transitive graph stay off the panel's initial load path).
  const [{ PAGE_TOOL_SPECS, makePageToolExecutor, PAGE_AUTOMATION_SYSTEM }, { detectCanvasAdapter }] =
    await Promise.all([import('./js/page-tools.js'), import('./js/canvas-adapters.js')]);

  // Structured-editor adapter (Excalidraw, …): when the active tab is a canvas app
  // with a native data format, expose a `structured_insert` tool so the agent
  // builds diagrams as DATA instead of pixel-driving. Pro-gated.
  let specs = PAGE_TOOL_SPECS;
  let system = PAGE_AUTOMATION_SYSTEM;
  let adapter = null;
  // Pick a structured-editor adapter by CAPABILITY (probe the live page), falling
  // back to URL — so it works on embeds/self-hosted, not just known hosts. Adapters
  // insert via chrome.scripting (+ tab reload); they don't need trusted events, so
  // don't gate on CDP — only the optional zoom/fit uses it (guarded per-adapter).
  let candidate = null;
  try {
    candidate = await detectCanvasAdapter(state.activeTab.id, state.activeTab.url || '');
  } catch (e) {
    console.warn('[chatpanel] canvas-adapter detection failed; using base page tools', e);
  }
  if (candidate && can(state.license, 'structuredInsert')) {
    adapter = candidate;
    specs = [...PAGE_TOOL_SPECS, ...adapter.toolSpecs()];
    system = `${PAGE_AUTOMATION_SYSTEM}\n\n${adapter.systemGuidance()}`;
    console.info('[chatpanel] structured-insert adapter active:', adapter.id, cdp ? '(cdp)' : '(no cdp)');
  } else if (candidate) {
    console.info('[chatpanel] structured-insert (', candidate.id, ') is a Pro feature — not offered');
  }

  const baseExecute = makePageToolExecutor(state.activeTab.id, { cdp, adapter });
  const pageOrigin = originOf(state.activeTab.url || '');
  const guardedExecute = async (name, input, meta) => {
    const confirmOn = state.settings.ui?.pageActionConfirm !== false; // default ON
    if (confirmOn && pageActionNeedsConfirm(name) && !trustedActionOrigins.has(pageOrigin)) {
      const host = pageOrigin ? pageOrigin.replace(/^https?:\/\//, '') : 'this page';
      const decision = await confirmPageAction(describePageAction(name, input, host));
      if (decision === 'deny') {
        toast('🖋 Action declined');
        return JSON.stringify({ error: 'The user DECLINED this page action. Do not retry it — stop and ask the user how to proceed.' });
      }
      if (decision === 'site' && pageOrigin) trustedActionOrigins.add(pageOrigin);
    }
    return baseExecute(name, input, meta);
  };
  return { specs, execute: guardedExecute, system };
}

// Build the full toolset for a turn. The side-panel-specific part — page-action
// tools (they need a live web tab + confirm dialogs) — is assembled here; the
// portable part (history + web-search + MCP + narrowing) is delegated to the
// shared `buildTurnTools` capability, which the Notes dashboard also calls, so the
// two can never drift. Returns undefined when nothing is armed.
async function toolsetFor(
  resolvedAgent,
  { historyRag = null, skillRun = null, mcpMode = MCP_TURN_MODES.AUTO, userText = '', attachments = [], pageTools = true } = {},
) {
  // Page-action tools need a live tab + confirm dialogs — skip them for background
  // callers (e.g. auto-refreshing live monitors) that shouldn't drive the tab.
  const page = pageTools ? await pageToolProvider(resolvedAgent) : null;
  const history = historyRag || skillRun?.history || null;
  const { buildTurnTools } = await import('./js/turn-tools.js'); // heavy toolset graph, on-demand
  return buildTurnTools({
    resolvedAgent,
    settings: state.settings,
    license: state.license,
    bridgeUrl: state.settings.bridgeUrl,
    bridgeAvailable: !!state.bridge?.ok,
    userText,
    attachments,
    mcpMode,
    skillRun,
    history,
    // Expose meeting_live_transcript only while a meeting is actually capturing.
    liveReader: (state.liveMeeting && can(state.license, 'liveMeetings')) ? getLiveMeetingRecord : null,
    // Page-action tools are side-panel-only — prepended verbatim.
    extraProviders: page ? [page] : [],
    onMcpError: (s, e) => {
      console.warn('[chatpanel] MCP server failed:', s.name || s.url || s.command, e.message);
      toast(`🔌 MCP “${s.name || s.url || s.command}” unavailable: ${e.message}`, 2600);
    },
  });
}

function runProfileForTurn(conv, assistant) {
  const idx = conv.messages.findIndex((m) => m.id === assistant.id);
  const stop = idx >= 0 ? idx - 1 : conv.messages.length - 1;
  for (let i = stop; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'user') {
      return {
        historyRag: m.historyRag || null,
        skillRun: m.skillRun || null,
        mcpMode: m.mcpMode || MCP_TURN_MODES.AUTO,
        userText: m.content || '',
        attachments: m.attachments || [],
      };
    }
  }
  return { historyRag: null, skillRun: null, mcpMode: MCP_TURN_MODES.AUTO, userText: '', attachments: [] };
}

// One reversible PII-redaction vault per conversation, so a placeholder means the
// same entity across turns (and survives chat switches mid-stream).
function piiVaultFor(convId) {
  let v = state.piiVaults.get(convId);
  if (!v) { v = createVault(); state.piiVaults.set(convId, v); }
  return v;
}

const state = {
  settings: null,
  license: null,
  conv: null, // active conversation
  index: [], // history index
  attachments: [], // pending context for the next message
  pendingSkillRun: null, // set when a skill is picked from the menu before send
  usePage: true, // auto-include the current tab as context
  activeTab: null, // { id, title, url } of the tab the panel is looking at
  ownPageTab: null, // our own dashboard (notes/meetings/history) tab, read from storage
  bridge: { ok: false, agents: [] },
  convCache: new Map(), // id -> live conv object (kept so streams survive switches)
  piiVaults: new Map(), // convId -> reversible PII redaction vault (per conversation)
  streams: new Map(), // convId -> { controller, started, lastEvent }
  bubbles: new Map(), // messageId -> bubble element (active view only)
  toolCancels: new Map(), // provider call id -> { cancel, tool, convId, assistantId }
  // Watch mode: re-read a FIXED tab on an interval and re-run the agent on change.
  watch: {
    on: false,
    timer: null,
    busy: false,
    tabId: null, // the tab captured at Start (not whatever's active later)
    tabTitle: '',
    convId: null, // the conversation watch runs append to
    lastHash: null,
    runs: 0,
    errored: false,
    instruction: '',
    intervalMs: 10000,
    onlyWhenChanged: true,
    maxRuns: 50,
  },
};

function withToolCancellation(tools, assistant, conv) {
  if (!tools?.execute) return tools;
  return {
    ...tools,
    async execute(name, input, meta = {}) {
      const callId =
        meta.callId || `${assistant.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
      let cancel;
      const skipped = new Promise((resolve) => {
        cancel = () => resolve(cancelledToolResult(name));
      });
      const running = Promise.resolve().then(() => tools.execute(name, input, meta));
      // If the user skips first, the underlying MCP request may still settle
      // later. Observe that rejection so it does not become an unhandled promise.
      running.catch(() => {});
      state.toolCancels.set(callId, { cancel, tool: name, convId: conv.id, assistantId: assistant.id });
      try {
        return await Promise.race([running, skipped]);
      } finally {
        state.toolCancels.delete(callId);
      }
    },
  };
}

function skipToolCall(callId) {
  const entry = state.toolCancels.get(callId);
  if (!entry) {
    toast('That tool call already finished', 1400);
    return;
  }
  entry.cancel();
  markToolStep(callId, 'skipped by user');
  const stream = state.streams.get(entry.convId);
  if (stream) stream.lastEvent = `Skipped ${entry.tool || 'tool'}`;
  renderActivity();
  toast('Skipped tool; continuing without it', 1600);
}

function markToolStep(callId, status) {
  for (const conv of state.convCache.values()) {
    const msg = conv.messages.find((m) => m.steps?.some((s) => s.callId === callId));
    if (!msg) continue;
    const step = msg.steps.find((s) => s.callId === callId);
    if (step) step.status = status;
    if (conv.id === state.conv?.id) updateBubble(msg);
    return;
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function init() {
  // Make the panel interactive on the FIRST paint. On a fresh install the service
  // worker cold-starts and the storage/license/index loads below can take a couple
  // of seconds; if we wired the composer only after them, typing and Send did
  // nothing until the panel was reopened (and the Web Store reviewer saw a "broken"
  // UI). So seed synchronous default settings and attach all handlers up front —
  // wireEvents() only attaches handlers (every state read is deferred), so it's safe
  // before the data is loaded. send() awaits composerReadyPromise to bridge the gap.
  state.settings = defaultSettings();
  applyTheme();
  wireEvents();
  wireDrawerResize();

  // Load everything independent CONCURRENTLY — these are all local reads (getLicense
  // verifies the entitlement OFFLINE, no network), so serializing them only added
  // dead time to the cold first-run. The index must reflect the prune, so chain those.
  const [settings, license, index] = await Promise.all([
    getSettings(),
    getLicense(),
    pruneEmptyConversations().then(() => getIndex()), // clear stale empty chats, then index
  ]);
  state.settings = settings;
  state.license = license;
  state.index = index;
  setPiiEntitlement(isPro(state.license));
  ensureUsableActiveAgent();
  state.usePage = state.settings.ui.autoAttachActiveTab !== false;
  applyTheme();
  wireMarkdownLinks();

  await startConversation();
  markComposerReady(); // settings + active conversation ready — Send/Enter can proceed
  refreshBridge();
  refreshActiveTab();
  renderUpgradeChip();
  maybeShowUpdateBanner();
  scheduleLiveNotes({ force: true }); // arm the global meeting-scribe loop (off-tab safe)
  // NB: NO warm sync on the load path. The gateway's warm index is persistent
  // (SQLite + backup-seeded) and kept fresh by the on-change handler, so panel open
  // stays hot-only and instant. Warm work happens on demand / on change, never here.
  if (state.settings.ui?.railCollapsed) {
    document.body.classList.add('rail-collapsed');
    const t = $('rail-toggle');
    if (t) { t.textContent = '›'; t.title = 'Show panel rail'; }
  }
  renderRail();
  // Handoffs from the full Meetings dashboard. "Ask" attaches the meeting to the
  // normal chat composer; older/open-view paths still open the meeting drawer.
  try {
    const attach = await chrome.storage.local.get('chatpanel:attachMeetingId');
    const attachMid = attach['chatpanel:attachMeetingId'];
    if (attachMid) {
      await chrome.storage.local.remove('chatpanel:attachMeetingId');
      await attachStoredMeetingToChat(attachMid);
    }

    const g = await chrome.storage.local.get('chatpanel:openMeetingId');
    const mid = g['chatpanel:openMeetingId'];
    if (mid) {
      await chrome.storage.local.remove('chatpanel:openMeetingId');
      if (can(state.license, 'liveMeetings')) {
        $('meetings-drawer').classList.remove('hidden');
        await openStoredMeeting(mid);
      }
    }
    // Handoff from the Chat-history dashboard's "Open in panel" button.
    const cg = await chrome.storage.local.get('chatpanel:openConversationId');
    const cid = cg['chatpanel:openConversationId'];
    if (cid) {
      await chrome.storage.local.remove('chatpanel:openConversationId');
      await openConversation(cid);
    }
    // Handoff from the Notes page "Ask about this note" button.
    const an = await chrome.storage.local.get('chatpanel:attachNoteId');
    const anid = an['chatpanel:attachNoteId'];
    if (anid) {
      await chrome.storage.local.remove('chatpanel:attachNoteId');
      await attachStoredNoteToChat(anid);
    }
  } catch { /* no handoff pending */ }
  // Keep the "recording" indicator + live-meeting cache fresh even when Live notes
  // is off and the user isn't switching tabs (so it clears soon after a call ends).
  setInterval(() => renderScribeIndicator(), 30_000);

  // Right-click "Ask ChatPanel" seed, and handoffs from the full dashboards
  // (Chat-history "Open in panel", Meetings "Ask") — these work even when the
  // side panel is ALREADY open (the init() flag only covers a fresh open).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'context-seed') applySeed(msg);
    else if (msg?.type === 'open-conversation' && msg.id) {
      chrome.storage.local.remove('chatpanel:openConversationId').catch(() => {});
      openConversation(msg.id);
    } else if (msg?.type === 'attach-meeting' && msg.id && can(state.license, 'liveMeetings')) {
      chrome.storage.local.remove('chatpanel:attachMeetingId').catch(() => {});
      attachStoredMeetingToChat(msg.id);
    } else if (msg?.type === 'attach-note' && msg.id) {
      chrome.storage.local.remove('chatpanel:attachNoteId').catch(() => {});
      attachStoredNoteToChat(msg.id);
    } else if (msg?.type === 'open-meeting' && msg.id && can(state.license, 'liveMeetings')) {
      chrome.storage.local.remove('chatpanel:openMeetingId').catch(() => {});
      $('meetings-drawer').classList.remove('hidden');
      openStoredMeeting(msg.id);
    } else if (msg?.type === 'CP_MEETING_ORPHANED' && msg.tabId != null) {
      // The extension was reloaded/updated while this meeting tab stayed open, so its
      // content script is detached and CANNOT record — reloading the tab is the only
      // recovery, so offer it in one click instead of failing silently.
      toastAction('Meeting tab disconnected — not recording.', 'Reload tab',
        () => chrome.tabs.reload(msg.tabId).catch(() => {}), 10000);
    } else if (msg?.type === 'CP_MEETING_BLOCKED') {
      // A capture was REFUSED (Free lifetime cap). Never fail silently: say so and offer
      // the upgrade, since the meeting is not being saved at all. Pro/Team should never
      // land here — if it does, that's a licensing bug, so say that instead of upselling.
      if (isPro(state.license)) toast('Meeting not saved — capture was refused despite Pro. Check Settings → License.', 6000);
      else showMeetingLimitPrompt();
    } else if (msg?.type === 'CP_MEETING_JOINED' || msg?.type === 'CP_MEETING_CAPTIONS') {
      // JOINED: the user joined a call (inCall flipped) → auto-start now.
      // CAPTIONS: live-caption state flipped → refresh so the "captions off" warning
      // appears/clears immediately. Both just re-run the bar (it re-probes + gates).
      renderMeetingBar();
    }
  });
  const { pendingSeed } = await chrome.storage.session.get('pendingSeed').catch(() => ({}));
  if (pendingSeed) {
    applySeed(pendingSeed);
    chrome.storage.session.remove('pendingSeed').catch(() => {});
  }
}

async function startConversation(existing) {
  const conv =
    existing || (await createConversation({ agentId: state.settings.activeAgentId }));
  state.convCache.set(conv.id, conv);
  state.conv = conv;
  state.bubbles.clear();
  state.attachments = [];
  renderAgentName();
  renderMessages();
  renderContextBar();
  updateComposerUI();
  renderActivity();
}

// Is the conversation currently on screen mid-response?
function isActiveStreaming() {
  return state.streams.has(state.conv.id);
}

// Parse a leading "/command args" into its skill (or null). The caller applies
// the skill's context/agent and substitutes variables — see applySkillPrep.
function matchSlashSkill(text) {
  const m = /^\/([a-z0-9_-]+)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const skill = state.settings.skills.find(
    (s) => (s.command || '').toLowerCase() === m[1].toLowerCase(),
  );
  return skill ? { skill, args: m[2].trim() } : null;
}

// Detect an inline "/search <terms>" (or "/web <terms>") directive ANYWHERE in the
// message — at the start or mid-prompt. The terms run to the end of that line.
// Returns { query, cleaned } where `cleaned` is the message with the directive
// stripped out (so the model sees the question, not the command), or null.
function parseSearchCommand(text) {
  const s = String(text || '');
  const m = /(^|\s)\/(?:search|web)[ \t]+([^\n]+)/i.exec(s);
  if (!m) return null;
  const query = m[2].trim();
  if (!query) return null;
  // Drop the directive but keep its leading boundary char so surrounding text joins cleanly.
  const cleaned = (s.slice(0, m.index) + (m[1] || '') + s.slice(m.index + m[0].length)).trim();
  return { query, cleaned };
}

// --------------------------------------------------------------------------
// Agents
// --------------------------------------------------------------------------
function currentAgent() {
  // state.conv is null during the cold-start window (wireEvents() attaches handlers
  // before startConversation() sets it), so fall back to the active agent — the
  // correct default when no conversation exists yet.
  return getTarget(state.settings, state.conv?.agentId || state.settings.activeAgentId);
}

// On Free, the active agent must be one of the unlocked slots. If it isn't
// (default points elsewhere, or the user downgraded from Pro), repoint to the
// free agent slot so chatting never targets a locked agent.
function ensureUsableActiveAgent() {
  // If the active target was disabled in Settings, move to the first enabled one so
  // chat doesn't point at a hidden/disabled model (applies to all tiers).
  const active = getTarget(state.settings, state.settings.activeAgentId);
  if (active && active.enabled === false) {
    const next =
      (state.settings.endpoints || []).find((e) => e.enabled !== false)?.id ||
      (state.settings.agents || []).find((a) => a.kind === 'bridge' && a.enabled !== false)?.id;
    if (next) { state.settings.activeAgentId = next; updateSettings({ activeAgentId: next }); }
  }
  if (isPro(state.license)) return;
  const cur = getTarget(state.settings, state.settings.activeAgentId);
  if (cur && canUseAgent(state.license, state.settings, cur)) return;
  const id = freeAgentId(state.settings) || freeEndpointId(state.settings);
  if (id && id !== state.settings.activeAgentId) {
    state.settings.activeAgentId = id;
    updateSettings({ activeAgentId: id });
  }
}

// `target` may be an endpoint, a model agent, or a bridge agent.
function agentAvailability(target) {
  if (!target) return { ok: false, reason: 'None' };
  if (target.kind === 'bridge') {
    if (!state.bridge.ok) return { ok: false, reason: 'Bridge not running' };
    // Custom "bring your own" agents aren't in /health (the bridge can't enumerate
    // user-defined commands); they're validated when run / via Settings' Check.
    if (target.bridgeAgent === 'custom') {
      return target.command ? { ok: true } : { ok: false, reason: 'No command set' };
    }
    const found = state.bridge.agents.find((a) => a.id === target.bridgeAgent);
    if (!found) return { ok: false, reason: 'Not detected' };
    return { ok: found.available, reason: found.reason };
  }
  // Endpoint or model agent — usable once it resolves to an endpoint + a model.
  const eff = resolveTarget(target, state.settings);
  // In-browser (WebLLM) needs no baseUrl/key — it runs on WebGPU. Always "available"
  // here; a missing-WebGPU machine surfaces a clear error at send time instead.
  if ((eff?.kind || target.kind) === 'webllm') return { ok: true };
  if (!eff?.baseUrl) return { ok: false, reason: 'No endpoint' };
  if (!eff.model) return { ok: false, reason: 'Pick a model' };
  return { ok: true };
}

async function refreshBridge() {
  state.bridge = await checkBridge(state.settings.bridgeUrl);
  renderAgentName();
}

function renderAgentName() {
  const a = currentAgent();
  $('agent-name').textContent = a?.name || 'Select agent';
  const modelLabel = agentModelLabel(a);
  $('agent-model').textContent = modelLabel;
  $('agent-model').title = modelLabel ? `Model: ${modelLabel}` : '';
  $('agent-model').classList.toggle('hidden', !modelLabel);
}

function agentModelLabel(target) {
  if (!target) return '';
  if (target.kind === 'bridge') return target.model || '';
  return resolveTarget(target, state.settings)?.model || '';
}

function renderAgentMenu() {
  const menu = $('agent-menu');
  menu.innerHTML = '';
  const s = state.settings;

  const addItem = (target, badge) => {
    const avail = agentAvailability(target);
    const usable = canUseAgent(state.license, s, target); // Pro, or the free pick
    const item = document.createElement('button');
    item.className =
      'menu-item' +
      (target.id === state.conv.agentId ? ' active' : '') +
      (usable ? '' : ' locked');
    const dot = document.createElement('span');
    dot.className = 'dot ' + (avail.ok ? 'on' : 'off');
    const label = document.createElement('span');
    label.style.flex = '1';
    const model = target.kind === 'bridge' ? '' : resolveTarget(target, s)?.model || '';
    const sub = !avail.ok
      ? `<span class="mi-sub">— ${escapeAttr(avail.reason)}</span>`
      : model
        ? `<span class="mi-sub">${escapeAttr(model)}</span>`
        : '';
    label.innerHTML = `${escapeAttr(target.name)} ${sub}`;
    item.append(dot, label);
    // Locked (Pro) items keep a 🔒 tag; free ones keep their existing badge.
    if (!usable) {
      const lock = document.createElement('span');
      lock.className = 'badge lock';
      lock.innerHTML = icon('lock') + ' Pro';
      item.appendChild(lock);
    } else if (badge) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = badge;
      item.appendChild(b);
    }
    item.onclick = () => {
      if (!usable) {
        // A locked pick is a high-intent moment — go straight to the pricing page
        // (carrying this install's id) so the user can choose a plan and buy. The
        // keyless poll in subscribe() flips this device to Pro on return.
        closeMenus();
        return startSubscribe('pro');
      }
      state.conv.agentId = target.id;
      state.settings.activeAgentId = target.id;
      updateSettings({ activeAgentId: target.id });
      saveConversation(state.conv);
      renderAgentName();
      closeMenus();
    };
    menu.appendChild(item);
  };

  // Hide endpoints/agents the user has disabled in Settings (kept, not deleted).
  const endpoints = (s.endpoints || []).filter((e) => e.enabled !== false);
  const bridge = (s.agents || []).filter((a) => a.kind === 'bridge' && a.enabled !== false);
  if (endpoints.length) {
    menu.appendChild(sectionLabel('API'));
    endpoints.forEach((e) => addItem(e));
  }
  if (bridge.length) {
    menu.appendChild(sectionLabel('Agents'));
    bridge.forEach((a) => addItem(a, 'local'));
  }
  const manage = document.createElement('button');
  manage.className = 'menu-item';
  manage.innerHTML = icon('settings') + ' <span>Manage in Settings…</span>';
  manage.onclick = () => chrome.runtime.openOptionsPage();
  menu.appendChild(manage);
}

// --------------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------------
function renderMessages() {
  const root = $('messages');
  root.querySelectorAll('.msg').forEach((n) => n.remove());
  state.bubbles.clear();
  const empty = $('empty');
  if (!state.conv.messages.length) {
    empty.classList.remove('hidden');
    renderSuggestions();
  } else {
    empty.classList.add('hidden');
    for (const m of state.conv.messages) root.appendChild(renderMessage(m));
  }
  scrollToBottomNow();
}

function renderMessage(m) {
  // Watch-mode log row — a compact dim line, not a chat bubble.
  if (m.role === 'watch') {
    const row = document.createElement('div');
    row.className = 'msg watch-log';
    row.dataset.id = m.id;
    row.innerHTML = `${icon('watch')} ${escapeAttr(String(m.content ?? ''))} · ${escapeAttr(timeLabel(m.ts))}`;
    return row;
  }

  // Live-meeting running summary — ONE self-updating card the scribe refreshes
  // (Phase 2). Role isn't user/assistant, so it's auto-excluded from the model
  // payload (messagesForModel) — it's a view for the user, not chat history.
  if (m.role === 'live-summary') {
    const card = document.createElement('div');
    card.className = 'msg live-summary';
    card.dataset.id = m.id;
    const head = document.createElement('div');
    head.className = 'live-summary-h';
    head.innerHTML = `${icon('mic')} Live summary · updated ${escapeAttr(timeLabel(m.ts))}`;
    const body = document.createElement('div');
    body.className = 'live-summary-b bubble';
    body.innerHTML = m.content ? renderMarkdown(m.content) : '<span class="muted">Waiting for the first summary…</span>';
    enhanceCode(body);
    card.append(head, body);
    return card;
  }

  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}${m.error ? ' error' : ''}${m.queued ? ' queued' : ''}`;
  wrap.dataset.id = m.id;

  if (m.role === 'assistant') {
    const who = document.createElement('div');
    who.className = 'who';
    if (m.watch) who.innerHTML = `${icon('watch')} watch run · ${escapeAttr(timeLabel(m.watchAt))}`;
    else who.textContent = m.agentName || 'Assistant';
    wrap.appendChild(who);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.role === 'assistant') {
    bubble.innerHTML = assistantBody(m);
    enhanceCode(bubble);
    wireStepControls(bubble);
  } else {
    // user bubble: plain text + attachment note (+ image thumbnails)
    bubble.textContent = m.content;
    if (m.attachments?.length) {
      const imgs = m.attachments.filter((a) => a.kind === 'image' && a.dataUrl);
      const rest = m.attachments.filter((a) => a.kind !== 'image');
      if (rest.length) {
        const note = document.createElement('div');
        note.className = 'who';
        note.style.marginTop = '6px';
        note.innerHTML = icon('attach') + ' ' + escapeAttr(rest.map((a) => a.title || a.url).join(', '));
        bubble.appendChild(note);
      }
      if (imgs.length) {
        const strip = document.createElement('div');
        strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px';
        for (const a of imgs) {
          const img = document.createElement('img');
          img.src = a.dataUrl;
          img.title = a.title || 'image';
          img.style.cssText = 'max-width:120px;max-height:120px;border-radius:8px;border:1px solid var(--border)';
          strip.appendChild(img);
        }
        bubble.appendChild(strip);
      }
    }
    if (m.queued) {
      const q = document.createElement('div');
      q.className = 'who';
      q.style.marginTop = '4px';
      q.innerHTML = icon('queued') + ' Queued';
      bubble.appendChild(q);
    }
  }
  wrap.appendChild(bubble);
  state.bubbles.set(m.id, bubble);

  // hover actions
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = miniBtn('Copy', () => navigator.clipboard.writeText(m.content));
  actions.appendChild(copy);
  if (m.role === 'assistant' && !m.pending) {
    actions.appendChild(miniBtn('Retry', () => retryFrom(m)));
  }
  if (m.role === 'user' && !m.queued) {
    actions.appendChild(miniBtn('Edit', () => editMessage(m)));
  }
  wrap.appendChild(actions);
  return wrap;
}

function updateBubble(m) {
  const bubble = state.bubbles.get(m.id);
  if (!bubble) return;
  bubble.innerHTML = assistantBody(m);
  enhanceCode(bubble);
  wireStepControls(bubble);
}

// A human label for one agent action (tool call), so the user can SEE what the
// agent is doing — especially with no-reasoning models, where the bubble would
// otherwise be blank while it loops through tools.
function stepLabel(s) {
  const i = s.input || {};
  switch (s.tool) {
    case 'inspect_page': return 'Read the page';
    case 'fill_form': return `Filled ${i.fields?.length || 0} field(s)`;
    case 'fill_combobox': return `Typed “${String(i.value || '').slice(0, 40)}” → select`;
    case 'click_element': return `Clicked ${String(i.selector || '').slice(0, 48)}`;
    case 'click_by_text': return `Clicked “${String(i.text || '').slice(0, 40)}”`;
    case 'screenshot': return 'Took a screenshot';
    case 'marked_screenshot': return 'Tagged clickable elements';
    case 'click_mark': return `Clicked element #${i.n}`;
    case 'click_at': return `Clicked at (${Math.round(i.x)}, ${Math.round(i.y)})`;
    case 'type_text': return `Typed “${String(i.text || '').slice(0, 40)}”`;
    case 'press_key': return `Pressed ${i.key}`;
    case 'scroll': return `Scrolled ${i.dy > 0 ? 'down' : 'up'}`;
    case 'draw_path': return `Drew a stroke (${i.points?.length || 0} pts)`;
    default: {
      const mcp = /^mcp_(.+?)__(.+)$/.exec(s.tool || '');
      if (mcp) return `${displayMcpServer(mcp[1])} / ${mcp[2]}`;
      return `${s.tool}`;
    }
  }
}

// The Lucide icon that leads a step's label — mirrors the emoji stepLabel used
// to prepend. Returned as an inline-SVG string so it can sit in the step's
// innerHTML (the text label beside it is escaped separately).
function stepIcon(s) {
  switch (s.tool) {
    case 'inspect_page': return icon('search');
    case 'fill_form':
    case 'fill_combobox':
    case 'type_text':
    case 'press_key': return icon('keyboard');
    case 'click_element':
    case 'click_by_text':
    case 'click_mark':
    case 'click_at':
    case 'scroll': return icon('mouse-pointer-click');
    case 'screenshot': return icon('camera');
    case 'marked_screenshot': return icon('hash');
    case 'draw_path': return icon('pencil');
    default:
      return /^mcp_(.+?)__(.+)$/.test(s.tool || '') ? '' : icon('wrench');
  }
}

function mcpInfo(tool) {
  const m = /^mcp_(.+?)__(.+)$/.exec(tool || '');
  return m ? { server: displayMcpServer(m[1]), tool: m[2] } : null;
}

function displayMcpServer(slug) {
  const s = String(slug || 'mcp').replace(/_/g, ' ');
  if (/^deepwiki$/i.test(s)) return 'DeepWiki';
  if (/^context7$/i.test(s)) return 'Context7';
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Page tools whose stepLabel already encodes their arguments — no need to repeat
// the raw input for these. Everything else (MCP tools, a CLI's own tools) shows
// its call arguments so the log reads like a real activity trace.
const LABELED_TOOLS = new Set([
  'inspect_page', 'fill_form', 'fill_combobox', 'click_element', 'click_by_text',
  'screenshot', 'marked_screenshot', 'click_mark', 'click_at', 'type_text',
  'press_key', 'scroll', 'draw_path',
]);

// A compact one-line view of a tool call's arguments (for MCP / generic tools).
function stepArgs(s) {
  if (LABELED_TOOLS.has(s.tool)) return '';
  const i = s.input;
  if (i == null) return '';
  if (typeof i === 'object' && !Array.isArray(i)) {
    const rows = Object.entries(i)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => {
        const value = typeof v === 'string' ? v : JSON.stringify(v);
        const clipped = value.length > 260 ? value.slice(0, 260) + '...' : value;
        return `<div class="step-arg"><span class="step-arg-key">${escapeAttr(k)}</span><span class="step-arg-val">${escapeAttr(clipped)}</span></div>`;
      })
      .join('');
    return rows ? `<div class="step-args-list">${rows}</div>` : '';
  }
  let str = typeof i === 'string' ? i : JSON.stringify(i);
  if (!str || str === '{}' || str === '""') return '';
  if (str.length > 220) str = str.slice(0, 220) + '...';
  return `<div class="step-args">${escapeAttr(str)}</div>`;
}

function stepHeader(s, badge, controls = '') {
  const info = mcpInfo(s.tool);
  if (!info) return `<div class="step">${stepIcon(s)}${escapeAttr(stepLabel(s))}${badge}${controls}</div>`;
  return (
    `<div class="step step-mcp">` +
    `<span class="step-server">${escapeAttr(info.server)}</span>` +
    `<span class="step-tool">${escapeAttr(info.tool)}</span>` +
    `<span class="step-meta">${badge}${controls}</span></div>`
  );
}

function stepControls(s) {
  if (!s.callId || s.status) return '';
  return ` <button type="button" class="step-skip" data-skip-tool="${escapeAttr(s.callId)}" title="Skip waiting for this tool result">Skip</button>`;
}

// Collapsible "Actions" log of the agent's tool calls (args, status, screenshots).
function renderSteps(m) {
  const open = m.pending ? ' open' : '';
  const items = m.steps
    .map((s) => {
      const shot = s.image
        ? `<img class="step-shot" src="${escapeAttr(s.image)}" alt="screenshot" />`
        : '';
      const badge = s.status ? ` <span class="step-status ${/error|fail|blocked|CDP failed/i.test(s.status) ? 'bad' : ''}">${escapeAttr(s.status)}</span>` : '';
      const result = s.result
        ? `<details class="step-result"><summary>result</summary><pre>${escapeAttr(String(s.result).slice(0, 4000))}</pre></details>`
        : '';
      return `${stepHeader(s, badge, stepControls(s))}${stepArgs(s)}${shot}${result}`;
    })
    .join('');
  return `<details class="agent-steps"${open}><summary>${icon('tools')} Actions (${m.steps.length})</summary><div class="steps-body">${items}</div></details>`;
}

function wireStepControls(root) {
  root.querySelectorAll('[data-skip-tool]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      skipToolCall(btn.dataset.skipTool);
    };
  });
}

async function copyChatAsMarkdown() {
  const conv = state.conv;
  if (!conv || !(conv.messages || []).some((m) => m.role === 'user' || m.role === 'assistant')) {
    toast('Nothing to copy yet');
    return;
  }
  const md = conversationToMarkdown(conv);
  try {
    await navigator.clipboard.writeText(md);
    toast('Chat copied as Markdown');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* blocked */ }
    ta.remove();
    toast(ok ? 'Chat copied as Markdown' : 'Copy failed');
  }
}

// Assistant bubble = an optional "Actions" log + streamed "thinking" + the answer.
function assistantBody(m) {
  let html = '';
  if (m.steps?.length) html += renderSteps(m);
  if (m.thinking) {
    const open = m.pending ? ' open' : '';
    html += `<details class="thinking"${open}><summary>${icon('thinking')} Thinking</summary><div class="thinking-body">${escapeAttr(
      m.thinking,
    )}</div></details>`;
  }
  html += m.content ? renderMarkdown(m.content) : '';
  // Nothing streamed yet → show a live "what's happening" line (spinner + phase +
  // elapsed) instead of a lonely blinking cursor. The 1s activity timer keeps the
  // phase/seconds fresh (see updatePendingBubble), so a slow first token, a long
  // think, or a running tool all read as visible progress.
  if (!html && m.pending) {
    html = '<div class="working"><span class="spinner"></span><span class="working-txt">Working…</span></div>';
  }
  return html;
}

function enhanceCode(bubble) {
  bubble.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent || '');
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    };
    pre.appendChild(btn);
  });
}

// Render the clickable idea chips into the empty-state box.
function paintSuggestions(box, ideas) {
  box.innerHTML = '';
  for (const idea of ideas) {
    const b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = idea;
    b.onclick = () => {
      // The current page is already auto-included via the 🌐 chip — don't
      // attach it again here or we'd send the page twice.
      $('input').value = idea;
      autoGrow();
      $('input').focus();
    };
    box.appendChild(b);
  }
}

// Monotonic token so a slow per-site fetch can't overwrite a newer render.
let suggestRun = 0;

// Toggle the "working on it" state while suggestions are generated: a soft pulse on
// the chips + the trigger button, so the user knows ideas are being tailored.
function setSuggestLoading(on, label) {
  const box = $('empty-suggestions');
  if (box) box.classList.toggle('loading', on);
  const btn = $('suggest-reload');
  if (!btn) return;
  if (on) {
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.classList.add('loading');
    if (btn._label == null) btn._label = btn.innerHTML;
    btn.innerHTML = label || (icon('assist') + ' Tailoring to this page…');
  } else {
    btn.dataset.busy = '0';
    btn.disabled = false;
    btn.classList.remove('loading');
    if (btn._label != null) { btn.innerHTML = btn._label; btn._label = null; }
  }
}

// Explicit "suggest for this page" — works even when auto-suggestions are off, and
// always re-fetches (bypasses the per-origin cache). Guides the user if no model is set.
async function runManualSuggest() {
  if ($('suggest-reload')?.dataset.busy === '1') return;
  const run = ++suggestRun; // invalidate any in-flight auto fetch
  setSuggestLoading(true, icon('assist') + ' Thinking…');
  try {
    const tab = await getActiveTab();
    const { items, source } = await getSuggestions({ tab, settings: state.settings, force: true });
    if (source === 'nomodel') {
      toast('Pick a model under Settings → Tools → Smart suggestions');
    } else if (run === suggestRun && items?.length && !state.conv?.messages?.length) {
      const live = $('empty-suggestions');
      if (live) paintSuggestions(live, items);
    }
  } catch {
    toast('Couldn’t generate suggestions');
  } finally {
    setSuggestLoading(false);
  }
}

function renderSuggestions() {
  const box = $('empty-suggestions');
  if (!box) return;
  // During a live meeting the Live-monitors "Suggest" covers this — skip the generic
  // page-suggestions (and their model call) and keep the empty state hidden.
  if (state.liveMeeting) { $('empty')?.classList.add('hidden'); return; }
  const reload = $('suggest-reload');
  if (reload && !reload._wired) { reload._wired = true; reload.onclick = runManualSuggest; }
  // Zero-setup hint: only when the active target is the in-browser model (hidden once
  // the user switches to a configured API/bridge, so it isn't misleading).
  const hint = $('empty-webllm-hint');
  if (hint) hint.hidden = getTarget(state.settings, state.settings.activeAgentId)?.kind !== 'webllm';
  // Universal fallbacks paint instantly — no model call, works offline.
  paintSuggestions(box, FALLBACK_SUGGESTIONS);
  // Opt-in: replace with page-specific ideas from a small model (metadata only).
  if (!state.settings?.ui?.suggestions?.enabled) return;
  const run = ++suggestRun;
  setSuggestLoading(true); // pulse while we tailor ideas in the background
  (async () => {
    try {
      const tab = await getActiveTab();
      const { items, source } = await getSuggestions({ tab, settings: state.settings });
      // Only paint if this is still the latest request, the chat is still empty,
      // and the user hasn't started typing.
      if (run !== suggestRun || source === 'fallback' || !items?.length) return;
      if (state.conv?.messages?.length || ($('input')?.value || '').trim()) return;
      const live = $('empty-suggestions');
      if (live) paintSuggestions(live, items);
    } catch { /* keep the fallbacks already shown */ } finally {
      if (run === suggestRun) setSuggestLoading(false);
    }
  })();
}

// --------------------------------------------------------------------------
// Sending + streaming
// --------------------------------------------------------------------------
// Conversations currently mid-send (between the click and the stream starting).
// Taken synchronously so a rapid double Enter/click can't fire two requests.
const sendingLock = new Set();

// First-paint readiness: the UI (composer handlers) is wired synchronously up front,
// but a send needs the async init (settings, index, active conversation) to finish.
// send() awaits this so a click/Enter during the cold first-run load WAITS and then
// sends, instead of silently failing on not-yet-initialized state. Resolved at the
// end of init().
let composerReady = false;
let resolveComposerReady;
const composerReadyPromise = new Promise((r) => { resolveComposerReady = r; });
function markComposerReady() { composerReady = true; resolveComposerReady(); }

// WARM tier (opt-in): keep the local gateway's search index in step with local history.
// Debounced so a burst of edits collapses into one push; a no-op unless enabled.
let _warmSyncTimer = null;
// The opt-in warm-search config for query-time fusion, or null when off. Same
// gate as maybeWarmSync — only route to the gateway if the user enabled it.
function warmSearchConfig() {
  const ws = state.settings?.ui?.warmSearch;
  return ws?.enabled && ws.url ? { url: ws.url } : null;
}

function maybeWarmSync({ immediate = false } = {}) {
  const ws = state.settings?.ui?.warmSearch;
  if (!ws?.enabled || !ws.url) return;
  clearTimeout(_warmSyncTimer);
  // Warm sync decrypts the full corpus to build upserts — heavy. Never let it
  // compete with first paint or typing: wait, THEN run it only when the main thread
  // is idle (requestIdleCallback), with a timeout so it still runs on a busy tab.
  _warmSyncTimer = setTimeout(() => {
    // Dynamic import: warm-sync pulls the whole history-rag subgraph, kept off first paint.
    const run = () => import('./js/warm-sync.js')
      .then(({ syncHistoryToGateway }) => syncHistoryToGateway(ws.url))
      .then((r) => { if (r && !r.ok && !r.skipped) console.debug('[chatpanel] warm sync:', r.error); });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 8000 });
    else run();
  }, immediate ? 1500 : 5000);
}

async function send() {
  // If the user hits Send/Enter before the cold first-run init finishes, wait for it
  // rather than throwing on an unset conversation/state (the fresh-install race).
  if (!composerReady) await composerReadyPromise;
  if (dictation?.recording) dictation.stop(); // finish any live dictation before sending
  const input = $('input');
  clearPromptSuggest();
  const raw = input.value.trim();
  // History RAG lives in a heavy subgraph kept off the panel's first paint; load it
  // now that the user is actually sending (module-cached, so this is a one-time cost).
  const { parseHistoryCommand, inferHistoryScopeFromQuery, retrieveHistory } = await import('./js/history-rag.js');
  const historyCommand = parseHistoryCommand(raw);
  if (historyCommand && !historyCommand.query) {
    toast('Type a question after /history');
    return;
  }
  const searchCommand = parseSearchCommand(raw);
  if (/^\/(?:search|web)\b/i.test(raw) && !searchCommand) {
    toast('Type a query after /search');
    return;
  }
  // /monitor <question> · /tldr <focus?> — launch a standing meeting monitor instead
  // of a normal turn (answered + kept fresh in the Live monitors panel).
  const monitorCommand = parseMonitorCommand(raw);
  if (monitorCommand) {
    if (monitorCommand.kind === 'qa' && !monitorCommand.prompt) { toast('Type a question after /monitor'); return; }
    $('input').value = '';
    addMonitor(monitorCommand);
    return;
  }
  const conv = state.conv; // capture: the user may switch chats while this streams
  // Guard BEFORE any await: a second fast Enter would otherwise slip through the
  // gap while we read the page, producing duplicate requests. `sendingLock` covers
  // that race. We deliberately DON'T block when a reply is already streaming —
  // that's how a message gets QUEUED (and, with Stop, how you STEER); see the
  // `queued` branch below.
  if ((!raw && !state.attachments.length) || sendingLock.has(conv.id)) {
    return;
  }
  sendingLock.add(conv.id);
  try {
    // A /command invokes its skill: switch agent, attach its context, and fill
    // {{variables}} — all before the page auto-attach below reads state.usePage.
    // Skills are Pro; on Free the command is sent as literal text with a nudge.
    let text = historyCommand ? historyCommand.query : raw;
    let skillRun = state.pendingSkillRun || null;
    const sk = historyCommand || searchCommand ? null : matchSlashSkill(raw);
    if (sk && !skillsAllowed()) {
      upsell('customSkills');
    } else if (sk) {
      await applySkillPrep(sk.skill);
      skillRun = skillRunFromSkill(sk.skill, { includeMeetings: can(state.license, 'liveMeetings') });
      text = await substituteVars(sk.skill.prompt + (sk.args ? `\n\n${sk.args}` : ''), { args: sk.args });
    }

    // /search <query>: render each enabled engine's SERP + top results in
    // background tabs (JS executes), extract, re-rank, and attach as context. The
    // same query becomes the message, so the model answers it with the results in
    // hand — no tool support required, so it works for every agent.
    if (searchCommand) {
      if (state.settings.ui?.webSearch?.enabled === false) {
        toast('Web search is turned off in Settings');
      } else {
        toast('🔎 Searching the web…');
        await addAttachment(async () => {
          const { captureSearch, webSearchOpts } = await import('./js/web-search.js'); // heavy; only on /search
          return captureSearch(searchCommand.query, webSearchOpts(state.settings, isPro(state.license)));
        });
      }
      // Strip the directive from the sent message; if nothing else remains, the
      // query itself becomes the question the model answers with the results.
      text = searchCommand.cleaned || searchCommand.query;
    }

    const includeMeetingsForHistory = can(state.license, 'liveMeetings');
    const autoHistoryContext = historyCommand ? null : historyContextForMode(state.settings.ui?.historyContextMode, {
      canMeetings: includeMeetingsForHistory,
    });
    const inferredHistoryScope = autoHistoryContext?.enabled
      ? inferHistoryScopeFromQuery(text, { includeMeetings: autoHistoryContext.includeMeetings })
      : 'all';
    const skipLivePageForHistoryIntent = !!historyCommand || (autoHistoryContext?.enabled && inferredHistoryScope !== 'all');

    // Live meeting: if capture is active on this tab, automatically include a FRESH
    // transcript snapshot (read at send time) so the user doesn't have to hit Attach
    // for every question. If the user manually attached a meeting, respect that for
    // this turn instead of replacing it with live context. Skips the generic page-read
    // below (the meeting shell page has no useful text — the transcript IS the context).
    // Live meeting rides along on EVERY message, from any tab, unless excluded —
    // so you never have to navigate to a button to ask about an in-progress call.
    let meetingIncluded = false;
    const hasMeetingAttachment = state.attachments.some((a) => a.kind === 'meeting');
    if (
      can(state.license, 'liveMeetings') &&
      state.liveMeeting &&
      !hasMeetingAttachment &&
      state.excludedMeetingId !== state.liveMeeting.id
    ) {
      try {
        const win = state.settings?.ui?.meetingWindowMin || 0; // 0 = full; N = last N min
        const sinceTs = win ? Date.now() - win * 60_000 : 0;
        // Read the live in-memory transcript at send time (real-time even when the
        // meeting tab is backgrounded), not the throttled persisted copy.
        const rec = await getLiveMeetingRecord();
        if (rec) {
          // Inject BOTH the running summary and the live transcript so the agent
          // answers from up-to-date context. Keep the recent transcript tail if long.
          const transcript = meetingToText(rec, { sinceTs });
          const notes = await getMeetingNotes(state.liveMeeting.id).catch(() => '');
          let body = (notes ? `RUNNING SUMMARY (so far):\n${notes}\n\n` : '') + 'LIVE TRANSCRIPT:\n';
          const cap = 40000;
          const room = Math.max(2000, cap - body.length);
          body += transcript.length > room ? '…' + transcript.slice(-room) : transcript;
          state.attachments = state.attachments.filter((a) => a.kind !== 'meeting');
          state.attachments.unshift({
            id: `mtg_${rec.id}_${Date.now()}`, kind: 'meeting',
            // Cite the meeting INSIDE ChatPanel (by id), not the external call URL —
            // the model echoes this as its source; the link opens the in-panel view.
            title: `🎙 ${rec.title || 'Meeting'} (live)`, url: meetingDeepLink(rec.id),
            text: body, chars: body.length,
          });
          meetingIncluded = true;
        }
      } catch {
        /* no transcript yet — fall through and send without it */
      }
    }

    // Include the current page fresh (read at send time) unless the user turned it
    // off or already attached this exact tab. We DO include it alongside a live
    // meeting (ask about both the page AND the call) — only the meeting tab's own
    // page is skipped (it's just Meet's UI, and the transcript already covers it).
    const onMeetingTab = !!(state.activeTab && meetingPlatform(state.activeTab.url || ''));
    // The page to auto-include: a normal web tab, or one of our own dashboards read
    // from storage (captureTab handles both — inject vs. storage-by-hash-id).
    const pageTab = state.activeTab || state.ownPageTab;
    if (
      !skipLivePageForHistoryIntent &&
      !onMeetingTab &&
      state.usePage &&
      pageTab &&
      !state.attachments.some((a) => a.url === pageTab.url)
    ) {
      try {
        toast('Reading this page…');
        state.attachments.unshift(await captureTab(pageTab.id));
      } catch {
        toast("⚠ Couldn't read this page; sending without it", 2200);
      }
    }

    // Auto-attach any URLs found in the message (the "paste a URL" flow).
    await autoAttachUrls(text);

    let historyRag = null;
    if (historyCommand) {
      const includeMeetings = includeMeetingsForHistory;
      if (!includeMeetings && historyCommand.scope === 'meetings') {
        upsell('liveMeetings', 'Meeting history search is a Pro feature. Use /history chats for chat history.');
        return;
      }
      historyRag = { enabled: true, includeMeetings, scope: historyCommand.scope };
      try {
        const retrieved = await retrieveHistory(text, {
          includeMeetings,
          scope: historyCommand.scope,
          limit: 8,
          maxChars: 12000,
          warm: warmSearchConfig(),
        });
        if (retrieved.results.length) {
          state.attachments.unshift(retrieved.attachment);
        } else {
          toast('No matching local history found', 2200);
        }
      } catch (e) {
        toast(`History search unavailable: ${e.message || e}`, 2800);
      }
    } else {
      if (autoHistoryContext.enabled) {
        historyRag = {
          enabled: true,
          includeMeetings: autoHistoryContext.includeMeetings,
          scope: autoHistoryContext.scope,
        };
        try {
          const retrieved = await retrieveHistory(text, {
            includeMeetings: autoHistoryContext.includeMeetings,
            scope: autoHistoryContext.scope,
            limit: 8,
            maxChars: 12000,
            warm: warmSearchConfig(),
          });
          if (retrieved.results.length) {
            state.attachments.unshift(retrieved.attachment);
          } else {
            toast('No matching local history found', 1800);
          }
        } catch (e) {
          toast(`History search unavailable: ${e.message || e}`, 2800);
        }
      }
    }

    // Final guard: never send the same source twice (e.g. live page + a manual
    // attach of the same tab).
    const seen = new Set();
    const attachments = state.attachments.filter((a) => {
      const key = a.url || a.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const userMsg = {
      id: uid(),
      role: 'user',
      content: text,
      attachments,
      ts: Date.now(),
      mcpMode: normalizeMcpTurnMode(state.settings.ui?.mcpToolsMode),
    };
    if (historyRag) userMsg.historyRag = historyRag;
    if (skillRun) userMsg.skillRun = skillRun;
    const queued = state.streams.has(conv.id); // a reply is already in flight
    userMsg.queued = queued;
    conv.messages.push(userMsg);
    input.value = '';
    autoGrow();
    suggestSuppressed = false;
    $('skill-suggest').classList.add('hidden');
    // Note references are STICKY across turns (a live doc you keep discussing); every
    // other attachment is turn-scoped. The model re-reads the latest via the note tool.
    state.attachments = (state.attachments || []).filter((a) => a.sourceNoteId);
    state.pendingSkillRun = null;
    renderContextBar();

    $('empty').classList.add('hidden');
    $('messages').appendChild(renderMessage(userMsg));
    scrollToBottomNow();
    await saveConversation(conv);
    refreshHistory();

    if (queued) {
      // Queue: the running response picks it up when it finishes. (Hit Stop to
      // answer it now instead — i.e. steer.)
      toast('Queued — sends after the current reply');
      return;
    }

    const agent = agentForConv(conv);
    const assistant = makeAssistant(agent);
    conv.messages.push(assistant);
    $('messages').appendChild(renderMessage(assistant));
    scrollToBottomNow();
    // runStream registers the stream synchronously, so releasing the lock in the
    // finally below safely hands off to the state.streams guard.
    runStream(agent, assistant, conv); // not awaited — keeps other chats usable
  } finally {
    sendingLock.delete(conv.id);
  }
}

function agentForConv(conv) {
  return getTarget(state.settings, conv.agentId || state.settings.activeAgentId);
}

function makeAssistant(agent) {
  return {
    id: uid(),
    role: 'assistant',
    content: '',
    agentId: agent.id,
    agentName: agent.name,
    ts: Date.now(),
    pending: true,
  };
}

// After a response finishes, answer any messages the user queued while it ran.
// Several consecutive queued messages are answered together in one turn.
function maybeDrainQueue(conv) {
  if (state.streams.has(conv.id)) return;
  const last = conv.messages[conv.messages.length - 1];
  if (!last || last.role !== 'user') return;
  for (let i = conv.messages.length - 1; i >= 0 && conv.messages[i].role === 'user'; i--) {
    conv.messages[i].queued = false;
  }
  const agent = agentForConv(conv);
  const assistant = makeAssistant(agent);
  conv.messages.push(assistant);
  if (conv.id === state.conv.id) renderMessages();
  runStream(agent, assistant, conv);
}

// --------------------------------------------------------------------------
// Context compaction — keep long conversations under ANY model's context window
// (local or API). When the model-visible history grows past a budget, summarize
// the older messages with the SAME model and send only that summary (folded into
// the system prompt) + the most recent messages. The on-screen transcript keeps
// every message; only what we SEND the model is bounded.
// --------------------------------------------------------------------------
const COMPACT_AT_TOKENS = 16000; // ~history budget before we summarize (chars/4)
const KEEP_RECENT = 4; // always send the last N messages verbatim
const estTokens = (s) => Math.ceil(String(s || '').length / 4);

function msgTokens(m) {
  let n = estTokens(m.content);
  if (m.attachments) for (const a of m.attachments) n += estTokens(a.text);
  return n;
}

// Real chat messages, dropping the pending assistant placeholder + empties.
function chatMessages(conv, exclude) {
  return conv.messages.filter(
    (m) =>
      m !== exclude &&
      !m.pending &&
      (m.role === 'user' || m.role === 'assistant') &&
      (m.content || m.attachments?.length),
  );
}

// The bounded message list to send the model: everything AFTER the last
// summarized message (or all of them, if no compaction yet).
function messagesForModel(conv, exclude) {
  const all = chatMessages(conv, exclude);
  const c = conv.compaction;
  if (!c) return all;
  const idx = all.findIndex((m) => m.id === c.uptoId);
  return idx >= 0 ? all.slice(idx + 1) : all;
}

// Fold the running summary into the system prompt so the model continues
// seamlessly without us reshuffling message roles (which providers are picky about).
function systemWithSummary(base, conv) {
  if (!conv.compaction?.summary) return base || '';
  const head = base ? `${base}\n\n` : '';
  return `${head}[Summary of the earlier part of this conversation — continue seamlessly; do not mention this summary]\n${conv.compaction.summary}`;
}

// Summarize all but the last `keepRecent` messages (folding in any prior summary)
// and remember it on conv.compaction. Returns true if it compacted.
async function compactNow(conv, resolved, keepRecent) {
  const all = chatMessages(conv);
  if (all.length <= keepRecent + 1) return false; // nothing meaningful to fold
  const fold = all.slice(0, all.length - keepRecent);
  const uptoId = fold[fold.length - 1].id;
  const transcript = fold
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content || '').slice(0, 4000)}`)
    .join('\n\n');
  const prior = conv.compaction?.summary ? `Earlier summary to fold in:\n${conv.compaction.summary}\n\n` : '';
  const sys =
    'You compress a conversation into a compact but COMPLETE summary for continuation. ' +
    'Preserve: the user’s goals, key facts, decisions made, current task/automation state, ' +
    'open questions, and specifics needed to keep going. Terse bullet points. No preamble.';
  if (conv.id === state.conv.id) toast('Compacting earlier conversation…', 1800);
  let summary = '';
  try {
    await streamChat({
      agent: { ...resolved, systemPrompt: sys, maxTokens: 1200, temperature: 0.3 },
      messages: [{ role: 'user', content: `${prior}Summarize the conversation so far:\n\n${transcript}` }],
      settings: state.settings,
      onDelta: (d) => {
        summary += d;
      },
      onEvent: () => {},
    });
  } catch {
    return false; // summarize failed — proceed uncompacted
  }
  if (!summary.trim()) return false;
  conv.compaction = { summary: summary.trim(), uptoId, ts: Date.now() };
  await saveConversation(conv);
  return true;
}

// Soft, pre-emptive: compact when our (rough) estimate exceeds the budget — cheap
// insurance so we usually don't even hit the wall. The hard limit is enforced
// reactively by forceCompact below, which is the authoritative net.
async function maybeCompact(conv, resolved) {
  const visible = messagesForModel(conv);
  const budget = visible.reduce((n, m) => n + msgTokens(m), 0) + estTokens(conv.compaction?.summary);
  if (budget >= COMPACT_AT_TOKENS) await compactNow(conv, resolved, KEEP_RECENT);
}

// Reactive net: the model itself reported the prompt is too long. Compact harder
// (keep fewer recent messages) so the retry fits — works for ANY model/window.
async function forceCompact(conv, resolved) {
  return compactNow(conv, resolved, 2);
}

// Does this error mean "you exceeded the context window"? Patterns span OpenAI,
// Anthropic, and local servers (llama.cpp / Ollama), which all word it differently.
function isContextLimitError(e) {
  return /context.{0,8}(length|window|size)|context_length_exceeded|prompt is too long|too many tokens|maximum context|exceed.{0,20}context|reduce the (length|number|size)|input is too long|token limit|n_ctx|kv cache/i.test(
    e?.message || '',
  );
}

// While the in-browser model downloads on first use (a minute or two, one time), turn
// the wait into an onboarding moment: a live progress bar plus a rotating carousel that
// teaches what the optional Bridge & Gateway unlock — the user's ALREADY-installed
// agents, client-side privacy redaction, on-device speech-to-text, model routing, tools.
const WEBLLM_DOWNLOAD_TIPS = [
  '🔌 **Use the AI agents you already have.** Install the free ChatPanel **Bridge** and chat with **Claude Code, Codex, Gemini CLI** and more — right here, using your existing logins. Nothing to re-configure.',
  '🛡️ **Keep your data private.** Add the **Privacy Gateway** to automatically redact names, emails and secrets *before* they ever reach a cloud model.',
  '🎙️ **Talk instead of type.** The Gateway runs **speech-to-text on your own machine** — dictate chats, notes and meetings, transcribed privately, no audio uploaded.',
  '🔀 **One place, every model.** The Gateway can **route across providers** (and your own keys) for the best cost, speed and quality — without rewiring anything.',
  '🧩 **Give the AI hands.** Connect **MCP tools** so it can search, read the page you’re on, and take actions for you.',
  '🔑 **Want bigger answers?** Add your own API key (many providers have a free tier) in **Settings** to use larger models anytime — the in-browser model always stays available offline.',
];

// paint(md) receives the markdown to show in the pending bubble. Rotates the tip on a
// timer so it advances even when download progress stalls. stop() clears the timer.
function makeDownloadUx(paint) {
  let pct = 0; let status = ''; let tip = 0; let timer = null; let done = false;
  const draw = () => {
    const f = Math.max(0, Math.min(20, Math.round(pct / 5)));
    const bar = '▰'.repeat(f) + '▱'.repeat(20 - f);
    paint(
      `**Setting up your private in-browser AI — ${pct}%**\n\n\`${bar}\`\n\n`
      + (status ? `_${status}_\n\n` : '')          // live WebLLM status (shards / MB fetched) — reassuring on slow machines
      + 'One-time download, then it runs offline on your device. Your chats never leave your machine.\n\n'
      + `**While you wait — optional power-ups:**\n\n${WEBLLM_DOWNLOAD_TIPS[tip % WEBLLM_DOWNLOAD_TIPS.length]}`,
    );
  };
  return {
    progress(ev) {
      if (done) return;
      if (typeof ev?.progress === 'number') pct = Math.round(ev.progress * 100);
      if (ev?.text) status = String(ev.text).replace(/^⏬\s*/, '').replace(/[`_*]/g, '').slice(0, 120);
      if (!timer) { draw(); timer = setInterval(() => { tip += 1; draw(); }, 4500); }
      else draw();
    },
    stop() { done = true; if (timer) { clearInterval(timer); timer = null; } },
  };
}

// Streams a response into `conv` (which may not be the one on screen). UI is only
// touched when conv is the active conversation, so concurrent chats don't fight.
async function runStream(agent, assistant, conv) {
  const controller = new AbortController();
  state.streams.set(conv.id, { controller, started: Date.now(), lastEvent: '' });
  if (conv.id === state.conv.id) updateComposerUI();
  ensureActivityTimer();
  renderActivity();

  let pending = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (conv.id === state.conv.id) {
      updateBubble(assistant);
      scrollToBottom();
    }
  };
  let dl = null; // in-browser model first-use download UX (progress + education carousel)

  // One streaming attempt — rebuilt each call so a retry uses the latest
  // (possibly just-compacted) history + system prompt.
  const runOnce = async () => {
    const resolved = resolveTarget(agent, state.settings);
    const profile = runProfileForTurn(conv, assistant);
    // The in-browser model is tiny — arming tools and the citation/source instructions
    // (written for capable models) sends it into repetition loops. Give it a clean,
    // minimal prompt and no tools; those stay for API/bridge agents.
    const isWebllm = resolved.kind === 'webllm';
    const rawTools = isWebllm ? undefined : await toolsetFor(resolved, profile);
    const tools = isWebllm ? undefined : withToolCancellation(rawTools, assistant, conv);
    // System prompt = the agent's own + (when compacted) the running summary.
    // providers.js appends tools.system once per backend, so keep it out here.
    const systemPrompt = isWebllm
      ? systemWithSummary(resolved.systemPrompt, conv)
      : combineSystemPrompt(
        systemWithSummary(resolved.systemPrompt, conv),
        sourceCitationSystem(),
      );
    // Reversible PII vault is per-conversation, so a placeholder stays stable turn
    // to turn — pass it into the shared redaction capability.
    const { buildRedaction } = await import('./js/turn-tools.js'); // module-cached after first turn
    const redaction = buildRedaction({ settings: state.settings, license: state.license, vault: piiVaultFor(conv.id) });
    await streamChat({
      agent: { ...resolved, systemPrompt },
      messages: messagesForModel(conv, assistant),
      settings: state.settings,
      signal: controller.signal,
      tools,
      redaction,
      onDelta: (d) => {
        if (dl) { dl.stop(); dl = null; } // first real token → tear down the download UX
        pending += d;
        assistant.content = pending; // keep the object current for switch-back
        if (!raf) raf = requestAnimationFrame(flush);
      },
      onEvent: (ev) => {
        // Stream reasoning/thinking text into a collapsible block as it arrives.
        if (ev.type === 'model-load') {
          // First-use in-browser model download/compile (a minute or two, one time).
          // Drive the progress bar + education carousel into the pending bubble until
          // real tokens arrive and take over (onDelta stops it).
          if (!pending) {
            if (!dl) dl = makeDownloadUx((md) => { assistant.content = md; if (!raf) raf = requestAnimationFrame(flush); });
            dl.progress(ev);
          }
        } else if (ev.type === 'reasoning' && ev.text) {
          assistant.thinking = (assistant.thinking || '') + ev.text;
          if (!raf) raf = requestAnimationFrame(flush);
        } else if (ev.type === 'tool' && ev.phase === 'start') {
          // Surface each tool call as a visible "Actions" step — crucial for
          // no-reasoning models, where the bubble is otherwise blank while it works.
          (assistant.steps ||= []).push({ tool: ev.name, callId: ev.callId, input: ev.input });
          if (!raf) raf = requestAnimationFrame(flush);
        } else if (ev.type === 'tool' && ev.phase === 'done' && assistant.steps?.length) {
          const step = ev.callId
            ? assistant.steps.find((s) => s.callId === ev.callId) || assistant.steps[assistant.steps.length - 1]
            : assistant.steps[assistant.steps.length - 1];
          if (ev.image) step.image = ev.image;
          if (ev.status) step.status = ev.status;
          if (ev.result) step.result = ev.result;
          if (ev.image || ev.status || ev.result) {
            if (!raf) raf = requestAnimationFrame(flush);
          }
        }
        recordActivity(conv.id, ev);
      },
    });
  };

  try {
    await maybeCompact(conv, resolveTarget(agent, state.settings)); // soft pre-emptive
    await runOnce();
    assistant.content = pending;
  } catch (e) {
    // Authoritative net: the model itself said the prompt is too long → compact
    // hard and retry once. Model-agnostic (works whatever the context window is).
    if (isContextLimitError(e) && !controller.signal.aborted) {
      try {
        if (conv.id === state.conv.id) toast('Context full — compacting and retrying…', 2400);
        pending = '';
        assistant.thinking = '';
        await forceCompact(conv, resolveTarget(agent, state.settings));
        await runOnce();
        assistant.content = pending;
      } catch (e2) {
        if (e2.name === 'AbortError') assistant.content = pending + (pending ? '\n\n_(stopped)_' : '_(stopped)_');
        else {
          assistant.content = `⚠ ${e2.message}`;
          assistant.error = true;
        }
      }
    } else if (e.name === 'AbortError') {
      assistant.content = pending + (pending ? '\n\n_(stopped)_' : '_(stopped)_');
    } else {
      assistant.content = `⚠ ${e.message}`;
      assistant.error = true;
    }
  } finally {
    if (dl) { dl.stop(); dl = null; } // never leave the download-tip timer running
    if (raf) cancelAnimationFrame(raf);
    assistant.pending = false;
    state.streams.delete(conv.id);
    ensureActivityTimer();
    if (conv.id === state.conv.id) {
      updateComposerUI();
      renderActivity();
      const node = $('messages').querySelector(`.msg[data-id="${assistant.id}"]`);
      if (node) node.replaceWith(renderMessage(assistant));
    }
    await saveConversation(conv);
    refreshHistory();
    maybeAutoTitle(conv).finally(() => maybeExtractConversationTopics(conv).catch(() => {})); // fire-and-forget background metadata
    // Answer anything the user queued while this ran. This also powers "steer":
    // hitting Stop ends the current reply, then the queued message is answered.
    maybeDrainQueue(conv);
  }
}

// Give a conversation a short, meaningful title generated by its OWN model from
// the first exchange — so history search shows "Refactor auth middleware" rather
// than a truncated first question. Runs once per conversation, in the background.
async function maybeAutoTitle(conv) {
  if (conv.autoTitled) return;
  const hasUser = conv.messages.some((m) => m.role === 'user' && m.content);
  const hasReply = conv.messages.some((m) => m.role === 'assistant' && m.content && !m.error);
  if (!hasUser || !hasReply) return;
  conv.autoTitled = true; // set first so concurrent turns don't double-run
  try {
    const target = resolveTarget(getTarget(state.settings, conv.agentId), state.settings);
    const title = await generateTitle(conv, target);
    if (title) conv.title = title;
  } catch {
    /* keep the truncated fallback title */
  }
  await saveConversation(conv).catch(() => {});
  refreshHistory();
}

const topicJobs = new Set();

function topicExtractionConfig() {
  return state.settings?.ui?.topicExtraction || { enabled: true, targetId: '' };
}

function topicTargetId(fallbackId = '') {
  const cfg = topicExtractionConfig();
  return cfg.targetId || fallbackId || state.settings?.activeAgentId || '';
}

function topicTarget(fallbackId = '') {
  const id = topicTargetId(fallbackId);
  const target = getTarget(state.settings, id || state.settings?.activeAgentId);
  return target ? resolveTarget(target, state.settings) : null;
}

async function extractTopicItems(kind, title, text, fallbackId = '') {
  const { fallbackTopicItems, topicExtractionPrompt, parseTopicExtractionResponse } = await import('./js/topic-extraction.js');
  const target = topicTarget(fallbackId);
  if (!target) return { items: fallbackTopicItems(text, 10), fallback: true, targetId: '' };
  let out = '';
  try {
    await streamChat({
      agent: { ...target, systemPrompt: 'Return only valid JSON. Do not include markdown fences.', temperature: 0.2, maxTokens: 500 },
      messages: [{ role: 'user', content: topicExtractionPrompt({ kind, title, text }) }],
      settings: state.settings,
      onDelta: (d) => { out += d; },
      onEvent: () => {},
    });
    const parsed = parseTopicExtractionResponse(out);
    if (parsed.length) return { items: parsed, fallback: false, targetId: target.id || topicTargetId(fallbackId) };
  } catch {
    /* fallback below */
  }
  return { items: fallbackTopicItems(text, 10), fallback: true, targetId: target.id || topicTargetId(fallbackId) };
}

async function maybeExtractConversationTopics(conv) {
  const cfg = topicExtractionConfig();
  if (cfg.enabled === false || !conv?.id) return;
  const { topicSourceTextForConversation, contentHash, shouldExtractTopics, makeTopicIndex } = await import('./js/topic-extraction.js');
  const text = topicSourceTextForConversation(conv);
  if (!text) return;
  const hash = contentHash(text);
  const targetId = topicTargetId(conv.agentId);
  if (!shouldExtractTopics(conv.topics, { hash, targetId, enabled: cfg.enabled !== false })) return;
  const key = `chat:${conv.id}`;
  if (topicJobs.has(key)) return;
  topicJobs.add(key);
  try {
    const { items, fallback, targetId: usedTargetId } = await extractTopicItems('chat', conv.title || 'Chat', text, conv.agentId);
    conv.topics = makeTopicIndex({ hash, targetId: usedTargetId || targetId, items, fallback });
    await saveConversation(conv);
    refreshHistory();
  } finally {
    topicJobs.delete(key);
  }
}

async function maybeExtractMeetingTopics(id) {
  const cfg = topicExtractionConfig();
  if (cfg.enabled === false || !id) return;
  const { contentHash, topicSourceTextForMeeting, insightTopicItemsFromNotes, shouldExtractTopics, makeTopicIndex } = await import('./js/topic-extraction.js');
  const key = `meeting:${id}`;
  if (topicJobs.has(key)) return;
  topicJobs.add(key);
  try {
    const rec = await getMeeting(id);
    if (!rec) return;
    const notes = await getMeetingNotes(id).catch(() => '');
    const text = topicSourceTextForMeeting(rec, notes);
    if (!text) return;
    const hash = contentHash(text);
    const insightTopics = insightTopicItemsFromNotes(notes, 10);
    const targetId = insightTopics.length ? 'insights' : topicTargetId(state.settings?.activeAgentId);
    const existing = await getMeetingTopics(id).catch(() => null);
    if (!shouldExtractTopics(existing, { hash, targetId, enabled: cfg.enabled !== false })) return;
    if (insightTopics.length) {
      await saveMeetingTopics(id, makeTopicIndex({ hash, targetId, items: insightTopics, fallback: false }));
      return;
    }
    const { items, fallback, targetId: usedTargetId } = await extractTopicItems('meeting', rec.title || 'Meeting', text, state.settings?.activeAgentId);
    await saveMeetingTopics(id, makeTopicIndex({ hash, targetId: usedTargetId || targetId, items, fallback }));
  } finally {
    topicJobs.delete(key);
  }
}

function cleanTitle(s) {
  let t = (s || '').trim().split('\n')[0].trim();
  t = t.replace(/^title\s*[:\-]\s*/i, '');
  t = t.replace(/^["'“”«]+|["'“”».]+$/g, '').trim();
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t || null;
}

async function generateTitle(conv, target) {
  if (!target) return null;
  const firstOf = (role) =>
    conv.messages.find((m) => m.role === role && m.content && !m.error)?.content || '';
  const u = firstOf('user').slice(0, 700);
  const a = firstOf('assistant').slice(0, 700);
  if (!u) return null;
  const sys =
    'You create a short, specific title for a chat conversation. Reply with ONLY ' +
    'the title: 3 to 6 words, Title Case, no quotes, no trailing punctuation.';
  const prompt = `Conversation:\n\nUser: ${u}\n\nAssistant: ${a}\n\nTitle:`;
  let out = '';
  await streamChat({
    // Override the system prompt + cap tokens; keep the conversation's model.
    agent: { ...target, systemPrompt: sys, maxTokens: 24, temperature: 0.3 },
    messages: [{ role: 'user', content: prompt }],
    settings: state.settings,
    onDelta: (d) => {
      out += d;
    },
    onEvent: () => {},
  });
  return cleanTitle(out);
}

function stopStream() {
  // If Watch is running on this conversation, Stop halts the WHOLE job — otherwise
  // it would only abort the current tick and the loop would reschedule + fire again.
  // stopWatch hard-aborts the in-flight stream, kills the timer, and logs
  // "👁 Watch stopped" so it's clear both the message and the watcher stopped.
  if (state.watch.on && state.watch.convId === state.conv.id) {
    stopWatch({ hard: true });
    return;
  }
  const s = state.streams.get(state.conv.id);
  if (s) s.controller.abort();
}

async function retryFrom(assistantMsg) {
  if (isActiveStreaming()) return;
  const conv = state.conv;
  const idx = conv.messages.indexOf(assistantMsg);
  if (idx < 0) return;
  // Drop this assistant turn and re-run from the prior user message.
  conv.messages.splice(idx, 1);
  const agent = currentAgent();
  const assistant = {
    id: uid(),
    role: 'assistant',
    content: '',
    agentId: agent.id,
    agentName: agent.name,
    ts: Date.now(),
    pending: true,
  };
  conv.messages.push(assistant);
  renderMessages();
  runStream(agent, assistant, conv);
}

// Edit a previously-sent user message in place: turn the bubble into a textarea
// with Save/Cancel. Saving truncates the conversation after that message and
// re-runs from it (its original attachments are kept).
function editMessage(m) {
  if (isActiveStreaming()) {
    toast('Wait for the current reply to finish, then edit');
    return;
  }
  const bubble = state.bubbles.get(m.id);
  const wrap = bubble?.closest('.msg');
  if (!wrap || wrap.querySelector('.msg-edit')) return;

  const editor = document.createElement('div');
  editor.className = 'msg-edit';
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit-input';
  ta.value = m.content || '';
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };
  const row = document.createElement('div');
  row.className = 'msg-edit-actions';
  row.append(
    miniBtn('Save & resend', () => resendEdited(m, ta.value.trim())),
    miniBtn('Cancel', () => renderMessages()),
  );
  editor.append(ta, row);
  bubble.replaceWith(editor);
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      resendEdited(m, ta.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      renderMessages();
    }
  });
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  grow();
}

async function resendEdited(m, text) {
  if (isActiveStreaming()) return;
  if (!text && !m.attachments?.length) {
    renderMessages();
    return;
  }
  const conv = state.conv;
  const idx = conv.messages.indexOf(m);
  if (idx < 0) return;
  m.content = text;
  m.ts = Date.now();
  m.queued = false;
  // Drop everything AFTER this message — the old reply and any later turns.
  conv.messages.splice(idx + 1);
  const agent = agentForConv(conv);
  const assistant = makeAssistant(agent);
  conv.messages.push(assistant);
  renderMessages();
  scrollToBottomNow();
  await saveConversation(conv);
  refreshHistory();
  runStream(agent, assistant, conv);
}

// Send is ALWAYS available now: a send while a reply streams queues the next
// turn. Stop lives in the activity strip. (Kept as a function since several
// places call it; the composer stop button stays hidden.)
function updateComposerUI() {
  $('btn-send').classList.remove('hidden');
  $('btn-stop').classList.add('hidden');
  renderPageActBtn();
  renderMcpToolsBtn();
  renderHistoryContextBtn();
  renderPrivacyBtn();
}

// Activity strip: latest tool/status for the active stream + elapsed seconds.
function recordActivity(convId, ev) {
  const s = state.streams.get(convId);
  if (!s) return;
  if (ev.type === 'tool') s.lastEvent = `${ev.name || 'tool'}${ev.summary ? ': ' + ev.summary : ''}`;
  else if (ev.type === 'status') s.lastEvent = ev.text || s.lastEvent;
  else if (ev.type === 'reasoning') s.lastEvent = 'Thinking';
  if (convId === state.conv.id) renderActivity();
}

function renderActivity() {
  const strip = $('activity');
  const s = state.streams.get(state.conv.id);
  if (!s) {
    strip.classList.add('hidden');
    return;
  }
  const secs = Math.floor((Date.now() - s.started) / 1000);
  strip.classList.remove('hidden');
  strip.innerHTML = '<span class="spinner"></span>';
  const label = document.createElement('span');
  label.textContent = `${s.lastEvent || 'Working'}… ${secs}s`;
  const stop = document.createElement('button');
  stop.className = 'activity-stop';
  stop.textContent = 'Stop';
  stop.onclick = (e) => {
    e.stopPropagation();
    stopStream();
  };
  strip.append(label, stop);
  updatePendingBubble(s, secs);
}

// Keep the in-bubble working indicator (spinner + phase + elapsed) live while the
// assistant bubble is still empty — so a slow first token reads as visible progress
// right where the user is looking, not just in the activity strip.
function updatePendingBubble(s, secs) {
  const conv = state.conv;
  const m = conv?.messages?.[conv.messages.length - 1];
  if (!m || m.role !== 'assistant' || !m.pending || m.content || m.thinking || m.steps?.length) return;
  const txt = state.bubbles.get(m.id)?.querySelector('.working-txt');
  if (txt) txt.textContent = `${s.lastEvent || 'Working'}… ${secs}s`;
}

let activityInterval = null;
function ensureActivityTimer() {
  if (state.streams.size && !activityInterval) {
    activityInterval = setInterval(renderActivity, 1000);
  } else if (!state.streams.size && activityInterval) {
    clearInterval(activityInterval);
    activityInterval = null;
  }
}

// --------------------------------------------------------------------------
// Context / attachments
// --------------------------------------------------------------------------
// Track which tab the panel is "looking at" so the page chip stays accurate.
async function refreshActiveTab() {
  try {
    const tab = await getActiveTab();
    const http = tab && /^https?:/.test(tab.url || '');
    state.activeTab = http ? { id: tab.id, title: tab.title || tab.url, url: tab.url } : null;
    // Our own dashboard pages (notes/meetings/history) can't be script-read, but we
    // read their record from storage by the URL's hash id (context.js captureOwnPage).
    // Kept SEPARATE from activeTab so it feeds page auto-include + the context chip
    // without arming DOM page-action tools / canvas / meeting probes on our own UI.
    state.ownPageTab =
      !http && tab && isOwnDashboardUrl(tab.url || '')
        ? { id: tab.id, title: tab.title || tab.url, url: tab.url }
        : null;
  } catch {
    state.activeTab = null;
    state.ownPageTab = null;
  }
  renderContextBar();
  renderMeetingBar();
  renderScribeIndicator();
  maybeRefreshSuggestions();
}

// Re-run the empty-state suggestions when the page actually changes (navigation,
// tab switch, window focus) — but only while the chat is empty, and only when the
// URL changed, so we don't flicker on every onUpdated event.
let _suggestUrl = null;
function maybeRefreshSuggestions() {
  if (state.conv?.messages?.length) return;
  const url = state.activeTab?.url || '';
  if (url === _suggestUrl) return;
  _suggestUrl = url;
  renderSuggestions();
}

// Meeting companion status bar. Shown only when the active tab is a recognised
// meeting platform; tells the user whether capture is wired up and lets them
// start/stop/attach the live transcript. Probing the content script is async, so
// a sequence token guards against an older tab's result landing after a newer one.
let _meetingBarSeq = 0;
const MEETING_LABELS = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams', webex: 'Webex' };
// Short names for the scribe brand label ("ChatPanel Zoom Scribe", …).
const MEETING_SHORT = { zoom: 'Zoom', meet: 'Meet', teams: 'Teams', webex: 'Webex' };
// Meetings the user explicitly Stopped — we don't auto-restart these until they
// manually Start again. Keyed by meeting id/key so it survives tab switches.
const _autoStartSuppressed = new Set();

// Rolling-window choices (minutes) for how much transcript rides along each message.
// 0 = the whole meeting so far; positive = last N minutes (cheaper per question).
const MEETING_WINDOWS = [0, 30, 15, 5];
function meetingWindowLabel() {
  const m = state.settings?.ui?.meetingWindowMin || 0;
  return m ? `Last ${m}m` : 'Full';
}
async function cycleMeetingWindow() {
  const cur = state.settings?.ui?.meetingWindowMin || 0;
  const next = MEETING_WINDOWS[(MEETING_WINDOWS.indexOf(cur) + 1) % MEETING_WINDOWS.length];
  state.settings = await updateSettings({ ui: { meetingWindowMin: next } });
  renderMeetingBar();
  toast(`Meeting context: ${meetingWindowLabel()}`);
}

// --------------------------------------------------------------------------
// Live scribe — one running minutes doc, merge-refreshed on an interval.
// --------------------------------------------------------------------------
const LIVE_NOTES_INTERVALS = [0, 2, 3, 5, 10]; // minutes; 0 = off
const liveNotes = {
  key: null, text: '', transcript: '', updatedAt: 0, lastTs: 0,
  busy: false, timer: null, failures: 0, tab: 'summary', title: 'Meeting',
};

function liveNotesIntervalMin() {
  return state.settings?.ui?.liveNotesIntervalMin || 0;
}

async function cycleLiveNotesInterval() {
  const cur = liveNotesIntervalMin();
  const next = LIVE_NOTES_INTERVALS[(LIVE_NOTES_INTERVALS.indexOf(cur) + 1) % LIVE_NOTES_INTERVALS.length];
  state.settings = await updateSettings({ ui: { liveNotesIntervalMin: next } });
  scheduleLiveNotes({ force: true });
  renderMeetingBar();
  toast(next ? `Live notes refreshing every ${next} min` : 'Live notes off');
  if (next && state.activeTab) viewActiveMeeting(state.activeTab.id);
}

function resetLiveNotes() {
  liveNotes.key = null;
  liveNotes.text = '';
  liveNotes.updatedAt = 0;
  liveNotes.lastTs = 0;
  liveNotes.failures = 0;
}

function stopLiveNotes() {
  clearTimeout(liveNotes.timer);
  liveNotes.timer = null;
}

// --------------------------------------------------------------------------
// Live scribe loop — headless & MULTI-MEETING, decoupled from the active tab.
// The content script persists every capturing meeting's transcript to storage
// every ~4s regardless of focus, so the loop summarizes ALL live meetings from
// STORAGE (getMeetingIndex → getMeeting) and saves notes per meeting. This keeps
// the scribe running while you browse other tabs, and handles multiple calls.
// (Names kept so existing callers — init, the meeting bar, the interval cycler —
// keep arming it.) Runs while the side panel is open + a Live interval is set.
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// Phase 2 — stream the scribe's running summary into the chat as ONE self-updating
// card (no extra model calls; it reuses the summary the scribe already produces).
// Opt-in per conversation via the live-meeting chip toggle. The card lives in
// conv.messages with a stable id so each refresh updates it in place.
// --------------------------------------------------------------------------
function liveSummaryCardId(meetingId) { return `live_${meetingId}`; }

function upsertLiveSummaryCard(meetingId, text) {
  const conv = state.conv;
  if (!conv) return;
  const id = liveSummaryCardId(meetingId);
  let m = conv.messages.find((x) => x.id === id);
  if (m) {
    m.content = text; m.ts = Date.now();
    const node = $('messages').querySelector(`[data-id="${id}"]`);
    if (node) node.replaceWith(renderMessage(m));
  } else {
    m = { id, role: 'live-summary', kind: 'live-summary', meetingId, content: text, ts: Date.now() };
    conv.messages.push(m);
    // The card is added out-of-band (not via renderMessages), so hide the generic
    // empty-state ourselves — otherwise its page-suggestions render over the summary.
    $('empty')?.classList.add('hidden');
    $('messages').appendChild(renderMessage(m));
    scrollToBottomNow();
  }
  saveConversation(conv).catch(() => {});
}

function removeLiveSummaryCard(meetingId) {
  const conv = state.conv;
  if (!conv) return;
  const id = liveSummaryCardId(meetingId);
  const i = conv.messages.findIndex((x) => x.id === id);
  if (i < 0) return;
  conv.messages.splice(i, 1);
  $('messages').querySelector(`[data-id="${id}"]`)?.remove();
  // If that was the only message, bring the empty state (and its suggestions) back.
  if (!conv.messages.length) renderMessages();
  saveConversation(conv).catch(() => {});
}

async function toggleLiveSummary() {
  const conv = state.conv;
  if (!conv || !state.liveMeeting) return;
  const mid = state.liveMeeting.id;
  conv.liveSummary = !conv.liveSummary;
  if (conv.liveSummary) {
    const notes = await getMeetingNotes(mid).catch(() => '');
    upsertLiveSummaryCard(mid, notes || '');
    scheduleLiveNotes({ force: true, delayMs: 1500 }); // nudge a fresh summary soon
    toast('Live summary on — updates as the meeting continues');
  } else {
    removeLiveSummaryCard(mid);
    toast('Live summary off');
  }
  await saveConversation(conv).catch(() => {});
  renderContextBar();
}

// --------------------------------------------------------------------------
// Live monitors — standing "goals" answered against the meeting as it progresses.
// kind 'qa' (a question), 'tldr' (running summary, optional focus), or 'skill' (a
// BYO meeting skill's prompt). Each re-runs on a scribe tick WITH new transcript and
// shows in the pinned panel above the composer; stop any one independently. Stored on
// the conversation (conv.monitors) so they survive reload and are per-chat. The cards
// are NOT chat messages, so they never enter the model payload.
// --------------------------------------------------------------------------
let monitorsBusy = false;
// Transient (per panel session) suggested clarifying questions for the active meeting.
const meetingSuggestState = { loading: false, items: [], meetingId: null };

// Generate clarifying questions from the meeting so far (on demand — no auto-spend).
async function suggestMeetingQuestions() {
  if (!state.liveMeeting || meetingSuggestState.loading) return;
  const mid = state.liveMeeting.id;
  meetingSuggestState.loading = true; renderMonitors();
  try {
    const rec = await getLiveMeetingRecord().catch(() => null);
    const transcript = rec ? meetingToText(rec, { sinceTs: 0 }) : '';
    const summary = await getLiveNotesText(mid).catch(() => '');
    const { items, source } = await getMeetingSuggestions({
      meeting: { title: state.liveMeeting.title, summary, transcript },
      settings: state.settings,
    });
    if (source === 'nomodel') toast('Pick a model under Settings → Tools → Smart suggestions');
    else if (!items.length) toast('Nothing to suggest yet — wait for more of the meeting');
    meetingSuggestState.items = items;
    meetingSuggestState.meetingId = mid;
  } catch {
    toast('Couldn’t generate suggestions');
  } finally {
    meetingSuggestState.loading = false;
    renderMonitors();
  }
}

// Skills the user has flagged for meetings (Unit 2 sets the flag; [] until then).
function meetingSkills() {
  return (state.settings?.skills || []).filter((s) => s && s.meeting && s.prompt);
}

function activeMonitors() {
  const conv = state.conv;
  if (!conv || !state.liveMeeting) return [];
  return (conv.monitors || []).filter((m) => m.meetingId === state.liveMeeting.id);
}

// Returns an inline-SVG icon string for a monitor row. Skill monitors may carry a
// user-chosen emoji (m.icon) — map it to an icon when known, else keep the emoji
// escaped so custom glyphs still show. Callers must insert the result as HTML.
function monitorIcon(m) {
  if (m.kind === 'tldr') return icon('pin');
  if (m.kind === 'skill') return iconForEmoji(m.icon) || (m.icon ? escapeAttr(m.icon) : icon('skills'));
  return icon('watch');
}
function monitorLabel(m) {
  if (m.kind === 'tldr') return m.prompt ? `TL;DR — ${m.prompt}` : 'Running TL;DR';
  return m.prompt || m.title || 'Monitor';
}

function renderMonitors() {
  const panel = $('monitors-panel');
  if (!panel) return;
  const show = !!state.liveMeeting && state.excludedMeetingId !== state.liveMeeting?.id && can(state.license, 'liveMeetings');
  panel.classList.toggle('hidden', !show);
  if (!show) { panel.innerHTML = ''; return; }
  panel.innerHTML = '';

  // Two-pane layout: a sticky control row (title + input + quick goals) that never
  // scrolls, over a dedicated scroll list of question cards — so the input stays
  // reachable no matter how many monitors are running.
  const controls = document.createElement('div');
  controls.className = 'mon-controls';
  panel.appendChild(controls);

  const head = document.createElement('div');
  head.className = 'mon-head';
  const title = document.createElement('span');
  title.className = 'mon-title';
  title.innerHTML = icon('watch') + ' Live monitors';
  const refresh = document.createElement('button');
  refresh.className = 'mon-refresh' + (monitorRefreshing ? ' spin' : '');
  refresh.innerHTML = icon('refresh');
  refresh.title = 'Refresh now — pull the latest transcript, update the summary, and re-answer all live (non-paused) monitors';
  refresh.disabled = monitorRefreshing;
  refresh.onclick = () => refreshMonitorsNow();
  head.append(title, refresh);
  controls.appendChild(head);

  // Add-a-question input + quick goals (TL;DR + the user's meeting skills).
  const add = document.createElement('div');
  add.className = 'mon-add';
  const inp = document.createElement('input');
  inp.className = 'mon-input';
  inp.placeholder = 'Ask a question to keep watching as the meeting goes…';
  const addQ = () => { const q = inp.value.trim(); if (q) { inp.value = ''; addMonitor({ kind: 'qa', prompt: q }); } };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addQ(); } };
  const watch = document.createElement('button');
  watch.className = 'mon-add-btn'; watch.textContent = 'Watch'; watch.onclick = addQ;
  add.append(inp, watch);
  const tldr = document.createElement('button');
  tldr.className = 'mon-skill-btn'; tldr.innerHTML = icon('pin') + ' TL;DR';
  tldr.title = 'Keep a running TL;DR'; tldr.onclick = () => addMonitor({ kind: 'tldr', prompt: '' });
  add.appendChild(tldr);
  const suggest = document.createElement('button');
  suggest.className = 'mon-skill-btn';
  suggest.innerHTML = icon('idea') + (meetingSuggestState.loading ? ' …' : ' Suggest');
  suggest.title = 'Suggest clarifying questions from the meeting so far';
  suggest.disabled = meetingSuggestState.loading;
  suggest.onclick = () => suggestMeetingQuestions();
  add.appendChild(suggest);
  for (const sk of meetingSkills()) {
    const b = document.createElement('button');
    b.className = 'mon-skill-btn';
    b.innerHTML = `${iconForEmoji(sk.icon) || (sk.icon ? escapeAttr(sk.icon) : icon('skills'))} ${escapeAttr(sk.name)}`;
    b.title = sk.description || sk.name;
    b.onclick = () => addMonitor({ kind: 'skill', skillId: sk.id, title: sk.name, icon: sk.icon });
    add.appendChild(b);
  }
  controls.appendChild(add);

  // Suggested clarifying questions (generated on demand) — tap to start monitoring one.
  if (meetingSuggestState.items.length && meetingSuggestState.meetingId === state.liveMeeting?.id) {
    const sg = document.createElement('div');
    sg.className = 'mon-suggest';
    for (const q of meetingSuggestState.items) {
      const chip = document.createElement('button');
      chip.className = 'mon-suggest-chip';
      chip.innerHTML = `${icon('idea')} ${escapeAttr(q)}`;
      chip.title = 'Monitor this question';
      chip.onclick = () => {
        meetingSuggestState.items = meetingSuggestState.items.filter((x) => x !== q);
        addMonitor({ kind: 'qa', prompt: q });
      };
      sg.appendChild(chip);
    }
    controls.appendChild(sg);
  }

  // Scroll pane: the running question cards live here so they scroll on their own.
  const list = document.createElement('div');
  list.className = 'mon-list';
  panel.appendChild(list);

  const monitors = activeMonitors();
  const minimized = monitors.filter((m) => m.minimized);
  const expanded = monitors.filter((m) => !m.minimized);

  // Minimized monitors collapse to a compact chips row — click to restore, no state
  // lost. Keeps a busy meeting's panel readable without deleting standing goals.
  if (minimized.length) {
    const row = document.createElement('div');
    row.className = 'mon-min-row';
    for (const m of minimized) {
      const chip = document.createElement('button');
      chip.className = 'mon-chip';
      chip.innerHTML = `${monitorIcon(m)} ${escapeAttr(monitorLabel(m))}`;
      chip.title = 'Restore monitor';
      chip.onclick = () => setMonitorMinimized(m.id, false);
      row.appendChild(chip);
    }
    list.appendChild(row);
  }

  if (!monitors.length) {
    const hint = document.createElement('div');
    hint.className = 'mon-empty';
    hint.textContent = 'Ask a question above to watch this meeting as it goes.';
    list.appendChild(hint);
  }

  for (const m of expanded) {
    const card = document.createElement('div');
    card.className = 'mon-card';
    const h = document.createElement('div');
    h.className = 'mon-card-h';
    const q = document.createElement('span');
    q.className = 'mon-card-q';
    q.innerHTML = `${monitorIcon(m)} ${escapeAttr(monitorLabel(m))}`;
    const t = document.createElement('span');
    t.className = 'mon-card-t';
    t.textContent = m.pending ? 'updating…' : `${cadenceLabel(m)} · ${timeLabel(m.ts)}`;
    // Per-question refresh — re-answer just this one now (works even when paused).
    const ref = document.createElement('button');
    ref.className = 'mon-card-refresh' + (m.pending ? ' spin' : '');
    ref.innerHTML = icon('refresh');
    ref.title = 'Refresh just this answer now';
    ref.disabled = m.pending;
    ref.onclick = () => refreshMonitor(m);
    // Edit — change the question text and/or refresh cadence, then resubmit.
    const ed = document.createElement('button');
    ed.className = 'mon-card-edit' + (editingMonitorId === m.id ? ' on' : '');
    ed.innerHTML = icon('edit'); ed.title = 'Edit question & refresh interval';
    ed.onclick = () => openMonitorEditor(m.id);
    const min = document.createElement('button');
    min.className = 'mon-card-min'; min.innerHTML = icon('chevron-down'); min.title = 'Minimize (keep watching)';
    min.onclick = () => setMonitorMinimized(m.id, true);
    const x = document.createElement('button');
    x.className = 'mon-card-x'; x.innerHTML = icon('close'); x.title = 'Stop monitoring';
    x.onclick = async () => {
      if (await confirmDelete({ title: 'Stop monitoring?', body: monitorLabel(m), confirmLabel: 'Stop & remove' })) closeMonitor(m.id);
    };
    h.append(q, t, ref, ed, min, x);
    card.appendChild(h);
    if (editingMonitorId === m.id) card.appendChild(monitorEditor(m));
    const body = document.createElement('div');
    body.className = 'mon-card-b bubble';
    body.innerHTML = m.answer ? renderMarkdown(m.answer) : `<span class="muted">${m.pending ? 'Answering…' : 'Waiting for the meeting…'}</span>`;
    if (m.answer && !m.pending) enhanceCode(body);
    card.appendChild(body);
    list.appendChild(card);
  }
}

// Preset per-question refresh cadences. everyMin 0 = every scribe update ("Live");
// N = at most every N minutes (when new transcript is available); paused = never auto.
const MONITOR_CADENCES = [
  { v: '0', label: 'Live — every update' },
  { v: '1', label: 'Every 1 min' },
  { v: '2', label: 'Every 2 min' },
  { v: '5', label: 'Every 5 min' },
  { v: '10', label: 'Every 10 min' },
  { v: '15', label: 'Every 15 min' },
  { v: 'paused', label: 'Paused — manual only' },
];

// Short badge for a monitor's current cadence, shown in the card timestamp.
function cadenceLabel(m) {
  if (m.paused) return 'Paused';
  return m.everyMin ? `every ${m.everyMin}m` : 'Live';
}

// Inline editor: edit the question (qa/tldr) + pick a refresh cadence, then resubmit.
// Field values live in monitorEditDraft so a mid-edit re-render preserves them.
function monitorEditor(m) {
  const fresh = !monitorEditDraft || monitorEditDraft.id !== m.id;
  if (fresh) monitorEditDraft = { id: m.id, prompt: m.prompt || '', every: m.paused ? 'paused' : String(m.everyMin || 0) };
  const draft = monitorEditDraft;
  const wrap = document.createElement('div');
  wrap.className = 'mon-edit';
  let input = null;
  if (m.kind !== 'skill') {
    input = document.createElement('input');
    input.className = 'mon-edit-input';
    input.value = draft.prompt;
    input.placeholder = m.kind === 'tldr' ? 'Focus (optional)…' : 'Question to keep answering…';
    input.oninput = () => { draft.prompt = input.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    wrap.appendChild(input);
  }
  const row = document.createElement('div');
  row.className = 'mon-edit-row';
  const lab = document.createElement('span');
  lab.className = 'mon-edit-lab';
  lab.textContent = 'Refresh';
  const sel = document.createElement('select');
  sel.className = 'mon-edit-every';
  for (const c of MONITOR_CADENCES) {
    const o = document.createElement('option');
    o.value = c.v; o.textContent = c.label;
    if (c.v === draft.every) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { draft.every = sel.value; };
  row.append(lab, sel);
  const actions = document.createElement('div');
  actions.className = 'mon-edit-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'mon-add-btn'; saveBtn.textContent = 'Save & run';
  const cancel = document.createElement('button');
  cancel.className = 'mon-skill-btn'; cancel.textContent = 'Cancel';
  cancel.onclick = () => { editingMonitorId = null; monitorEditDraft = null; renderMonitors(); };
  actions.append(saveBtn, cancel);
  wrap.append(row, actions);
  function save() {
    const prompt = input ? draft.prompt.trim() : m.prompt;
    if (m.kind === 'qa' && !prompt) { toast('Type a question to monitor'); return; }
    const val = draft.every;
    applyMonitorEdit(m.id, {
      prompt,
      everyMin: val === 'paused' ? (m.everyMin || 0) : Number(val),
      paused: val === 'paused',
    });
  }
  saveBtn.onclick = save;
  // Focus the field on first open (not on background re-renders, which would steal it).
  if (fresh && input) setTimeout(() => input.focus(), 0);
  return wrap;
}

// Apply an edit and resubmit: update the question + cadence, persist, then re-run
// (unless it was set to Paused — then just save without a fresh call).
function applyMonitorEdit(id, { prompt, everyMin, paused }) {
  const conv = state.conv;
  const m = (conv?.monitors || []).find((x) => x.id === id);
  if (!m) return;
  m.prompt = prompt;
  m.everyMin = Math.max(0, everyMin | 0);
  m.paused = !!paused;
  editingMonitorId = null;
  monitorEditDraft = null;
  renderMonitors();
  saveConversation(conv).catch(() => {});
  persistMonitor(m);
  if (!m.paused) runMonitor(m, { force: true }); // question changed → resubmit even if the transcript hasn't grown
}

async function addMonitor({ kind, prompt = '', skillId = '', title = '', icon = '' }) {
  const conv = state.conv;
  if (!conv) return;
  if (!state.liveMeeting) { toast('No live meeting — start or attach one first'); return; }
  if (!can(state.license, 'liveMeetings')) { upsell('liveMeetings'); return; }
  if (kind === 'qa' && !prompt) { toast('Type a question to monitor'); return; }
  conv.monitors = conv.monitors || [];
  const now = Date.now();
  const m = { id: `mon_${uid()}`, kind, prompt, skillId, title, icon, answer: '', ts: now, createdAt: now, pending: true, minimized: false, paused: false, everyMin: 0, meetingId: state.liveMeeting.id };
  conv.monitors.push(m);
  renderMonitors();
  await saveConversation(conv).catch(() => {});
  persistMonitor(m);
  runMonitor(m);
  scheduleLiveNotes({ force: true, delayMs: 1500 });
}

// Mirror one monitor into the durable, meeting-scoped store (drops the transient
// `pending` flag) so its insight survives a chat switch / restart and is surfaced +
// searchable. Fire-and-forget: the panel already has the live copy in conv.monitors.
function persistMonitor(m) {
  if (!m?.meetingId) return;
  const { pending, ...rec } = m;
  upsertMeetingMonitor(m.meetingId, rec).catch(() => {});
}

// Minimize (keep + collapse to a chip) vs restore — no confirm, state persists.
function setMonitorMinimized(id, minimized) {
  const conv = state.conv;
  const m = (conv?.monitors || []).find((x) => x.id === id);
  if (!m) return;
  m.minimized = !!minimized;
  renderMonitors();
  saveConversation(conv).catch(() => {});
  persistMonitor(m);
}

// Which monitor card is showing its inline editor (question + cadence), or null — plus
// a live draft of its fields so a background re-render (scribe tick) can't wipe typing.
let editingMonitorId = null;
let monitorEditDraft = null; // { id, prompt, every }
function openMonitorEditor(id) {
  editingMonitorId = editingMonitorId === id ? null : id;
  monitorEditDraft = null; // re-seed from the record on next render
  renderMonitors();
}

// Re-answer a SINGLE monitor now — a manual, per-question refresh that runs even if the
// question is paused (an explicit click overrides the freeze, one-off). Skips (with a
// note) when nothing new has been said, so an idle click doesn't burn tokens.
function refreshMonitor(m) {
  if (!m || m.pending) return;
  runMonitor(m).then((r) => { if (r?.skipped) toast('No new transcript since last update', 1600); });
}

// Is a monitor due for an AUTOMATIC (scribe-driven) refresh? Paused ones never are;
// otherwise everyMin is a minimum spacing since the last run (0 = every update).
function monitorDueForAuto(m, now = Date.now()) {
  if (m.paused) return false;
  const every = Math.max(0, m.everyMin | 0);
  if (!every) return true;
  return now - (m.ts || 0) >= every * 60_000;
}

// Close = remove from the live panel but KEEP the record (closed:true) so it can be
// restored after an accidental close or restart. Offers an inline undo.
function closeMonitor(id) {
  const conv = state.conv;
  if (!conv) return;
  const m = (conv.monitors || []).find((x) => x.id === id);
  const mid = m?.meetingId;
  conv.monitors = (conv.monitors || []).filter((x) => x.id !== id);
  renderMonitors();
  saveConversation(conv).catch(() => {});
  if (mid) setMonitorClosed(mid, id, true).catch(() => {});
  if (m) toastAction('Monitor closed', 'Undo', () => restoreMonitor(m), 5000);
}

// Bring a closed/absent monitor back into the live panel.
function restoreMonitor(rec) {
  const conv = state.conv;
  if (!conv || !rec?.id) return;
  conv.monitors = conv.monitors || [];
  if (!conv.monitors.some((x) => x.id === rec.id)) {
    conv.monitors.push({ ...rec, minimized: false, pending: false });
  }
  renderMonitors();
  saveConversation(conv).catch(() => {});
  if (rec.meetingId) setMonitorClosed(rec.meetingId, rec.id, false).catch(() => {});
}

// Restore any active (non-closed) monitors saved for a meeting that aren't already in
// the current conversation — so switching chats or restarting the extension while a
// meeting is live brings the standing monitors back.
async function hydrateMonitorsForMeeting(meetingId) {
  const conv = state.conv;
  if (!conv || !meetingId) return;
  let saved = [];
  try { saved = await getMeetingMonitors(meetingId); } catch { return; }
  if (!saved.length) return;
  conv.monitors = conv.monitors || [];
  const have = new Set(conv.monitors.map((x) => x.id));
  let added = 0;
  for (const rec of saved) {
    if (rec.closed || have.has(rec.id)) continue;
    conv.monitors.push({ ...rec, pending: false });
    added++;
  }
  if (added) { renderMonitors(); saveConversation(conv).catch(() => {}); }
}

// Manual "Refresh now": pull fresh transcript, update the summary, and re-answer every
// monitor immediately instead of waiting for the next scribe tick.
let monitorRefreshing = false;
async function refreshMonitorsNow() {
  const mid = state.liveMeeting?.id;
  if (!mid || monitorRefreshing) return;
  monitorRefreshing = true; renderMonitors();
  try {
    await runLiveNotesTick();                     // new transcript delta + summary refresh
    await runMeetingMonitors(mid, { manual: true }); // re-answer all non-paused now (ignore per-question intervals)
  } catch { /* surfaced per-monitor */ } finally {
    monitorRefreshing = false; renderMonitors();
  }
}

function monitorPrompt(m, summary, transcript) {
  if (m.kind === 'tldr') {
    return [
      'You are maintaining a SHORT running TL;DR of a LIVE meeting'
        + (m.prompt ? `, focused on: ${m.prompt}` : '') + '. 2–5 tight bullets of what matters so far; update as it progresses; never invent.',
      summary && `RUNNING SUMMARY:\n${summary}`,
      `RECENT TRANSCRIPT:\n${transcript}`,
    ].filter(Boolean).join('\n\n');
  }
  if (m.kind === 'skill') {
    const sk = (state.settings?.skills || []).find((s) => s.id === m.skillId);
    return [
      sk?.prompt || 'Summarize the relevant part of this meeting.',
      'Apply the instruction above to the LIVE meeting. The running summary + recent transcript below are your PRIMARY source; you MAY use available tools (web search, history, MCP, etc.) to verify or add context, citing outside sources. Be concise and grounded; say plainly if still unknown; never invent.',
      summary && `RUNNING SUMMARY:\n${summary}`,
      `RECENT TRANSCRIPT:\n${transcript}`,
    ].filter(Boolean).join('\n\n');
  }
  return [
    'You are keeping a SINGLE concise answer to the user’s question up to date as a LIVE meeting progresses. The meeting transcript + running summary below are your PRIMARY source — ground the answer in them and prioritize what was actually said. You MAY use available tools (web search, history, MCP, etc.) to verify or fact-check claims from the meeting and add missing context, citing any outside sources. State what is known so far, flag if still unknown, and never invent.',
    `QUESTION: ${m.prompt}`,
    summary && `RUNNING SUMMARY:\n${summary}`,
    `RECENT TRANSCRIPT:\n${transcript}`,
  ].filter(Boolean).join('\n\n');
}

async function runMonitor(m, { force = false } = {}) {
  const conv = state.conv;
  if (!conv) return { skipped: false };
  const rec = await getLiveMeetingRecord().catch(() => null);
  const latestTs = rec?.segments?.length ? (rec.segments[rec.segments.length - 1]?.t || 0) : 0;
  // No new speech since this question last ran → don't spend tokens re-answering the
  // same transcript. `force` (a just-edited question) overrides. A question with no
  // answer yet always runs.
  if (!force && m.answer && latestTs && latestTs <= (m.lastTranscriptTs || 0)) {
    return { skipped: true };
  }
  m.pending = true; renderMonitors();
  const controller = new AbortController();
  try {
    const transcript = rec ? meetingToText(rec, { sinceTs: Date.now() - 15 * 60_000 }) : '';
    const summary = await getLiveNotesText(m.meetingId).catch(() => '');
    const resolved = resolveTarget(agentForConv(conv), state.settings);
    // Give the monitor the SAME access as a normal chat turn — web search, history,
    // MCP + the live-transcript reader — so it can fact-check / augment the meeting
    // against other sources. Skip only the interactive page-action tools (a
    // background auto-refresh must not pop confirm dialogs or drive the tab).
    const tools = await toolsetFor(resolved, { userText: m.prompt || '', pageTools: false });
    // Redact the transcript/PII before it leaves and restore placeholders on the way
    // back — the reversible per-conversation vault, exactly like chat turns.
    const { buildRedaction } = await import('./js/turn-tools.js'); // module-cached after first turn
    const redaction = buildRedaction({ settings: state.settings, license: state.license, vault: piiVaultFor(conv.id) });
    const systemPrompt = combineSystemPrompt(
      systemWithSummary(resolved.systemPrompt, conv),
      sourceCitationSystem(),
    );
    let out = '';
    await streamChat({
      agent: { ...resolved, systemPrompt },
      messages: [{ role: 'user', content: monitorPrompt(m, summary, transcript) }],
      settings: state.settings,
      signal: controller.signal,
      tools,
      redaction,
      onDelta: (d) => { out += d; },
    });
    m.answer = out.trim();
    m.lastTranscriptTs = latestTs; // watermark: only re-run when the transcript grows past this
  } catch (e) {
    m.answer = `⚠ ${e.message || 'failed'}`;
  } finally {
    m.pending = false;
    m.ts = Date.now();
    renderMonitors();
    saveConversation(conv).catch(() => {});
    persistMonitor(m); // durably snapshot the fresh insight (appends to history)
  }
  return { skipped: false };
}

// Re-run every monitor for a meeting once new transcript has landed (serialized so a
// slow tick can't overlap the next). Called by the scribe loop after it saves.
async function runMeetingMonitors(meetingId, { manual = false } = {}) {
  if (monitorsBusy) return;
  const conv = state.conv;
  // Paused questions are always skipped. Auto (scribe-driven) runs honor each
  // question's cadence (everyMin) so slow ones don't re-run every update; a manual
  // "Refresh now (all)" ignores the interval and re-answers every non-paused question.
  const now = Date.now();
  const mons = (conv?.monitors || []).filter((m) => m.meetingId === meetingId && !m.paused && (manual || monitorDueForAuto(m, now)));
  if (!mons.length) return;
  monitorsBusy = true;
  try { for (const m of mons) await runMonitor(m); }
  finally { monitorsBusy = false; }
}

// Slash launchers: /monitor <question> · /tldr <focus?>
function parseMonitorCommand(raw) {
  const mm = /^\/(monitor|tldr)\b\s*([\s\S]*)$/i.exec(raw || '');
  if (!mm) return null;
  return { kind: mm[1].toLowerCase() === 'tldr' ? 'tldr' : 'qa', prompt: mm[2].trim() };
}

const scribeState = new Map(); // meetingId → { lastTs }
let scribeBusy = false;

// `force` reschedules immediately; otherwise only arms if nothing is pending.
function scheduleLiveNotes({ force = false, delayMs } = {}) {
  const min = liveNotesIntervalMin();
  if (!min) { stopLiveNotes(); return; }
  if (liveNotes.timer && !force) return;
  clearTimeout(liveNotes.timer);
  liveNotes.timer = setTimeout(runLiveNotesTick, delayMs ?? (scribeState.size ? min * 60_000 : 4000));
}

async function runLiveNotesTick() {
  liveNotes.timer = null;
  const min = liveNotesIntervalMin();
  if (!min) return;
  if (scribeBusy) { scheduleLiveNotes({ force: true, delayMs: 15_000 }); return; }
  scribeBusy = true;
  try {
    let index = [];
    try { index = await getMeetingIndex(); } catch { /* none yet */ }
    const live = index.filter((e) => e.status !== 'ended');
    renderScribeIndicator(live);
    for (const e of live) {
      try {
        const rec = await getMeeting(e.id);
        const segs = rec?.segments || [];
        if (!segs.length) continue;
        const st = scribeState.get(e.id) || { lastTs: 0 };
        const latestTs = segs[segs.length - 1]?.t || Date.now();
        // Merge into the evolving LIVE version (not whichever version the user is
        // currently viewing) so regenerating a summary never derails the scribe.
        const prev = await getLiveNotesText(e.id).catch(() => '');
        const isFirst = !prev;
        if (!isFirst && latestTs <= st.lastTs) continue; // nothing new said
        const delta = meetingToText(rec, { sinceTs: isFirst ? 0 : st.lastTs });
        if (!delta.trim()) { st.lastTs = latestTs; scribeState.set(e.id, st); continue; }
        const text = await summarizeMeeting(prev, delta, isFirst, {
          style: state.settings?.ui?.meetingSummaryStyle === 'detailed' ? 'detailed' : 'concise',
        });
        if (text) {
          await saveMeetingNotes(e.id, text);
          maybeExtractMeetingTopics(e.id).catch(() => {});
          if (meetingsView.rec && meetingsView.rec.id === e.id) refreshLiveMeetingView();
          // Phase 2: if this conversation is streaming THIS live meeting's summary,
          // refresh its in-chat card in place (no extra model call — same summary).
          if (state.conv?.liveSummary && state.liveMeeting?.id === e.id) upsertLiveSummaryCard(e.id, text);
          // Live monitors: re-run every standing goal for this meeting on new
          // transcript (token-lean — only here, where the scribe confirmed new content).
          if (state.liveMeeting?.id === e.id) runMeetingMonitors(e.id);
        }
        st.lastTs = latestTs;
        scribeState.set(e.id, st);
      } catch { /* skip this meeting this tick, retry next */ }
    }
  } finally {
    scribeBusy = false;
    scheduleLiveNotes({ force: true });
  }
}

// --------------------------------------------------------------------------
// Watch mode — re-read a FIXED tab on an interval and re-run the agent when the
// page changes, so ChatPanel can act on a live page (e.g. post to Slack on change).
// Mirrors the live-notes loop (setTimeout reschedule + busy guard); each run is a
// SINGLE-SHOT agent call so cost stays bounded. The loop is runtime-only; the
// interval/checkbox/instruction persist in settings.ui.watch.
// --------------------------------------------------------------------------
function watchIntervalLabel(ms) {
  return ms % 60000 === 0 ? `${ms / 60000}m` : `${Math.round(ms / 1000)}s`;
}
// The bridge agent answering this conversation (for the "can it act?" helper).
// BYO API agents have no MCP/skills, so the permission note doesn't apply to them.
function currentBridgeAgent() {
  const id = state.conv.agentId || state.settings.activeAgentId;
  const a = (state.settings.agents || []).find((x) => x.id === id);
  return a && a.kind === 'bridge' ? a : null;
}
function timeLabel(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
// Cheap FNV-1a hash of the captured text — detect change without storing the page.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

async function startWatch({ instruction, intervalMs, onlyWhenChanged }) {
  if (state.watch.on) return;
  if (!can(state.license, 'watch')) { upsell('watch'); return; } // Pro feature
  if (!state.activeTab) { toast('No readable tab to watch'); return; }
  const w = state.watch;
  Object.assign(w, {
    on: true,
    busy: false,
    errored: false,
    tabId: state.activeTab.id,
    tabTitle: state.activeTab.title || state.activeTab.url,
    convId: state.conv.id,
    lastHash: null,
    runs: 0,
    instruction: instruction || '',
    intervalMs: intervalMs || 10000,
    onlyWhenChanged: onlyWhenChanged !== false,
  });
  state.settings = await updateSettings({
    ui: { watch: { intervalMs: w.intervalMs, onlyWhenChanged: w.onlyWhenChanged, instruction: w.instruction } },
  });
  appendWatchLog(`Watching “${w.tabTitle}” every ${watchIntervalLabel(w.intervalMs)}`);
  closeMenus();
  renderWatchButton();
  scheduleWatch({ force: true, delayMs: 0 }); // immediate first run for instant feedback
}

function stopWatch({ reason, hard } = {}) {
  const w = state.watch;
  if (!w.on && !w.timer) return;
  clearTimeout(w.timer);
  w.timer = null;
  const was = w.on;
  w.on = false;
  if (hard) state.streams.get(w.convId)?.controller.abort();
  if (was) appendWatchLog(`Watch stopped${reason ? ' — ' + reason : ''}`);
  renderWatchButton();
}

function scheduleWatch({ force = false, delayMs } = {}) {
  const w = state.watch;
  if (!w.on) { clearTimeout(w.timer); w.timer = null; return; }
  if (w.timer && !force) return;
  clearTimeout(w.timer);
  w.timer = setTimeout(runWatchTick, delayMs ?? w.intervalMs);
}

async function runWatchTick() {
  const w = state.watch;
  w.timer = null;
  if (!w.on) return;
  const conv = state.convCache.get(w.convId) || state.conv;
  // Never overlap a manual send or a still-streaming watch run.
  if (w.busy || state.streams.has(conv.id)) {
    scheduleWatch({ force: true, delayMs: Math.min(w.intervalMs, 5000) });
    return;
  }
  if (w.runs >= w.maxRuns) { stopWatch({ reason: `reached ${w.maxRuns} runs` }); return; }
  w.busy = true;
  try {
    const cap = await captureTab(w.tabId);
    const h = hashText(cap.text || '');
    const first = w.lastHash === null;
    const changed = first || h !== w.lastHash;
    w.lastHash = h;
    if (w.onlyWhenChanged && !changed) {
      appendWatchLog('no change');
      scheduleWatch({ force: true });
      return;
    }
    await runWatchRun(conv, cap, first); // reschedules in runWatchStream's finally
    if (w.errored) stopWatch({ reason: 'stopped on error' });
  } catch (e) {
    appendWatchLog(`⚠ ${e.message || e}`);
    stopWatch({ reason: 'stopped on error' });
  } finally {
    w.busy = false;
  }
}

async function runWatchRun(conv, cap, first) {
  const w = state.watch;
  const instr =
    (w.instruction || 'Briefly report what this page shows now.') +
    (first ? '' : '\n\n(The watched page changed since the last check.)');
  const userMsg = { id: uid(), role: 'user', content: instr, attachments: [cap], ts: Date.now(), watch: true };
  conv.messages.push(userMsg);
  if (conv.id === state.conv.id) $('messages').appendChild(renderMessage(userMsg));
  const agent = agentForConv(conv);
  const assistant = makeAssistant(agent);
  assistant.watch = true;
  assistant.watchAt = Date.now();
  conv.messages.push(assistant);
  if (conv.id === state.conv.id) { $('messages').appendChild(renderMessage(assistant)); scrollToBottom(); }
  w.runs += 1;
  renderWatchButton();
  await runWatchStream(agent, assistant, conv, userMsg);
}

// Fork of runStream(): SINGLE-SHOT messages ([userMsg]) instead of full history, and
// it reschedules the watch loop when the turn ends.
async function runWatchStream(agent, assistant, conv, userMsg) {
  const controller = new AbortController();
  state.streams.set(conv.id, { controller, started: Date.now(), lastEvent: '' });
  if (conv.id === state.conv.id) updateComposerUI();
  ensureActivityTimer();
  renderActivity();

  let pending = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (conv.id === state.conv.id) { updateBubble(assistant); scrollToBottom(); }
  };

  try {
    const resolved = resolveTarget(agent, state.settings);
    await streamChat({
      agent: {
        ...resolved,
        systemPrompt: combineSystemPrompt(resolved?.systemPrompt, sourceCitationSystem()),
      },
      messages: [userMsg], // single-shot: just this tick's instruction + page capture
      settings: state.settings,
      signal: controller.signal,
      onDelta: (d) => {
        pending += d;
        assistant.content = pending;
        if (!raf) raf = requestAnimationFrame(flush);
      },
      onEvent: (ev) => {
        if (ev.type === 'reasoning' && ev.text) {
          assistant.thinking = (assistant.thinking || '') + ev.text;
          if (!raf) raf = requestAnimationFrame(flush);
        }
        recordActivity(conv.id, ev);
      },
    });
    assistant.content = pending;
  } catch (e) {
    if (e.name === 'AbortError') {
      assistant.content = pending + (pending ? '\n\n_(stopped)_' : '_(stopped)_');
    } else {
      assistant.content = `⚠ ${e.message}`;
      assistant.error = true;
      state.watch.errored = true; // the tick will stop the loop
    }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    assistant.pending = false;
    state.streams.delete(conv.id);
    ensureActivityTimer();
    if (conv.id === state.conv.id) {
      updateComposerUI();
      renderActivity();
      const node = $('messages').querySelector(`.msg[data-id="${assistant.id}"]`);
      if (node) node.replaceWith(renderMessage(assistant));
    }
    await saveConversation(conv);
    refreshHistory();
    maybeDrainQueue(conv); // answer anything the user queued mid-watch
    if (state.watch.on && !state.watch.errored) scheduleWatch({ force: true });
  }
}

// A compact, dim log row in the watched conversation (role 'watch' is filtered out
// of every model call by providers.js, so it never leaks into a prompt).
function appendWatchLog(text) {
  const conv = state.convCache.get(state.watch.convId) || state.conv;
  const m = { id: uid(), role: 'watch', kind: 'watch-log', content: text, ts: Date.now() };
  conv.messages.push(m);
  if (conv.id === state.conv.id) { $('messages').appendChild(renderMessage(m)); scrollToBottom(); }
  saveConversation(conv);
}

function renderWatchButton() {
  if (typeof renderRail === 'function') renderRail(); // keep the rail 👁 highlight in sync
  const btn = $('btn-watch');
  if (btn) btn.classList.toggle('watching', state.watch.on);
  const status = $('watch-status');
  if (status) {
    status.classList.toggle('hidden', !state.watch.on);
    if (state.watch.on) {
      status.textContent = `Watching every ${watchIntervalLabel(state.watch.intervalMs)} · ${state.watch.runs} run${state.watch.runs === 1 ? '' : 's'}`;
    }
  }
  const start = $('watch-start');
  const stop = $('watch-stop');
  if (start) start.classList.toggle('hidden', state.watch.on);
  if (stop) stop.classList.toggle('hidden', !state.watch.on);
}

// Reflect the "Act on page" toggle on the composer button.
function renderPageActBtn() {
  const btn = $('btn-pageact');
  if (!btn) return;
  const on = !!state.settings.ui?.pageActions;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function mcpToolsMode() {
  return normalizeMcpTurnMode(state.settings.ui?.mcpToolsMode);
}

function renderMcpToolsBtn() {
  const btn = $('btn-mcp');
  if (!btn) return;
  const mode = mcpToolsMode();
  const titles = {
    [MCP_TURN_MODES.AUTO]: `MCP tools: Auto — arm only the ${DEFAULT_AUTO_TOOL_CAP} most relevant tools per message (faster)`,
    [MCP_TURN_MODES.OFF]: 'MCP tools: Off — never expose MCP tools for chat turns',
    [MCP_TURN_MODES.ON]: 'MCP tools: On — expose all enabled MCP tools for chat turns',
  };
  btn.dataset.mode = mode;
  btn.classList.toggle('active', mode === MCP_TURN_MODES.ON);
  btn.setAttribute('aria-pressed', mode === MCP_TURN_MODES.ON ? 'true' : 'false');
  btn.title = `${titles[mode] || titles[MCP_TURN_MODES.AUTO]} (click to change)`;
  btn.setAttribute('aria-label', titles[mode] || titles[MCP_TURN_MODES.AUTO]);
}

function historyContextMode() {
  return normalizeHistoryContextMode(state.settings.ui?.historyContextMode);
}

function renderHistoryContextBtn() {
  const btn = $('btn-history-context');
  if (!btn) return;
  const canMeetings = can(state.license, 'liveMeetings');
  const mode = historyContextMode();
  const label = historyContextLabel(mode, { canMeetings });
  const active = mode !== HISTORY_CONTEXT_MODES.OFF;
  btn.dataset.mode = mode;
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.title = `${label} (click to choose)`;
  btn.setAttribute('aria-label', label);
}

async function setHistoryContextMode(mode) {
  const normalized = normalizeHistoryContextMode(mode);
  const canMeetings = can(state.license, 'liveMeetings');
  if (normalized === HISTORY_CONTEXT_MODES.MEETINGS && !canMeetings) {
    upsell('liveMeetings', 'Meeting history search is a Pro feature. Chat history is available now.');
    return;
  }
  state.settings = await updateSettings({ ui: { historyContextMode: normalized } });
  renderHistoryContextBtn();
  const label = historyContextLabel(normalized, { canMeetings });
  toast(`🕘 ${label}`, 1800);
}

function renderHistoryContextMenu() {
  const menu = $('history-context-menu');
  const canMeetings = can(state.license, 'liveMeetings');
  const current = historyContextMode();
  const choices = [
    {
      mode: HISTORY_CONTEXT_MODES.OFF,
      icon: '○',
      label: 'Off',
      sub: 'Do not search local history automatically.',
    },
    {
      mode: HISTORY_CONTEXT_MODES.CHATS,
      icon: '💬',
      label: 'Chat history',
      sub: 'Search prior ChatPanel chats for each message.',
    },
    {
      mode: HISTORY_CONTEXT_MODES.MEETINGS,
      icon: '🎙️',
      label: 'Meeting history',
      sub: canMeetings ? 'Search saved meeting transcripts.' : 'Pro: search saved meeting transcripts.',
      locked: !canMeetings,
    },
    {
      mode: HISTORY_CONTEXT_MODES.ALL,
      icon: '🧭',
      label: 'Chats + meetings',
      sub: canMeetings ? 'Search both local history sources.' : 'Chats now; meetings unlock with Pro.',
    },
  ];
  menu.innerHTML = '';
  menu.appendChild(sectionLabel('History context'));
  for (const choice of choices) {
    const item = document.createElement('button');
    item.className = `menu-item${choice.locked ? ' locked' : ''}`;
    const active = current === choice.mode;
    item.innerHTML =
      `<span>${iconForEmoji(choice.icon) || escapeAttr(choice.icon)}</span>` +
      `<span style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">` +
      `<span>${active ? '✓ ' : ''}${escapeAttr(choice.label)}</span>` +
      `<span class="mi-sub">${escapeAttr(choice.sub)}</span>` +
      `</span>` +
      `${choice.locked ? '<span class="badge lock">Pro</span>' : ''}`;
    item.onmousedown = (e) => {
      e.preventDefault();
      closeMenus();
      setHistoryContextMode(choice.mode);
    };
    menu.appendChild(item);
  }
}

// --- Privacy / PII redaction quick control (composer) -----------------------
// Mirrors the full Privacy settings tab so you can flip redaction + detected
// types without leaving the chat. Writes to the SAME ui.piiRedaction settings.
function renderPrivacyBtn() {
  const btn = $('btn-privacy');
  if (!btn) return;
  const mode = state.settings.ui?.piiRedaction?.mode || 'off';
  const active = mode !== 'off';
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  const label = active ? (mode === 'model' ? 'Privacy: redaction on + model detection' : 'Privacy: redaction on') : 'Privacy: redaction off';
  btn.title = `${label} (click to change)`;
  btn.setAttribute('aria-label', label);
}

async function setPiiMode(mode) {
  if (mode === 'model' && !isPro(state.license)) {
    upsell('piiRedaction', '✨ Local-model PII detection is a Pro feature.');
    return;
  }
  const cur = state.settings.ui?.piiRedaction || {};
  state.settings = await updateSettings({ ui: { piiRedaction: { ...cur, mode } } });
  renderPrivacyBtn();
  renderPrivacyMenu();
  schedulePiiPreview(); // mode change flips the preview's visibility/content
  toast(`🛡 Redaction: ${mode === 'off' ? 'off' : mode === 'model' ? 'on + model' : 'on'}`, 1500);
}

async function togglePiiType(key) {
  const cur = state.settings.ui?.piiRedaction || {};
  const det = cur.detection || {};
  const wasOn = det.types?.[key] !== false;
  const types = { ...(det.types || {}), [key]: !wasOn };
  state.settings = await updateSettings({ ui: { piiRedaction: { ...cur, detection: { ...det, types } } } });
  renderPrivacyMenu();
}

// ── Redaction preview — the EXACT outbound text, live above the composer ───────
// View toggle only: the input keeps the real (unredacted) draft, this panel shows
// the placeholders the model will receive. The WIRE is unaffected either way —
// when privacy is on the model always gets the redacted text (streamChat
// chokepoint); this just makes that visible. Uses the same previewRedaction()
// pipeline as the Settings "Test a prompt" button, so it never lies.
let _piiPreviewTimer = null;
let _piiPreviewSeq = 0;

function piiPreviewEnabled() {
  const pii = state.settings?.ui?.piiRedaction || {};
  return pii.preview === true && (pii.mode || 'off') !== 'off';
}

function schedulePiiPreview() {
  const panel = $('redact-preview');
  if (!panel) return;
  if (!piiPreviewEnabled()) { panel.classList.add('hidden'); return; }
  clearTimeout(_piiPreviewTimer);
  _piiPreviewTimer = setTimeout(runPiiPreview, 600); // debounce keystrokes (model detection can be a real call)
}

async function runPiiPreview() {
  const panel = $('redact-preview');
  if (!panel || !piiPreviewEnabled()) return;
  const draft = $('input').value;
  if (!draft.trim()) { panel.classList.add('hidden'); return; }
  const seq = ++_piiPreviewSeq;
  try {
    const { redacted, spans } = await previewRedaction(state.settings, draft);
    if (seq !== _piiPreviewSeq || !piiPreviewEnabled()) return; // stale keystrokes raced us
    let html = escapeAttr(redacted).replace(/\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g, (m) => `<mark>${m}</mark>`);
    // Pseudonyms aren't tokenized — highlight the alias text itself.
    for (const s of spans.filter((x) => x.kind === 'alias')) {
      const alias = escapeAttr(s.token);
      if (alias) html = html.split(alias).join(`<mark>${alias}</mark>`);
    }
    panel.innerHTML = `<span class="rp-head">🛡 What the model receives</span>${html}`;
    panel.classList.remove('hidden');
  } catch { /* best-effort — never block typing on a preview */ }
}

async function togglePiiPreview() {
  const cur = state.settings.ui?.piiRedaction || {};
  state.settings = await updateSettings({ ui: { piiRedaction: { ...cur, preview: cur.preview !== true } } });
  renderPrivacyMenu();
  schedulePiiPreview();
  if (piiPreviewEnabled()) runPiiPreview();
}

function renderPrivacyMenu() {
  const menu = $('privacy-menu');
  if (!menu) return;
  const pii = state.settings.ui?.piiRedaction || {};
  const mode = pii.mode || 'off';
  const pro = isPro(state.license);
  menu.innerHTML = '';
  menu.appendChild(sectionLabel('Redaction'));
  const modes = [
    { mode: 'off', icon: '○', label: 'Off', sub: 'Send text to models unredacted.' },
    { mode: 'deterministic', icon: '🛡', label: 'On — patterns + dictionary', sub: 'Emails, phones, cards, keys + your dictionary.' },
    { mode: 'model', icon: '🧠', label: 'On — + model detection', sub: pro ? 'Also auto-detect names/orgs/etc. via your local detector.' : 'Free trial: auto-detect names/orgs, then patterns + dictionary.', trial: !pro },
  ];
  for (const m of modes) {
    const item = document.createElement('button');
    item.className = `menu-item${m.locked ? ' locked' : ''}`; // trial items stay fully selectable
    const active = mode === m.mode;
    item.innerHTML =
      `<span class="pii-radio${active ? ' on' : ''}"></span>`
      + '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">'
      + `<span>${escapeAttr(m.label)}</span>`
      + `<span class="mi-sub">${escapeAttr(m.sub)}</span>`
      + '</span>'
      + `${m.locked ? '<span class="badge lock">Pro</span>' : m.trial ? '<span class="badge lock">Free trial</span>' : ''}`;
    item.onmousedown = (e) => { e.preventDefault(); setPiiMode(m.mode); };
    menu.appendChild(item);
  }
  // Redaction preview toggle — see the exact outbound (placeholder) text live
  // above the composer while you type/dictate. View-only; the wire is always
  // redacted while a redaction mode is on.
  if (mode !== 'off') {
    const on = pii.preview === true;
    const item = document.createElement('button');
    item.className = 'menu-item toggle';
    item.innerHTML =
      `<span class="pii-box${on ? ' on' : ''}">✓</span>`
      + '<span style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">'
      + '<span>Show what the model sees</span>'
      + '<span class="mi-sub">Live preview of your prompt with PII replaced by placeholders.</span>'
      + '</span>';
    item.onmousedown = (e) => { e.preventDefault(); togglePiiPreview(); };
    menu.appendChild(item);
  }
  // Auto-detect categories. Shown whenever redaction is on — functional in Pro
  // model mode, otherwise a LOCKED preview so Free sees exactly what Pro unlocks.
  if (mode !== 'off') {
    const functional = mode === 'model' && pro;
    const header = sectionLabel('Auto-detect & redact');
    if (!functional) {
      const badge = document.createElement('span');
      badge.className = 'badge lock';
      badge.style.marginLeft = '6px';
      badge.textContent = pro ? 'needs model mode' : 'Pro';
      header.appendChild(badge);
    }
    menu.appendChild(header);
    const types = pii.detection?.types || {};
    const cats = [
      { key: 'person', label: 'People (names)' },
      { key: 'org', label: 'Organizations' },
      { key: 'location', label: 'Locations (cities, places)' },
      { key: 'number', label: 'Numbers & IDs' },
    ];
    for (const c of cats) {
      const on = functional ? types[c.key] !== false : true; // preview shows all on
      const item = document.createElement('button');
      item.className = `menu-item toggle${functional ? '' : ' locked'}`;
      item.innerHTML = `<span class="pii-box${on ? ' on' : ''}">✓</span><span style="flex:1;min-width:0">${escapeAttr(c.label)}</span>`;
      item.onmousedown = (e) => {
        e.preventDefault();
        if (functional) togglePiiType(c.key);
        else if (!pro) upsell('piiRedaction', '✨ Auto-detect names, orgs & locations is a Pro feature.');
        else setPiiMode('model');
      };
      menu.appendChild(item);
    }
    const note = document.createElement('div');
    note.className = 'menu-note';
    note.textContent = functional
      ? 'Emails & phones always redact.'
      : pro ? 'Turn on “+ model detection” to auto-detect these.'
        : 'Pro: auto-detect names/orgs/locations with a local model — no dictionary needed.';
    menu.appendChild(note);
  }
  const more = document.createElement('button');
  more.className = 'menu-item';
  more.innerHTML = `<span>${icon('settings')}</span><span style="flex:1;min-width:0">Privacy settings…</span>`;
  more.onmousedown = (e) => {
    e.preventDefault();
    closeMenus();
    // Deep-link straight to the Privacy tab (settings.js honors the #hash on load);
    // openOptionsPage() can't carry a hash, so it would land on the last tab.
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#privacy') });
  };
  menu.appendChild(more);
}

async function setMcpToolsMode(mode) {
  const normalized = normalizeMcpTurnMode(mode);
  state.settings = await updateSettings({ ui: { mcpToolsMode: normalized } });
  renderMcpToolsBtn();
  const label =
    normalized === MCP_TURN_MODES.AUTO ? 'Auto — most relevant tools only'
      : normalized === MCP_TURN_MODES.OFF ? 'Off'
        : 'On — all enabled tools';
  toast(`🔌 MCP tools: ${label}`, 1600);
}

// A pick-a-mode menu (Off / Auto / On) anchored to the MCP button — same pattern as
// the History context menu, so the three modes are discoverable with descriptions
// instead of a blind click-to-cycle.
function renderMcpToolsMenu() {
  const menu = $('mcp-tools-menu');
  if (!menu) return;
  const current = mcpToolsMode();
  const choices = [
    { mode: MCP_TURN_MODES.OFF, icon: '○', label: 'Off', sub: 'Never expose MCP tools for chat turns.' },
    { mode: MCP_TURN_MODES.AUTO, icon: '⚖️', label: 'Auto', sub: `Arm only the ${DEFAULT_AUTO_TOOL_CAP} most relevant tools each message (faster).` },
    { mode: MCP_TURN_MODES.ON, icon: '🔌', label: 'On', sub: 'Expose all enabled MCP tools every message.' },
  ];
  menu.innerHTML = '';
  menu.appendChild(sectionLabel('MCP tools'));
  for (const choice of choices) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    const active = current === choice.mode;
    item.innerHTML =
      `<span>${iconForEmoji(choice.icon) || escapeAttr(choice.icon)}</span>` +
      `<span style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">` +
      `<span>${active ? '✓ ' : ''}${escapeAttr(choice.label)}</span>` +
      `<span class="mi-sub">${escapeAttr(choice.sub)}</span>` +
      `</span>`;
    item.onmousedown = (e) => {
      e.preventDefault();
      closeMenus();
      setMcpToolsMode(choice.mode);
    };
    menu.appendChild(item);
  }
}

function renderWatchMenu() {
  const cfg = (state.settings.ui && state.settings.ui.watch) || {};
  const ms = state.watch.on ? state.watch.intervalMs : cfg.intervalMs || 10000;
  const unit = ms % 60000 === 0 && ms >= 60000 ? 60000 : 1000;
  const nEl = $('watch-interval-n');
  const unitEl = $('watch-interval-unit');
  if (nEl) nEl.value = String(Math.max(1, Math.round(ms / unit)));
  if (unitEl) unitEl.value = String(unit);
  const changed = $('watch-changed');
  if (changed) changed.checked = state.watch.on ? state.watch.onlyWhenChanged : cfg.onlyWhenChanged !== false;
  const instr = $('watch-instruction');
  if (instr) instr.value = state.watch.on ? state.watch.instruction : cfg.instruction || '';
  renderWatchPerm();
  renderWatchButton();
}

// Inline permission helper: a watch agent can only post to Slack/MCP, edit, or run
// shell if its mode is bypassPermissions — otherwise the action is auto-cancelled
// in headless mode. Make that one click instead of a buried Settings trip.
function renderWatchPerm() {
  const el = $('watch-perm');
  if (!el) return;
  const agent = currentBridgeAgent();
  if (!agent) { el.className = 'watch-perm-note'; el.textContent = ''; return; } // BYO API: N/A
  el.innerHTML = '';
  if (agent.permissionMode === 'bypassPermissions') {
    el.className = 'watch-perm-note ok';
    el.textContent = `✓ “${agent.name}” can take actions (Slack/MCP, edits, shell).`;
    return;
  }
  el.className = 'watch-perm-note warn';
  el.append(`⚠ “${agent.name}” can read the page but won't post to Slack/MCP or act until allowed. `);
  const btn = document.createElement('button');
  btn.className = 'watch-btn';
  btn.textContent = 'Allow this agent to act';
  btn.onclick = async () => {
    agent.permissionMode = 'bypassPermissions';
    state.settings = await updateSettings({ agents: state.settings.agents });
    renderWatchPerm();
    toast('Agent can now take actions');
  };
  el.appendChild(btn);
}

// --------------------------------------------------------------------------
// Past Meetings — list + reopen recorded meetings (transcript + saved AI summary).
// Reuses the scribe drawer styles; its own state so a live meeting never conflicts.
// --------------------------------------------------------------------------
const meetingsView = { rec: null, notes: '', tab: 'summary', generating: false, live: false, liveTimer: null, searchToken: 0, mode: 'smart' };
const PLATFORM_ICON = { zoom: '🟦', meet: '🟩', teams: '🟪', webex: '🟧' };

async function openMeetings() {
  if (!can(state.license, 'liveMeetings')) return upsell('liveMeetings'); // Pro — covers all entry points
  $('meetings-drawer').classList.remove('hidden');
  sizeDrawers();
  $('meeting-view').classList.add('hidden');
  $('meetings-list-view').classList.remove('hidden');
  $('meetings-search').value = '';
  await renderMeetingsList('');
}
function closeMeetings() { clearInterval(meetingsView.liveTimer); $('meetings-drawer').classList.add('hidden'); renderRail(); }

// On Chrome's side panel a freshly-shown position:absolute drawer opened blank/near-zero
// width — its `width:88%` didn't resolve until the user dragged the resize handle, which
// sets an EXPLICIT pixel width via applyDrawerWidth(). So do that ourselves on open: give
// the drawers a concrete px width (saved, or a sensible default) so they lay out and paint
// immediately. Re-tries on the next frame if the panel hasn't been measured yet.
function sizeDrawers() {
  const panelW = Math.round(($('panel-body') || document.body).getBoundingClientRect().width);
  if (panelW <= 1) { requestAnimationFrame(sizeDrawers); return; }
  const saved = parseInt(localStorage.getItem(DRAWER_WIDTH_KEY) || '', 10);
  const target = saved > 0
    ? Math.min(saved, panelW)
    : Math.min(380, Math.max(DRAWER_MIN_W, Math.round(panelW * 0.88)));
  applyDrawerWidth(target);
}

async function renderMeetingsList(query) {
  const list = $('meetings-list');
  const token = ++meetingsView.searchToken;
  let index = [];
  try { index = await getMeetingIndex(); } catch { /* none */ }
  const q = (query || '').trim();
  const details = new Map();
  if (q) {
    await Promise.all(index.map(async (e) => {
      const [rec, notes] = await Promise.all([
        getMeeting(e.id).catch(() => null),
        getMeetingNotes(e.id).catch(() => ''),
      ]);
      details.set(e.id, { rec, notes });
    }));
  }
  if (token !== meetingsView.searchToken) return;
  index = rankMeetingEntries(index, q, details, { mode: meetingsView.mode });
  if (!index.length) {
    list.innerHTML = q
      ? '<div class="empty-notes">No meetings match that search.</div>'
      : '<div class="empty-notes">No meetings yet. Join a Zoom/Meet/Teams/Webex call with captions on and ChatPanel records the transcript.</div>';
    return;
  }
  list.innerHTML = '';
  for (const e of index) {
    const live = e.status !== 'ended';
    const dur = e.endedAt && e.startedAt ? Math.round((e.endedAt - e.startedAt) / 60000) : 0;
    const meta = [relAgo(e.endedAt || e.startedAt), dur ? `${dur}m` : '', `${e.lines || 0} lines`, live ? '· live' : '']
      .filter(Boolean).join(' · ');
    const row = document.createElement('div');
    row.className = 'meeting-row';
    const main = document.createElement('button');
    main.className = 'meeting-row-main';
    main.innerHTML =
      `<div class="meeting-row-title">${PLATFORM_ICON[e.platform] || '🎙'} ${escHtml(e.title || 'Meeting')}</div>` +
      `<div class="meeting-row-meta">${escHtml(meta)}</div>`;
    main.onclick = () => openStoredMeeting(e.id);
    const del = miniBtn('✕', async () => {
      if (!(await confirmDelete({
        title: 'Delete this meeting?',
        body: `“${e.title || 'Meeting'}” and its transcript & summaries will be permanently removed. This can’t be undone.`,
        confirmLabel: 'Delete meeting',
      }))) return;
      await deleteMeeting(e.id);
      renderMeetingsList($('meetings-search').value);
      toast('Meeting deleted');
    });
    del.title = 'Delete meeting';
    del.className = 'mini-btn meeting-row-del';
    row.appendChild(main);
    row.appendChild(del);
    list.appendChild(row);
  }
}

// Citation link for a meeting → opens it INSIDE ChatPanel by id (the in-panel
// meetings view), not the external call URL. The markdown-link handler intercepts it.
function meetingDeepLink(id) {
  try { return chrome.runtime.getURL(`meetings.html#${encodeURIComponent(id)}`); }
  catch { return ''; }
}

async function openMeetingFromLink(id) {
  $('meetings-drawer')?.classList.remove('hidden');
  renderRail();
  try { await openStoredMeeting(id); } catch { toast('Meeting not found'); }
}

async function openStoredMeeting(id) {
  const rec = await getMeeting(id);
  if (!rec) { toast('Meeting not found'); return; }
  clearInterval(meetingsView.liveTimer);
  meetingsView.rec = rec;
  await loadMeetingVersions();
  meetingsView.generating = false;
  meetingsView.live = rec.status !== 'ended';
  $('meeting-view-title').textContent =
    `${PLATFORM_ICON[rec.platform] || '🎙'} ${rec.title || 'Meeting'}${meetingsView.live ? ' · live' : ''}`;
  $('meetings-list-view').classList.add('hidden');
  $('meeting-view').classList.remove('hidden');
  // "Sync now" only makes sense for a still-live meeting (pull the latest transcript
  // from its tab without switching to it).
  $('meeting-sync')?.classList.toggle('hidden', !meetingsView.live);
  switchMeetingTab('summary');
  // Live meeting → keep the view fresh (transcript + summary) while open.
  if (meetingsView.live) meetingsView.liveTimer = setInterval(refreshLiveMeetingView, 5000);
}

// Re-read the currently-viewed live meeting from storage and re-render (called on a
// timer while viewing a live meeting, and by the scribe loop right after it saves).
async function refreshLiveMeetingView() {
  const cur = meetingsView.rec;
  if (!cur) return;
  // For the live meeting, read the FRESH in-memory record (real-time even when its
  // tab is backgrounded); else the persisted record.
  const rec =
    state.liveMeeting && state.liveMeeting.id === cur.id
      ? (await getLiveMeetingRecord()) || (await getMeeting(cur.id))
      : await getMeeting(cur.id);
  if (!rec) return;
  meetingsView.rec = rec;
  if (!meetingsView.generating) await loadMeetingVersions();
  meetingsView.live = rec.status !== 'ended';
  if (meetingsView.tab === 'transcript') renderMeetingTranscript();
  else if (!meetingsView.generating) renderMeetingSummary();
  setMeetingViewStatus();
  if (!meetingsView.live) clearInterval(meetingsView.liveTimer);
}

// Get the FRESHEST record for the live meeting. Background tabs throttle the
// content script's storage flush, so the persisted record lags — but the in-memory
// buffer (read via a message to the tab, which works even when backgrounded) is
// real-time. Find the meeting's tab and read it live; fall back to storage.
async function getLiveMeetingRecord() {
  if (!state.liveMeeting) return null;
  const id = state.liveMeeting.id;
  const tryTab = async (tabId) => {
    if (tabId == null) return null;
    try { const r = await getMeetingRecord(tabId); return r && r.id === id ? r : null; } catch { return null; }
  };
  let rec = await tryTab(state.liveMeeting.tabId); // cached from a prior lookup
  if (!rec) {
    try {
      const tabs = await listTabs({ currentWindowOnly: false }); // meeting may be in another window
      for (const t of tabs) {
        if (!meetingPlatform(t.url || '')) continue;
        const r = await getMeetingRecord(t.id);
        if (r && r.id === id) { rec = r; state.liveMeeting.tabId = t.id; break; }
      }
    } catch { /* fall through */ }
  }
  if (!rec) rec = await getMeeting(id); // last resort: persisted (may lag when backgrounded)
  return rec;
}

// "View" on the meeting bar → open the active tab's meeting in the unified viewer.
async function viewActiveMeeting(tabId) {
  const rec = await getMeetingRecord(tabId);
  if (!rec?.id) { toast('No transcript captured yet'); return; }
  $('meetings-drawer').classList.remove('hidden');
  await openStoredMeeting(rec.id);
}

function attachMeetingToChat(rec, notes = '') {
  state.attachments = state.attachments || [];
  state.attachments = upsertMeetingChatAttachment(state.attachments, rec, notes);
  closeMeetings();
  renderContextBar();
  $('input').focus();
  toast('Meeting attached — ask your question');
}

async function attachStoredMeetingToChat(id) {
  if (!can(state.license, 'liveMeetings')) { upsell('liveMeetings'); return; }
  const rec = await getMeeting(id);
  if (!rec) { toast('Meeting not found'); return; }
  const notes = await getMeetingNotes(id).catch(() => '');
  attachMeetingToChat(rec, notes);
}

// Attach a note as chat context (handoff from the Notes page "Ask" button). Reuses
// the generic 'page' attachment kind, so context-building + the context bar just work.
async function attachStoredNoteToChat(id) {
  const { getNote, noteToMarkdown } = await import('./js/store-notes.js');
  const note = await getNote(id);
  if (!note) { toast('Note not found'); return; }
  // A LIVE reference: the current snapshot for immediacy, plus the note id + an
  // instruction so the model re-reads the latest with history_get_source and
  // correlates with related notes/chats/meetings via history_search on every turn.
  const body = noteToMarkdown(note).slice(0, 40000);
  const text =
    `The user is working in their note "${note.title || 'Note'}" (source id: note:${id}). It is LIVE — to read its current content on any turn (it may have changed), call history_get_source with sourceId "note:${id}". Use history_search to find related notes, chats and meetings. Current snapshot:\n\n${body}`;
  state.attachments = (state.attachments || []).filter((a) => a.sourceNoteId !== id);
  state.attachments.push({
    id: `note_${id}_${Date.now()}`,
    kind: 'page',
    title: `📝 ${note.title || 'Note'}`,
    url: chrome.runtime.getURL(`notes.html#${encodeURIComponent(id)}`),
    text,
    chars: text.length,
    sourceNoteId: id,
  });
  renderContextBar();
  $('input')?.focus();
  toast('Note attached (live) — ask away; it stays for follow-ups');
}

// Attach the viewed meeting's transcript as context and focus the composer, so the
// user can ask about it from ANY tab.
function askAboutMeeting() {
  const rec = meetingsView.rec;
  if (!rec) return;
  attachMeetingToChat(rec, meetingsView.notes || '');
}

// Slim "N meetings recording" strip, shown from any non-meeting tab.
async function renderScribeIndicator(liveOpt) {
  let live = liveOpt;
  if (!live) {
    try { live = (await getMeetingIndex()).filter((e) => e.status !== 'ended'); } catch { live = []; }
  }
  // Finalize a "zombie": a live entry whose heartbeat (persistedAt) went stale. The
  // service worker now keeps persistedAt FRESH during a live call by pinging the
  // capturing tab every ~30s (even backgrounded/silent), and it flips a meeting to
  // 'ended' the moment inCall() goes false (leave/hangup control gone) or the tab
  // closes/navigates — so this 90s window is purely the transient-disconnect grace /
  // last-resort net for a crashed tab, NOT the primary ender. (Do NOT tie liveness to
  // "tab still open": a left-but-still-on-the-URL call must stop, not linger.)
  const now = Date.now();
  const ZOMBIE_MS = 90_000;
  const fresh = [];
  for (const e of live) {
    if (e.persistedAt && now - e.persistedAt < ZOMBIE_MS) fresh.push(e);
    else markMeetingEnded(e.id).then(() => maybeExtractMeetingTopics(e.id)).catch(() => {});
  }
  live = fresh;

  // Cache the most-recent live meeting so it can auto-attach + show a context chip
  // from ANY tab. When it starts/changes/ends, refresh the context bar.
  const top = [...live].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  const prevId = state.liveMeeting && state.liveMeeting.id;
  const prevTabId = state.liveMeeting && state.liveMeeting.tabId;
  state.liveMeeting = top ? { id: top.id, title: top.title, tabId: top.id === prevId ? prevTabId : undefined } : null;
  if ((state.liveMeeting && state.liveMeeting.id) !== prevId) {
    renderContextBar();
    // A different meeting just became the live one (start / attach / boot) — restore any
    // active monitors saved for it that aren't in this conversation yet.
    if (state.liveMeeting?.id) hydrateMonitorsForMeeting(state.liveMeeting.id);
  }

  const el = $('scribe-indicator');
  if (!el) return;
  const onMeetingTab = state.activeTab && meetingPlatform(state.activeTab.url || '');
  if (live.length && !onMeetingTab) {
    el.classList.remove('hidden');
    el.innerHTML = `${icon('mic')} ${live.length} meeting${live.length === 1 ? '' : 's'} recording — view`;
  } else {
    el.classList.add('hidden');
  }
}

function meetingBackToList() {
  clearInterval(meetingsView.liveTimer);
  $('meeting-view').classList.add('hidden');
  $('meetings-list-view').classList.remove('hidden');
  renderMeetingsList($('meetings-search').value);
}

// --------------------------------------------------------------------------
// Right icon rail — a pluggable home for panes (Meetings, Watch; future: Skills,
// graph-viz). Add a pane with registerPane({ id, icon, title, open, isOpen, pro? }).
// --------------------------------------------------------------------------
const RAIL_PANES = [
  { id: 'meetings', icon: '👥', label: 'Meet', title: 'Meetings — live & past', pro: 'liveMeetings', open: openMeetings,
    isOpen: () => !$('meetings-drawer').classList.contains('hidden') },
  { id: 'watch', icon: '👁', label: 'Watch', title: 'Watch this page & act', pro: 'watch', open: openWatchPane,
    isOpen: () => !$('watch-menu').classList.contains('hidden') },
];
function registerPane(p) { RAIL_PANES.push(p); renderRail(); }

function safePaneOpen(p) { try { return p.isOpen ? p.isOpen() : false; } catch { return false; } }
function closePane(p) {
  if (p.id === 'meetings') closeMeetings();
  else if (p.id === 'watch') $('watch-menu').classList.add('hidden');
  else if (p.close) p.close();
}
function renderRail() {
  const rail = $('rail');
  if (!rail) return;
  rail.innerHTML = '';
  for (const p of RAIL_PANES) {
    const btn = document.createElement('button');
    const active = safePaneOpen(p) || (p.id === 'watch' && state.watch.on); // 👁 stays lit while watching
    btn.className = 'rail-btn' + (active ? ' active' : '');
    const ico = document.createElement('span');
    ico.className = 'rail-ico';
    const railSvg = iconForEmoji(p.icon);
    if (railSvg) ico.innerHTML = railSvg; else ico.textContent = p.icon;
    btn.appendChild(ico);
    if (p.label) {
      const lab = document.createElement('span');
      lab.className = 'rail-label';
      lab.textContent = p.label;
      btn.appendChild(lab);
    }
    btn.title = p.title;
    btn.onclick = (e) => {
      e.stopPropagation(); // don't let the body click close the popover we just opened
      if (p.pro && !can(state.license, p.pro)) return upsell(p.pro); // Pro-gated pane
      if (safePaneOpen(p)) closePane(p);
      else { RAIL_PANES.forEach((q) => q !== p && safePaneOpen(q) && closePane(q)); p.open(); }
      renderRail();
    };
    rail.appendChild(btn);
  }
}
function openWatchPane() {
  if (!can(state.license, 'watch')) return upsell('watch');
  closeMenus();
  renderWatchMenu();
  $('watch-menu').classList.remove('hidden');
}
function toggleRail() {
  const collapsed = document.body.classList.toggle('rail-collapsed');
  const t = $('rail-toggle');
  if (t) {
    t.textContent = collapsed ? '›' : '‹';
    t.title = collapsed ? 'Show panel rail' : 'Collapse panel rail';
  }
  updateSettings({ ui: { railCollapsed: collapsed } }).then((s) => (state.settings = s)).catch(() => {});
}

function switchMeetingTab(tab) {
  meetingsView.tab = tab;
  const isT = tab === 'transcript';
  const isM = tab === 'monitors';
  $('mv-tab-summary').classList.toggle('active', tab === 'summary');
  $('mv-tab-transcript').classList.toggle('active', isT);
  $('mv-tab-monitors')?.classList.toggle('active', isM);
  $('meeting-summary').classList.toggle('hidden', tab !== 'summary');
  $('meeting-transcript').classList.toggle('hidden', !isT);
  $('meeting-monitors')?.classList.toggle('hidden', !isM);
  $('meeting-search').classList.toggle('hidden', !isT);
  if (isT) renderMeetingTranscript();
  else if (isM) renderMeetingMonitors();
  else renderMeetingSummary();
  setMeetingViewStatus();
}

// Monitors tab: the standing questions + latest insights saved for this meeting,
// pulled from the durable meeting-scoped store (so they show even after the chat that
// created them is gone). Closed monitors can be re-opened from here.
async function renderMeetingMonitors() {
  const body = $('meeting-monitors');
  if (!body || !meetingsView.rec) return;
  body.innerHTML = '<div class="muted" style="padding:8px 2px">Loading…</div>';
  let items = [];
  try { items = await getMeetingMonitors(meetingsView.rec.id); } catch { /* none */ }
  if (!items.length) {
    body.innerHTML = '<div class="muted" style="padding:8px 2px">No live-monitor questions were saved for this meeting.</div>';
    return;
  }
  // Active first, then closed; newest updated first within each group.
  items.sort((a, b) => (a.closed === b.closed ? (b.updatedAt || 0) - (a.updatedAt || 0) : a.closed ? 1 : -1));
  body.innerHTML = '';
  for (const m of items) {
    const card = document.createElement('div');
    card.className = 'mon-card' + (m.closed ? ' mon-closed' : '');
    const h = document.createElement('div');
    h.className = 'mon-card-h';
    const q = document.createElement('span');
    q.className = 'mon-card-q';
    q.innerHTML = `${monitorIcon(m)} ${escapeAttr(monitorLabel(m))}`;
    const t = document.createElement('span');
    t.className = 'mon-card-t';
    t.textContent = timeLabel(m.updatedAt || m.ts);
    h.append(q, t);
    if (m.closed && state.liveMeeting?.id === m.meetingId) {
      const re = document.createElement('button');
      re.className = 'mon-card-min'; re.title = 'Restore to live panel';
      re.innerHTML = icon('refresh');
      re.onclick = () => { restoreMonitor(m); renderMeetingMonitors(); };
      h.appendChild(re);
    }
    const bd = document.createElement('div');
    bd.className = 'mon-card-b bubble';
    const answer = m.answer || m.history?.[m.history.length - 1]?.answer || '';
    bd.innerHTML = answer ? renderMarkdown(answer) : '<span class="muted">No answer captured yet.</span>';
    if (answer) enhanceCode(bd);
    card.append(h, bd);
    body.appendChild(card);
  }
}

// Load all summary versions for the viewed meeting into meetingsView (active text
// stays in meetingsView.notes for the existing attach/export/download callers).
async function loadMeetingVersions() {
  if (!meetingsView.rec) { meetingsView.versions = []; meetingsView.activeId = null; meetingsView.notes = ''; return; }
  const { activeId, versions } = await getMeetingNoteVersions(meetingsView.rec.id).catch(() => ({ activeId: null, versions: [] }));
  meetingsView.versions = versions;
  meetingsView.activeId = activeId;
  const active = versions.find((x) => x.id === activeId) || versions[versions.length - 1];
  meetingsView.notes = active ? String(active.text || '') : '';
}

function noteVersionLabel(v) {
  if (v.id === 'live') return '🔴 Live';
  return `${v.style === 'detailed' ? 'Detailed' : 'Concise'} · ${timeLabel(v.createdAt)}`;
}

function renderMeetingSummary() {
  const body = $('meeting-summary');
  body.innerHTML = '';
  const versions = meetingsView.versions || [];

  // Version bar: switch between kept summaries + regenerate in either style.
  const bar = document.createElement('div');
  bar.className = 'mtg-ver-bar';
  for (const v of versions) {
    const chip = document.createElement('span');
    chip.className = 'mtg-ver' + (v.id === meetingsView.activeId ? ' on' : '');
    const lab = document.createElement('button');
    lab.className = 'mtg-ver-lab';
    lab.textContent = noteVersionLabel(v);
    lab.title = 'View this version';
    lab.onclick = () => switchMeetingVersion(v.id);
    chip.appendChild(lab);
    if (v.id !== 'live') {
      const x = document.createElement('button');
      x.className = 'mtg-ver-x';
      x.innerHTML = icon('close');
      x.title = 'Delete this version';
      x.onclick = (e) => { e.stopPropagation(); deleteMeetingVersion(v.id); };
      chip.appendChild(x);
    }
    bar.appendChild(chip);
  }
  const spacer = document.createElement('span');
  spacer.className = 'mtg-ver-spacer';
  bar.appendChild(spacer);
  for (const style of ['concise', 'detailed']) {
    const b = document.createElement('button');
    b.className = 'mtg-ver regen';
    b.disabled = !!meetingsView.generating;
    if (meetingsView.generating) b.textContent = '…';
    else b.innerHTML = icon('refresh') + (style === 'concise' ? ' Concise' : ' Detailed');
    b.title = `Generate a new ${style} summary from the full transcript (kept as a new version)`;
    b.onclick = (e) => { e.stopPropagation(); regenerateMeetingSummary(style); };
    bar.appendChild(b);
  }
  body.appendChild(bar);

  const content = document.createElement('div');
  content.className = 'mtg-summary-content';
  content.innerHTML = meetingsView.notes
    ? renderMarkdown(meetingsView.notes)
    : '<div class="empty-notes">No summary yet — click ↻ Concise or ↻ Detailed to generate one.</div>';
  enhanceCode(content);
  body.appendChild(content);

  // Surface saved live-monitor insights beneath the summary — rendered, NOT written
  // into the notes text, so regenerating a summary never pulls them in. Filled async.
  const monWrap = document.createElement('div');
  monWrap.className = 'mtg-monitors';
  body.appendChild(monWrap);
  renderSummaryMonitorInsights(meetingsView.rec?.id, monWrap);
}

async function renderSummaryMonitorInsights(meetingId, wrap) {
  if (!meetingId || !wrap) return;
  let items = [];
  try { items = await getMeetingMonitors(meetingId); } catch { return; }
  const active = items.filter((m) => !m.closed && (m.answer || m.history?.length));
  if (!active.length) return;
  const h = document.createElement('div');
  h.className = 'mtg-monitors-h';
  h.innerHTML = `${icon('watch')} Live monitor insights`;
  wrap.appendChild(h);
  for (const m of active) {
    const row = document.createElement('div');
    row.className = 'mtg-monitor';
    const answer = m.answer || m.history?.[m.history.length - 1]?.answer || '';
    row.innerHTML = `<div class="mtg-monitor-q">${monitorIcon(m)} ${escapeAttr(monitorLabel(m))}</div>`
      + `<div class="mtg-monitor-a">${renderMarkdown(answer)}</div>`;
    enhanceCode(row);
    wrap.appendChild(row);
  }
}

async function switchMeetingVersion(vid) {
  if (!meetingsView.rec) return;
  await setActiveMeetingNote(meetingsView.rec.id, vid).catch(() => {});
  await loadMeetingVersions();
  renderMeetingSummary();
}

async function deleteMeetingVersion(vid) {
  if (!meetingsView.rec) return;
  const v = (meetingsView.versions || []).find((x) => x.id === vid);
  if (!(await confirmDelete({
    title: 'Delete this summary version?',
    body: `The ${v ? noteVersionLabel(v) : 'selected'} summary will be removed. Other versions and the transcript are untouched.`,
    confirmLabel: 'Delete version',
  }))) return;
  await deleteMeetingNoteVersion(meetingsView.rec.id, vid).catch(() => {});
  await loadMeetingVersions();
  renderMeetingSummary();
  toast('Version deleted');
}

function renderMeetingTranscript() {
  const body = $('meeting-transcript');
  const q = ($('meeting-search').value || '').trim().toLowerCase();
  const lines = meetingToText(meetingsView.rec, { sinceTs: 0 }).split('\n').filter((l) => l.trim());
  if (!lines.length) { body.innerHTML = '<div class="empty-notes">No transcript captured.</div>'; return; }
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  if (!shown.length) { body.innerHTML = `<div class="empty-notes">No lines match “${escHtml(q)}”.</div>`; return; }
  const hi = (t) => {
    if (!q) return escHtml(t);
    const i = t.toLowerCase().indexOf(q);
    return i < 0 ? escHtml(t) : escHtml(t.slice(0, i)) + '<mark>' + escHtml(t.slice(i, i + q.length)) + '</mark>' + escHtml(t.slice(i + q.length));
  };
  body.innerHTML = shown.map((l) => `<div class="ln-line">${hi(l)}</div>`).join('');
}

function setMeetingViewStatus() {
  const el = $('meeting-view-status');
  if (!el || !meetingsView.rec) return;
  if (meetingsView.tab === 'transcript') {
    const n = meetingToText(meetingsView.rec, { sinceTs: 0 }).split('\n').filter((l) => l.trim()).length;
    el.textContent = `${n} line${n === 1 ? '' : 's'}`;
  } else {
    el.textContent = relAgo(meetingsView.rec.endedAt || meetingsView.rec.startedAt);
  }
}

// Generate a NEW summary version from the full transcript in the chosen style and
// keep it (the live running summary is never overwritten — the user can switch back).
async function regenerateMeetingSummary(style = 'concise') {
  if (meetingsView.generating || !meetingsView.rec) return;
  meetingsView.generating = true;
  renderMeetingSummary();
  const content = $('meeting-summary').querySelector('.mtg-summary-content');
  if (content) content.innerHTML = `<div class="empty-notes">Generating ${style} summary…</div>`;
  const transcript = meetingToText(meetingsView.rec, { sinceTs: 0 });
  try {
    const text = (await summarizeMeeting('', transcript, true, { style })).trim();
    if (!text) throw new Error('empty summary');
    await saveMeetingNotes(meetingsView.rec.id, text, { newVersion: true, style, kind: 'regenerated' });
    maybeExtractMeetingTopics(meetingsView.rec.id).catch(() => {});
    toast(`${style === 'detailed' ? 'Detailed' : 'Concise'} summary added`);
  } catch (e) {
    toast(`⚠ ${e.message || String(e)}`);
  } finally {
    meetingsView.generating = false;
    await loadMeetingVersions();
    renderMeetingSummary();
  }
}

function copyMeetingActive() {
  const t = meetingsView.tab === 'transcript' ? meetingToText(meetingsView.rec, { sinceTs: 0 }) : meetingsView.notes;
  navigator.clipboard.writeText(t || '').then(() => toast('Copied')).catch(() => {});
}
function downloadMeetingActive() {
  const rec = meetingsView.rec;
  if (!rec) return;
  const base = (rec.title || 'meeting').replace(/[^\w]+/g, '_').slice(0, 50) || 'meeting';
  if (meetingsView.tab === 'transcript') downloadText(`${base}_transcript.txt`, meetingToText(rec, { sinceTs: 0 }), 'text/plain');
  else if (meetingsView.notes) downloadText(`${base}_notes.md`, meetingsView.notes, 'text/markdown');
  else downloadText(`${base}.md`, meetingToMarkdown(rec), 'text/markdown');
  toast('Downloaded');
}

// Run the agent to produce/merge the running notes, streaming into the drawer.
// Produce/merge a meeting's running notes from `prevNotes` + the new transcript
// delta. Headless — returns the merged markdown (the scribe loop saves it to
// storage; viewers read it from there). No drawer/UI coupling.
// Concise running-summary prompts — the DEFAULT for the live scribe (refreshes every
// couple minutes, so it must stay short). 'detailed' falls back to the full Meeting
// notes minutes. Regenerate (Phase 3b) lets the user pick the style per version.
const CONCISE_FIRST = [
  'You are a live meeting scribe. Write a SHORT running summary of the transcript so far. It may be partial/live — write "as of now" and never invent an ending, decision, owner, or date. Ground every line in the transcript; no padding or speculation.',
  'Output compact GitHub-flavored Markdown, OMITTING any section with no real content:',
  '## TL;DR — 2–4 short bullets: the bottom line and the biggest open issue.',
  '## Decisions & risks — only if explicit; one line each, tagged **[decision]** / **[risk]** / **[question]**. Skip the whole section if none.',
  '## Action items — a task list; owner in _(parens)_ and — _due_ ONLY if stated. Skip if none.',
  'Keep it tight: short phrases over sentences, no preamble, no restating the question.',
].join('\n');
const CONCISE_MERGE = [
  'You are a live meeting scribe maintaining ONE short running summary. Merge the NEW transcript into the CURRENT summary — do NOT start over, do NOT duplicate, keep stable items stable, and refine an earlier line only if the new transcript clarifies it.',
  'Keep the SAME compact shape (TL;DR 2–4 bullets; Decisions & risks only if explicit; Action items only if stated) and stay tight — short phrases. Output ONLY the complete updated summary.',
].join('\n');

async function summarizeMeeting(prevNotes, deltaText, isFirst, { style = 'concise' } = {}) {
  const agent = getTarget(state.settings, state.settings.activeAgentId);
  const detailed = style === 'detailed';
  const prompt = isFirst
    ? `${detailed ? meetingNotesSkill().prompt : CONCISE_FIRST}\n\n--- MEETING TRANSCRIPT SO FAR ---\n${deltaText}`
    : detailed
      ? [
          'You are a live meeting scribe maintaining ONE running minutes document.',
          'Update the CURRENT running notes by merging in the NEW transcript below — do not start over.',
          'Rules: keep the same sections (TL;DR, Topics, Key Moments tagged [decision]/[highlight]/[risk]/[question], Action Items with owners/dues). Merge new items into the right place; refine or correct earlier entries if the new transcript clarifies them; never duplicate; keep stable items stable. Output ONLY the complete updated document.',
          '',
          '--- CURRENT RUNNING NOTES ---',
          prevNotes,
          '',
          '--- NEW TRANSCRIPT SINCE LAST UPDATE ---',
          deltaText,
        ].join('\n')
      : [
          CONCISE_MERGE,
          '',
          '--- CURRENT SUMMARY ---',
          prevNotes,
          '',
          '--- NEW TRANSCRIPT SINCE LAST UPDATE ---',
          deltaText,
        ].join('\n');

  let out = '';
  await streamChat({
    agent,
    messages: [{ role: 'user', content: prompt }],
    settings: state.settings,
    onDelta: (d) => { out += d; },
  });
  return out.trim();
}

function liveNotesDrawerOpen() {
  return !$('live-notes-drawer').classList.contains('hidden');
}

// Summary tab (rendered markdown). Kept as renderLiveNotesBody so the streaming
// merge can call it on each delta.
function renderLiveNotesBody(text) {
  const body = $('live-notes-summary');
  if (!body) return;
  body.innerHTML = text
    ? renderMarkdown(text)
    : '<div class="empty-notes">No summary yet. Turn on 📝 Live (or send a /notes message) to generate one.</div>';
}

function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Transcript tab — one line per segment, optionally filtered+highlighted by the
// search box. Speaker is dimmed so the spoken text reads cleanly.
function renderTranscript() {
  const body = $('live-notes-transcript');
  if (!body) return;
  const q = ($('live-notes-search').value || '').trim().toLowerCase();
  const lines = (liveNotes.transcript || '').split('\n').filter((l) => l.trim());
  if (!lines.length) {
    body.innerHTML = '<div class="empty-notes">No transcript captured yet — make sure captions are on.</div>';
    return;
  }
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  if (!shown.length) {
    body.innerHTML = `<div class="empty-notes">No lines match “${escHtml(q)}”.</div>`;
    return;
  }
  const hi = (text) => {
    if (!q) return escHtml(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return escHtml(text);
    return escHtml(text.slice(0, i)) + '<mark>' + escHtml(text.slice(i, i + q.length)) + '</mark>' + escHtml(text.slice(i + q.length));
  };
  body.innerHTML = shown.map((l) => `<div class="ln-line">${hi(l)}</div>`).join('');
}

// Pull the full transcript from the capturing frame into liveNotes.transcript.
// Force the live meeting tab to flush its latest buffer NOW (via the service worker,
// which pings the capturing tab) and reload the transcript into whatever meeting view
// is open — so you can pull the newest transcript WITHOUT switching to the meeting tab.
let syncingTranscript = false;
async function syncTranscriptNow() {
  if (syncingTranscript) return;
  const mid = state.liveMeeting?.id;
  const btns = [$('meeting-sync'), $('live-notes-sync')].filter(Boolean);
  syncingTranscript = true;
  btns.forEach((b) => { b.classList.add('spin'); b.disabled = true; });
  try {
    try { await chrome.runtime.sendMessage({ type: 'CP_MEETING_SYNC_NOW' }); } catch { /* SW asleep */ }
    await new Promise((r) => setTimeout(r, 450)); // let the flush land in storage
    if (liveNotesDrawerOpen() && mid) {
      const rec = await getMeeting(mid).catch(() => null);
      if (rec) { liveNotes.transcript = meetingToText(rec, { sinceTs: 0 }); liveNotes.title = rec.title || liveNotes.title; }
      if (liveNotes.tab === 'transcript') renderTranscript();
      setLiveNotesStatus();
    }
    if (meetingsView.rec && !$('meeting-view').classList.contains('hidden')) {
      const rec = await getMeeting(meetingsView.rec.id).catch(() => null);
      if (rec) meetingsView.rec = rec;
      if (meetingsView.tab === 'transcript') renderMeetingTranscript();
      else if (meetingsView.tab === 'monitors') renderMeetingMonitors();
      else renderMeetingSummary();
    }
    toast('Transcript synced', 1200);
  } finally {
    syncingTranscript = false;
    btns.forEach((b) => { b.classList.remove('spin'); b.disabled = false; });
  }
}

async function refreshTranscript() {
  const tab = state.activeTab;
  if (!tab) return;
  try {
    const rec = await getMeetingRecord(tab.id);
    if (rec) {
      liveNotes.transcript = meetingToText(rec, { sinceTs: 0 });
      liveNotes.title = rec.title || 'Meeting';
    }
  } catch {
    /* leave the last transcript in place */
  }
}

function relAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function setLiveNotesStatus(override) {
  const el = $('live-notes-status');
  if (!el) return;
  if (override) { el.textContent = override; return; }
  if (liveNotes.tab === 'transcript') {
    const n = (liveNotes.transcript || '').split('\n').filter((l) => l.trim()).length;
    el.textContent = `${n} line${n === 1 ? '' : 's'}`;
    return;
  }
  const iv = liveNotesIntervalMin();
  el.textContent = `${iv ? `every ${iv}m · ` : 'off · '}updated ${relAgo(liveNotes.updatedAt)}`;
}

function switchLiveNotesTab(tab) {
  liveNotes.tab = tab;
  const isT = tab === 'transcript';
  $('ln-tab-summary').classList.toggle('active', !isT);
  $('ln-tab-transcript').classList.toggle('active', isT);
  $('live-notes-summary').classList.toggle('hidden', isT);
  $('live-notes-transcript').classList.toggle('hidden', !isT);
  $('live-notes-search').classList.toggle('hidden', !isT);
  if (isT) renderTranscript();
  else renderLiveNotesBody(liveNotes.text);
  setLiveNotesStatus();
}

async function openLiveNotes() {
  $('live-notes-drawer').classList.remove('hidden');
  await refreshTranscript();
  switchLiveNotesTab(liveNotes.tab);
  // Keep the transcript live while the drawer is open (independent of the summary
  // interval, so the Transcript tab updates even with Live notes off).
  clearInterval(liveNotes.transcriptTimer);
  liveNotes.transcriptTimer = setInterval(async () => {
    if (!liveNotesDrawerOpen()) return;
    await refreshTranscript();
    if (liveNotes.tab === 'transcript') { renderTranscript(); setLiveNotesStatus(); }
  }, 5000);
}
function closeLiveNotes() {
  $('live-notes-drawer').classList.add('hidden');
  clearInterval(liveNotes.transcriptTimer);
  liveNotes.transcriptTimer = null;
}

// Download the active tab: Summary → .md, Transcript → .txt.
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function liveNotesFileBase() {
  return (liveNotes.title || 'meeting').replace(/[^\w.-]+/g, '_').slice(0, 50);
}
function downloadLiveNotesActive() {
  if (liveNotes.tab === 'transcript') {
    if (!liveNotes.transcript) return toast('No transcript yet');
    downloadText(`${liveNotesFileBase()}_transcript.txt`, liveNotes.transcript, 'text/plain');
  } else {
    if (!liveNotes.text) return toast('No summary yet');
    downloadText(`${liveNotesFileBase()}_notes.md`, liveNotes.text, 'text/markdown');
  }
  toast('Downloaded');
}
function copyLiveNotesActive() {
  const text = liveNotes.tab === 'transcript' ? liveNotes.transcript : liveNotes.text;
  navigator.clipboard.writeText(text || '').then(() => toast('Copied')).catch(() => {});
}

async function renderMeetingBar() {
  const bar = $('meeting-bar');
  const tab = state.activeTab;
  const platform = tab && meetingPlatform(tab.url || '');
  if (!platform) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const seq = ++_meetingBarSeq;
  const label = MEETING_LABELS[platform] || platform;
  const probe = await probeMeeting(tab.id); // null if the content script isn't loaded
  if (seq !== _meetingBarSeq) return; // a newer render superseded us

  // Brand the bar as the scribe rather than a "recording" — we read live captions,
  // not audio/video, so no red dot.
  const scribe = `ChatPanel ${MEETING_SHORT[platform] || label} Scribe`;
  const render = (text, buttons = []) => {
    bar.classList.remove('hidden');
    bar.innerHTML = '';
    const logo = document.createElement('img');
    logo.className = 'meeting-logo';
    logo.src = 'assets/icon16.png';
    logo.alt = '';
    const span = document.createElement('span');
    span.className = 'meeting-text';
    span.textContent = text;
    bar.append(logo, span);
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'meeting-btn' + (b.primary ? ' primary' : '');
      // b.icon is an icon-role name; render it as a leading SVG with the (escaped)
      // label. Falls back to plain text when no icon role is given.
      if (b.icon) btn.innerHTML = icon(b.icon) + ' ' + escapeAttr(b.label);
      else btn.textContent = b.label;
      btn.onclick = b.onClick;
      bar.appendChild(btn);
    }
  };

  // Content script not responding → the tab loaded before the extension did.
  if (!probe?.ok) {
    render(`${scribe} · reload the tab to enable`, [
      { label: 'Reload', onClick: () => chrome.tabs.reload(tab.id) },
    ]);
    return;
  }
  // Platform recognised but adapter not implemented yet.
  if (probe.ready === false) {
    render(`${scribe} · coming soon`);
    return;
  }
  // Gated behind Pro.
  if (!can(state.license, 'liveMeetings')) {
    render(`${scribe} · Pro`, [
      { label: 'Upgrade', icon: 'upgrade', primary: true, onClick: () => upsell('liveMeetings') },
    ]);
    return;
  }
  // Pro + active. Capture is auto-included on every message; controls are the live
  // notes interval, the rolling window, and Stop.
  const key = probe.meetingKey || tab.url;
  if (probe.capturing) {
    const iv = liveNotesIntervalMin();
    // We capture rendered caption text — with captions OFF there's nothing to read.
    // Auto-enable runs in the content script; if it hasn't taken, warn + offer a
    // manual nudge. The content script pings CP_MEETING_CAPTIONS when this flips, so
    // the warning appears/clears without the user switching tabs.
    if (!probe.live) {
      render(`${scribe} · ⚠ captions off — no transcript`, [
        {
          label: '🔴 Turn on captions',
          primary: true,
          onClick: async () => {
            toast('Trying to turn on captions…');
            await enableMeetingCaptions(tab.id);
          },
        },
        { label: 'View', icon: 'document', onClick: () => viewActiveMeeting(tab.id) },
        {
          label: 'Stop',
          onClick: async () => {
            _autoStartSuppressed.add(key);
            await stopMeeting(tab.id);
            renderMeetingBar();
          },
        },
      ]);
      scheduleLiveNotes();
      return;
    }
    render(scribe, [
      { label: 'View', icon: 'document', onClick: () => viewActiveMeeting(tab.id) },
      { label: `Live ${iv ? iv + 'm' : 'Off'}`, icon: 'note', onClick: cycleLiveNotesInterval },
      { label: `${meetingWindowLabel()}`, icon: 'history-clock', onClick: cycleMeetingWindow },
      {
        label: 'Stop',
        primary: true,
        onClick: async () => {
          _autoStartSuppressed.add(key); // don't auto-restart after an explicit stop
          await stopMeeting(tab.id); // flips status→ended; the scribe loop then skips it
          renderMeetingBar();
        },
      },
    ]);
    scheduleLiveNotes(); // ensure the global scribe loop is armed (idempotent)
    return;
  }
  // Not capturing on THIS tab — but the global scribe loop keeps running for any
  // OTHER live meetings, so we intentionally do not stop it here.

  // On a meeting platform but not actually in the call yet (landing / green room /
  // pre-join / preview — all share the meeting URL pattern). Don't auto-start: that
  // would open an empty record on a non-meeting page. Show a passive "ready" chip;
  // the content script pings CP_MEETING_JOINED the moment the user joins, which
  // re-runs this and auto-starts then.
  if (!probe.inCall) {
    render(`${scribe} · ready · starts when you join`);
    return;
  }

  // Not capturing but in the call: auto-start the moment we see a live meeting, so
  // the user never has to click Start — unless they explicitly Stopped this meeting.
  if (!_autoStartSuppressed.has(key)) {
    await startMeeting(tab.id);
    if (seq !== _meetingBarSeq) return;
    toast('🎙 Meeting notes started — ask away, the transcript rides along');
    return renderMeetingBar();
  }

  // Suppressed (user Stopped) — offer a manual restart.
  const capsHint = probe.live ? 'captions on' : 'turn on captions';
  render(`${scribe} · paused · ${capsHint}`, [
    {
      label: 'Start',
      primary: true,
      onClick: async () => {
        _autoStartSuppressed.delete(key);
        await startMeeting(tab.id);
        renderMeetingBar();
        toast('Scribe on — ask away, the transcript rides along automatically');
      },
    },
  ]);
}

async function addAttachment(producer) {
  // Enforce free-tier attachment limit.
  if (
    state.attachments.length >= FREE_LIMITS.attachmentsPerMessage &&
    !can(state.license, 'multiTab')
  ) {
    return upsell('multiTab');
  }
  try {
    toast('Reading…');
    const att = await producer();
    state.attachments.push(att);
    renderContextBar();
    toast(`Attached: ${att.title}`);
  } catch (e) {
    toast('⚠ ' + e.message, 2600);
  }
}

// --------------------------------------------------------------------------
// Image attachments — paste / file-pick / drag-drop. Sent to vision API models
// as image blocks (see providers.toMultimodalMessages). Free for everyone.
// --------------------------------------------------------------------------
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB raw — keeps base64 under model limits

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith('image/')) return reject(new Error('Not an image'));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error('Image too large (max 5 MB)'));
    const r = new FileReader();
    r.onload = () =>
      resolve({
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        kind: 'image',
        title: file.name || 'image',
        mediaType: file.type,
        dataUrl: String(r.result),
        chars: 0,
      });
    r.onerror = () => reject(new Error('Could not read image'));
    r.readAsDataURL(file);
  });
}

// Bridge agents that can receive images (the bridge writes them to temp files and
// attaches them, e.g. `codex exec -i`). Others have no image channel yet.
const IMAGE_CAPABLE_BRIDGE = new Set(['codex', 'claude', 'antigravity', 'pi', 'opencode']);
function warnIfNoVision() {
  const agent = resolveTarget(agentForConv(state.conv), state.settings);
  if (agent?.kind !== 'bridge') return;
  // Custom agents take images only if the user configured how (imageArg template).
  const capable =
    agent.bridgeAgent === 'custom' ? !!agent.imageArg : IMAGE_CAPABLE_BRIDGE.has(agent.bridgeAgent);
  if (!capable) {
    toast('Heads up: this CLI agent can’t see images — set its image parameter in Settings, or use a vision model.', 3600);
  }
}

async function addImageFiles(files) {
  const imgs = [...files].filter((f) => f && f.type?.startsWith('image/'));
  if (!imgs.length) return;
  for (const file of imgs) await addAttachment(() => readImageFile(file));
  warnIfNoVision();
}

let _imgPicker = null;
function pickImages() {
  if (!_imgPicker) {
    _imgPicker = document.createElement('input');
    _imgPicker.type = 'file';
    _imgPicker.accept = 'image/*';
    _imgPicker.multiple = true;
    _imgPicker.style.display = 'none';
    _imgPicker.addEventListener('change', () => {
      const files = [..._imgPicker.files];
      _imgPicker.value = '';
      addImageFiles(files);
    });
    document.body.appendChild(_imgPicker);
  }
  _imgPicker.click();
}

async function autoAttachUrls(text) {
  const urls = [...new Set((text.match(/https?:\/\/[^\s)]+/gi) || []))].slice(0, 3);
  for (const url of urls) {
    if (state.attachments.find((a) => a.url === url)) continue;
    // First URL is free; additional ones need Pro (multi-context).
    if (state.attachments.length >= FREE_LIMITS.attachmentsPerMessage && !can(state.license, 'multiTab')) break;
    try {
      const att = await captureUrl(url);
      state.attachments.push(att);
    } catch {
      /* leave the bare URL in the text */
    }
  }
  renderContextBar();
}

// "Whole-window context" (Pro): grab every readable tab in the current window in
// one shot. Capped so we don't blow past a model's context window.
const WINDOW_TAB_CAP = 10;
async function attachWholeWindow() {
  if (!can(state.license, 'multiTab')) return upsell('multiTab');
  const all = (await listTabs({ currentWindowOnly: true })).filter(
    (t) => !state.attachments.some((a) => a.url === t.url),
  );
  const targets = all.slice(0, WINDOW_TAB_CAP);
  if (!targets.length) return toast('No new tabs to attach in this window');
  toast(`Reading ${targets.length} tab${targets.length === 1 ? '' : 's'}…`, 4000);
  const results = await Promise.allSettled(targets.map((t) => captureTab(t.id)));
  let n = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      state.attachments.push(r.value);
      n++;
    }
  }
  renderContextBar();
  const extra = all.length > WINDOW_TAB_CAP ? ` (first ${WINDOW_TAB_CAP} of ${all.length})` : '';
  toast(n ? `Attached ${n} tab${n === 1 ? '' : 's'}${extra}` : 'Could not read those tabs', 2600);
}

function renderContextBar() {
  const bar = $('context-bar');
  bar.innerHTML = '';
  const pageTab = state.activeTab || state.ownPageTab;
  const showPage = state.usePage && pageTab;
  const showMeeting = !!state.liveMeeting && state.excludedMeetingId !== state.liveMeeting.id;
  if (!state.attachments.length && !showPage && !showMeeting) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  // Live meeting chip — its transcript is read fresh from the DB and included on
  // EVERY message, from any tab, until you dismiss it (then it stays off for this
  // meeting). No navigating to a button.
  if (showMeeting) {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip page-chip';
    chip.title = 'Live meeting transcript — included on every message (read fresh each send)';
    chip.innerHTML = `<span class="ctx-kind">${icon('mic')}</span><span class="ctx-title">${escapeAttr(
      (state.liveMeeting.title || 'Meeting') + ' · live',
    )}</span>`;
    // Live-summary toggle (Phase 2): stream the scribe's running summary into this
    // chat, updated automatically — no extra model calls.
    const on = !!state.conv?.liveSummary;
    const live = document.createElement('button');
    live.className = 'ctx-live' + (on ? ' on' : '');
    live.textContent = on ? '🔴 Live summary' : '○ Live summary';
    live.title = on
      ? 'Streaming the running summary into this chat — click to stop'
      : 'Stream the meeting’s running summary into this chat (auto-updates, no extra model calls)';
    live.onclick = (e) => { e.stopPropagation(); toggleLiveSummary(); };
    chip.appendChild(live);
    // (Monitors moved to the pinned "Live monitors" panel below — see renderMonitors.)
    const x = document.createElement('button');
    x.className = 'ctx-x';
    x.innerHTML = icon('close');
    x.title = 'Stop including this meeting';
    x.onclick = () => {
      state.excludedMeetingId = state.liveMeeting.id;
      renderContextBar();
      toast('Meeting context off for this meeting');
    };
    chip.appendChild(x);
    bar.appendChild(chip);
  }

  // The "live page" chip: the current tab, auto-included and read fresh at send.
  if (showPage) {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip page-chip';
    chip.title = `This page is included as context — ${pageTab.url}`;
    chip.innerHTML = `<span class="ctx-kind">${icon(state.ownPageTab ? 'file-text' : 'web')}</span><span class="ctx-title">${escapeAttr(
      pageTab.title,
    )}</span>`;
    const x = document.createElement('button');
    x.className = 'ctx-x';
    x.innerHTML = icon('close');
    x.title = 'Stop including this page';
    x.onclick = () => {
      state.usePage = false;
      renderContextBar();
      toast('Page context off — add it back with 📎');
    };
    chip.appendChild(x);
    bar.appendChild(chip);
  }

  state.attachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    const kind = { page: icon('web'), url: icon('link'), selection: icon('cut'), image: icon('image') }[att.kind] || icon('attach');
    chip.innerHTML = `<span class="ctx-kind">${kind}</span><span class="ctx-title">${escapeAttr(
      att.title || att.url,
    )}</span>`;
    const x = document.createElement('button');
    x.className = 'ctx-x';
    x.innerHTML = icon('close');
    x.onclick = () => {
      state.attachments.splice(i, 1);
      renderContextBar();
    };
    chip.appendChild(x);
    bar.appendChild(chip);
  });
  renderMonitors(); // the live-monitors panel tracks the same meeting state as the chip
}

async function renderAttachMenu() {
  const menu = $('attach-menu');
  menu.innerHTML = '';
  // Toggle for auto-including the current page (the default behavior).
  const toggle = actionItem(state.usePage ? icon('check') : icon('square'), 'Include this page automatically', () => {
    state.usePage = !state.usePage;
    refreshActiveTab();
    toast(state.usePage ? 'This page will be included' : 'Page context off');
  });
  menu.appendChild(toggle);
  menu.appendChild(actionItem('🌐', 'Current tab (once)', () => addAttachment(() => captureActiveTab())));
  menu.appendChild(actionItem('✂️', 'Current selection', () => addAttachment(() => captureSelection())));
  menu.appendChild(actionItem('🖼', 'Attach an image', () => { closeMenus(); pickImages(); }));
  // Whole-window context (Pro): attach every readable tab in this window at once.
  const proWindow = can(state.license, 'multiTab');
  menu.appendChild(
    actionItem('🪟', `All tabs in this window${proWindow ? '' : ' — Pro'}`, () => attachWholeWindow()),
  );

  // Live meeting transcript (Pro) — only shown when the active tab is a meeting.
  if (state.activeTab && meetingPlatform(state.activeTab.url || '')) {
    const proMeet = can(state.license, 'liveMeetings');
    menu.appendChild(
      actionItem('🎙', `Live meeting transcript${proMeet ? '' : ' — Pro'}`, () => {
        if (!proMeet) return upsell('liveMeetings');
        addAttachment(() => captureMeetingTranscript(state.activeTab.id));
      }),
    );
  }

  // Combined search / URL box: filters the open-tab list as you type. Pasting a
  // URL + Enter analyzes it too (pasting a URL straight into the composer also
  // works — autoAttachUrls — so this is just a convenience, not the only way).
  const searchWrap = document.createElement('div');
  searchWrap.style.padding = '6px 8px';
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search open tabs… or paste a URL';
  search.style.cssText =
    'width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft);color:var(--text);';
  searchWrap.appendChild(search);
  menu.appendChild(searchWrap);

  menu.appendChild(sectionLabel('Open tabs'));
  const tabsBox = document.createElement('div');
  menu.appendChild(tabsBox);

  const tabs = await listTabs();
  const looksLikeUrl = (v) => /^https?:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(v);
  const matchTabs = (q) => {
    const n = q.trim().toLowerCase();
    return n ? tabs.filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(n)) : tabs;
  };

  const renderTabList = () => {
    tabsBox.innerHTML = '';
    const matched = matchTabs(search.value).slice(0, 25);
    for (const t of matched) {
      const item = document.createElement('button');
      item.className = 'menu-item';
      const fav = t.favIconUrl
        ? `<img src="${escapeAttr(t.favIconUrl)}" width="14" height="14" style="border-radius:3px"/>`
        : icon('file');
      item.innerHTML = `${fav}<span class="ctx-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeAttr(
        t.title,
      )}</span>`;
      item.onclick = () => {
        closeMenus();
        addAttachment(() => captureTab(t.id));
      };
      tabsBox.appendChild(item);
    }
    if (!matched.length) {
      const none = document.createElement('div');
      none.className = 'menu-section';
      none.textContent = looksLikeUrl(search.value.trim()) ? 'Press Enter to analyze this URL' : 'No matching tabs';
      tabsBox.appendChild(none);
    }
  };
  renderTabList();

  search.oninput = renderTabList;
  search.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const v = search.value.trim();
    if (!v) return;
    if (looksLikeUrl(v)) {
      closeMenus();
      addAttachment(() => captureUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`));
      return;
    }
    const matched = matchTabs(v); // Enter with a single match attaches it
    if (matched.length === 1) {
      closeMenus();
      addAttachment(() => captureTab(matched[0].id));
    }
  };
  setTimeout(() => search.focus(), 0);

  if (!can(state.license, 'multiTab')) {
    const hint = document.createElement('div');
    hint.className = 'menu-section';
    hint.textContent = 'Pro: attach several tabs at once';
    menu.appendChild(hint);
  }
}

// --------------------------------------------------------------------------
// Skills
// --------------------------------------------------------------------------
function renderSkillsMenu() {
  const menu = $('skills-menu');
  menu.innerHTML = '';
  menu.appendChild(sectionLabel('Skills'));
  for (const skill of state.settings.skills) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.innerHTML = `<span>${iconForEmoji(skill.icon) || (skill.icon ? escapeAttr(skill.icon) : icon('skills'))}</span><span>${escapeAttr(skill.name)}</span><span class="mi-sub">/${escapeAttr(
      skill.command || '',
    )}</span>`;
    item.onclick = () => {
      applySkill(skill);
      closeMenus();
    };
    menu.appendChild(item);
  }
  const manage = document.createElement('button');
  manage.className = 'menu-item';
  manage.innerHTML = icon('settings') + ' <span>Manage skills…</span>';
  manage.onclick = () => chrome.runtime.openOptionsPage();
  menu.appendChild(manage);
}

// Apply a skill from the 🎓 menu: prep agent/context, fill variables, drop the
// prompt into the composer for the user to review and send.
async function applySkill(skill) {
  const input = $('input');
  await applySkillPrep(skill);
  state.pendingSkillRun = skillRunFromSkill(skill, { includeMeetings: can(state.license, 'liveMeetings') });
  const text = await substituteVars(skill.prompt, { args: '' });
  input.value = text + (input.value ? '\n\n' + input.value : '');
  autoGrow();
  input.focus();
}

// Per-skill agent + context: switch the conversation's agent and attach the
// context the skill declares (page / selection / all-tabs / none / auto).
async function applySkillPrep(skill) {
  if (skill.agentId && getTarget(state.settings, skill.agentId)) {
    state.conv.agentId = skill.agentId;
    state.settings.activeAgentId = skill.agentId;
    updateSettings({ activeAgentId: skill.agentId });
    renderAgentName();
  }
  switch (skill.context || 'auto') {
    case 'none':
      state.usePage = false;
      renderContextBar();
      break;
    case 'page':
      state.usePage = true;
      renderContextBar();
      break;
    case 'selection':
      await addAttachment(() => captureSelection()).catch(() => {});
      break;
    case 'tabs':
      await attachWholeWindow();
      break;
    default: // 'auto' — leave the current page/attachment behavior as-is.
      break;
  }
}

// Fill {{placeholders}} in a skill prompt. {{input}} (and {{input:label}}) take
// the text typed after the command; {{url}}/{{title}}/{{date}} are sync; only
// {{selection}} costs a tab read, and only when present.
async function substituteVars(text, { args = '' } = {}) {
  if (!text.includes('{{')) return text;
  let out = text
    .replace(/\{\{\s*input(?::[^}]*)?\s*\}\}/gi, args || '')
    .replace(/\{\{\s*url\s*\}\}/gi, (state.activeTab || state.ownPageTab)?.url || '')
    .replace(/\{\{\s*title\s*\}\}/gi, (state.activeTab || state.ownPageTab)?.title || '')
    .replace(/\{\{\s*date\s*\}\}/gi, new Date().toLocaleDateString());
  if (/\{\{\s*selection\s*\}\}/i.test(out)) {
    let sel = '';
    try {
      sel = (await captureSelection()).text || '';
    } catch {
      /* nothing selected */
    }
    out = out.replace(/\{\{\s*selection\s*\}\}/gi, sel);
  }
  return out;
}

// ✨ Improve the composer's draft with the user's configured model, streamed in.
async function improvePrompt() {
  const input = $('input');
  const btn = $('btn-assist');
  if (btn.disabled) return;
  const before = input.value;
  btn.disabled = true;
  const prev = btn.innerHTML;
  btn.innerHTML = icon('queued');
  let streamed = false;
  try {
    await assistPrompt({
      draft: before,
      settings: state.settings,
      onDelta: (full) => {
        streamed = true;
        input.value = full;
        autoGrow();
      },
    });
    input.focus();
  } catch (e) {
    // Only roll back if nothing streamed — keep a good (or partial) result even
    // if the model throws a late/benign error after the text already arrived.
    if (streamed && input.value.trim()) {
      toast('⚠ ' + e.message, 2600);
      input.focus();
    } else {
      input.value = before;
      toast('✕ ' + e.message, 2800);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = prev;
  }
}

// 🎙 Dictation — real-time speech → text streamed straight into the composer,
// using the browser's built-in engine. The heavy-ish module is dynamic-imported
// at this call site so it never touches first paint (it's action-only).
let dictation = null;        // active controller while recording, else null
let dictationBase = '';      // composer text captured when dictation began
let dictationCommitted = ''; // finalized transcript chunks so far this session

// Language code → display name for the dictation status line.
const LANG_NAME = { en: 'English', te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', bn: 'Bengali', es: 'Spanish', fr: 'French', de: 'German', zh: 'Chinese', ja: 'Japanese', ar: 'Arabic', ru: 'Russian', pt: 'Portuguese' };

function setMicRecording(on) {
  const btn = $('btn-mic');
  if (!btn) return;
  btn.classList.toggle('recording', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Stop dictation' : 'Dictate (voice → text)';
  btn.setAttribute('aria-label', on ? 'Stop dictation' : 'Dictate');
  // Swap the mic glyph for a stop square while recording — click again to stop.
  btn.innerHTML = icon(on ? 'stop' : 'mic');
}

// Persistent dictation status (engine + model download % + language) — so
// first-run never looks like "nothing happened". `dl` = {pct,file} or null.
function renderDictationStatus({ engine, hidden = false, dl = null, lang = null } = {}) {
  const el = $('dictation-status');
  if (!el) return;
  if (hidden || !engine) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.classList.toggle('local', !!engine.private);
  el.classList.toggle('cloud', !engine.private);
  const langName = lang ? (LANG_NAME[lang] || lang) : null;
  const head = engine.private
    ? `🎙 Listening — <strong>local, on-device</strong>${langName ? ` · ${langName}` : ''}`
    : `🎙 Listening — <strong>browser engine</strong> · audio processed by Google${langName ? ` · ${langName}` : ''}`;
  let body = `<div class="ds-row"><span class="ds-dot"></span><span>${head}</span></div>`;
  if (dl) {
    const pct = Math.max(3, dl.pct || 0);
    body += `<div class="ds-dl-bar"><div class="ds-dl-fill" style="width:${pct}%"></div></div>`
      + `<div class="ds-sub">Downloading speech model — ${dl.pct || 0}% (one-time). Keep talking; it starts transcribing when ready.</div>`;
  } else if (!engine.private) {
    body += '<div class="ds-sub">Install the ChatPanel gateway for private, on-device dictation (any language).</div>';
  }
  el.innerHTML = body;
}

async function toggleDictation() {
  // Any click while a dictation exists is a STOP (or a no-op while it's already
  // tearing down) — never a restart. The button flips to idle immediately even
  // though the SSE 'end' (final flush) can lag on large models; a safety timer
  // clears the handle if 'end' never arrives, so the mic can't wedge.
  if (dictation) {
    if (dictation.recording) {
      dictation.stop();
      setMicRecording(false);
      renderDictationStatus({ hidden: true });
      const d = dictation;
      setTimeout(() => { if (dictation === d) dictation = null; }, 6000);
    }
    return;
  }
  const { createDictation, micPermissionState, resolveDictationProvider } = await import('./js/dictation.js');
  // The side panel can't show Chrome's mic prompt — route through the one-time
  // grant page first; after that, dictation here just works.
  if (await micPermissionState() !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
    toast('Allow the microphone in the new tab, then tap the mic again', 3600);
    return;
  }
  // Engine auto-detect: local gateway whisper when running (private — audio never
  // leaves the machine), else the browser engine, LABELED (Google processes it).
  const gatewayUrl = state.settings?.gatewayUrl || state.settings?.ui?.warmSearch?.url || undefined;
  const engine = await resolveDictationProvider({ gatewayUrl });
  if (!engine.provider) {
    toast('✕ Voice input isn’t supported in this browser', 2600);
    return;
  }
  const input = $('input');
  dictationBase = input.value;
  // Keep the existing draft; separate it from dictated text with a space.
  if (dictationBase && !/\s$/.test(dictationBase)) dictationBase += ' ';
  dictationCommitted = '';
  const render = (interim = '') => { input.value = dictationBase + dictationCommitted + interim; autoGrow(); };

  const dictLang = state.settings?.ui?.dictation?.lang || undefined; // '' → auto-detect
  let curLang = dictLang || null;
  dictation = createDictation({
    provider: engine.provider,
    gatewayUrl,
    lang: dictLang,
    onStart: () => {
      setMicRecording(true);
      $('btn-mic').title = `Stop dictation — ${engine.label}`;
      renderDictationStatus({ engine, lang: curLang });
      input.focus();
    },
    onStatus: ({ state: st, pct, lang }) => {
      if (lang) { curLang = lang; renderDictationStatus({ engine, lang: curLang }); return; } // auto-detected language
      if (st === 'downloading' || st === 'loading') renderDictationStatus({ engine, dl: { pct, file: null }, lang: curLang });
      else renderDictationStatus({ engine, lang: curLang });
    },
    onInterim: (t) => render(t),
    onFinal: (t) => { dictationCommitted += (dictationCommitted ? ' ' : '') + t.trim(); render(); },
    onEnd: () => { setMicRecording(false); dictation = null; renderDictationStatus({ hidden: true }); input.focus(); },
    onError: ({ code, message, fatal }) => {
      if (code === 'not-allowed' || code === 'service-not-allowed')
        toast('✕ Microphone blocked — allow mic access for the side panel', 3200);
      else if (code === 'network')
        toast('✕ Voice input needs a network connection', 2800);
      else if (code === 'gateway-unreachable')
        toast('✕ Gateway stopped answering — tap the mic to retry', 2800);
      else if (fatal)
        toast('✕ Voice input error: ' + (message || code), 2800);
      if (fatal) { setMicRecording(false); dictation = null; renderDictationStatus({ hidden: true }); }
    },
  });
  renderDictationStatus({ engine, lang: curLang }); // show immediately, before the first event
  dictation.start();
}

// Skills (the 🎓 menu, /commands, suggestions) are a Pro feature.
function skillsAllowed() {
  return can(state.license, 'customSkills');
}

// Lightweight, free, instant: suggest the skill whose name/command/description
// best matches what the user is typing.
let suggestSuppressed = false;
function suggestSkill(text) {
  if (!skillsAllowed()) return null; // no skills for Free users
  const t = (text || '').toLowerCase().trim();
  if (t.length < 8 || t.startsWith('/')) return null;
  const words = new Set(t.split(/\W+/).filter((w) => w.length > 3));
  let best = null;
  let bestScore = 0;
  for (const skill of state.settings.skills || []) {
    const hay = `${skill.name} ${skill.command} ${skill.description || ''}`.toLowerCase();
    const keys = hay.split(/\W+/).filter((w) => w.length > 3);
    let score = 0;
    for (const w of words) if (keys.includes(w)) score += 1;
    for (const k of keys) if (t.includes(k)) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return bestScore >= 1.5 ? best : null;
}

function renderSuggest() {
  const box = $('skill-suggest');
  const skill = suggestSuppressed ? null : suggestSkill($('input').value);
  if (!skill) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '';
  const chip = document.createElement('button');
  chip.className = 'suggest-chip';
  chip.innerHTML = `${icon('idea')} Use <b>/${escapeAttr(skill.command)}</b> — ${escapeAttr(skill.description || skill.name)}`;
  chip.onclick = () => {
    box.classList.add('hidden');
    applySkill(skill);
  };
  const x = document.createElement('button');
  x.className = 'suggest-x';
  x.innerHTML = icon('close');
  x.title = 'Dismiss';
  x.onclick = () => {
    suggestSuppressed = true;
    box.classList.add('hidden');
  };
  box.append(chip, x);
  box.classList.remove('hidden');
}

// Slash menu — typing "/" (then a partial command) shows a filterable dropdown
// of skills, like a command palette. Selecting one completes "/command " in the
// composer so the user can add args and send (the /command is parsed on send).
// Reuses the #skill-suggest box (rendered as a list in `slash-menu` mode).
let slashItems = [];
let slashActive = -1;
function slashMenuOpen() { return slashItems.length > 0; }

function renderSlashMenu() {
  const box = $('skill-suggest');
  const m = /^\/([a-z0-9_-]*(?:\s+[a-z0-9_-]*)?)$/i.exec($('input').value); // slash + partial command, optional subcommand
  if (!m) { hideSlashMenu(); return false; }
  const prefix = m[1].toLowerCase();
  const matches = slashCommandItems({
    skills: state.settings.skills || [],
    prefix,
    skillsAllowed: skillsAllowed(),
    canMeetings: can(state.license, 'liveMeetings'),
  });
  if (!matches.length) { hideSlashMenu(); return false; }
  slashItems = matches;
  slashActive = Math.max(0, Math.min(slashActive, matches.length - 1));
  box.innerHTML = '';
  box.classList.add('slash-menu');
  matches.forEach((itemData, i) => {
    const item = document.createElement('button');
    item.className = 'slash-item' + (i === slashActive ? ' active' : '');
    const badge = itemData.locked ? '<span class="si-badge">Pro</span>' : '';
    item.innerHTML =
      `<span class="si-icon">${iconForEmoji(itemData.icon) || (itemData.icon ? escapeAttr(itemData.icon) : icon('skills'))}</span>` +
      `<span class="si-cmd">/${escapeAttr(itemData.command || '')}</span>` +
      `${badge}` +
      `<span class="si-desc">${escapeAttr(itemData.description || '')}</span>`;
    // mousedown (not click) so we act before the textarea blur hides the menu.
    item.onmousedown = (e) => { e.preventDefault(); chooseSlash(i); };
    box.appendChild(item);
  });
  box.classList.remove('hidden');
  return true;
}

function hideSlashMenu() {
  if (!slashItems.length) return;
  const box = $('skill-suggest');
  box.classList.remove('slash-menu');
  box.classList.add('hidden');
  box.innerHTML = '';
  slashItems = [];
  slashActive = -1;
}

function chooseSlash(i) {
  const item = slashItems[i];
  hideSlashMenu();
  if (!item) return;
  const input = $('input');
  input.value = slashCommandInsert(item); // complete the command; user adds args + Enter
  autoGrow();
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

// --------------------------------------------------------------------------
// History
// --------------------------------------------------------------------------
const historyView = { mode: 'smart', page: 1, renderToken: 0 };

async function refreshHistory() {
  state.index = await getIndex();
  if (!$('history').classList.contains('hidden')) await renderHistory();
}

function renderHistoryPager(pageData) {
  const pager = $('history-pager');
  const status = $('history-page-status');
  if (!pager || !status) return;
  pager.classList.toggle('hidden', pageData.total <= HISTORY_PAGE_SIZE);
  status.textContent = pageData.total
    ? `${pageData.start}-${pageData.end} of ${pageData.total}`
    : '0 of 0';
  $('history-page-prev').disabled = !pageData.hasPrev;
  $('history-page-next').disabled = !pageData.hasNext;
}

async function renderHistory(filter = '') {
  const list = $('history-list');
  list.innerHTML = '';
  const token = ++historyView.renderToken;
  const q = String(filter || '').trim();
  const conversations = new Map();
  if (q) {
    list.innerHTML = '<div class="menu-section">Searching chats…</div>';
    await Promise.all(state.index.map(async (e) => {
      const conv = state.convCache.get(e.id) || (await getConversation(e.id).catch(() => null));
      if (conv) conversations.set(e.id, conv);
    }));
  }
  if (token !== historyView.renderToken) return;
  const matches = rankConversationEntries(state.index, q, conversations, { mode: historyView.mode });
  const pageData = paginateEntries(matches, { page: historyView.page, pageSize: HISTORY_PAGE_SIZE });
  historyView.page = pageData.page;
  renderHistoryPager(pageData);
  if (!pageData.items.length) {
    list.innerHTML = q ? '<div class="menu-section">No chats match that search</div>' : '<div class="menu-section">No chats yet</div>';
    return;
  }
  list.innerHTML = '';
  for (const e of pageData.items) {
    const item = document.createElement('div');
    item.className = 'history-item' + (e.id === state.conv.id ? ' active' : '');
    const main = document.createElement('div');
    main.className = 'hi-main';
    main.innerHTML = `<div class="hi-title">${escapeAttr(e.title)}</div><div class="hi-meta">${relTime(
      e.updatedAt,
    )} · ${e.msgs} msgs</div>`;
    if (state.streams.has(e.id)) {
      const dot = document.createElement('span');
      dot.className = 'dot on';
      dot.title = 'Responding…';
      main.querySelector('.hi-meta').append(' · ', dot);
    }
    main.onclick = () => openConversation(e.id);
    const actions = document.createElement('div');
    actions.className = 'hi-actions';
    actions.appendChild(miniBtn(icon('rename'), () => startRename(e, item), 'Rename'));
    actions.appendChild(miniBtn(icon('download'), () => exportConv(e.id), 'Export as Markdown'));
    actions.appendChild(miniBtn('🗑', () => removeConv(e.id), 'Delete'));
    item.append(main, actions);
    list.appendChild(item);
  }
}

async function openConversation(id) {
  // Prefer the in-memory copy if it exists (it may be mid-stream).
  const conv = state.convCache.get(id) || (await getConversation(id));
  if (!conv) return;
  await startConversation(conv);
  $('history').classList.add('hidden');
}

// Inline rename (window.prompt is unreliable in side panels).
function startRename(e, itemEl) {
  const titleEl = itemEl.querySelector('.hi-title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'hi-rename';
  input.value = e.title;
  input.onclick = (ev) => ev.stopPropagation();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim() || e.title;
    await renameConversation(e.id, name);
    const c = state.convCache.get(e.id);
    if (c) c.title = name;
    if (state.conv.id === e.id) state.conv.title = name;
    refreshHistory();
  };
  input.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit();
    else if (ev.key === 'Escape') {
      done = true;
      refreshHistory();
    }
  };
  input.onblur = commit;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// Confirm first (a DOM modal — native confirm() is unreliable in side panels), then
// delete with an Undo toast as a second safety net.
async function removeConv(id) {
  const conv = state.convCache.get(id) || (await getConversation(id));
  if (!(await confirmDelete({
    title: 'Delete this chat?',
    body: `“${(conv && conv.title) || 'Untitled chat'}” will be deleted. You can Undo right after.`,
    confirmLabel: 'Delete chat',
  }))) return;
  const s = state.streams.get(id);
  if (s) {
    s.controller.abort();
    state.streams.delete(id);
  }
  await deleteConversation(id);
  state.convCache.delete(id);
  if (state.conv.id === id) await startConversation();
  refreshHistory();
  if (conv) {
    toastAction('Chat deleted', 'Undo', async () => {
      await saveConversation(conv);
      state.convCache.set(conv.id, conv);
      refreshHistory();
    });
  }
}

// Export one conversation as Markdown (Pro; Free users see an upgrade prompt).
async function exportConv(id) {
  if (!can(state.license, 'exportChats')) return upsell('exportChats');
  const conv = state.convCache.get(id) || (await getConversation(id));
  if (!conv) return;
  const md = conversationToMarkdown(conv);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (conv.title || 'chat').replace(/[^\w.-]+/g, '_').slice(0, 60) + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported as Markdown');
}

// --------------------------------------------------------------------------
// Misc UI
// --------------------------------------------------------------------------
// Top-bar chip: an "✨ Upgrade" call-to-action for Free users, or a "Pro"/"Team"
// status badge once subscribed. Always visible (it's the plan indicator).
function renderUpgradeChip() {
  const el = $('btn-upgrade');
  el.classList.remove('hidden');
  if (isPro(state.license)) {
    el.textContent = planLabel(state.license); // "Pro" / "Team"
    el.title = `${planLabel(state.license)} active — manage in Settings`;
    el.classList.add('is-active');
    el.classList.remove('is-upgrade');
  } else {
    el.innerHTML = icon('upgrade') + ' Upgrade';
    el.title = 'Upgrade to Pro';
    el.classList.add('is-upgrade');
    el.classList.remove('is-active');
  }
}

// Manual ("Load unpacked") builds don't auto-update — surface a one-click update
// when a newer release is out. No-ops on Web Store installs and stays dismissed
// per-version so it never nags.
async function maybeShowUpdateBanner() {
  let info;
  try {
    info = await checkForUpdate();
  } catch {
    return;
  }
  if (!info.updateAvailable || (await isDismissed(info.latest))) return;
  const banner = $('update-banner');
  $('update-banner-text').textContent = `ChatPanel ${info.latest} is available (you have ${info.current}).`;
  const link = $('update-banner-link');
  link.href = info.downloadUrl;
  $('update-banner-dismiss').onclick = async () => {
    await dismiss(info.latest);
    banner.classList.add('hidden');
  };
  banner.classList.remove('hidden');
}

function applyTheme() {
  const t = state.settings.ui?.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function applySeed(seed) {
  const input = $('input');
  if (seed.selection) {
    state.attachments.push({
      id: uid(),
      kind: 'selection',
      title: seed.title || 'Selection',
      url: seed.url,
      text: seed.selection,
      chars: seed.selection.length,
    });
    renderContextBar();
  } else if (seed.url) {
    input.value = `Tell me about ${seed.url}`;
  }
  autoGrow();
  input.focus();
}

function toast(text, ms = 1400) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// A REFUSED meeting capture is a high-intent moment — and, unlike most gates, one where
// something is actively being lost: the call is happening and nothing is being recorded.
// So state that plainly and offer the upgrade inline (no surprise tab), long enough to read.
function showMeetingLimitPrompt() {
  toastAction(
    `Meeting not being saved — Free keeps your first ${FREE_LIMITS.meetings} meetings.`,
    'Upgrade',
    () => startSubscribe('pro'),
    9000,
  );
}

// Toast with an action button (used for Undo).
function toastAction(text, label, fn, ms = 5000) {
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text + '  ';
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = label;
  btn.onclick = (e) => {
    e.stopPropagation();
    t.classList.add('hidden');
    fn();
  };
  t.append(span, btn);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function upsell(feature, msg) {
  const plan = tierFor(feature) === 'team' ? 'team' : 'pro';
  const tier = plan === 'team' ? 'Team' : 'Pro';
  // High-intent moment — open checkout and auto-activate on return (no key). The
  // storage listener flips the UI to Pro once the entitlement lands.
  toastAction(msg || `✨ ${tier} feature`, `Upgrade to ${tier}`, () => startSubscribe(plan), 4500);
}

// Seamless, keyless subscribe from the side panel: open checkout, poll, and let
// the user know the moment Pro turns on (the storage listener re-renders the UI).
function startSubscribe(plan = 'pro') {
  toast('Opening checkout… Pro activates automatically when you finish.', 2600);
  subscribe(plan, { onActivated: () => toast('✓ Pro is now active. Thank you!', 2600) });
}

// The composer grows with content up to ~45% of the panel; a manual drag (see
// wireComposerResize) pins an explicit height that wins until double-click reset.
function autoGrow() {
  // Every programmatic draft change (dictation, ✨assist, templates) funnels
  // through here — keep the redaction preview in sync without per-site wiring.
  schedulePiiPreview();
  const i = $('input');
  if (state.composerH) {
    i.style.height = state.composerH + 'px';
    i.style.overflowY = 'auto'; // manual height is fixed → allow scrolling inside it
    return;
  }
  i.style.height = 'auto';
  // Expand generously so a long prompt is visible without scrolling; only cap
  // near the full panel height. Show the scrollbar ONLY past the cap, so a fitting
  // box never shows one (matters on Windows, where scrollbars take layout space).
  const cap = Math.round(window.innerHeight * 0.75);
  i.style.height = Math.min(i.scrollHeight, cap) + 'px';
  i.style.overflowY = i.scrollHeight > cap ? 'auto' : 'hidden';
}

function wireComposerResize() {
  const handle = $('composer-resize');
  const input = $('input');
  if (!handle) return;
  let startY = 0;
  let startH = 0;
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY; // drag up → taller
    state.composerH = Math.max(38, Math.min(startH + dy, Math.round(window.innerHeight * 0.7)));
    input.style.height = state.composerH + 'px';
    e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = input.getBoundingClientRect().height;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
  handle.addEventListener('dblclick', () => {
    state.composerH = 0; // back to auto-grow
    autoGrow();
  });
}

// --------------------------------------------------------------------------
// Prompt autocomplete (Pro, opt-in) — as the user pauses typing, ask a fast API
// model for a short continuation and offer it as ghost text ("Tab to complete").
// Off by default; enabled in Settings → Preferences. Uses an API endpoint even
// when the chat agent is a local bridge agent (see autocompleteTarget).
// --------------------------------------------------------------------------
let acTimer = null;
let acController = null;
let acSuggestion = '';
let acHintShown = false;
let acBridgeHintShown = false; // one-time "CLI agents are slow for autocomplete" notice
const acSmallModel = new Map(); // endpoint → smallest model id (cached)

// For an API endpoint, query its models once and cache the smallest one to use
// for autocomplete (e.g. a 0.5B local model instead of the big chat model).
// Falls back to the endpoint's configured model if listing isn't available.
async function smallModelFor(target) {
  const key = target.baseUrl || target.name || 'default';
  if (acSmallModel.has(key)) return acSmallModel.get(key) || target.model;
  let small = null;
  try {
    small = smallestModel(await listModels(target));
  } catch {
    /* listing unavailable — fall back below */
  }
  acSmallModel.set(key, small);
  return small || target.model;
}

// Default fast model per bridge engine for autocomplete. Claude → Haiku (in-process,
// snappy). The CLI agents (codex/antigravity/pi/opencode/kiro) spawn a process per
// call, so they fall back to their default model unless the agent sets
// `autocompleteModel` — in which case that explicit choice wins (see autocompleteSource).
const FAST_MODEL = { claude: 'haiku' };

// Where autocomplete should get its suggestion, FASTEST first. Autocomplete fires
// on a 500ms pause and is superseded by the next keystroke, so the source must
// answer in well under a second. API endpoints stream a few tokens almost
// instantly; bridge agents spawn a CLI process per call (~seconds), so their
// reply usually arrives stale and gets discarded. Hence we prefer ANY configured
// API endpoint over the active bridge agent — the bridge agent is only a last
// resort when no endpoint exists.
//   1) the active agent if it's itself an API endpoint;
//   2) any other configured API endpoint with a model;
//   3) the active bridge agent → bridge /complete (slow; best-effort).
function autocompleteSource() {
  const active = resolveTarget(currentAgent(), state.settings);
  // ALWAYS prefer a fast API endpoint: inline autocomplete needs a sub-500ms
  // reply, and only a streaming API model delivers that. Bridge agents spawn a
  // CLI per call (~seconds) so they're a slow last resort, never preferred —
  // even if the user set an "Autocomplete model" on one.
  // 1) Active agent if it's itself an API endpoint.
  if (active && active.kind !== 'bridge' && active.model) return { kind: 'api', target: active };
  // 2) Any other configured API endpoint with a model (skip disabled ones — this is
  //    how "disable local models to test autocomplete" takes effect).
  for (const ep of state.settings.endpoints || []) {
    if (ep.enabled === false) continue;
    const t = resolveTarget(ep, state.settings);
    if (t && t.kind !== 'bridge' && t.model) return { kind: 'api', target: t };
  }
  // 3) Last resort — the active bridge agent via /complete (slow; only when no
  //    API endpoint exists). Honors its configured autocomplete model.
  if (active && active.kind === 'bridge') {
    const engine = active.bridgeAgent || 'claude';
    return { kind: 'bridge', engine, model: active.autocompleteModel || FAST_MODEL[engine] || '' };
  }
  return null;
}

function clearPromptSuggest() {
  clearTimeout(acTimer);
  if (acController) {
    acController.abort();
    acController = null;
  }
  acSuggestion = '';
  const ghost = $('input-ghost');
  if (ghost) ghost.innerHTML = '';
  const hint = $('prompt-suggest');
  if (hint) {
    hint.classList.add('hidden');
    hint.innerHTML = '';
  }
}

function scheduleAutocomplete() {
  clearTimeout(acTimer);
  if (acController) {
    acController.abort();
    acController = null;
  }
  acSuggestion = '';
  $('prompt-suggest').classList.add('hidden');
  // Wipe any rendered ghost immediately — on every edit (incl. backspace) the
  // prior suggestion is stale, so it must not linger over the input/placeholder.
  const ghost = $('input-ghost');
  if (ghost) ghost.innerHTML = '';
  if (!state.settings.ui?.autocomplete || !isPro(state.license) || isActiveStreaming()) return;
  const input = $('input');
  const text = input.value;
  // Need enough to continue, cursor at the very end, not a slash command.
  if (text.trim().length < 6 || text.startsWith('/')) return;
  if (input.selectionStart !== text.length) return;
  // A finished sentence has nothing to autocomplete — and asking anyway tends to
  // make the model ANSWER it instead of predicting the next words. Skip when the
  // text already ends a sentence (optionally with a closing quote/bracket).
  if (/[.?!]["'’”)\]]?\s*$/.test(text)) return;
  // Resolve where the suggestion comes from. If nothing usable (e.g. a bridge
  // agent that's offline and no API endpoint), say so once instead of silence.
  const source = autocompleteSource();
  if (!source) {
    if (!acHintShown) {
      acHintShown = true;
      const el = $('prompt-suggest');
      el.innerHTML = '<span class="ps-ghost">Autocomplete needs a model — pick an agent or add an API endpoint.</span>';
      el.classList.remove('hidden');
      el.onclick = () => chrome.runtime.openOptionsPage();
    }
    return;
  }
  // Bridge agents cold-spawn a CLI per call (~5s), so fire only after a real pause
  // (a per-keystroke request would just be aborted by the next key, never landing).
  // A fast API endpoint streams in well under a second, so keep it snappy there.
  if (source.kind === 'bridge') {
    if (!acBridgeHintShown) {
      acBridgeHintShown = true;
      toast('💡 Autocomplete via a CLI agent (Claude Code/Codex) is slow (~5s) — it only appears if you pause. Enable a fast API model for instant suggestions.', 5000);
    }
  }
  const delay = source.kind === 'bridge' ? 1100 : 500;
  acTimer = setTimeout(() => requestAutocomplete(text, source), delay);
}

// A short, de-duplicated slice of the attached context (the page/tabs/url the
// user has on), so completions are relevant to what they're looking at.
function autocompleteContext() {
  const parts = (state.attachments || []).map((a) => `${a.title ? a.title + ': ' : ''}${a.text || ''}`.trim());
  const ctx = parts.filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  return ctx.slice(0, 1200);
}

async function requestAutocomplete(text, source) {
  if (!source) return;
  acController = new AbortController();
  const ctx = autocompleteContext();
  // Frame this as a text-continuation engine (ghost text), NOT a chat task —
  // "finish the message" reads as an instruction and makes models answer. The
  // few-shot examples teach small/local models the format (raw next words, can
  // start mid-word, no reply).
  const sys =
    'You are a text autocomplete engine — like the gray ghost text in a code editor ' +
    'or a phone keyboard. Predict ONLY the next few words (at most ~6) that continue ' +
    "the user's current sentence, in their own voice. You are NOT a chat assistant: " +
    'never answer, reply, explain, greet, or start a new sentence. The continuation ' +
    'may begin mid-word. Output the raw continuation only — no quotes, no labels. If ' +
    'the text already reads as a complete sentence, output nothing.\n\n' +
    'Examples:\n' +
    'Text: "what are the main diff" -> "erences between them"\n' +
    'Text: "how do I center a" -> " div with flexbox"\n' +
    'Text: "can you summarize this" -> " page for me"\n' +
    'Text: "write a python function to" -> " parse the CSV"';
  const prompt =
    (ctx ? `Context (the page the user is viewing):\n"""\n${ctx}\n"""\n\n` : '') +
    `Continue this text with only the next few words. Do not answer it:\n${text}`;
  let out = '';
  try {
    if (source.kind === 'bridge') {
      // Fast path through the local bridge using the agent's fast model.
      const base = (state.settings.bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
      // Redact the draft + page context before it crosses to the bridge/local model
      // (this raw fetch bypasses streamChat's redaction), then restore the ghost text.
      const ac = redactOnce(prompt, state.settings);
      const res = await fetch(`${base}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: source.engine, prompt: ac.text, model: source.model, system: sys }),
        signal: acController.signal,
      });
      if (!res.ok) return;
      out = (await res.json()).text || '';
      if (ac.vault) out = restorePii(out, ac.vault);
    } else {
      // Honor an explicitly-chosen autocomplete model on the endpoint; otherwise
      // auto-pick the smallest available (e.g. a 0.5B model over the big chat one).
      const model = source.target.autocompleteModel || (await smallModelFor(source.target));
      // Fast NER (endpoint) is cheap enough to run per-autocomplete; skip only the
      // slow LLM detector here so keystroke latency stays low.
      const acR = redactionFromSettings(state.settings);
      if (acR) acR.detect = state.settings?.ui?.piiRedaction?.detection?.backend === 'endpoint';
      await streamChat({
        agent: { ...source.target, model, systemPrompt: sys, maxTokens: 16, temperature: 0.2 },
        messages: [{ role: 'user', content: prompt }],
        settings: state.settings,
        signal: acController.signal,
        redaction: acR,
        onDelta: (d) => {
          out += d;
        },
        onEvent: () => {},
      });
    }
  } catch {
    return; // aborted or failed — no suggestion
  }
  const input = $('input');
  if (input.value !== text) return; // user typed more meanwhile
  let s = out.replace(/^\s*["'“]+|["'”]+\s*$/g, '');
  // Strip an echoed copy of the user's text if the model repeated it.
  if (s.trimStart().toLowerCase().startsWith(text.trim().toLowerCase())) {
    s = s.trimStart().slice(text.trim().length);
  }
  s = s.replace(/\n[\s\S]*$/, ''); // first line only
  if (!s.trim()) return;
  // Honor the model's word-boundary signal: our few-shot prompt teaches it to emit
  // a LEADING space for a new word (" div with flexbox") and none to continue the
  // current word ("S" -> "an Francisco" = "San Francisco"). So insert a space only
  // when the model asked for one and the text doesn't already end with whitespace —
  // never fabricate one, which produced "from S an Francisco".
  const sep = /\s$/.test(text) || !/^\s/.test(s) ? '' : ' ';
  acSuggestion = sep + s.trim();
  renderGhost(text, acSuggestion);
}

// Inline ghost text: mirror the typed text (transparent) + the suggestion (dim)
// so it appears right after the cursor, VS Code style.
function renderGhost(typed, suggestion) {
  const el = $('input-ghost');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(typed));
  const s = document.createElement('span');
  s.className = 'gs';
  s.textContent = suggestion;
  el.appendChild(s);
  el.scrollTop = $('input').scrollTop;
}

function acceptPromptSuggest() {
  if (!acSuggestion) return;
  const input = $('input');
  input.value = input.value + acSuggestion; // acSuggestion already includes any leading space
  acSuggestion = '';
  $('input-ghost').innerHTML = '';
  autoGrow();
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

// Stick-to-bottom latch. During streaming we only auto-scroll while the user is
// AT the bottom. The moment they scroll up to read, the latch releases and we stop
// yanking them down — until they scroll back to the bottom themselves. (The old
// 200px "nearBottom" recheck per frame is what fought scroll-up: within 200px it
// snapped back every token.)
let stickToBottom = true;
let lastScrollTop = 0;
function scrollToBottom() {
  const m = $('messages');
  if (!m) return;
  if (!m._stickWired) {
    m._stickWired = true;
    lastScrollTop = m.scrollTop;
    m.addEventListener('scroll', () => {
      const top = m.scrollTop;
      const distance = m.scrollHeight - top - m.clientHeight;
      // Detect DIRECTION, not a threshold: ANY upward move (>2px) means the user is
      // reading → release immediately, even a slight nudge. Re-engage only once they
      // return to the very bottom. Our own scroll updates lastScrollTop below, so it
      // never looks like a user up-scroll.
      if (top < lastScrollTop - 2) stickToBottom = false;
      else if (distance < 8) stickToBottom = true;
      lastScrollTop = top;
    }, { passive: true });
  }
  if (stickToBottom) {
    m.scrollTop = m.scrollHeight;
    lastScrollTop = m.scrollTop; // record our own position so it isn't read as a scroll-up
  }
}
// Force to the bottom AND re-engage following — for fresh user actions (sending a
// message, switching conversations) where the view should jump down regardless.
function scrollToBottomNow() {
  stickToBottom = true;
  scrollToBottom();
}

// External markdown links carry their URL in data-href (no live href) so Chrome's
// speculative preloading can't prerender the target — which would load that page's
// scripts/fonts under the panel's strict CSP and flood the extension console.
// Delegated so it covers every rendered bubble; left/middle-click open a new tab.
function wireMarkdownLinks() {
  if (document._mdLinksWired) return;
  document._mdLinksWired = true;
  const open = (e, active) => {
    const a = e.target.closest?.('a.md-link');
    if (!a) return;
    // External links carry the URL in data-href (no live href); internal note/chat/
    // meeting deep links carry a live chrome-extension: href. Route both here.
    const url = a.getAttribute('data-href') || a.getAttribute('href') || '';
    if (!/^(https?:|chrome-extension:)/i.test(url)) return; // mailto: etc. → native href
    e.preventDefault();
    // A ChatPanel meeting citation (meetings.html#<id>) → open the meeting INSIDE the
    // panel instead of a new tab, so a cited source stays in context.
    const mm = /\/meetings\.html#(.+)$/.exec(url);
    if (mm) { openMeetingFromLink(decodeURIComponent(mm[1])); return; }
    chrome.tabs.create({ url, active });
  };
  document.addEventListener('click', (e) => open(e, true));
  document.addEventListener('auxclick', (e) => { if (e.button === 1) open(e, false); });
}

// --------------------------------------------------------------------------
// Drawer resize — drag the left edge of a side drawer (Meetings / live notes)
// to widen or narrow it. Both drawers share one persisted width so the layout is
// consistent. Width is clamped to [MIN, panel width].
// --------------------------------------------------------------------------
const DRAWER_WIDTH_KEY = 'cp:drawerWidth';
const DRAWER_MIN_W = 280;

function applyDrawerWidth(px) {
  document.querySelectorAll('.live-notes-drawer').forEach((d) => {
    d.style.width = `${px}px`;
    d.style.maxWidth = 'none';
  });
}

function wireDrawerResize() {
  // Always establish a concrete px width (saved or default) so BOTH drawers (live scribe
  // + past meetings) lay out and paint on their first open — without it, CSS width:88%
  // didn't resolve on Chrome's side panel until a manual resize. See sizeDrawers().
  sizeDrawers();

  document.querySelectorAll('.live-notes-resize').forEach((handle) => {
    const drawer = handle.closest('.live-notes-drawer');
    if (!drawer) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const maxW = (drawer.parentElement || document.body).getBoundingClientRect().width;
      drawer.classList.add('resizing');
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const w = drawer.getBoundingClientRect().right - ev.clientX; // right edge is fixed
        applyDrawerWidth(Math.max(DRAWER_MIN_W, Math.min(w, maxW)));
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        drawer.classList.remove('resizing');
        localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(drawer.getBoundingClientRect().width)));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------
function wireEvents() {
  $('btn-send').onclick = send;
  $('btn-stop').onclick = stopStream;
  $('btn-new').onclick = () => startConversation();
  $('btn-copy-chat').onclick = () => copyChatAsMarkdown();
  $('btn-settings').onclick = () => chrome.runtime.openOptionsPage();
  // The plan chip: Free → open the site pricing page (carrying this install's id)
  // and poll so Pro auto-activates on return; Pro/Team → open the Account tab to
  // manage the subscription.
  $('btn-upgrade').onclick = () => {
    if (isPro(state.license)) {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#license') });
    } else {
      startSubscribe('pro');
    }
  };
  $('btn-assist').onclick = improvePrompt;
  $('btn-mic').onclick = toggleDictation;
  $('btn-mcp').onclick = (e) => {
    e.stopPropagation();
    const m = $('mcp-tools-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      renderMcpToolsMenu();
      m.classList.remove('hidden');
    }
  };

  wireComposerResize();

  const input = $('input');
  input.oninput = () => {
    autoGrow();
    schedulePiiPreview();
    if (!input.value.trim()) suggestSuppressed = false;
    // Slash command palette takes precedence over the natural-language chip.
    if (!renderSlashMenu()) renderSuggest();
    scheduleAutocomplete();
  };
  input.onkeydown = (e) => {
    // Slash command palette nav takes priority while it's open.
    if (slashMenuOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashActive = (slashActive + 1) % slashItems.length; renderSlashMenu(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = (slashActive - 1 + slashItems.length) % slashItems.length; renderSlashMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseSlash(slashActive); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
    }
    // Tab accepts an autocomplete suggestion; Esc dismisses it.
    if (e.key === 'Tab' && !e.shiftKey && acSuggestion) {
      e.preventDefault();
      acceptPromptSuggest();
      return;
    }
    if (e.key === 'Escape' && acSuggestion) {
      clearPromptSuggest();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && state.settings.ui.sendOnEnter) {
      e.preventDefault();
      send();
    }
  };
  input.onblur = () => setTimeout(() => { clearPromptSuggest(); hideSlashMenu(); }, 150);
  input.addEventListener('scroll', () => {
    const g = $('input-ghost');
    if (g) g.scrollTop = input.scrollTop;
  });

  // Paste an image straight into the composer → attach it (text paste is untouched).
  input.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (!imgs.length) return; // no image on the clipboard — let the text paste happen
    e.preventDefault();
    addImageFiles(imgs);
  });
  // Drag an image file onto the composer → attach it.
  const composerBox = input.closest('.composer-box') || input;
  ['dragover', 'dragenter'].forEach((ev) =>
    composerBox.addEventListener(ev, (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault();
        composerBox.classList.add('drag-over');
      }
    }),
  );
  ['dragleave', 'dragend', 'drop'].forEach((ev) =>
    composerBox.addEventListener(ev, () => composerBox.classList.remove('drag-over')),
  );
  composerBox.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addImageFiles(files);
  });

  // Agent menu
  $('agent-button').onclick = (e) => {
    e.stopPropagation();
    const m = $('agent-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      renderAgentMenu();
      m.classList.remove('hidden');
      // Re-poll the bridge so availability is fresh (it may have just started or
      // gained a new agent like Antigravity); re-render the menu if it's still open.
      refreshBridge().then(() => {
        if (!m.classList.contains('hidden')) renderAgentMenu();
      });
    }
  };

  // Attach + skills menus
  $('btn-attach').onclick = async (e) => {
    e.stopPropagation();
    const m = $('attach-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      await renderAttachMenu();
      m.classList.remove('hidden');
    }
  };
  $('btn-skills').onclick = (e) => {
    e.stopPropagation();
    closeMenus();
    if (!skillsAllowed()) return upsell('customSkills'); // Skills are Pro
    const m = $('skills-menu');
    const opening = m.classList.contains('hidden');
    if (opening) {
      renderSkillsMenu();
      m.classList.remove('hidden');
    }
  };
  $('btn-history-context').onclick = (e) => {
    e.stopPropagation();
    const m = $('history-context-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      renderHistoryContextMenu();
      m.classList.remove('hidden');
    }
  };
  $('btn-privacy').onclick = (e) => {
    e.stopPropagation();
    const m = $('privacy-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      renderPrivacyMenu();
      m.classList.remove('hidden');
    }
  };
  // "Act on page" arms page-action tools for API agents directly and for bridge
  // agents through the local MCP relay.
  $('btn-pageact').onclick = async (e) => {
    e.stopPropagation();
    closeMenus();
    const on = !state.settings.ui?.pageActions;
    state.settings = await updateSettings({ ui: { pageActions: on } });
    renderPageActBtn();
    const agent = resolveTarget(agentForConv(state.conv), state.settings);
    if (on && agent?.kind === 'bridge') {
      toast('▶️ Act on page on. Bridge agents use browser tools through the local bridge.');
    } else if (on) {
      // Disclaimer up front: this is best-effort automation by an LLM.
      toast(
        state.activeTab
          ? '▶️ Act on page on. I’ll fill & click when asked — I can get it wrong, so review before you submit.'
          : 'Open a web tab to act on.',
      );
    }
  };

  // Watch mode: 👁 opens the popover; Start/Stop control the loop.
  $('rail-toggle').onclick = toggleRail;
  $('watch-start').onclick = () => {
    const n = Math.max(1, Number($('watch-interval-n').value) || 10);
    const unit = Number($('watch-interval-unit').value) || 1000;
    startWatch({
      instruction: $('watch-instruction').value.trim(),
      intervalMs: Math.max(5000, n * unit), // 5s floor — change-gating bounds cost
      onlyWhenChanged: $('watch-changed').checked,
    });
  };
  $('watch-stop').onclick = () => stopWatch({ hard: true });

  // History drawer
  $('btn-history').onclick = () => {
    $('history').classList.remove('hidden');
    historyView.page = 1;
    renderHistory($('history-search').value);
  };
  $('history-close').onclick = () => { historyView.renderToken += 1; $('history').classList.add('hidden'); };
  $('history-expand').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  $('btn-notes').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') });
  $('history-search').oninput = (e) => { historyView.page = 1; renderHistory(e.target.value); };
  $('history-modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    historyView.mode = b.dataset.mode === 'keyword' ? 'keyword' : 'smart';
    historyView.page = 1;
    $('history-modes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderHistory($('history-search').value);
  });
  $('history-page-prev').onclick = () => {
    historyView.page = Math.max(1, historyView.page - 1);
    renderHistory($('history-search').value);
  };
  $('history-page-next').onclick = () => {
    historyView.page += 1;
    renderHistory($('history-search').value);
  };
  // Live-notes drawer controls (Summary / Transcript tabs, search, copy, download).
  $('live-notes-close').onclick = () => closeLiveNotes();
  $('live-notes-copy').onclick = () => copyLiveNotesActive();
  $('live-notes-download').onclick = () => downloadLiveNotesActive();
  $('live-notes-sync').onclick = () => syncTranscriptNow();
  $('meeting-sync').onclick = () => syncTranscriptNow();
  $('ln-tab-summary').onclick = () => switchLiveNotesTab('summary');
  $('ln-tab-transcript').onclick = () => switchLiveNotesTab('transcript');
  $('live-notes-search').oninput = () => renderTranscript();

  // Past Meetings drawer
  $('meetings-close').onclick = () => closeMeetings();
  $('meetings-expand').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('meetings.html') });
  $('meeting-vclose').onclick = () => closeMeetings();
  $('meeting-back').onclick = () => meetingBackToList();
  $('meetings-search').oninput = (e) => renderMeetingsList(e.target.value);
  $('meetings-modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    meetingsView.mode = b.dataset.mode === 'keyword' ? 'keyword' : 'smart';
    $('meetings-modes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderMeetingsList($('meetings-search').value);
  });
  $('mv-tab-summary').onclick = () => switchMeetingTab('summary');
  $('mv-tab-transcript').onclick = () => switchMeetingTab('transcript');
  $('mv-tab-monitors').onclick = () => switchMeetingTab('monitors');
  $('meeting-search').oninput = () => renderMeetingTranscript();
  $('meeting-copy').onclick = () => copyMeetingActive();
  $('meeting-download').onclick = () => downloadMeetingActive();
  $('meeting-ask').onclick = () => askAboutMeeting();
  $('scribe-indicator').onclick = () => openMeetings();
  $('history-clear').onclick = async (e) => {
    e.stopPropagation();
    if (!(await confirmDelete({ title: 'Clear all history?', body: 'All saved chats will be permanently deleted. This can\'t be undone.', confirmLabel: 'Clear all' }))) return;
    for (const s of state.streams.values()) s.controller.abort();
    state.streams.clear();
    state.convCache.clear();
    ensureActivityTimer();
    await clearAllConversations();
    await startConversation();
    refreshHistory();
  };

  // Keep clicks inside an open menu (e.g. the URL input) from closing it.
  ['agent-menu', 'attach-menu', 'skills-menu', 'history-context-menu', 'privacy-menu', 'watch-menu'].forEach((id) =>
    $(id).addEventListener('click', (e) => e.stopPropagation()),
  );
  document.body.onclick = () => closeMenus();

  // Stop watching if the watched tab is closed.
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (state.watch.on && tabId === state.watch.tabId) stopWatch({ reason: 'watched tab closed' });
  });

  // Keep the page chip pointed at whatever tab the user is on.
  chrome.tabs.onActivated.addListener(() => refreshActiveTab());
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.status === 'complete' || info.title)) refreshActiveTab();
  });
  chrome.windows?.onFocusChanged?.addListener(() => refreshActiveTab());

  // React to settings changes from the options page (saved to storage).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes['chatpanel:settings']) {
      state.settings = await getSettings();
      applyTheme();
      renderAgentName();
      renderMcpToolsBtn();
      renderHistoryContextBtn();
      renderPrivacyBtn();
      refreshBridge();
      maybeWarmSync(); // a just-enabled warm toggle should start syncing
    }
    // WARM tier: history changed → refresh the gateway index (opt-in, debounced no-op otherwise).
    if (Object.keys(changes).some((k) => /^chatpanel:(conv|chat|meeting|note)/i.test(k))) maybeWarmSync();
    if (changes['chatpanel:license']) {
      state.license = await getLicense();
      setPiiEntitlement(isPro(state.license));
      ensureUsableActiveAgent();
      renderUpgradeChip();
      renderAgentName();
      renderHistoryContextBtn();
      renderPrivacyBtn();
    }
  });
}

function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
}

// --------------------------------------------------------------------------
// Tiny helpers
// --------------------------------------------------------------------------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function miniBtn(label, onClick, title) {
  const b = document.createElement('button');
  b.className = 'mini-btn';
  // `label` may be an icon() SVG string, a legacy emoji, or plain text.
  const svg = /^<svg/.test(label) ? label : iconForEmoji(label);
  if (svg) b.innerHTML = svg;
  else b.textContent = label;
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}
function actionItem(glyph, label, onClick) {
  const b = document.createElement('button');
  b.className = 'menu-item';
  // `glyph` may be an icon() SVG string, a legacy emoji, or plain text.
  const ic = /^<svg/.test(glyph) ? glyph : (iconForEmoji(glyph) || escapeAttr(glyph));
  b.innerHTML = `<span>${ic}</span><span>${escapeAttr(label)}</span>`;
  b.onclick = () => {
    closeMenus();
    onClick();
  };
  return b;
}
function sectionLabel(text) {
  const d = document.createElement('div');
  d.className = 'menu-section';
  d.textContent = text;
  return d;
}
function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

init();
