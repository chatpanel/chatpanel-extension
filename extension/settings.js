// ChatPanel options page — tabs: API · Agents · Skills · License.
//
//   API     — endpoints: a connection (provider + base URL + key) with a chosen
//             model and optional system prompt/tuning. Chat with one directly.
//   Agents  — the local bridge (CLI) agents: Claude Code, Codex, Antigravity CLI,
//             plus the bridge connection itself.
import { getSettings, saveSettings, uid, importAllData, resetSkillsToDefaults } from './js/store.js';
import { readZipEntry } from './js/zip.js';
import { hasDebugger } from './js/browser-api.js';
// Small, pure and dependency-free — the seed list is needed synchronously when the panel
// renders, and deferring one frozen array would cost a frame to save nothing.
import { DEFAULT_INTERNAL_PATTERNS, INTERNAL_PATTERN_CATALOG } from './js/events/sources.js';
import { icon, iconForEmoji, hydrate } from './js/icons.js';
import { getBackupState, setAutoBackupEnabled, setAutoBackupPassphrase, setAutoBackupHour, setBackupGatewayIndex, setAutoBackupDestination, setBackupDeviceName, backupDestinationIncludes, destinationAfterDriveConnect, runAutoBackup } from './js/auto-backup.js';
import { decryptBackup, isEncryptedBackup } from './js/crypto-backup.js';
import { googleDriveRedirectUri, connectGoogleDrive, disconnectGoogleDrive, getGoogleDriveConnection, listGoogleDriveBackups, downloadGoogleDriveBackup, googleDriveBackupDevice, latestGoogleDriveBackupsByDevice } from './js/drive-backup.js';
import { checkBridge, updateBridge, testAgent, listModelOptions, listBridgeModels, checkAgentCommand, previewRedaction, traceFlow } from './js/providers.js';
import { buildToolset } from './js/toolset.js';
import { getMcpProviders } from './js/mcp-manager.js';
import { historyToolProvider } from './js/history-rag.js';
import { webSearchToolProvider, webSearchOpts, webSearchUsage } from './js/web-search.js';
import { fullRedactionUsage } from './js/pii-usage.js';
import { sanitizeUnicode } from './js/sanitize.js';
import { PAGE_MODES, migratePageActions, listSites, forgetSite, denySite } from './js/page-policy.js';
import { narrowToolset, isLocalToolSpec } from './js/tool-select.js';
// A leaf with nothing behind it — the same arithmetic the history drawer pages with.
import { paginateEntries } from './js/paginate.js';
import { DEFAULT_AUTO_TOOL_CAP } from './js/tool-policy.js';
import {
  applyOAuthPreset,
  connectOAuthEndpoint,
  disconnectOAuthEndpoint,
  getOAuthToken,
  hasOAuthConfig,
  isOAuthMode,
  oauthConfigMessage,
  oauthProvider,
  oauthProviderId,
  oauthRedirectUri,
  oauthSetupHelp,
  oauthStatusLabel,
} from './js/oauth.js';
import { testMcpServer } from './js/mcp-manager.js';
import { MCP_CATALOG } from './js/mcp-catalog.js';
import { argsToText, parseArgsInput, parseMcpConfig } from './js/mcp-config-import.js';
import { fetchMcpRegistryPage } from './js/mcp-registry.js';
import { searchModels, formatDownloads } from './js/model-registry.js';
import { assistPrompt } from './js/assist.js';
import { isSkillEnabled } from './js/skill-runtime.js';
import { lintSkillPrompt } from './js/events/skill-vars.js';
import { checkForUpdate, currentVersion, DOWNLOAD_URL } from './js/update.js';
import { agentBrand, applyProviderPreset, orderedProviderPresets, providerBrand, providerPresetById, providerPresetForEndpoint } from './js/provider-presets.js';
import { anyExpanded, forgetCard, setAllExpanded, setExpanded, wireCollapsible } from './js/collapse-cards.js';
import { filterComboboxOptions, normalizeComboboxOptions } from './js/combobox.js';
import { WEBLLM_ALL_MODELS, WEBLLM_RECOMMENDED, DEFAULT_WEBLLM_MODEL, deleteModel as deleteWebllmModel } from './js/webllm.js';
import { webgpuSupport } from './js/webgpu-support.js';
import { parseJsonObject, prettyJson, sanitizeExtraBody, sanitizeExtraHeaders } from './js/request-options.js';
import { clearEndpointModelState, endpointErrorAuthStatus, modelListAuthStatus } from './js/settings-endpoint.js';
import { localStorageHealth, localBytesInUse } from './js/storage-health.js';
import { checkGateway, getGatewayConfig, getGatewayLogs, getGatewayObservability, clearGatewayHistory, setGatewayConfig, ensureGatewayEntitlement, normalizeGatewayUrl, parseDictionary, stringifyDictionary, getNerModels, setNerModel, getSttModels, setSttModel, getDiarizeModel, downloadDiarizeModel, setGatewayToken, handshakeGatewayToken } from './js/gateway.js';
import { createVault, redactText } from './js/pii-redact.js';
import { detectEntities } from './js/pii-detect.js';
import {
  getLicense,
  getEntitlementToken,
  can,
  isPro,
  deactivate,
  subscribe,
  restoreByEmail,
  recheckEntitlement,
  isOptedOut,
  planOf,
  planLabel,
  freeEndpointId,
  freeAgentId,
  FREE_LIMITS,
  PRO_FEATURES,
  TEAM_FEATURES,
} from './js/license.js';

const $ = (id) => document.getElementById(id);
let settings;
let license;
let bridgeState = { ok: false, agents: [] };
let mcpRegistryState = { query: '', items: [], nextCursor: '', loaded: false, loading: false, error: '' };

async function init() {
  settings = await getSettings();
  license = await getLicense();
  // Catch a just-completed checkout / sync-restore the moment Settings opens —
  // unless the user deliberately released Pro on this device (opt-out). Also
  // re-check whenever this tab regains focus: buying happens in ANOTHER tab, so
  // coming back here is the moment the purchase is most likely to have landed.
  isOptedOut().then((opted) => {
    if (opted) return;
    const check = () =>
      recheckEntitlement().then((lic) => {
        // Announce only a real change — an already-Pro user reopening Settings
        // shouldn't be told "Pro is now active" every time.
        if (lic) onProActivated(lic, planOf(license) === 'free');
      });
    check();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && planOf(license) === 'free') check();
    });
  });

  renderAbout();
  renderStorageHealth();

  wireTabs();
  // Bind the static controls BEFORE rendering any cards: a render() that throws
  // (e.g. a stale template missing an element) must not leave every button dead.
  wire();
  renderEndpoints();
  renderBridge();
  renderMcpServers();
  renderSkills();
  renderPrefs();
  setupNotesPrefs();
  setupMemoryPrefs();
  renderLicense();
  wireGateway();
  renderGateway();
  wireChannels(); // rendering is lazy (on tab open); binding is not, so no button is ever dead
  wireUsage();
  refreshBridgeState();
  loadMcpRegistry({ reset: true });
}

// --------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------
function wireTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const show = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document
      .querySelectorAll('.panel')
      .forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    // Usage renders lazily and only when visible — trigger it whenever the panel
    // is shown (a Cmd+R deep-link to #usage or last-tab restore reveals it without
    // a click), else it sits at the static "Loading…" placeholder forever.

    // Same lazy rule as usage: the log module and the analysis load only when this tab is
    // actually shown, so a user who never opens Activity never pays for it.
    if (name === 'activity') { renderObservability(); renderUsage(); renderActivity(); }
    if (name === 'plugins') { renderPlugins(); loadRoutingForm(); renderRouting(); renderRoutingModels(); }
    if (name === 'channels') renderChannels();
  };
  const exists = (name) => !!document.querySelector(`.tab[data-tab="${name}"]`);

  // Remember which collapsible sections a person closed (Workspace + Privacy). A per-viewer
  // convenience, so localStorage is the right home — every read and write guarded, because a
  // private window or blocked site data throws rather than returning empty.
  function wireCollapsibleSections() {
    const KEY = 'cp:settings:ws-collapsed';
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { /* no store */ }
    for (const el of document.querySelectorAll('details.ws-section')) {
      if (collapsed.has(el.id)) el.open = false;
      el.addEventListener('toggle', () => {
        try {
          const set = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
          if (el.open) set.delete(el.id); else set.add(el.id);
          localStorage.setItem(KEY, JSON.stringify([...set]));
        } catch { /* private window — the section still toggles, it just won't be remembered */ }
      });
    }
  }
  const showAlias = (name) => {
    const a = TAB_ALIAS[name];
    show(a.tab);
    jumpToSection(a.section, { flash: false });
  };
  const select = (name) => {
    show(name);
    // Use replaceState, NOT location.hash: a panel like "skills" shares its id
    // with the <div id="skills"> list, so setting location.hash would make the
    // browser scroll to that element (the "jump"). replaceState updates the URL
    // without scrolling.
    history.replaceState(null, '', '#' + name);
    // Remember the last tab so the gear icon reopens where you left off.
    chrome.storage.local.set({ [K_SETTINGS_TAB]: name }).catch(() => {});
  };
  tabs.forEach((t) => (t.onclick = () => {
    select(t.dataset.tab);
    window.scrollTo({ top: 0 });
  }));
  wireCollapsibleSections();
  // Priority: an explicit #hash (e.g. the Pro chip opens #license), else the
  // last-opened tab, else the default (API).
  const fromHash = (location.hash || '').replace('#', '');
  if (fromHash && TAB_ALIAS[fromHash]) {
    showAlias(fromHash);
    return;
  }
  if (fromHash && exists(fromHash)) {
    show(fromHash);
    return;
  }
  chrome.storage.local.get(K_SETTINGS_TAB).then((g) => {
    const last = g[K_SETTINGS_TAB];
    if (last && TAB_ALIAS[last]) show(TAB_ALIAS[last].tab);
    else if (last && exists(last)) show(last);
  });
}
const K_SETTINGS_TAB = 'chatpanel:settingsTab';

// Tabs that used to exist and are now SECTIONS of another tab. Notes/Meetings/History
// folded into Workspace; Gateway folded into Privacy. Old deep-links (#notes, #gateway,
// used by notes.js/meetings.js and any stored last-tab) must keep landing on the thing
// they name, so each alias resolves to a tab plus the section to open inside it.
const TAB_ALIAS = {
  notes: { tab: 'workspace', section: 'ws-notes' },
  meetings: { tab: 'workspace', section: 'ws-meetings' },
  history: { tab: 'workspace', section: 'ws-history' },
  gateway: { tab: 'privacy', section: 'pv-gateway' },
};

// Land ON a section, not merely on the panel that contains it. Opens every collapsed
// <details> above the target first — a closed summary hides the very control the link
// promised. A target inside a container that is hidden for a reason (the gateway config
// before the gateway connects) can't be scrolled to at all, so fall back to the nearest
// visible ancestor section instead of scrolling nowhere.
function jumpToSection(id, { flash = true } = {}) {
  let el = id && document.getElementById(id);
  if (!el) return;
  const openAncestors = (node) => {
    for (let n = node; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  };
  openAncestors(el);
  if (!el.getClientRects().length) {
    const fb = el.closest('.hidden')?.parentElement?.closest('details.ws-section');
    if (!fb) return;
    openAncestors(fb);
    el = fb;
  }
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (!flash) return;
  el.classList.add('config-flash');
  setTimeout(() => el.classList.remove('config-flash'), 1400);
}

// A collapsed section still has to say what state it is in — "is redaction on", "is the
// gateway running" must be answerable without expanding three sections to find out.
function setSectionBadge(id, text, tone = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = `pv-badge${tone ? ' ' + tone : ''}${text ? '' : ' hidden'}`;
}

// "Go to the gateway" — it is a section of the Privacy tab now, not a tab of its own, so
// every in-page link to it goes through here rather than clicking a tab that no longer exists.
function openGatewaySection() {
  document.querySelector('.tab[data-tab="privacy"]')?.click();
  jumpToSection('pv-gateway');
}

// Cross-links inside a panel ("Manage NER models →", the Privacy overview chips) point at a
// section id with data-jump, so adding one is markup-only.
function wireSectionJumps() {
  for (const b of document.querySelectorAll('[data-jump]')) {
    b.addEventListener('click', (e) => { e.preventDefault(); jumpToSection(b.dataset.jump); });
  }
}

// --------------------------------------------------------------------------
// Memory — the management view.
//
// This page is not a nicety. Memory is the one feature that puts words in front of a model on
// the user's behalf on EVERY turn, so it has to be readable in one screen, correctable in one
// click and deletable without ceremony — otherwise the honest advice would be to turn it off.
// Hence: full text always shown (never truncated), edit in place, and every row says where it
// came from.
// --------------------------------------------------------------------------
// The store and the contract are loaded on FIRST RENDER, not at module top: this page already
// pulls a megabyte, and the memory list is one section of one tab of nine. Cached after the
// first call, so the toggles and every later re-render are free.
let memoryApi = null;
async function memoryModule() {
  if (!memoryApi) {
    const [store, contract] = await Promise.all([
      import('./js/store-memory.js'),
      import('./js/events/memory.js'),
    ]);
    memoryApi = { ...store, ...contract };
  }
  return memoryApi;
}

function setupMemoryPrefs() {
  const en = $('memory-enabled');
  const offers = $('memory-offers');
  if (en) {
    en.checked = settings.ui?.memory?.enabled !== false;
    en.onchange = () => {
      settings.ui = settings.ui || {};
      settings.ui.memory = { ...(settings.ui.memory || {}), enabled: en.checked };
      saveSettings(settings);
      if (offers) offers.disabled = !en.checked;
    };
  }
  if (offers) {
    offers.checked = settings.ui?.memory?.offers !== false;
    offers.disabled = settings.ui?.memory?.enabled === false;
    offers.onchange = () => {
      settings.ui = settings.ui || {};
      settings.ui.memory = { ...(settings.ui.memory || {}), offers: offers.checked };
      saveSettings(settings);
    };
  }
  if ($('memory-add')) $('memory-add').onclick = addMemoryRow;
  if ($('memory-clear')) {
    $('memory-clear').onclick = async () => {
      const { getMemories, clearAllMemories } = await memoryModule();
      const all = await getMemories();
      if (!all.length) return;
      // Irreversible and unrecoverable — memory is the one store with no source to rebuild
      // it from, so this is the one place a confirm is worth the friction.
      if (!confirm(`Forget all ${all.length} memories? This cannot be undone.`)) return;
      await clearAllMemories();
      renderMemories();
    };
  }
  renderMemories();
}

async function renderMemories() {
  const list = $('memory-list');
  if (!list) return;
  const { getMemories } = await memoryModule();
  const all = await getMemories().catch(() => []);
  const count = $('memory-count');
  if (count) count.textContent = all.length ? `— ${all.length} of ${200} kept` : '';
  list.innerHTML = '';
  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'mem-empty';
    empty.textContent = 'Nothing remembered yet. Say “remember that …” in a chat, or add one here.';
    list.append(empty);
    return;
  }
  for (const m of all) list.append(memoryRow(m, memoryApi));
  hydrate(list);
}

function memoryRow(m, { MEMORY_KINDS, MEMORY_KIND_NAMES, MAX_MEMORY_CHARS, forgetMemory, updateMemory }) {
  const row = document.createElement('div');
  row.className = 'memory-row';

  const kind = document.createElement('select');
  kind.className = 'mem-kind';
  for (const k of MEMORY_KIND_NAMES) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    opt.selected = k === m.kind;
    kind.append(opt);
  }
  kind.title = MEMORY_KINDS[m.kind]?.hint || '';
  kind.onchange = async () => { await updateMemory(m.id, { kind: kind.value }); renderMemories(); };

  const body = document.createElement('div');
  body.className = 'mem-body';

  // A textarea, not a truncated line: a memory the user cannot read in full is one they
  // cannot judge, and judging them is the entire purpose of this list.
  const text = document.createElement('textarea');
  text.className = 'mem-text';
  text.rows = 1;
  text.maxLength = MAX_MEMORY_CHARS;
  text.value = m.text;
  const grow = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight}px`; };
  text.oninput = grow;
  text.onblur = async () => {
    const next = text.value.trim();
    if (!next || next === m.text) { text.value = m.text; grow(); return; }
    try { await updateMemory(m.id, { text: next }); } catch { text.value = m.text; }
    renderMemories();
  };
  requestAnimationFrame(grow);

  const meta = document.createElement('div');
  meta.className = 'mem-meta';
  const via = m.source?.via === 'agent' ? `saved by ${m.source.agent || 'an agent'}` : 'saved by you';
  const when = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : '';
  const used = m.useCount ? ` · used ${m.useCount}×` : '';
  const was = m.history?.length ? ` · was “${m.history.at(-1).text}”` : '';
  meta.textContent = [via, when].filter(Boolean).join(' · ') + used + was;

  body.append(text, meta);

  const actions = document.createElement('div');
  actions.className = 'mem-actions';

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = `mem-btn${m.pinned ? ' on' : ''}`;
  pin.title = m.pinned ? 'Always included — click to unpin' : 'Pin: always include this one';
  pin.textContent = m.pinned ? '★' : '☆';
  pin.onclick = async () => { await updateMemory(m.id, { pinned: !m.pinned }); renderMemories(); };

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'mem-btn';
  del.title = 'Forget this';
  del.textContent = '✕';
  del.onclick = async () => { await forgetMemory(m.id); renderMemories(); };

  actions.append(pin, del);
  row.append(kind, body, actions);
  return row;
}

async function addMemoryRow() {
  const text = prompt('What should ChatPanel remember about you?\n\nOne short sentence, e.g. “Prefers terse answers with no preamble”.');
  if (!text?.trim()) return;
  try {
    const { rememberMemory } = await memoryModule();
    await rememberMemory({ text: text.trim(), kind: 'preference', source: { via: 'user', surface: 'settings' } });
  } catch (e) {
    alert(e.message || 'Could not save that memory.');
  }
  renderMemories();
}

// --------------------------------------------------------------------------
// Notes tab — the notes editor's own preferences. Editor view + co-writer live
// in localStorage (shared across every extension page, the same source the notes
// editor reads, so it picks changes up on next load). The @insert tool overrides
// live in settings.ui.notes so buildTurnTools can honor them per surface.
// --------------------------------------------------------------------------
const NOTES_COWRITER_KEY = 'chatpanel.notes.cowriter';

function setupNotesPrefs() {
  const cw = $('notes-cowriter-enabled');
  if (cw) {
    cw.checked = localStorage.getItem(NOTES_COWRITER_KEY) === '1';
    cw.onchange = () => localStorage.setItem(NOTES_COWRITER_KEY, cw.checked ? '1' : '0');
  }
  // Per-Notes @insert tool overrides — checked (default) follows the global setting;
  // unchecked forces the tool OFF for note commands only.
  const nt = settings.ui?.notes?.tools || {};
  const bindTool = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.checked = nt[key] !== false;
    el.onchange = () => {
      settings.ui = settings.ui || {};
      settings.ui.notes = settings.ui.notes || {};
      settings.ui.notes.tools = { ...(settings.ui.notes.tools || {}), [key]: el.checked };
      saveSettings(settings);
    };
  };
  bindTool('notes-tool-websearch', 'webSearch');
  bindTool('notes-tool-mcp', 'mcp');
  bindTool('notes-tool-history', 'history');
  // Inline autocomplete — on/off + which configured agent/model predicts (empty = the
  // active agent). Stored under settings.ui.notes.autocomplete; the notes page reads it.
  const acCfg = settings.ui?.notes?.autocomplete || {};
  const acEn = $('notes-ac-enabled');
  const acModel = $('notes-ac-model');
  if (acModel) {
    acModel.innerHTML = '';
    const add = (val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; acModel.appendChild(o); };
    add('', 'Active agent (default)');
    for (const ep of settings.endpoints || []) if (ep?.model) add(ep.id, ep.name || ep.model);
    for (const ag of settings.agents || []) add(ag.id, ag.name || ag.bridgeAgent || 'Agent');
    acModel.value = acCfg.agentId || '';
  }
  const saveAc = () => {
    settings.ui = settings.ui || {};
    settings.ui.notes = settings.ui.notes || {};
    settings.ui.notes.autocomplete = { enabled: !!(acEn && acEn.checked), agentId: (acModel && acModel.value) || '' };
    saveSettings(settings);
  };
  if (acEn) { acEn.checked = !!acCfg.enabled; acEn.onchange = saveAc; }
  if (acModel) acModel.onchange = saveAc;
  // Cross-links: switch tabs in-page (reuse the tab button) rather than reopen.
  const jump = (btnId, tab) => {
    const b = $(btnId);
    if (!b) return;
    b.onclick = () => {
      const t = document.querySelector(`.tab[data-tab="${tab}"]`);
      if (t) { t.click(); window.scrollTo({ top: 0 }); }
      else chrome.tabs.create({ url: chrome.runtime.getURL(`settings.html#${tab}`) });
    };
  };
  jump('notes-open-agents', 'agents');
  jump('notes-open-privacy', 'privacy');
  jump('notes-open-backup', 'license');
  const dash = $('open-notes-dashboard');
  if (dash) dash.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') });
}

// --------------------------------------------------------------------------
// Model picker: custom combobox that filters in an anchored popup while still
// accepting any free-typed model id.
// --------------------------------------------------------------------------
function normalizeStoredModelOptions(models, modelOptions) {
  const byId = new Map();
  for (const m of modelOptions || []) {
    if (m?.id) byId.set(m.id, m);
  }
  for (const id of models || []) {
    if (id && !byId.has(id)) byId.set(id, { id, label: id, free: false });
  }
  return [...byId.values()];
}

function ensureCombobox(input) {
  if (input.parentElement?.classList.contains('combo')) {
    return {
      wrap: input.parentElement,
      menu: input.parentElement.querySelector('.combo-menu'),
      toggle: input.parentElement.querySelector('.combo-toggle'),
      lead: input.parentElement.querySelector('.combo-lead'),
    };
  }
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.insertAdjacentElement('beforebegin', wrap);
  wrap.appendChild(input);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  // Lead monogram: shown only when the committed value matches an option that
  // carries an icon (e.g. the provider picker). Generic comboboxes leave it
  // hidden, so there's no visual change for model/agent fields.
  const lead = document.createElement('span');
  lead.className = 'combo-lead hidden';
  lead.setAttribute('aria-hidden', 'true');
  wrap.appendChild(lead);

  const toggle = document.createElement('button');
  toggle.className = 'combo-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Show options');
  toggle.innerHTML = icon('caret');
  wrap.appendChild(toggle);

  const menu = document.createElement('div');
  menu.className = 'combo-menu hidden';
  menu.setAttribute('role', 'listbox');
  wrap.appendChild(menu);
  return { wrap, menu, toggle, lead };
}

// An icon chip is either a bundled brand logo (on a white tile) or a colored
// monogram. comboIconHtml builds the markup string; applyComboIcon mutates an
// existing element (used for the lead chip).
function comboIconHtml(icon, cls) {
  if (icon?.logo) {
    return `<span class="${cls} is-img"><img src="${escapeHtml(icon.logo)}" alt="" loading="lazy"></span>`;
  }
  return `<span class="${cls}" style="--logo-bg:${escapeHtml(icon?.color || '#64748b')}">${escapeHtml(icon?.mark || '?')}</span>`;
}
function applyComboIcon(el, icon) {
  if (icon?.logo) {
    el.classList.add('is-img');
    el.style.removeProperty('--logo-bg');
    el.innerHTML = `<img src="${escapeHtml(icon.logo)}" alt="" loading="lazy">`;
  } else {
    el.classList.remove('is-img');
    el.style.setProperty('--logo-bg', icon?.color || '#64748b');
    el.textContent = icon?.mark || '?';
  }
}

// Show/hide the lead chip based on whether the current value matches an option
// that carries an icon.
function syncComboLead(input, state) {
  const lead = state?.lead;
  if (!lead) return;
  const value = String(input.value || '');
  const match = state.options.find((o) => o.value === value);
  const icon = match?.icon;
  if (icon) {
    applyComboIcon(lead, icon);
    lead.classList.remove('hidden');
    input.classList.add('combo-has-lead');
  } else {
    lead.classList.add('hidden');
    input.classList.remove('combo-has-lead');
  }
}

function renderCombobox(input, state, open = true, showAll = false) {
  // When the field shows a committed selection, opening it (focus/toggle) must
  // list every option — filtering by the displayed value would hide all but the
  // current pick. Only narrow the list once the user actually types a query.
  const matches = filterComboboxOptions(state.options, showAll ? '' : input.value);
  const menu = state.menu;
  menu.innerHTML = '';
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = input.value ? 'No matches. Press Enter or Save to keep this value.' : state.emptyText;
    menu.appendChild(empty);
  } else {
    for (const option of matches) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'combo-item';
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      const textHtml = `<span>${escapeHtml(option.value)}</span>${option.meta ? `<small>${escapeHtml(option.meta)}</small>` : ''}`;
      if (option.icon) {
        item.classList.add('has-logo');
        item.innerHTML = comboIconHtml(option.icon, 'combo-logo') + `<span class="combo-text">${textHtml}</span>`;
      } else {
        item.innerHTML = textHtml;
      }
      // Suppress the mousedown default so the input keeps focus while selecting.
      // Otherwise clicking an option blurs the input first, firing its native
      // `change` on the half-typed query — which (for the provider picker)
      // resolves to Custom and re-renders the menu, removing this button before
      // the click can land. That's the "reverts to Custom when picked by mouse"
      // bug. Keep click for the actual commit (also used by keyboard activation).
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.onclick = () => {
        input.value = option.value;
        closeCombobox(state);
        syncComboLead(input, state);
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      menu.appendChild(item);
    }
  }
  menu.classList.toggle('hidden', !open);
  input.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeCombobox(state) {
  state.menu.classList.add('hidden');
  state.input.setAttribute('aria-expanded', 'false');
}

function wireCombobox(input, options, current, placeholder, emptyText = 'No options loaded yet. Type any value.') {
  const normalized = normalizeComboboxOptions(options);
  const existing = input._chatpanelCombo;
  const parts = existing || ensureCombobox(input);
  const state = {
    input,
    menu: parts.menu,
    toggle: parts.toggle,
    lead: parts.lead || existing?.lead || null,
    options: normalized,
    emptyText,
  };
  input._chatpanelCombo = state;
  input.value = current ?? input.value ?? '';
  input.placeholder = placeholder;
  input.removeAttribute('list');

  if (!existing) {
    input.addEventListener('focus', () => renderCombobox(input, input._chatpanelCombo, true, true));
    input.addEventListener('input', () => {
      renderCombobox(input, input._chatpanelCombo, true);
      syncComboLead(input, input._chatpanelCombo);
    });
    input.addEventListener('keydown', (event) => {
      const currentState = input._chatpanelCombo;
      if (event.key === 'Escape') {
        closeCombobox(currentState);
        return;
      }
      // Tab (not Shift+Tab) accepts the option when the query has narrowed to a
      // single match, then lets focus advance normally (no preventDefault).
      if (event.key === 'Tab' && !event.shiftKey) {
        const items = currentState.menu.querySelectorAll('.combo-item');
        if (!currentState.menu.classList.contains('hidden') && items.length === 1) items[0].click();
        return;
      }
      if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
      const first = currentState.menu.querySelector('.combo-item');
      if (!first) return;
      event.preventDefault();
      first.click();
    });
    state.toggle.addEventListener('click', () => {
      const currentState = input._chatpanelCombo;
      const open = currentState.menu.classList.contains('hidden');
      renderCombobox(input, currentState, open, true);
      input.focus();
    });
    document.addEventListener('click', (event) => {
      const currentState = input._chatpanelCombo;
      if (!currentState?.input?.parentElement?.contains(event.target)) closeCombobox(currentState);
    });
  }
  renderCombobox(input, state, false);
  syncComboLead(input, state);
}

function populateModelSelect(sel, customEl, models, current, modelOptions) {
  const options = normalizeStoredModelOptions(models, modelOptions);
  wireCombobox(
    sel,
    options,
    current,
    options.length ? 'Search or type a model id' : 'Click Load models or type a model id',
    'Click Load models or type a model id',
  );
  customEl?.classList.add('hidden');
  if (customEl) customEl.value = '';
}
function wireModelSelect(sel, customEl, models, current, modelOptions) {
  populateModelSelect(sel, customEl, models, current, modelOptions);
}
function readModel(sel, customEl) {
  return (sel.value === '__custom__' ? customEl?.value : sel.value).trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

// --------------------------------------------------------------------------
// API endpoints
// --------------------------------------------------------------------------
function customEndpointCount() {
  return (settings.endpoints || []).filter((e) => !e.builtin).length;
}

// Free may configure its own endpoints up to FREE_LIMITS.apiEndpoints; the
// shipped built-ins (in-browser WebLLM, local Ollama) don't count against it.
function endpointAddLocked() {
  return !isPro(license) && customEndpointCount() >= FREE_LIMITS.apiEndpoints;
}

function providerPresetDisplayName(id) {
  return providerPresetById(id)?.name || providerPresetById('custom')?.name || 'Custom / self-hosted';
}

function providerPresetOptions() {
  return orderedProviderPresets().map((preset) => ({
    value: preset.name,
    label: preset.id,
    icon: providerBrand(preset.id),
  }));
}

function providerPresetIdFromInput(input) {
  const value = String(input?.value || '').trim();
  const current = input?.dataset.providerPreset;
  const currentPreset = providerPresetById(current);
  if (currentPreset && (!value || value === currentPreset.name || value === currentPreset.id)) return currentPreset.id;
  const match = orderedProviderPresets().find((preset) => (
    preset.name.toLowerCase() === value.toLowerCase() ||
    preset.id.toLowerCase() === value.toLowerCase()
  ));
  return match?.id || 'custom';
}

function setProviderPresetInput(input, id) {
  const preset = providerPresetById(id) || providerPresetById('custom');
  input.dataset.providerPreset = preset?.id || 'custom';
  input.value = preset?.name || 'Custom / self-hosted';
}

function populateProviderPresetSelect(input, current) {
  const id = providerPresetById(current) ? current : 'custom';
  wireCombobox(
    input,
    providerPresetOptions(),
    providerPresetDisplayName(id),
    'Search providers or choose Custom',
    'No providers match. Choose Custom for a private endpoint.',
  );
  input.dataset.providerPreset = id;
}

// In-browser (WebLLM) endpoint editor: no baseUrl / key / provider — just a curated
// on-device model picker (with download sizes) + a note and a "remove downloaded
// model" button. We hide the API-endpoint fields that would only confuse here.
function applyWebllmEndpointUi(node, q, ep) {
  // The API-style <select> has no 'webllm' option, so ensure one exists and is
  // selected — otherwise a Save would read the first option and silently turn this
  // into an 'openai' endpoint (breaking in-browser routing). The field stays hidden.
  const kindSel = q('.ep-kind');
  if (kindSel) {
    if (!Array.from(kindSel.options).some((o) => o.value === 'webllm')) {
      const o = document.createElement('option');
      o.value = 'webllm'; o.textContent = 'In-browser (WebGPU)';
      kindSel.appendChild(o);
    }
    kindSel.value = 'webllm';
  }
  // Keep the Provider picker visible (WebLLM is now a real provider choice, so the user
  // must be able to switch back to an HTTP provider) — only the API-style select is fixed.
  q('.ep-kind')?.closest('.field')?.classList.add('hidden');                        // API style (fixed to webllm)
  q('.ep-baseurl')?.closest('.row')?.classList.add('hidden');                       // Base URL
  node.querySelectorAll('.endpoint-section')[0]?.classList.add('hidden');           // Authentication section
  q('.ep-acmodel')?.closest('.row')?.classList.add('hidden');                        // Autocomplete model
  q('.ep-load')?.classList.add('hidden');                                            // Load models (N/A)
  q('.ep-test')?.classList.add('hidden');                                            // Test (N/A)

  // Full on-device catalog (~159 models) + any user-added custom models, searchable;
  // customs and recommended first, then by size. Persists to ep.model on Save.
  const rec = new Set(WEBLLM_RECOMMENDED);
  const custom = (settings.webllmCustomModels || []).filter((c) => c && c.id);
  const opts = [
    ...custom.map((c) => ({ id: c.id, label: `⚙ ${c.id} · custom`, free: true })),
    ...[...WEBLLM_ALL_MODELS]
      .sort((a, b) => (rec.has(b.id) - rec.has(a.id)) || (a.mb - b.mb))
      .map((m) => ({
        id: m.id,
        label: `${rec.has(m.id) ? '★ ' : ''}${m.id.replace(/-MLC$/, '')} · ~${m.mb} MB${m.ctx ? ` · ${Math.round(m.ctx / 1024)}k ctx` : ''}`,
        free: true,
      })),
  ];
  const ids = [...custom.map((c) => c.id), ...WEBLLM_ALL_MODELS.map((m) => m.id)];
  wireModelSelect(q('.ep-model'), q('.ep-model-custom'), ids, ep.model || DEFAULT_WEBLLM_MODEL, opts);

  const section = q('.ep-model')?.closest('.endpoint-section');
  if (section && !section.querySelector('.ep-webllm-extra')) {
    const extra = document.createElement('div');
    extra.className = 'row ep-webllm-extra';
    const note = document.createElement('p');
    note.className = 'muted tiny';
    note.textContent = 'Runs 100% in your browser on WebGPU — no API key, no server, works offline after a one-time download. Bigger models give better answers.';
    // …unless this browser's WebGPU can't actually load it. Say so HERE, next to the
    // model picker, rather than letting the user choose a model and discover it at send
    // time (or after a ~700 MB download). Async + best-effort: the generic copy above
    // stands until the probe answers.
    webgpuSupport().then((gpu) => {
      if (gpu.ok || !note.isConnected) return;
      note.textContent = `⚠ ${gpu.message}`;
      note.classList.add('warn');
    }).catch(() => { /* no verdict — leave the generic copy */ });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost ep-webllm-remove';
    btn.textContent = 'Remove downloaded model';
    btn.title = 'Delete the selected model’s weights from browser storage to reclaim disk';
    btn.addEventListener('click', async () => {
      const id = readModel(q('.ep-model'), q('.ep-model-custom')) || ep.model;
      if (!id) return;
      const was = btn.textContent; btn.disabled = true; btn.textContent = 'Removing…';
      try { await deleteWebllmModel(id); btn.textContent = 'Removed ✓'; }
      catch (e) { btn.textContent = 'Failed'; console.warn('[chatpanel] remove webllm model', e); }
      setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 2000);
    });
    // "Stay warm" toggle lives right here by the model, not buried in general prefs —
    // it only means anything for the in-browser model. Writes the global ui flag.
    const bgLabel = document.createElement('label');
    bgLabel.className = 'check';
    const bgCb = document.createElement('input');
    bgCb.type = 'checkbox';
    bgCb.checked = settings.ui?.webllmBackground === true;
    bgCb.addEventListener('change', async () => {
      settings.ui = settings.ui || {};
      settings.ui.webllmBackground = bgCb.checked;
      await saveSettings(settings);
    });
    const bgText = document.createElement('span');
    bgText.innerHTML = ' Keep the model loaded in the background <span class="sub">— stays warm across panel open/close so there’s no reload wait; uses more memory while idle. Falls back automatically if unsupported.</span>';
    bgLabel.append(bgCb, bgText);
    extra.appendChild(note);
    extra.appendChild(bgLabel);
    extra.appendChild(btn);
    section.appendChild(extra);
  }
  if (section && !section.querySelector('.ep-webllm-cm')) {
    section.appendChild(buildWebllmCustomModelsUi());
  }
}

// Advanced: manage user-added MLC models ({ id, model, model_lib }). They're global
// (settings.webllmCustomModels) and appear in the model picker with a ⚙ marker.
function buildWebllmCustomModelsUi() {
  const wrap = document.createElement('div');
  wrap.className = 'row ep-webllm-cm';
  const title = document.createElement('p');
  title.className = 'muted tiny';
  title.innerHTML = 'Custom MLC models (advanced) — add an <a href="https://github.com/mlc-ai/web-llm#custom-models" target="_blank" rel="noopener">MLC-converted</a> model: an id, its weights URL (HF repo), and its model-lib WASM URL.';
  const list = document.createElement('div');
  list.className = 'ep-webllm-cm-list';
  const renderList = () => {
    list.innerHTML = '';
    for (const c of settings.webllmCustomModels || []) {
      const row = document.createElement('div');
      row.className = 'ep-webllm-cm-item';
      const label = document.createElement('span');
      label.className = 'muted tiny';
      label.textContent = c.id;
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'btn ghost'; del.textContent = '✕';
      del.title = 'Remove this custom model';
      del.addEventListener('click', async () => {
        settings.webllmCustomModels = (settings.webllmCustomModels || []).filter((x) => x.id !== c.id);
        await saveSettings(settings);
        renderEndpoints();
      });
      row.append(label, del);
      list.appendChild(row);
    }
  };
  renderList();
  const mkInput = (ph) => { const i = document.createElement('input'); i.placeholder = ph; i.className = 'ep-webllm-cm-input'; return i; };
  const idIn = mkInput('model id — e.g. MyModel-q4f16_1-MLC');
  const modelIn = mkInput('weights URL — MLC-converted HF repo/folder');
  const libIn = mkInput('model-lib .wasm URL');
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'btn accent'; add.textContent = 'Add model';
  const flash = (t) => { const was = add.textContent; add.textContent = t; setTimeout(() => { add.textContent = was; }, 1600); };
  add.addEventListener('click', async () => {
    const id = idIn.value.trim(); const model = modelIn.value.trim(); const model_lib = libIn.value.trim();
    if (!id || !model || !model_lib) return flash('All three required');
    settings.webllmCustomModels = settings.webllmCustomModels || [];
    if (settings.webllmCustomModels.some((x) => x.id === id)) return flash('Already added');
    settings.webllmCustomModels.push({ id, model, model_lib });
    await saveSettings(settings);
    renderEndpoints();
  });
  const form = document.createElement('div');
  form.className = 'ep-webllm-cm-form';
  form.append(idIn, modelIn, libIn, add);
  wrap.append(title, list, form);
  return wrap;
}

const endpointKey = (ep) => `endpoint:${ep.id}`;

function renderEndpoints() {
  const root = $('endpoints');
  root.innerHTML = '';
  const list = settings.endpoints || [];
  list.forEach((ep, i) => {
    const node = endpointCard(ep);
    setCardIndex(node, i, list.length, 'Endpoint'); // "N of M" — one card, one unit
    root.appendChild(node);
  });
  wireExpandAll('toggle-endpoints', list.map(endpointKey), renderEndpoints);
  renderGateBadges();
}

// Paint a card in its provider's / CLI's brand colour: the left rail, the head
// band, the foot band and the chip all read from --ep-accent. These configuration
// blocks are long and looked identical; this makes the boundary between one and
// the next unmistakable while scrolling. Shared by endpoints and bridge agents —
// `brand` is whatever providerBrand()/agentBrand() returned.
function applyCardBrand(node, brand, name, fallbackName = 'Untitled') {
  node.style.setProperty('--ep-accent', brand.color);
  const chip = node.querySelector('.card-brand');
  if (chip) {
    chip.classList.toggle('has-logo', !!brand.logo);
    if (brand.logo) {
      const img = chip.querySelector('img') || Object.assign(document.createElement('img'), { alt: '' });
      if (img.getAttribute('src') !== brand.logo) img.src = brand.logo;
      if (!img.isConnected) { chip.textContent = ''; chip.appendChild(img); }
    } else {
      chip.textContent = brand.mark;
    }
  }
  const foot = node.querySelector('.card-foot-name');
  // The foot repeats which card you just finished configuring — the "end of this
  // block" marker the cards were missing.
  if (foot) foot.textContent = (name || '').trim() || fallbackName;
}

// host:port of a base URL, for a collapsed card's summary line ("localhost:11434").
function hostLabel(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`);
    return u.host || url;
  } catch {
    return String(url || '').trim();
  }
}

// Set the ordinal shown at the start of a card head ("3" of 5).
function setCardIndex(node, i, total, label) {
  const idx = node?.querySelector('.card-index');
  if (!idx) return;
  idx.textContent = String(i + 1);
  idx.title = `${label} ${i + 1} of ${total}`;
}

// Flip a whole list open/closed from its header button, and keep that button's
// label honest about what it will do next.
function wireExpandAll(btnId, keys, rerender) {
  const btn = $(btnId);
  if (!btn) return;
  btn.textContent = anyExpanded(keys) ? 'Collapse all' : 'Expand all';
  btn.disabled = !keys.length;
  btn.onclick = () => { setAllExpanded(keys, !anyExpanded(keys)); rerender(); };
}

function endpointCard(ep) {
  const node = $('endpoint-tpl').content.firstElementChild.cloneNode(true);
  hydrate(node);
  const q = (sel) => node.querySelector(sel);
  const selectedPresetId = ep.providerPreset || providerPresetForEndpoint(ep)?.id || 'custom';
  const selectedPreset = providerPresetById(selectedPresetId);
  q('.ep-name').value = ep.name || '';
  q('.ep-enabled').checked = ep.enabled !== false;
  populateProviderPresetSelect(q('.ep-provider'), selectedPresetId);
  q('.ep-kind').value = ep.kind || 'openai';
  q('.ep-baseurl').value = ep.baseUrl || '';
  q('.ep-authmode').value = isOAuthMode(ep.authMode) ? ep.authMode : 'apiKey';
  q('.ep-apikey').value = ep.apiKey || '';
  q('.ep-oauth-clientid').value = ep.oauth?.clientId || '';
  q('.ep-oauth-project').value = ep.oauth?.projectId || '';
  q('.ep-temp').value = ep.temperature ?? '';
  q('.ep-maxtok').value = ep.maxTokens ?? '';
  q('.ep-maxreq').value = ep.maxRequestsPerTurn ?? '';
  q('.ep-extra-body').value = prettyJson(ep.extraBody);
  q('.ep-extra-headers').value = prettyJson({ ...(selectedPreset?.defaultHeaders || {}), ...(ep.headers || {}) });
  q('.ep-system').value = ep.systemPrompt || '';
  q('.ep-acmodel').value = ep.autocompleteModel || '';
  gateField('advancedAgent', q('.ep-system')); // per-agent system prompt is Pro
  applyFreeSlot(node, ep, 'endpoint'); // Free uses one endpoint — the user's pick
  // Collapsed by default (addEndpoint opens the one it just created); the summary
  // is what you read at rest, so it has to say what this endpoint actually is.
  const card = wireCollapsible(node, endpointKey(ep));
  const syncCardSummary = () => {
    const bits = [providerPresetDisplayName(readProviderPresetId())];
    const model = (q('.ep-model')?.value || ep.model || '').trim();
    if (model) bits.push(model);
    else if (q('.ep-baseurl')?.value.trim()) bits.push(hostLabel(q('.ep-baseurl').value));
    else bits.push('not configured');
    if (q('.ep-enabled')?.checked === false) bits.push('disabled');
    card.setSummary(bits.filter(Boolean).join(' · '));
  };
  wireModelSelect(q('.ep-model'), q('.ep-model-custom'), ep.models, ep.model, ep.modelOptions);
  if ((ep.kind || 'openai') === 'webllm') applyWebllmEndpointUi(node, q, ep);
  wireCombobox(
    q('.ep-acmodel'),
    normalizeStoredModelOptions(ep.models, ep.modelOptions),
    ep.autocompleteModel || '',
    'optional — a small/fast model just for inline autocomplete (avoid reasoning models)',
  );

  const readOauth = () => ({
    providerId: q('.ep-authmode').value,
    clientId: q('.ep-oauth-clientid').value.trim(),
    projectId: q('.ep-oauth-project').value.trim(),
  });

  const readAdvancedOptions = () => ({
    extraBody: sanitizeExtraBody(parseJsonObject(q('.ep-extra-body').value, 'Extra request JSON')),
    headers: sanitizeExtraHeaders(parseJsonObject(q('.ep-extra-headers').value, 'Extra headers JSON')),
  });

  const readProviderPresetId = () => providerPresetIdFromInput(q('.ep-provider'));
  const writeProviderPresetId = (id) => {
    setProviderPresetInput(q('.ep-provider'), id);
    wireCombobox(
      q('.ep-provider'),
      providerPresetOptions(),
      providerPresetDisplayName(providerPresetIdFromInput(q('.ep-provider'))),
      'Search providers or choose Custom',
      'No providers match. Choose Custom for a private endpoint.',
    );
  };

  const rawConn = (includeAdvanced = false) => ({
    id: ep.id,
    name: q('.ep-name').value.trim() || 'Endpoint',
    providerPreset: readProviderPresetId(),
    kind: q('.ep-kind').value,
    baseUrl: q('.ep-baseurl').value.trim(),
    authMode: q('.ep-authmode').value,
    apiKey: isOAuthMode(q('.ep-authmode').value) ? '' : q('.ep-apikey').value,
    oauth: readOauth(),
    ...(includeAdvanced ? readAdvancedOptions() : { extraBody: ep.extraBody || {}, headers: ep.headers || {} }),
  });

  const writeConn = (next) => {
    q('.ep-name').value = next.name || '';
    writeProviderPresetId(next.providerPreset || providerPresetForEndpoint(next)?.id || 'custom');
    q('.ep-kind').value = next.kind || 'openai';
    q('.ep-baseurl').value = next.baseUrl || '';
    q('.ep-authmode').value = next.authMode || 'apiKey';
    q('.ep-extra-headers').value = prettyJson(next.headers);
    if (next.extraBody) q('.ep-extra-body').value = prettyJson(next.extraBody);
  };

  // Switching to a hosted preset overwrites baseUrl/kind/auth with the preset's
  // values. Stash the user's Custom/self-hosted fields verbatim (raw strings, so
  // an in-progress JSON edit survives too) when leaving custom, and put them back
  // when they switch back — instead of stranding them on the preset's values.
  let customDraft = ep.providerPreset === 'custom' || !ep.providerPreset ? {
    name: ep.name || '',
    kind: ep.kind || 'openai',
    baseUrl: ep.baseUrl || '',
    authMode: ep.authMode || 'apiKey',
    apiKey: ep.apiKey || '',
  } : null;
  const snapshotCustomDraft = () => {
    customDraft = {
      name: q('.ep-name').value,
      kind: q('.ep-kind').value,
      baseUrl: q('.ep-baseurl').value,
      authMode: q('.ep-authmode').value,
      apiKey: q('.ep-apikey').value,
      headers: q('.ep-extra-headers').value,
      extraBody: q('.ep-extra-body').value,
    };
  };
  const restoreCustomDraft = (d) => {
    if (d.name !== undefined) q('.ep-name').value = d.name;
    q('.ep-kind').value = d.kind || 'openai';
    q('.ep-baseurl').value = d.baseUrl || '';
    q('.ep-authmode').value = d.authMode || 'apiKey';
    q('.ep-apikey').value = d.apiKey || '';
    if (d.headers !== undefined) q('.ep-extra-headers').value = d.headers;
    if (d.extraBody !== undefined) q('.ep-extra-body').value = d.extraBody;
  };

  const resetModelPickers = () => {
    Object.assign(ep, clearEndpointModelState(ep));
    const modelEl = q('.ep-model');
    const customModelEl = q('.ep-model-custom');
    const autocompleteEl = q('.ep-acmodel');
    modelEl.value = '';
    if (customModelEl) customModelEl.value = '';
    autocompleteEl.value = '';
    wireModelSelect(modelEl, customModelEl, [], '', []);
    wireCombobox(
      autocompleteEl,
      [],
      '',
      'optional — a small/fast model just for inline autocomplete (avoid reasoning models)',
    );
  };

  const setAuthStatus = (text, cls = '') => {
    setStatus(q('.ep-auth-status'), text, cls);
  };

  const setEndpointError = (statusEl, error, options = {}) => {
    const message = error?.message || String(error || '');
    setStatus(statusEl, '✕ ' + message, 'err');
    const authText = endpointErrorAuthStatus(error, options);
    setAuthStatus(authText, authText ? 'err' : '');
  };

  const conn = (includeAdvanced = false) => applyOAuthPreset(rawConn(includeAdvanced));

  const syncProviderHelp = () => {
    const preset = providerPresetById(readProviderPresetId());
    applyCardBrand(node, providerBrand(preset?.id || readProviderPresetId() || 'custom'), q('.ep-name').value, 'Untitled endpoint');
    syncCardSummary();
    const links = q('.ep-provider-links');
    const note = q('.ep-provider-note');
    links.innerHTML = '';
    const addLink = (label, url) => {
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label;
      links.appendChild(a);
    };
    addLink('Sign up', preset?.signupUrl);
    addLink('Get API key', preset?.keyUrl);
    addLink('Docs', preset?.docsUrl);
    links.classList.toggle('hidden', !links.children.length);
    note.textContent = preset?.note || '';
    note.classList.toggle('hidden', !preset?.note);
  };

  const markCustomProviderIfEdited = () => {
    const matched = providerPresetForEndpoint({ ...rawConn(), providerPreset: '' });
    if (!matched || matched.id !== readProviderPresetId()) writeProviderPresetId('custom');
  };

  const updateOAuthRedirect = () => {
    const temp = { ...ep, ...conn() };
    try {
      q('.ep-oauth-redirect').value = oauthRedirectUri(oauthProviderId(temp));
    } catch {
      q('.ep-oauth-redirect').value = 'Available after loading as a Chrome extension';
    }
  };
  const updateOAuthStatus = async () => {
    const temp = { ...ep, ...conn() };
    const token = await getOAuthToken(temp).catch(() => null);
    q('.ep-oauth-disconnect').disabled = !token?.access_token;
    const configMessage = oauthConfigMessage(temp);
    setStatus(q('.ep-oauth-status'), configMessage || oauthStatusLabel(temp, token), configMessage ? 'err' : token?.access_token ? 'ok' : '');
  };
  const syncAuthMode = () => {
    const mode = q('.ep-authmode').value;
    const oauth = isOAuthMode(mode);
    const temp = applyOAuthPreset({ ...ep, authMode: mode, oauth: readOauth() });
    const provider = oauthProvider(temp);
    q('.ep-apikey-row').classList.toggle('hidden', oauth);
    q('.ep-oauth').classList.toggle('hidden', !oauth);
    q('.ep-baseurl').disabled = oauth;
    q('.ep-kind').disabled = oauth;
    q('.ep-oauth-client-row').classList.toggle('hidden', mode === 'openrouter');
    q('.ep-oauth-project-row').classList.toggle('hidden', mode !== 'gemini');
    q('.ep-oauth-clientid').placeholder = mode === 'gemini'
      ? 'Google OAuth client id'
      : mode === 'huggingface'
        ? 'optional — leave blank to sign in with ChatPanel'
        : 'Public OAuth app client id';
    q('.ep-oauth-note').textContent = oauth ? oauthSetupHelp(mode) : '';
    const maxTokensNote = mode === 'openrouter'
      ? 'OpenRouter credit errors often mean Max tokens is too high. Lower this below the affordable number in the error, for example 4096 or 7400, or add credits.'
      : '';
    q('.ep-maxtok-note').textContent = maxTokensNote;
    q('.ep-maxtok-note').classList.toggle('hidden', !maxTokensNote);
    if (oauth && provider) q('.ep-baseurl').value = provider.baseUrl || q('.ep-baseurl').value;
    if (oauth) {
      updateOAuthRedirect();
      updateOAuthStatus();
    }
  };
  q('.ep-authmode').onchange = syncAuthMode;
  q('.ep-provider').onchange = async () => {
    const previous = q('.ep-provider').dataset.providerPreset;
    if (previous === 'custom') snapshotCustomDraft();
    const selected = readProviderPresetId();
    writeProviderPresetId(selected);
    // The endpoint's INTENDED kind for the new provider. Compute it from the preset (or a
    // clean reset), NOT from the .ep-kind <select> — that select has no 'webllm' option
    // until applyWebllmEndpointUi injects one, so reading it back is unreliable exactly
    // across the WebLLM boundary (the source of the flakiness).
    let intendedKind;
    if (selected !== 'custom') {
      const applied = applyProviderPreset({ ...rawConn(), providerPreset: selected });
      writeConn(applied);
      intendedKind = applied.kind || 'openai';
    } else if (customDraft) {
      restoreCustomDraft(customDraft);
      intendedKind = customDraft.kind || 'openai';
    } else {
      // Leaving a preset for Custom with nothing stashed (e.g. WebLLM → Custom): start a
      // clean HTTP card so no WebLLM/base-url state leaks across.
      intendedKind = 'openai';
      q('.ep-kind').value = 'openai';
      q('.ep-baseurl').value = '';
    }
    // WebLLM is a different endpoint UI than the HTTP providers (catalog picker, no base
    // URL / key / Test). When the pick crosses that boundary either way, rebuild THIS card
    // from the intended kind so the right controls show — other endpoints are untouched.
    const nowWebllm = intendedKind === 'webllm';
    const nodeIsWebllm = !!node.querySelector('.ep-webllm-extra');
    if (nowWebllm !== nodeIsWebllm) {
      // Reset model state — the old id belongs to the old provider. WebLLM seeds its
      // default; HTTP providers start empty (→ Load models).
      const base = {
        ...ep, ...rawConn(), kind: intendedKind,
        baseUrl: nowWebllm ? '' : rawConn().baseUrl,
        model: nowWebllm ? DEFAULT_WEBLLM_MODEL : '', models: [], modelOptions: [],
      };
      // Rebuild the card around the STORED endpoint — `endpointCard(base)` bound the new
      // card to a COPY that was never in settings.endpoints, so everything the user then did
      // wrote into a detached object: Save reported "✓ Saved" while saveSettings persisted the
      // untouched original, the list re-rendered as "New endpoint" with no model, and the side
      // panel — which reads the settings, not the card — never saw a WebLLM endpoint at all,
      // so no model was ever downloaded. `base` spreads `...ep` first, so it is a superset and
      // assigning it back needs no key pruning.
      Object.assign(ep, base);
      const fresh = endpointCard(ep);
      // Rebuilt in place — carry the ordinal over (renderEndpoints owns it).
      const idx = node.querySelector('.card-index');
      const freshIdx = fresh.querySelector('.card-index');
      if (idx && freshIdx) { freshIdx.textContent = idx.textContent; freshIdx.title = idx.title; }
      node.replaceWith(fresh);
      // Crossing the WebLLM boundary rewrote the endpoint's kind and model, so persist it now
      // rather than leaving settings-in-memory ahead of storage until some other card saves.
      await saveSettings(settings);
      return;
    }
    resetModelPickers();
    setAuthStatus('Run Load models or Test to check authentication.');
    syncAuthMode();
    syncProviderHelp();
  };
  q('.ep-name').oninput = () => {
    const foot = q('.card-foot-name');
    if (foot) foot.textContent = q('.ep-name').value.trim() || 'Untitled endpoint';
  };
  q('.ep-baseurl').oninput = () => {
    markCustomProviderIfEdited();
    syncProviderHelp();
  };
  q('.ep-kind').onchange = () => {
    markCustomProviderIfEdited();
    syncProviderHelp();
  };
  syncAuthMode();
  syncProviderHelp();

  q('.ep-load').onclick = async () => {
    const st = q('.ep-status');
    setStatus(st, 'Loading models…');
    setAuthStatus('Checking authentication…');
    try {
      const endpoint = conn(true);
      const options = await listModelOptions(endpoint);
      if (!options.length) {
        const auth = modelListAuthStatus(endpoint);
        setAuthStatus(auth.text, auth.cls);
        return setStatus(st, 'Endpoint returned no models', 'err');
      }
      const ids = options.map((m) => m.id);
      ep.models = ids;
      ep.modelOptions = options;
      wireModelSelect(q('.ep-model'), q('.ep-model-custom'), ids, readModel(q('.ep-model'), q('.ep-model-custom')) || ep.model, options);
      // Refresh the autocomplete picker from the same freshly loaded list — it is
      // wired once at render time, so without this it stays empty after Load.
      wireCombobox(
        q('.ep-acmodel'),
        normalizeStoredModelOptions(ids, options),
        q('.ep-acmodel').value.trim() || ep.autocompleteModel || '',
        'optional — a small/fast model just for inline autocomplete (avoid reasoning models)',
      );
      await saveSettings(settings);
      const freeCount = options.filter((m) => m.free).length;
      const freeText = freeCount ? ` (${freeCount} free marked in the picker)` : '';
      const auth = modelListAuthStatus(endpoint);
      setAuthStatus(auth.text, auth.cls);
      setStatus(st, `✓ ${ids.length} models${freeText} — search or type one below`, 'ok');
    } catch (e) {
      setEndpointError(st, e, { includeNonAuth: true });
    }
  };

  q('.ep-test').onclick = async () => {
    const st = q('.ep-status');
    const model = readModel(q('.ep-model'), q('.ep-model-custom'));
    if (!model) return setStatus(st, '✕ Pick a model first', 'err');
    setStatus(st, 'Testing…');
    setAuthStatus('Checking authentication…');
    try {
      const endpoint = { ...conn(true), model, systemPrompt: '', maxTokens: 64 };
      if (isOAuthMode(endpoint.authMode) && !hasOAuthConfig(endpoint)) throw new Error('Fill OAuth fields and connect first');
      const reply = await testAgent(endpoint, settings);
      setAuthStatus('✓ Authentication accepted', 'ok');
      setStatus(st, `✓ Replied: "${reply.slice(0, 40)}"`, 'ok');
    } catch (e) {
      setEndpointError(st, e);
    }
  };

  q('.ep-save').onclick = async () => {
    let advanced;
    try {
      advanced = readAdvancedOptions();
    } catch (e) {
      return setStatus(q('.ep-status'), '✕ ' + e.message, 'err');
    }
    Object.assign(ep, applyOAuthPreset({
      name: q('.ep-name').value.trim() || 'Endpoint',
      providerPreset: readProviderPresetId(),
      kind: q('.ep-kind').value,
      baseUrl: q('.ep-baseurl').value.trim(),
      authMode: q('.ep-authmode').value,
      apiKey: isOAuthMode(q('.ep-authmode').value) ? '' : q('.ep-apikey').value,
      oauth: readOauth(),
      ...advanced,
      model: readModel(q('.ep-model'), q('.ep-model-custom')),
      autocompleteModel: q('.ep-acmodel').value.trim(),
      temperature: q('.ep-temp').value === '' ? undefined : Number(q('.ep-temp').value),
      maxTokens: q('.ep-maxtok').value === '' ? undefined : Number(q('.ep-maxtok').value),
      maxRequestsPerTurn: q('.ep-maxreq').value === '' ? undefined : Math.max(0, Number(q('.ep-maxreq').value) || 0),
      systemPrompt: q('.ep-system').value,
    }));
    await saveSettings(settings);
    updateOAuthRedirect();
    updateOAuthStatus();
    syncCardSummary(); // the collapsed line must reflect what was just saved
    setStatus(q('.ep-status'), '✓ Saved', 'ok');
  };

  q('.ep-oauth-connect').onclick = async () => {
    const st = q('.ep-oauth-status');
    let temp;
    try {
      temp = applyOAuthPreset({
        ...ep,
        ...conn(true),
        model: readModel(q('.ep-model'), q('.ep-model-custom')),
        oauth: readOauth(),
      });
    } catch (e) {
      return setStatus(st, '✕ ' + (e.message || e), 'err');
    }
    const configMessage = oauthConfigMessage(temp);
    if (configMessage) return setStatus(st, '✕ ' + configMessage, 'err');
    setStatus(st, 'Opening provider sign-in…');
    try {
      const token = await connectOAuthEndpoint(temp);
      Object.assign(ep, {
        name: temp.name,
        kind: temp.kind,
        baseUrl: temp.baseUrl,
        providerPreset: temp.providerPreset,
        authMode: temp.authMode,
        apiKey: '',
        oauth: temp.oauth,
        extraBody: temp.extraBody,
        headers: temp.headers,
        model: temp.model,
      });
      await saveSettings(settings);
      setStatus(st, oauthStatusLabel(ep, token), 'ok');
      setAuthStatus(oauthStatusLabel(ep, token), 'ok');
      setStatus(q('.ep-status'), '✓ OAuth connected and saved', 'ok');
    } catch (e) {
      setStatus(st, '✕ ' + (e.message || e), 'err');
      setEndpointError(q('.ep-status'), e);
    }
  };

  q('.ep-oauth-disconnect').onclick = async () => {
    await disconnectOAuthEndpoint({ ...ep, ...conn() });
    await updateOAuthStatus();
  };

  q('.ep-enabled').onchange = async () => {
    ep.enabled = q('.ep-enabled').checked;
    syncCardSummary();
    await saveSettings(settings);
    setStatus(q('.ep-status'), ep.enabled ? 'Enabled' : 'Disabled — hidden from pickers, autocomplete & gateway', ep.enabled ? 'ok' : '');
  };

  q('.ep-del').onclick = async () => {
    if ((settings.endpoints || []).length <= 1) {
      return setStatus(q('.ep-status'), 'Keep at least one endpoint', 'err');
    }
    const { confirmDelete } = await import('./js/confirm-modal.js');
    const name = (q('.ep-name').value || ep.name || 'this endpoint').trim();
    if (!(await confirmDelete({
      title: `Delete “${name}”?`,
      body: 'This removes the endpoint along with its base URL, API key and model settings. This can\'t be undone.',
    }))) return;
    settings.endpoints = settings.endpoints.filter((e) => e !== ep);
    forgetCard(endpointKey(ep));
    await saveSettings(settings);
    renderEndpoints();
  };

  return node;
}

// Free is "one endpoint of YOUR choosing" — not "whatever we shipped". The
// built-ins (in-browser WebLLM, local Ollama) are zero-setup onboarding defaults,
// so gating Add behind Pro meant a Free user could never point ChatPanel at their
// own provider — the single most basic thing a Free user needs to do. Free adds up
// to FREE_LIMITS.apiEndpoints endpoints of their own; beyond that it's Pro.
async function addEndpoint() {
  if (endpointAddLocked()) {
    return upsell(
      `Free includes ${FREE_LIMITS.apiEndpoints} endpoint of your own, plus the built-in ones. Upgrade to Pro for unlimited endpoints.`,
    );
  }
  settings.endpoints = settings.endpoints || [];
  const ep = {
    id: uid(),
    name: 'New endpoint',
    kind: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    models: [],
    systemPrompt: '',
  };
  settings.endpoints.push(ep);
  // Hand the free slot over to the endpoint they just added, as long as it's still
  // sitting on a built-in default. Without this they'd configure their own provider,
  // hit send, and be told it needs Pro — the endpoint exists but isn't usable.
  const currentFree = (settings.endpoints || []).find((e) => e.id === freeEndpointId(settings));
  const claimedFreeSlot = !isPro(license) && (!currentFree || currentFree.builtin);
  if (claimedFreeSlot) settings.freeEndpointId = ep.id;
  setExpanded(endpointKey(ep), true); // you added it to configure it — open it
  await saveSettings(settings);
  renderEndpoints();
  const node = $('endpoints').lastElementChild;
  node?.scrollIntoView({ behavior: 'smooth' });
  if (claimedFreeSlot && node) {
    setStatus(node.querySelector('.ep-status'), '★ This is now your Free endpoint — set it up and Save.', 'ok');
  }
}

// --------------------------------------------------------------------------
// Agents (local bridge: Claude Code / Codex / Antigravity CLI)
// --------------------------------------------------------------------------
function renderBridge() {
  $('bridge-url').value = settings.bridgeUrl || '';
  $('bridge-token').value = settings.bridgeToken || '';
  renderBridgeAgents();
  renderLocalRuntime(); // the unified "ChatPanel local" status atop this tab
}

// The one place a person can see what ChatPanel is running locally: the bridge (your
// agents + skills) and the gateway (an optional upgrade — redaction, routing, voice).
// The framing is the point — bridge up + gateway absent is COMPLETE, not a warning.
async function renderLocalRuntime({ recheck = false } = {}) {
  const root = $('local-runtime');
  if (!root) return;
  if (recheck) {
    bridgeState = await checkBridge(settings.bridgeUrl);
    gatewayState = await checkGateway(settings.gatewayUrl || 'http://127.0.0.1:4320');
  }
  // Cheap localhost checks; run them if we have no reading yet so opening the tab shows truth.
  if (!recheck) {
    if (!bridgeState?.version && bridgeState?.ok !== true) bridgeState = await checkBridge(settings.bridgeUrl);
    if (gatewayState?.ok === undefined) gatewayState = await checkGateway(settings.gatewayUrl || 'http://127.0.0.1:4320');
  }

  const bridgeOn = !!bridgeState?.ok;
  const gwOn = !!gatewayState?.ok;
  const agentCount = (bridgeState?.agents || []).filter((a) => a.available).length;
  const skillCount = bridgeState?.skills?.count;

  const row = ({ cls, name, on, statusText, detail, cta }) => {
    const el = document.createElement('div');
    el.className = `runtime-row ${cls}${on ? ' on' : ''}`;
    const dot = `<span class="runtime-dot"></span>`;
    const head = `<div class="runtime-head">${dot}<b>${name}</b><span class="runtime-status">${statusText}</span></div>`;
    el.innerHTML = `${head}<div class="runtime-detail">${detail}</div>${cta ? `<div class="runtime-cta">${cta}</div>` : ''}`;
    return el;
  };

  root.replaceChildren();
  // Bridge — the common case, the thing that runs agents + skills.
  root.appendChild(row({
    cls: 'rt-bridge', name: 'Bridge', on: bridgeOn,
    statusText: bridgeOn
      ? `Running · v${bridgeState.version}`
      : 'Not running',
    detail: bridgeOn
      ? `Your local coding agents and skills.${Number.isFinite(agentCount) ? ` ${agentCount} agent${agentCount === 1 ? '' : 's'} ready` : ''}${Number.isFinite(skillCount) ? ` · ${skillCount} skill${skillCount === 1 ? '' : 's'} discoverable` : ''}.`
      : 'Runs your local coding agents (Claude Code, Codex, …) and makes your skills discoverable. Install it with the commands below.',
  }));
  // Gateway — the optional upgrade. Absent is normal.
  root.appendChild(row({
    cls: 'rt-gateway', name: 'Gateway', on: gwOn,
    statusText: gwOn ? `Running · v${gatewayState.version}` : 'Optional',
    detail: gwOn
      ? 'The privacy upgrade: PII redaction, model routing, and voice — in front of everything above.'
      : 'An optional upgrade that adds PII redaction, model routing and voice. You don\'t need it for local agents and skills.',
    cta: gwOn ? '' : '<a href="#gateway" class="runtime-link">What the gateway adds →</a>',
  }));

  // The honest summary line, so "gateway not running" never reads as broken.
  const note = document.createElement('p');
  note.className = 'muted tiny runtime-note';
  note.textContent = bridgeOn && gwOn
    ? 'Both running — local traffic is routed through the gateway\'s privacy layer.'
    : bridgeOn
      ? 'You\'re set for local agents and skills. The gateway is an optional upgrade.'
      : 'Start the bridge to use your local agents and skills.';
  root.appendChild(note);
}

// --------------------------------------------------------------------------
// Gateway — the ChatPanel Privacy Gateway, configured over its localhost API.
// The extension stores only the URL; the gateway owns the rest of its config.
// --------------------------------------------------------------------------
let gatewayState = { ok: false };
let gatewayDests = []; // working copy of cfg.destinations for the editor

// Render the destinations list (model → agent/API routing). Each row edits the
// matching entry in gatewayDests in place.
// True when an endpoint's baseUrl points at the gateway itself (same host:port) —
// exposing it would make the gateway forward to itself forever.
function pointsAtGateway(baseUrl, gwUrl) {
  try {
    if (!gwUrl) return false;
    const norm = (s) => { const u = new URL(/^https?:\/\//.test(s) ? s : `http://${s}`); return `${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`; };
    return norm(baseUrl) === norm(gwUrl);
  } catch { return false; }
}

// The destinations ARE the user's already-configured APIs (API tab) + agents
// (Agents tab) — each a checkbox to expose it through the gateway. No re-typing.
// Every destination the gateway COULD route to — configured APIs (not the gateway
// itself) + bridge agents. Used by "Select all".
function availableDestinations() {
  const gwUrl = normalizeGatewayUrl($('gw-url').value || settings.gatewayUrl || '');
  const out = [];
  for (const ep of (settings.endpoints || []).filter((e) => e && !e.builtin && e.baseUrl && e.enabled !== false)) {
    if (pointsAtGateway(ep.baseUrl, gwUrl)) continue;
    out.push({
      id: ep.name || ep.model || ep.id, type: 'api', baseUrl: ep.baseUrl,
      protocol: ep.kind === 'anthropic' ? 'anthropic' : 'openai',
      models: [ep.model].filter(Boolean),
      ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
    });
  }
  const agentIds = (bridgeState && bridgeState.agents && bridgeState.agents.length) ? bridgeState.agents.map((a) => a.id) : ['codex', 'claude', 'opencode', 'pi'];
  for (const a of agentIds) out.push({ id: a, type: 'agent', agent: a, models: [a] });
  return out;
}

// Compact summary shown on the collapsed dropdown trigger — names a couple of
// selected destinations, then "+N more", or a placeholder when none are picked.
function updateDestSummary() {
  const el = $('gw-dest-summary');
  if (!el) return;
  const total = availableDestinations().length;
  const sel = gatewayDests || [];
  if (!sel.length) { el.innerHTML = '<span class="none">No destinations selected</span>'; return; }
  if (total && sel.length >= total) { el.textContent = `All destinations (${sel.length})`; return; }
  const names = sel.map((d) => d.id);
  const shown = names.slice(0, 2).join(', ');
  el.textContent = names.length > 2 ? `${shown} +${names.length - 2} more` : shown;
}

function renderDestinations() {
  const host = $('gw-dests');
  if (!host) return;
  host.innerHTML = '';
  const gwUrl = normalizeGatewayUrl($('gw-url').value || settings.gatewayUrl || '');

  // Free routes to a single destination (same idea as the header model dropdown:
  // one free pick, the rest locked behind Pro). Pro routes to unlimited.
  const pro = isPro(license);
  const cap = FREE_LIMITS.gatewayDestinations;
  const atCap = () => !pro && gatewayDests.length >= cap;
  const lockMsg = `Free routes to ${cap} gateway destination. Upgrade to Pro to route to all your APIs & agents.`;

  const isEnabled = (id) => gatewayDests.some((d) => d.id === id);
  const flowCount = () => {
    const el = $('gw-flow-dests'); if (el) el.textContent = gatewayDests.length ? `${gatewayDests.length} enabled` : 'your APIs & agents';
    updateDestSummary();
  };
  const toggle = (dest, on) => {
    if (on && !isEnabled(dest.id) && atCap()) { upsell(lockMsg); renderDestinations(); return; }
    gatewayDests = gatewayDests.filter((d) => d.id !== dest.id);
    if (on) gatewayDests.push(dest);
    flowCount(); autoSaveGateway();
    if (!pro) renderDestinations(); // refresh which rows are locked
  };
  const checkRow = (emoji, name, models, dest, { disabled = false, note = '' } = {}) => {
    const locked = !disabled && !pro && !isEnabled(dest.id) && atCap();
    const wrap = document.createElement('label');
    wrap.className = 'gw-dest' + (disabled || locked ? ' off' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = isEnabled(dest.id); cb.disabled = disabled || locked;
    cb.onchange = () => toggle(dest, cb.checked);
    wrap.appendChild(cb);
    const nm = document.createElement('span'); nm.className = 'name';
    nm.innerHTML = (iconForEmoji(emoji) || escapeHtml(emoji)) + ' ' + escapeHtml(name);
    wrap.appendChild(nm);
    for (const m of (models || []).slice(0, 4)) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = m; wrap.appendChild(c); }
    const sp = document.createElement('span'); sp.className = 'spacer'; wrap.appendChild(sp);
    if (locked) {
      wrap.onclick = (e) => { e.preventDefault(); upsell(lockMsg); };
      const b = document.createElement('span'); b.className = 'chip'; b.innerHTML = icon('lock') + ' Pro'; wrap.appendChild(b);
    } else if (note) {
      const n = document.createElement('span'); n.className = 'muted sm'; n.textContent = note; wrap.appendChild(n);
    }
    host.appendChild(wrap);
  };
  const head = (text) => { const p = document.createElement('p'); p.className = 'muted sm'; p.style.margin = '8px 0 2px'; p.textContent = text; host.appendChild(p); };

  if (!pro) {
    const p = document.createElement('p'); p.className = 'muted sm'; p.style.margin = '0 0 4px';
    p.innerHTML = `${icon('lock')} Free routes to <strong>${cap}</strong> destination — <a href="#" class="gw-dest-upsell">upgrade to Pro</a> for unlimited.`;
    p.querySelector('a').onclick = (e) => { e.preventDefault(); subscribePro(); };
    host.appendChild(p);
  }

  // APIs (from the API tab)
  head('APIs (from your API tab):');
  const apis = (settings.endpoints || []).filter((e) => e && !e.builtin && e.baseUrl);
  if (!apis.length) { const e = document.createElement('p'); e.className = 'muted sm'; e.textContent = '— none configured —'; host.appendChild(e); }
  for (const ep of apis) {
    const isGw = pointsAtGateway(ep.baseUrl, gwUrl);
    const dest = {
      id: ep.name || ep.model || ep.id,
      type: 'api',
      baseUrl: ep.baseUrl,
      protocol: ep.kind === 'anthropic' ? 'anthropic' : 'openai',
      models: [ep.model].filter(Boolean),
      ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
    };
    checkRow('🌐', ep.name || ep.model || ep.id, dest.models, dest,
      { disabled: isGw, note: isGw ? '(this is the gateway — can’t forward to itself)' : '' });
  }

  // Agents (via the bridge / your login)
  head('Agents (via the bridge · your login):');
  const agentIds = (bridgeState && bridgeState.agents && bridgeState.agents.length)
    ? bridgeState.agents.map((a) => a.id)
    : ['codex', 'claude', 'opencode', 'pi'];
  for (const a of agentIds) {
    checkRow('🤖', a, [a], { id: a, type: 'agent', agent: a, models: [a] });
  }
  flowCount();
  populateTestModels();
}

function renderGateway() {
  // Pre-fill the default localhost URL so the user doesn't have to type it (still
  // editable). Auto-check whatever ends up in the field.
  $('gw-url').value = settings.gatewayUrl || 'http://127.0.0.1:4320';
  if ($('gw-url').value) refreshGateway();

  // WARM search opt-in: index local history to this gateway (off by default).
  const warm = $('gw-warm-search');
  if (warm) {
    warm.checked = !!settings.ui?.warmSearch?.enabled;
    warm.onchange = async () => {
      settings.ui = settings.ui || {};
      settings.ui.warmSearch = { enabled: warm.checked, url: normalizeGatewayUrl($('gw-url').value) || 'http://127.0.0.1:4320' };
      await saveSettings(settings);
      toast(warm.checked ? 'Indexing history to the gateway…' : 'Gateway search off');
      if (warm.checked) {
        const { syncHistoryToGateway } = await import('./js/warm-sync.js');
        const result = await syncHistoryToGateway(settings.ui.warmSearch.url);
        toast(result.ok ? `Indexed ${result.sent || 0} history records` : `History indexing failed: ${result.error || 'gateway unavailable'}`);
      }
    };
  }

  wireBackupKeyHandoff();
}

// Backup key-handoff: send the daily-backup password to the LOCAL gateway so it can
// decrypt + index the .encrypted.json backups (POST /v1/history/key). The checkbox
// reflects the gateway's current key state (GET /v1/history/key). Loopback only.
function wireBackupKeyHandoff() {
  const box = $('gw-backup-key');
  const status = $('gw-backup-key-status');
  if (!box) return;
  const gwUrl = () => normalizeGatewayUrl($('gw-url').value) || 'http://127.0.0.1:4320';
  const say = (t) => { if (status) status.textContent = t ? ` ${t}` : ''; };

  // Reflect whether the gateway already holds a key.
  Promise.all([getBackupState(), fetch(gwUrl() + '/v1/history/key').then((r) => r.json())])
    .then(async ([st, d]) => {
      box.checked = !!d?.hasKey;
      if (box.checked !== !!st.gatewayBackupIndex) await setBackupGatewayIndex(box.checked);
    }).catch(() => { box.checked = false; });

  box.onchange = async () => {
    say('');
    try {
      if (box.checked) {
        const { passphrase } = await getBackupState();
        if (!passphrase) {
          box.checked = false;
          say('⚠ Set an encrypted-backup password in the Backup section first.');
          return;
        }
        const res = await fetch(gwUrl() + '/v1/history/key', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase }),
        });
        const d = await res.json();
        if (!res.ok || d?.error) throw new Error(d?.error?.message || `gateway ${res.status}`);
        await setBackupGatewayIndex(true);
        say(`✓ Indexed ${d.ingested ?? 0} records${d.file ? ` from ${d.file.split('/').pop()}` : ''}.`);
      } else {
        await fetch(gwUrl() + '/v1/history/key', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: '' }),
        });
        await setBackupGatewayIndex(false);
        say('Key forgotten.');
      }
    } catch (e) {
      box.checked = !box.checked; // revert on failure
      say(`⚠ ${e.message || e} — is the gateway running?`);
    }
  };
}

// Build the detector dropdown: bundled NER, custom NER, each configured LOCAL
// model (cloud ones are flagged — the detector sees raw text), then manual LLM.
function populateDetectorOptions() {
  const sel = $('gw-det-backend');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  opt('off', 'Bundled NER (in-process, automatic)');
  opt('endpoint', 'Custom PII service (URL)');
  for (const ep of (settings.endpoints || []).filter((e) => e && !e.builtin && e.baseUrl)) {
    const local = /127\.0\.0\.1|localhost|::1/.test(ep.baseUrl);
    opt(`cfg:${ep.id}`, `${local ? '🟢 local' : '⚠ cloud'} — ${ep.name || ep.model || ep.id}`);
  }
  opt('openai', 'Other local LLM (URL + model)');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// Show the types/values radio sub-options only when "Capture redaction detail" is on.
function setGwDetailRows() {
  const on = $('gw-log-detail') && $('gw-log-detail').checked;
  const box = $('gw-log-detail-mode');
  if (box) box.classList.toggle('hidden', !on);
}

function setGwDetectorRows() {
  const b = $('gw-det-backend').value;
  const manual = b === 'endpoint' || b === 'openai'; // configured (cfg:*) needs no fields
  $('gw-det-url-row').classList.toggle('hidden', !manual);
  $('gw-det-model-row').classList.toggle('hidden', b !== 'openai');
  $('gw-det-key-row').classList.toggle('hidden', !manual);
  $('gw-det-timeout-row').classList.toggle('hidden', b === 'off'); // any active detector
  // Loud warning when the chosen detector is NOT on this machine — it receives the
  // raw, un-redacted text, so a cloud endpoint sends your PII to that provider.
  const isLocal = (u) => /127\.0\.0\.1|localhost|::1/.test(u || '');
  let cloud = false;
  if (b.startsWith('cfg:')) {
    const ep = (settings.endpoints || []).find((e) => e.id === b.slice(4));
    cloud = !!(ep && ep.baseUrl && !isLocal(ep.baseUrl));
  } else if (manual) {
    cloud = !isLocal($('gw-det-url').value);
    if (!$('gw-det-url').value.trim()) cloud = false; // nothing entered yet
  }
  const warn = $('gw-det-warn');
  if (warn) warn.classList.toggle('hidden', !cloud);
}

function fillGatewayForm(cfg) {
  gatewayDests = Array.isArray(cfg.destinations) ? cfg.destinations.map((d) => ({ ...d, models: [...(d.models || [])] })) : [];
  renderDestinations();
  $('gw-tier').value = cfg.redaction?.tier === 'full' ? 'full' : 'basic';
  $('gw-redact-system').checked = cfg.redaction?.redactSystem !== false;
  populateDetectorOptions();
  const det = cfg.redaction?.detection || { backend: 'off' };
  let detSel = det.backend || 'off';
  // If the saved detector matches a configured API (same baseUrl + model), select it.
  if (det.backend === 'openai' && det.url) {
    const ep = (settings.endpoints || []).find((e) => e.baseUrl === det.url && (!det.model || e.model === det.model));
    if (ep) detSel = `cfg:${ep.id}`;
  }
  $('gw-det-backend').value = [...$('gw-det-backend').options].some((o) => o.value === detSel) ? detSel : 'off';
  $('gw-det-url').value = det.url || '';
  $('gw-det-model').value = det.model || '';
  $('gw-det-timeout').value = det.timeoutMs ? String(det.timeoutMs) : '';
  $('gw-det-key').value = ''; // write-only; the gateway never echoes the key back
  $('gw-dictionary').value = stringifyDictionary(cfg.redaction?.dictionary);
  $('gw-origins').value = (cfg.allowedOrigins || []).join('\n');
  $('gw-pro-token').value = ''; // write-only; never echoed back from the gateway
  renderGatewayFreeUsage(cfg.pro, cfg.pro?.free);
  $('gw-log').checked = !!cfg.logRequests;
  const detail = ['types', 'values'].includes(cfg.logDetail) ? cfg.logDetail : 'off';
  $('gw-log-detail').checked = detail !== 'off';
  const detRadio = document.querySelector(`input[name="gw-detail"][value="${detail === 'off' ? 'types' : detail}"]`);
  if (detRadio) detRadio.checked = true;
  setGwDetailRows();
  $('gw-tools-data').value = cfg.tools?.toolData === 'redactRemote' ? 'redactRemote' : 'real';
  $('gw-tools-narrow').checked = cfg.tools?.autoNarrow !== false;
  $('gw-tools-cap').value = cfg.tools?.maxPerTurn ?? 8;
  $('gw-tools-narrowall').checked = !!cfg.tools?.narrowAll;
  setGwDetectorRows();
}

// Show the Free lifetime redaction usage on the gateway (read-only).
function renderGatewayFreeUsage(pro, usage) {
  const el = $('gw-free-usage');
  if (!el) return;
  if (pro?.unlocked) {
    el.innerHTML = '✓ <strong>Pro active</strong> on the gateway — unlimited, full-tier redaction.';
    return;
  }
  // Prefer an explicit usage object (/status); else the free block from /config.
  const u = usage || pro?.free || {};
  const used = Number(u.used) || 0;
  const cap = Number(u.cap) || 100;
  const left = Math.max(0, cap - used);
  el.innerHTML = `Free includes <strong>${cap} full redactions</strong> total (the real thing — names &amp; orgs `
    + `included) to try it out. <strong>${left} of ${cap} left.</strong> Activate Pro below for unlimited.`;
}

// Recent request summaries (counts only) from the gateway's /logs.
async function refreshGatewayLogs() {
  const host = $('gw-logs');
  if (!host) return;
  const url = normalizeGatewayUrl($('gw-url').value);
  if (!url) { host.textContent = ''; return; }
  const entries = await getGatewayLogs(url);
  if (!entries.length) { host.innerHTML = '<span class="muted sm">No requests yet (enable "Log requests", then send one).</span>'; return; }
  host.innerHTML = entries.slice(0, 12).map((e) => {
    const time = new Date(e.t).toLocaleTimeString();
    const dest = e.dest ? `${escapeHtml(e.dest)}${e.type ? ` (${e.type})` : ''}` : '—';
    const summary = `<code>${time}</code> ${escapeHtml(e.model || '?')} → <b>${dest}</b> · redacted ${e.redacted || 0}`;
    const detail = Array.isArray(e.detail) ? e.detail : null;
    const body = gatewayLogBody(e.timings, detail);
    if (!body) {
      // Nothing to expand: timings off (logDetail's sibling) and no PII breakdown.
      return `<details class="gw-logrow flat"><summary>${summary}</summary></details>`;
    }
    return `<details class="gw-logrow"><summary>${summary}</summary>${body}</details>`;
  }).join('');
}

// The expandable contents of one log row: the per-stage latency bar (so you can
// see WHAT's slow — usually the model hop) plus the redaction breakdown if any.
function gatewayLogBody(timings, detail) {
  let html = '';
  if (timings && typeof timings === 'object') {
    // Label upstream as "model"; flag the slowest non-total leg as the bottleneck.
    const legs = ['redact', 'upstream', 'stream', 'restore'].filter((k) => typeof timings[k] === 'number');
    const label = { redact: 'redact', upstream: 'model', stream: 'stream', restore: 'restore' };
    const slowest = legs.reduce((a, k) => (timings[k] > (timings[a] ?? -1) ? k : a), legs[0]);
    const parts = legs.map((k) => `<span class="leg${k === slowest ? ' hot' : ''}">${label[k]} ${timings[k]}ms</span>`).join('<span class="sep">·</span>');
    const total = typeof timings.total === 'number' ? `<span class="leg total">total ${timings.total}ms</span>` : '';
    html += `<div class="gw-timings">${icon('timer')} ${parts}${parts && total ? '<span class="sep">·</span>' : ''}${total}</div>`;
  }
  if (Array.isArray(detail) && detail.length) {
    const rows = detail.map((d) => {
      const tok = `<span class="tok">[[${escapeHtml(d.token)}]]</span>`;
      return 'value' in d
        ? `<div class="ent"><span class="val">${escapeHtml(String(d.value))}</span><span class="arrow">→</span>${tok}</div>`
        : `<div class="ent">${tok} <span class="ty">${escapeHtml(d.type)}</span></div>`;
    }).join('');
    html += `<div class="gw-detail-list">${rows}</div>`;
  }
  return html;
}

function renderGatewayMonitor(s) {
  const el = $('gw-monitor');
  if (!el) return;
  if (!s || !s.ok) { el.textContent = '—'; return; }
  const u = s.usage || {};
  const used = s.pro?.unlocked ? 'unlimited (Pro)' : `${u.used || 0} / ${u.cap || 0} free redactions used`;
  el.innerHTML = `Redactions: <strong>${used}</strong> · NER: ${s.ner?.ready ? 'on' : 'off'} · uptime ${Math.floor((s.uptimeSeconds || 0) / 60)}m`;
  // Keep the Pro panel's usage line in sync with the latest /status.
  renderGatewayFreeUsage(s.pro, s.usage);
}

async function refreshGateway() {
  const url = normalizeGatewayUrl($('gw-url').value);
  const status = $('gw-status');
  if (!url) {
    status.textContent = 'Enter the gateway URL.'; status.className = 'status';
    setSectionBadge('pv-gateway-badge', 'Not set', 'off');
    return;
  }
  status.textContent = 'Checking…'; status.className = 'status';
  gatewayState = await checkGateway(url);
  if (!gatewayState.ok) {
    status.textContent = `✕ Not running yet — install it below to enable local dictation, PII detection & routing.`;
    status.className = 'status err';
    $('gw-config').classList.add('hidden');
    $('gw-preview')?.classList.remove('hidden'); // show the "what you get" discovery panel
    setSectionBadge('pv-gateway-badge', 'Not installed', 'off');
    return;
  }
  status.innerHTML = `✓ Connected — v${gatewayState.version} · backend: <strong>${gatewayState.backend}</strong> · ${gatewayState.pro?.unlocked ? 'Pro' : 'Free'}`;
  status.className = 'status ok';
  setSectionBadge('pv-gateway-badge', `Running · v${gatewayState.version}`, 'on');
  // Connected is enough to retire the "what the gateway adds, once it's running" pitch —
  // it used to survive an admin-token failure, so the page read "✓ Connected" directly above
  // a panel explaining what you'd get if you installed it.
  $('gw-preview')?.classList.add('hidden');
  // Admin routes (GET /config) need the token because Chrome omits Origin on GET to a
  // permitted host. Seed any manually-entered token, then auto-handshake (a POST DOES
  // carry our extension Origin, so the gateway hands back the token) so most users never
  // touch the field. A pre-0.6.31 gateway has no handshake → fall back to the manual token.
  setGatewayToken(settings.gatewayToken || '');
  await handshakeGatewayToken(url);
  try {
    let cfg = await getGatewayConfig(url);
    // A gateway is a separate process, so merely connecting it does not inherit the
    // extension's subscription. After the authenticated admin handshake, silently
    // hand it this device's signed entitlement whenever the extension is Pro but the
    // gateway is not. The explicit Activate button remains a visible retry path.
    if (isPro(license) && !gatewayState.pro?.unlocked) {
      const token = await getEntitlementToken();
      if (token) {
        try {
          const synced = await ensureGatewayEntitlement(url, { localPro: true, token, unlocked: false });
          if (synced.config) cfg = synced.config;
          if (synced.status?.ok) gatewayState = synced.status;
        } catch (e) {
          const proStatus = $('gw-pro-status');
          if (proStatus) {
            proStatus.textContent = `Automatic Pro activation failed: ${e.message}. Click Activate to retry.`;
            proStatus.className = 'status err';
          }
        }
      }
    }
    status.innerHTML = `✓ Connected — v${gatewayState.version} · backend: <strong>${gatewayState.backend}</strong> · ${gatewayState.pro?.unlocked ? 'Pro' : 'Free'}`;
    fillGatewayForm(cfg);
    $('gw-config').classList.remove('hidden'); // the real config replaces the preview
    $('gw-token-row')?.classList.add('hidden'); // authorized — hide the manual token fallback
    $('gw-token-hint')?.classList.add('hidden');
    renderGatewayMonitor(gatewayState);
    renderNerStatus(gatewayState.ner);
    refreshNerModels();
    refreshSttModels();
    refreshDiarizeModel();
  } catch (e) {
    const isAuth = /admin route|token required|403/i.test(e.message || '');
    status.innerHTML = isAuth
      ? `✓ Connected, but the admin API needs a token. Update the gateway (v0.6.31+) so it authorizes automatically, or paste the token below.`
      : `✓ Connected, but config load failed: ${e.message}`;
    if (isAuth) { $('gw-token-row')?.classList.remove('hidden'); $('gw-token-hint')?.classList.remove('hidden'); } // reveal manual token field
    setSectionBadge('pv-gateway-badge', isAuth ? 'Needs a token' : 'Config failed', 'warn');
  }
}

// Show the status of the ACTIVE detector. Only the bundled NER ('off') is described
// from /status.ner; a chosen external detector (LLM / custom NER) is described from
// the dropdown, so it's obvious detection is by THAT model, not the bundled NER.
function renderNerStatus(ner) {
  const el = $('gw-ner-status');
  if (!el) return;
  const selEl = $('gw-det-backend');
  const sel = selEl ? selEl.value : 'off';
  if (sel && sel !== 'off') {
    const label = ((selEl.selectedOptions[0] && selEl.selectedOptions[0].textContent) || sel).trim();
    const kind = sel === 'endpoint' ? 'custom NER service' : 'LLM detector';
    el.className = 'status';
    el.textContent = `Detector: ${label} — ${kind}. The bundled NER is not used. Click “Check NER health” to test it.`;
    return;
  }
  if (!ner || !ner.autostart) { el.className = 'status'; el.textContent = 'NER: autostart off (deterministic-only detection).'; return; }
  if (ner.ready) {
    el.className = 'status ok';
    el.textContent = `NER: ✓ ready${ner.model ? ` · model ${ner.model}` : ''}${ner.url ? ` · ${ner.url}` : ''}`;
  } else if (ner.configured) {
    el.className = 'status';
    el.textContent = 'NER: ⏳ starting… (first run downloads the model, ~100 MB — can take a minute). Click Check again.';
  } else {
    el.className = 'status err';
    el.textContent = 'NER: ✕ not running — falling back to deterministic redaction.';
  }
}

// Check the ACTIVE detector. For the bundled NER, probe the gateway's health. For a
// chosen external detector (LLM / custom NER), actually RUN it on a sample in strict
// mode so failures (404, timeout, bad model/key) surface instead of failing open.
async function checkNer() {
  const url = normalizeGatewayUrl($('gw-url').value);
  const el = $('gw-ner-status');
  if (!url || !el) return;
  const selEl = $('gw-det-backend');
  const sel = selEl ? selEl.value : 'off';
  if (sel && sel !== 'off') {
    const label = ((selEl.selectedOptions[0] && selEl.selectedOptions[0].textContent) || sel).trim();
    el.className = 'status'; el.textContent = `Testing ${label}…`;
    try {
      const ents = await detectEntities('Alex Rivera from Acme Corp in Geneva.', { detection: collectDetection() }, { strict: true });
      el.className = 'status ok';
      el.textContent = `Detector ✓ ${label} responded — ${ents.length} entit${ents.length === 1 ? 'y' : 'ies'} on the sample.`;
    } catch (e) {
      el.className = 'status err';
      el.textContent = `Detector ✕ ${label}: ${e.message} — check URL/model/key, and raise Timeout if slow.`;
    }
    return;
  }
  el.className = 'status'; el.textContent = 'NER: checking…';
  const s = await checkGateway(url);
  renderNerStatus(s.ok ? s.ner : null);
}

// The Privacy tab's "Bundled NER" reuses the SAME in-process NER the gateway runs
// (POST {text}->{entities} at <gateway>/ner) and the SAME model catalog. Resolve
// the gateway base the Privacy tab should talk to (the URL configured on the
// Gateway tab, else the localhost default).
function gatewayBaseUrl() {
  const fromField = $('gw-url') ? $('gw-url').value : '';
  return normalizeGatewayUrl(settings.gatewayUrl || fromField || 'http://127.0.0.1:4320');
}
function gatewayNerEndpoint() { return `${gatewayBaseUrl()}/ner`; }

// There is ONE NER model catalog (Gateway → On-device models) because there is one
// in-process NER. Both health lines describe it — the panel's detector line and the
// gateway's — so a model switch refreshes both rather than leaving one stale.
const GW_NER = {
  url: () => normalizeGatewayUrl($('gw-url').value),
  models: 'gw-models',
  mstatus: 'gw-models-status',
  onHealth: (ner) => { renderNerStatus(ner); renderPrivNerHealth(ner); },
};

// Render the NER model catalog (GET /ner/models): each model with its size + an
// In use / Use / Download button. Buttons are wired here (the list is dynamic).
function renderNerModels(data, ctx = GW_NER) {
  const host = $(ctx.models);
  if (!host) return;
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const active = data?.active || null;
  const dl = data?.progress || null;
  const rows = (data?.available || []).map((m) => {
    const isActive = m.id === active;
    const downloading = dl && dl.model === m.id;
    const meta = [esc(m.lang), m.approxMB ? `${m.approxMB} MB` : '', m.installed && !isActive ? 'installed' : '']
      .filter(Boolean).join(' · ');
    const label = downloading
      ? `Downloading… ${dl.pct || 0}%`
      : isActive ? 'In use' : (m.installed ? 'Use' : `Download${m.approxMB ? ` (${m.approxMB} MB)` : ''}`);
    return `<div class="entity">
      <div class="entity-head">
        <strong style="flex:1 1 auto">${esc(m.label || m.id)}</strong>
        <span class="status">${meta}</span>
        <button type="button" class="btn ${isActive ? '' : 'primary'} gw-model-use" data-id="${esc(m.id)}" ${isActive || downloading ? 'disabled' : ''}>${label}</button>
      </div>
      <p class="muted sm" style="margin:0">${esc(m.note || '')}</p>
    </div>`;
  });
  host.innerHTML = rows.join('') || '<p class="muted sm">No models available.</p>';
  host.querySelectorAll('.gw-model-use').forEach((b) => { b.onclick = () => selectNerModel(b.dataset.id, ctx); });
}

// Fetch + render the model list. Returns the data (or null) so the poller can read
// progress/active without re-fetching.
async function refreshNerModels(ctx = GW_NER) {
  const url = ctx.url();
  const st = $(ctx.mstatus);
  if (!url) return null;
  try {
    const data = await getNerModels(url);
    renderNerModels(data, ctx);
    if (st) {
      if (data.progress) { st.className = 'status'; st.textContent = `Downloading ${data.progress.model} — ${data.progress.pct || 0}%…`; }
      else { st.className = 'status'; st.textContent = ''; }
    }
    return data;
  } catch (e) {
    if (st) { st.className = 'status err'; st.textContent = `Models: ${e.message}`; }
    return null;
  }
}

// Switch to a model (the gateway downloads it first if needed). POST returns 202;
// we poll the list until it's active + ready (downloads can take a minute or more).
async function selectNerModel(id, ctx = GW_NER) {
  const url = ctx.url();
  const st = $(ctx.mstatus);
  if (!url || !id) return;
  st.className = 'status'; st.textContent = `Switching to ${id}…`;
  try {
    await setNerModel(url, id);
  } catch (e) { st.className = 'status err'; st.textContent = `Switch failed: ${e.message}`; return; }
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const data = await refreshNerModels(ctx);
    if (data && data.active === id && data.state === 'ready') {
      st.className = 'status ok'; st.textContent = `✓ Using ${id}`;
      const s = await checkGateway(url);
      ctx.onHealth(s.ok ? s.ner : null);
      return;
    }
  }
  st.className = 'status'; st.textContent = 'Still downloading… it will switch when ready.';
}

// ── STT (dictation) model manager — mirrors the NER one above ────────────────────
// Pickable by machine resources: each row shows size + a rough RAM hint + tier.
const TIER_LABEL = { light: 'Light', balanced: 'Balanced', accurate: 'Accurate', max: 'Max', custom: 'Custom' };

function renderSttModels(data) {
  const host = $('gw-stt-models');
  if (!host) return;
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const active = data?.active || null;
  const dl = data?.progress || null;
  // Surface the recommended default (e.g. Parakeet) first — it's the one we steer
  // users to. Stable sort: recommended before the rest, order otherwise preserved.
  const avail = (data?.available || []).slice()
    .sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
  const rows = avail.map((m) => {
    const isActive = m.id === active;
    const downloading = dl && dl.model === m.id;
    const meta = [
      m.tier ? esc(TIER_LABEL[m.tier] || m.tier) : '',
      esc(m.lang),
      m.approxMB ? `~${m.approxMB} MB` : '',
      m.ramMB ? `~${(m.ramMB / 1024).toFixed(1)} GB RAM` : '',
      m.installed && !isActive ? 'installed' : '',
    ].filter(Boolean).join(' · ');
    const label = downloading
      ? `Downloading… ${dl.pct || 0}%`
      : isActive ? 'In use' : (m.installed ? 'Use' : `Download${m.approxMB ? ` (~${m.approxMB} MB)` : ''}`);
    const bar = downloading
      ? `<div class="dl-bar"><div class="dl-bar-fill" style="width:${Math.max(3, dl.pct || 0)}%"></div></div>
         <p class="muted sm" style="margin:2px 0 0">${dl.file ? esc(dl.file) + ' · ' : ''}${dl.pct || 0}% — large models take a few minutes; you can keep working.</p>`
      : '';
    return `<div class="entity">
      <div class="entity-head">
        <strong style="flex:1 1 auto">${esc(m.label || m.id)}${m.recommended ? '<span class="reco-badge">Recommended</span>' : ''}</strong>
        <span class="status">${meta}</span>
        <button type="button" class="btn ${isActive ? '' : 'primary'} gw-stt-use" data-id="${esc(m.id)}" ${isActive || downloading ? 'disabled' : ''}>${label}</button>
      </div>
      <p class="muted sm" style="margin:0">${esc(m.note || '')}</p>
      ${bar}
    </div>`;
  });
  host.innerHTML = rows.join('') || '<p class="muted sm">No models available.</p>';
  host.querySelectorAll('.gw-stt-use').forEach((b) => { b.onclick = () => selectSttModel(b.dataset.id); });
  renderSttDtype(data);
}

// Precision (quantization) picker. Re-loads the ACTIVE model at the chosen dtype.
// On the WASM binary only fp32 loads, so the rest are disabled there.
let _sttActive = null;
function renderSttDtype(data) {
  const sel = $('gw-stt-dtype');
  const note = $('gw-stt-dtype-note');
  if (!sel) return;
  _sttActive = data?.active || null;
  const opts = data?.dtypes || [{ id: 'auto', label: 'Auto (recommended)' }];
  const cur = data?.dtype || 'auto';
  const wasm = data?.runtime === 'wasm';
  sel.innerHTML = opts.map((o) => {
    const disabled = wasm && o.id !== 'auto' && o.id !== 'fp32'; // only fp32 loads on WASM
    return `<option value="${escapeHtml(o.id)}"${o.id === cur ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(o.label)}${disabled ? ' — native only' : ''}</option>`;
  }).join('');
  if (note) {
    const curNote = (opts.find((o) => o.id === cur) || {}).note || '';
    note.textContent = curNote + (data?.loadedDtype ? `  ·  currently loaded: ${data.loadedDtype}` : '');
  }
  sel.onchange = () => {
    if (!_sttActive) { $('gw-stt-models-status').textContent = 'Pick a model first, then a precision.'; return; }
    selectSttModel(_sttActive, sel.value); // re-load the active model at this precision
  };
}

// Show a speed advisory when the gateway is the WASM (binary) build — it's fp32-
// only + single-thread (~10× slower). The native npm gateway loads q8 quantized.
async function renderSttRuntimeHint() {
  const el = $('gw-stt-runtime-hint');
  if (!el) return;
  const url = normalizeGatewayUrl($('gw-url').value);
  if (!url) { el.classList.add('hidden'); return; }
  try {
    const h = await checkGateway(url); // /status; fall back to /health for runtime
    let runtime = h?.stt?.runtime;
    if (!runtime) { try { runtime = (await (await fetch(`${url}/health`)).json())?.stt?.runtime; } catch { /* ignore */ } }
    if (runtime === 'wasm') {
      el.classList.remove('hidden');
      el.innerHTML = '⚡ <strong>This gateway is the standalone (WASM) build</strong> — it runs models in fp32, single-threaded (slower, and can\'t use quantized models). For <strong>~10× faster</strong> speech-to-text (quantized q8, even Small/Large in real time), install the <strong>native</strong> gateway: <code>npm i -g @chatpanel/gateway</code> then <code>chatpanel-gateway --install</code>.';
    } else { el.classList.add('hidden'); }
  } catch { el.classList.add('hidden'); }
}

async function refreshSttModels() {
  const url = normalizeGatewayUrl($('gw-url').value);
  const st = $('gw-stt-models-status');
  if (!url) return null;
  renderSttRuntimeHint();
  try {
    const data = await getSttModels(url);
    renderSttModels(data);
    if (st) {
      if (data.progress) { st.className = 'status'; st.textContent = `Downloading ${data.progress.model} — ${data.progress.pct || 0}%…`; }
      else { st.className = 'status'; st.textContent = ''; }
    }
    return data;
  } catch (e) {
    // Older gateways (pre-STT) 404 here — show a gentle hint, not a scary error.
    if (st) { st.className = 'status'; st.textContent = /404/.test(e.message) ? 'Update the gateway to enable local dictation.' : `Models: ${e.message}`; }
    return null;
  }
}

// One STT poll loop at a time: each click bumps the token so any older loop
// exits (otherwise clicking Download twice stacks loops that both hammer
// /stt/models — the "called in a loop" bug). A large model can take minutes, so
// poll at 2s and surface the % the whole time.
let _sttPollToken = 0;
async function selectSttModel(id, dtype) {
  const url = normalizeGatewayUrl($('gw-url').value);
  const st = $('gw-stt-models-status');
  if (!url || !id) return;
  const my = ++_sttPollToken;
  st.className = 'status'; st.textContent = `Switching to ${id}${dtype && dtype !== 'auto' ? ` (${dtype})` : ''}…`;
  try {
    await setSttModel(url, id, dtype);
  } catch (e) { st.className = 'status err'; st.textContent = `Switch failed: ${e.message}`; return; }
  for (let i = 0; i < 450 && my === _sttPollToken; i++) { // ~15 min ceiling; superseded by a newer click
    await new Promise((r) => setTimeout(r, 2000));
    if (my !== _sttPollToken) return; // a newer selection took over
    const data = await refreshSttModels();
    if (data && data.active === id && data.state === 'ready') { st.className = 'status ok'; st.textContent = `✓ Using ${id}`; return; }
    if (data && data.state === 'error') { st.className = 'status err'; st.textContent = 'Model failed to load — try a smaller one.'; return; }
  }
  if (my === _sttPollToken) { st.className = 'status'; st.textContent = 'Still downloading… it will switch when ready.'; }
}

// ── Speaker (diarization) model — a single model with a Download / In-use button.
let _diarPollToken = 0;
function renderDiarizeModel(data) {
  const host = $('gw-diarize-models');
  if (!host) return;
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const dl = data?.progress || null;
  const m = (data?.available || [])[0];
  if (!m) { host.innerHTML = '<p class="muted sm">Unavailable.</p>'; return; }
  const downloading = (dl && dl.model === m.id) || data?.state === 'downloading' || data?.state === 'loading';
  const ready = data?.state === 'ready' && m.installed;
  const meta = [m.approxMB ? `~${m.approxMB} MB` : '', m.installed ? 'installed' : ''].filter(Boolean).join(' · ');
  const label = downloading ? `Downloading… ${dl?.pct || 0}%` : ready ? 'Ready' : (m.installed ? 'Load' : `Download (~${m.approxMB} MB)`);
  const bar = downloading
    ? `<div class="dl-bar"><div class="dl-bar-fill" style="width:${Math.max(3, dl?.pct || 0)}%"></div></div>
       <p class="muted sm" style="margin:2px 0 0">${dl?.file ? esc(dl.file) + ' · ' : ''}${dl?.pct || 0}% — one-time.</p>`
    : '';
  host.innerHTML = `<div class="entity">
      <div class="entity-head">
        <strong style="flex:1 1 auto">${esc(m.label || m.id)}</strong>
        <span class="status">${esc(meta)}</span>
        <button type="button" class="btn ${ready ? '' : 'primary'} gw-diar-use" ${ready || downloading ? 'disabled' : ''}>${label}</button>
      </div>
      <p class="muted sm" style="margin:0">${esc(m.note || '')}</p>
      ${bar}
    </div>`;
  const btn = host.querySelector('.gw-diar-use');
  if (btn) btn.onclick = () => downloadDiarize();
}
async function refreshDiarizeModel() {
  const url = normalizeGatewayUrl($('gw-url').value);
  if (!url) return null;
  try { const data = await getDiarizeModel(url); renderDiarizeModel(data); return data; }
  catch (e) {
    const st = $('gw-diarize-status');
    if (st) { st.className = 'status'; st.textContent = /404/.test(e.message) ? 'Update the gateway to enable speaker diarization.' : `Speaker model: ${e.message}`; }
    return null;
  }
}
async function downloadDiarize() {
  const url = normalizeGatewayUrl($('gw-url').value);
  const st = $('gw-diarize-status');
  if (!url) return;
  const my = ++_diarPollToken;
  st.className = 'status'; st.textContent = 'Downloading speaker model…';
  try { await downloadDiarizeModel(url); } catch (e) { st.className = 'status err'; st.textContent = `Download failed: ${e.message}`; return; }
  for (let i = 0; i < 300 && my === _diarPollToken; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (my !== _diarPollToken) return;
    const data = await refreshDiarizeModel();
    if (data && data.state === 'ready') { st.className = 'status ok'; st.textContent = '✓ Speaker model ready'; return; }
    if (data && data.state === 'error') { st.className = 'status err'; st.textContent = 'Model failed to load.'; return; }
  }
  if (my === _diarPollToken) { st.className = 'status'; st.textContent = 'Still downloading… it will be ready shortly.'; }
}

// ── Searchable model registry (Hugging Face) — browse & download models, like the
// MCP tools tab. task 'stt' → whisper (/stt/models); 'ner' → token-classification
// (/ner/models). Only transformers.js (ONNX) models show, so anything listed runs.
const MODEL_REG = {
  stt: { input: 'gw-stt-search', btn: 'gw-stt-search-btn', results: 'gw-stt-search-results', pick: (id) => selectSttModel(id) },
  ner: { input: 'gw-ner-search', btn: 'gw-ner-search-btn', results: 'gw-ner-search-results', pick: (id) => selectNerModel(id) },
};

async function runModelSearch(task) {
  const ctx = MODEL_REG[task];
  const box = $(ctx.results);
  if (!box) return;
  const query = ($(ctx.input).value || '').trim();
  box.classList.remove('hidden');
  box.innerHTML = '<p class="muted sm">Searching Hugging Face…</p>';
  try {
    const items = await searchModels({ task, query, limit: 30 });
    if (!items.length) { box.innerHTML = '<p class="muted sm">No transformers.js (ONNX) models matched. Try another term.</p>'; return; }
    box.innerHTML = items.map((m) => {
      const meta = [`↓ ${formatDownloads(m.downloads)}`, m.likes ? `♥ ${m.likes}` : '', m.langs.length ? m.langs.join('/') : '']
        .filter(Boolean).join(' · ');
      return `<div class="model-reg-item">
        <div class="mri-main">
          <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" class="mri-id">${escapeHtml(m.id)}</a>
          <span class="mri-meta">${escapeHtml(meta)}</span>
        </div>
        <button type="button" class="btn primary sm mri-use" data-id="${escapeHtml(m.id)}">Download &amp; use</button>
      </div>`;
    }).join('');
    box.querySelectorAll('.mri-use').forEach((b) => { b.onclick = () => ctx.pick(b.dataset.id); });
  } catch (e) {
    box.innerHTML = `<p class="status err">Search failed: ${escapeHtml(e.message)}</p>`;
  }
}

// Privacy-tab NER health line (the "Bundled NER" detector === the gateway's NER).
function renderPrivNerHealth(ner) {
  const el = $('priv-ner-status');
  if (!el) return;
  if (!ner) { el.className = 'status err'; el.textContent = `NER: gateway not reachable at ${gatewayBaseUrl()} — start it (or set its URL on the Gateway tab).`; return; }
  if (ner.ready) { el.className = 'status ok'; el.textContent = `NER: ✓ ready${ner.model ? ` · model ${ner.model}` : ''} · ${gatewayNerEndpoint()}`; return; }
  if (ner.configured) { el.className = 'status'; el.textContent = 'NER: ⏳ starting… first run downloads the model (~100 MB). Check again shortly.'; return; }
  el.className = 'status err'; el.textContent = 'NER: ✕ not running on the gateway.';
}

// "Check NER health" on the Privacy tab — probe the gateway and show its NER state.
async function checkPrivNer() {
  const el = $('priv-ner-status');
  if (!el) return;
  el.className = 'status'; el.textContent = 'NER: checking…';
  const s = await checkGateway(gatewayBaseUrl());
  renderPrivNerHealth(s.ok ? s.ner : null);
}

// Resolve the detector selection → a detection config the gateway understands.
function collectDetection() {
  const det = $('gw-det-backend').value;
  if (det === 'off') return { backend: 'off' };
  // LLM detectors have first-token latency, so default a generous timeout (the
  // preview honors this; the gateway server floors detection at 30s regardless).
  // This mirrors the Privacy tab, where detection runs with a long timeout.
  const isLLM = det === 'openai' || det.startsWith('cfg:');
  const raw = Number($('gw-det-timeout').value);
  const timeoutMs = raw > 0 ? raw : (isLLM ? 15000 : 8000);
  if (det.startsWith('cfg:')) {
    const ep = (settings.endpoints || []).find((e) => e.id === det.slice(4));
    if (!ep) return { backend: 'off' };
    return { backend: 'openai', url: ep.baseUrl, ...(ep.model ? { model: ep.model } : {}), ...(ep.apiKey ? { apiKey: ep.apiKey } : {}), timeoutMs };
  }
  return {
    backend: det,
    url: $('gw-det-url').value.trim(),
    ...(det === 'openai' && $('gw-det-model').value.trim() ? { model: $('gw-det-model').value.trim() } : {}),
    ...($('gw-det-key').value.trim() ? { apiKey: $('gw-det-key').value.trim() } : {}),
    timeoutMs,
  };
}

function collectGatewayPatch() {
  const patch = {
    destinations: gatewayDests
      .filter((d) => d && d.id && (d.type === 'agent' || d.type === 'api'))
      .map((d) => ({ ...d, models: (d.models || []).filter(Boolean) })),
    redaction: {
      tier: $('gw-tier').value,
      redactSystem: $('gw-redact-system').checked,
      dictionary: parseDictionary($('gw-dictionary').value),
      detection: collectDetection(),
    },
    allowedOrigins: $('gw-origins').value.split('\n').map((s) => s.trim()).filter(Boolean),
    logRequests: $('gw-log').checked,
    logDetail: $('gw-log-detail').checked
      ? (document.querySelector('input[name="gw-detail"]:checked')?.value === 'values' ? 'values' : 'types')
      : 'off',
    tools: {
      toolData: $('gw-tools-data').value,
      autoNarrow: $('gw-tools-narrow').checked,
      maxPerTurn: Number($('gw-tools-cap').value) || 8,
      narrowAll: $('gw-tools-narrowall').checked,
    },
  };
  // The client only ever sends a Pro token — never a cap or usage count.
  const token = $('gw-pro-token').value.trim();
  if (token) patch.pro = { entitlementToken: token };
  return patch;
}

async function saveGateway() {
  const url = normalizeGatewayUrl($('gw-url').value);
  const st = $('gw-save-status');
  if (!url) return;
  st.textContent = 'Saving…'; st.className = 'status';
  try {
    fillGatewayForm(await setGatewayConfig(url, collectGatewayPatch()));
    st.textContent = '✓ Saved to gateway'; st.className = 'status ok';
    gatewayState = await checkGateway(url);
    renderGatewayMonitor(gatewayState);
  } catch (e) {
    st.textContent = `✕ ${e.message}`; st.className = 'status err';
  }
}

// Auto-save (debounced): the gateway owns its config, so we push edits to it on
// change — no "did I click Save?" footgun. Unlike saveGateway() we DON'T re-fill the
// form (that would fight the user mid-edit); the explicit button stays for a full
// save+refresh. No-op until connected.
let gwAutoSaveTimer = null;
function autoSaveGateway() {
  if (gwAutoSaveTimer) clearTimeout(gwAutoSaveTimer);
  const st = $('gw-save-status');
  if (st) { st.textContent = 'Saving…'; st.className = 'status'; }
  gwAutoSaveTimer = setTimeout(async () => {
    const url = normalizeGatewayUrl($('gw-url').value);
    if (!url || !(gatewayState && gatewayState.ok)) {
      if (st) { st.textContent = 'Connect to the gateway to save.'; st.className = 'status'; }
      return;
    }
    try {
      await setGatewayConfig(url, collectGatewayPatch());
      if (st) { st.textContent = '✓ Saved automatically'; st.className = 'status ok'; }
    } catch (e) {
      if (st) { st.textContent = `✕ ${e.message}`; st.className = 'status err'; }
    }
  }, 700);
}

// Push THIS device's ChatPanel Pro entitlement token to the gateway, so it
// inherits the same subscription that unlocks Pro in the extension/bridge — no
// copy-paste. The gateway verifies the token offline (ECDSA) and unlocks.
async function activateGatewayPro() {
  const url = normalizeGatewayUrl($('gw-url').value);
  const st = $('gw-pro-status');
  if (!url) { st.textContent = 'Connect to the gateway first.'; st.className = 'status'; return; }
  if (!isPro(license)) {
    st.textContent = 'You’re on Free. Activate ChatPanel Pro in the Account tab, then click here.';
    st.className = 'status';
    return;
  }
  const token = await getEntitlementToken();
  if (!token) {
    st.textContent = 'No active entitlement on this device — reactivate Pro in the Account tab.';
    st.className = 'status err';
    return;
  }
  st.textContent = 'Activating…'; st.className = 'status';
  try {
    const synced = await ensureGatewayEntitlement(url, { localPro: true, token, unlocked: false });
    fillGatewayForm(synced.config);
    gatewayState = synced.status;
    renderGatewayMonitor(gatewayState);
    const ok = gatewayState.ok && gatewayState.pro && gatewayState.pro.unlocked;
    st.textContent = ok ? '✓ Pro active on the gateway — full tier, unlimited.' : 'Saved, but not unlocked (token may be expired — reactivate Pro).';
    st.className = ok ? 'status ok' : 'status err';
  } catch (e) {
    st.textContent = `✕ ${e.message}`; st.className = 'status err';
  }
}

// Populate the test model picker from the enabled destinations' models.
function populateTestModels() {
  renderFlowTools('gw-test-tools'); // arm the same tool picker as the privacy test
  const sel = $('gw-test-model');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  const models = [...new Set(gatewayDests.flatMap((d) => (d.models && d.models.length ? d.models : [d.id])))];
  if (!models.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(enable a destination first)'; sel.appendChild(o); return; }
  for (const m of models) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
  if (models.includes(cur)) sel.value = cur;
}

// Preview the redaction LOCALLY with the same engine + config the gateway uses.
async function gatewayPreview(prompt) {
  const url = normalizeGatewayUrl($('gw-url').value);
  const tier = $('gw-tier').value;
  const dictionary = parseDictionary($('gw-dictionary').value);
  let detection = collectDetection();
  // When no external detector is configured, preview against the gateway's OWN
  // in-process NER (served at <gateway>/ner) — not the long-gone bundled :9009.
  if (detection.backend === 'off') detection = { backend: 'endpoint', url: `${url}/ner`, timeoutMs: 8000 }; // gateway in-process NER
  let detected = [];
  if (tier === 'full' && detection.backend !== 'off') {
    try { detected = await detectEntities(prompt, { detection }); } catch { detected = []; }
  }
  const vault = createVault();
  const redacted = redactText(prompt, vault, { tier, entities: detected, dictionary });
  const spans = [...(vault.byToken || new Map())].map(([token, value]) => ({ token, value }));
  return { detected, redacted, spans };
}

const GW_TEST_SAMPLE = 'My name is John, email john@adams.com — who is the famous president with my name?';

function renderGatewayFlow({ input, detected, redacted, spans, reply, error, toolEvents }, withModel) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const cards = [];
  cards.push(flowCard(1, 'Your prompt', `<div class="flow-text">${esc(input)}</div>${hiddenCharNote(input)}`));
  const chips = (detected || []).length
    ? detected.map((d) => `<span class="flow-chip">${esc(d.value)}<em>${esc(d.type)}</em></span>`).join('')
    : '<span class="muted sm">No AI-detected entities (patterns + dictionary still apply).</span>';
  cards.push(flowCard(2, 'Detected', chips));
  cards.push(flowCard(3, 'Model / agent sees', `<div class="flow-text">${esc(redacted)}</div>`, 'flow-model'));
  const maps = (spans || []).length
    ? spans.map((s) => `<div class="flow-map"><code>${esc(s.token)}</code> → <b>${esc(s.value)}</b></div>`).join('')
    : '<span class="muted sm">Nothing replaced.</span>';
  cards.push(flowCard(4, 'Restored from', maps, 'flow-tools'));
  let n = 4;
  // Tool round-trip the agent ran through the gateway (args restored to REAL values).
  if (withModel && (toolEvents || []).length) {
    const rows = toolEvents.map((t) => `<div class="flow-map">${icon('tools')} <code>${esc(t.name)}</code><div class="muted sm">args → tool: ${esc(JSON.stringify(t.args))}</div><div class="muted sm">result → ${esc((t.result || '').slice(0, 240))}</div></div>`).join('');
    cards.push(flowCard(++n, 'Tools run (real values)', rows, 'flow-tools'));
  }
  if (withModel) {
    // What the destination model actually sent back — still holding the placeholder
    // tokens, BEFORE the gateway swaps them back to real values. Reconstructed from
    // the spans, since the gateway restores server-side (the client never sees it raw).
    if (!error && reply) {
      cards.push(flowCard(++n, 'Model reply (redacted)', `<div class="flow-text">${esc(reRedactReply(reply, spans))}</div>`, 'flow-model'));
    }
    const r = error ? `<span class="flow-err">✕ ${esc(error)}</span>` : `<div class="flow-text">${esc(reply) || '<span class="muted sm">(empty)</span>'}</div>`;
    cards.push(flowCard(++n, 'You see (restored)', r, 'flow-you'));
  }
  $('gw-test-out').innerHTML = cards.join('<div class="flow-arrow">→</div>');
}

// Parse an OpenAI SSE stream → accumulated text + assembled tool_calls (by index).
async function readOpenAIStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const tc = []; // index -> { id, type, function:{ name, arguments } }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (typeof d.content === 'string') content += d.content;
      for (const t of d.tool_calls || []) {
        const idx = t.index ?? 0;
        tc[idx] = tc[idx] || { id: t.id, type: 'function', function: { name: '', arguments: '' } };
        if (t.id) tc[idx].id = t.id;
        if (t.function?.name) tc[idx].function.name = t.function.name;
        if (t.function?.arguments) tc[idx].function.arguments += t.function.arguments;
      }
    }
  }
  return { content, toolCalls: tc.filter(Boolean) };
}

// Run the prompt through the gateway as a real OpenAI agentic client: stream, run
// any tool calls IN-EXTENSION (the gateway restored their args to real values), feed
// results back, and loop until the destination answers. This is what ChatPanel does
// — so the gateway test now exercises the full harness, not just redaction.
async function gatewayAgenticRun(url, model, prompt, toolset) {
  const toolSpecs = (toolset?.specs || []).map((s) => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } }));
  const toolsSent = toolSpecs.length;
  // Send the MCP guidance (how/when to use the tools) as a system message, exactly
  // like the real chat — the gateway adds the placeholder note on top. Without this
  // the destination has tools but no usage guidance and may not call them.
  const msgs = toolset?.system
    ? [{ role: 'system', content: toolset.system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];
  const toolEvents = [];
  for (let step = 0; step < 6; step++) {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, ...(toolSpecs.length ? { tools: toolSpecs } : {}), stream: true }),
    });
    if (!res.ok) return { reply: '', toolEvents, toolsSent, error: `HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const { content, toolCalls } = await readOpenAIStream(res);
    if (!toolCalls.length) return { reply: content, toolEvents, toolsSent, error: content ? '' : 'no reply' };
    msgs.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    for (const t of toolCalls) {
      let args = {}; try { args = JSON.parse(t.function.arguments || '{}'); } catch { /* keep {} */ }
      let text;
      try {
        const result = toolset && typeof toolset.execute === 'function' ? await toolset.execute(t.function.name, args, { callId: t.id }) : 'no tools armed';
        text = typeof result === 'string' ? result : (result?.text ?? JSON.stringify(result));
      } catch (e) { text = `Tool error: ${e.message}`; }
      toolEvents.push({ name: t.function.name, args, result: text });
      msgs.push({ role: 'tool', tool_call_id: t.id, content: text });
    }
  }
  return { reply: '(reached the tool-step limit)', toolEvents, toolsSent, error: '' };
}

async function runGatewayTest(withModel) {
  const url = normalizeGatewayUrl($('gw-url').value);
  const prompt = $('gw-test-input').value.trim() || GW_TEST_SAMPLE;
  const model = $('gw-test-model').value;
  const st = $('gw-test-status');
  if (!url) { st.textContent = 'Connect to the gateway first.'; st.className = 'status'; return; }
  st.textContent = 'Redacting…'; st.className = 'status';
  let prev;
  try { prev = await gatewayPreview(prompt); } catch (e) { st.textContent = `✕ preview: ${e.message}`; st.className = 'status err'; return; }
  renderGatewayFlow({ input: prompt, ...prev }, false);
  if (!withModel) { st.textContent = '✓ preview'; st.className = 'status ok'; return; }
  if (!model) { st.textContent = 'Pick a model (enable a destination).'; st.className = 'status'; return; }
  st.textContent = `Running through the gateway → ${model}…`;
  try {
    // Narrow to the relevant tools with the SAME shared ranker the privacy tab uses,
    // so the destination gets a focused set (a weak model handed 63 tools flails and
    // calls something irrelevant). Local tools are always kept.
    const fullToolset = await buildHarnessTools('gw-test-tools');
    const fullCount = (fullToolset && fullToolset.specs && fullToolset.specs.length) || 0;
    const toolset = narrowToolset(fullToolset, prompt, { cap: Number(settings.ui?.maxToolsPerTurn) || DEFAULT_AUTO_TOOL_CAP, keep: isLocalToolSpec });
    const { reply, toolEvents, toolsSent = 0, error } = await gatewayAgenticRun(url, model, prompt, toolset);
    renderGatewayFlow({ input: prompt, ...prev, reply, toolEvents, error }, true);
    const n = (toolEvents || []).length;
    const narrowed = fullCount > toolsSent ? ` (narrowed from ${fullCount})` : '';
    const armed = `${toolsSent} tool${toolsSent === 1 ? '' : 's'} armed${narrowed}`;
    st.textContent = reply
      ? `✓ done · ${armed}${n ? ` · ${n} call${n === 1 ? '' : 's'}` : ' · 0 calls'}`
      : `✕ ${error || 'no reply'} · ${armed}`;
    st.className = reply ? 'status ok' : 'status err';
  } catch (e) {
    renderGatewayFlow({ input: prompt, ...prev, error: e.message }, true);
    st.textContent = `✕ ${e.message}`; st.className = 'status err';
  }
}

function wireGateway() {
  $('gw-check').onclick = async () => {
    settings.gatewayUrl = normalizeGatewayUrl($('gw-url').value);
    await saveSettings(settings);
    refreshGateway();
  };
  if ($('gw-token')) $('gw-token').value = settings.gatewayToken || '';
  const saveTok = $('gw-token-save');
  if (saveTok) saveTok.onclick = async () => {
    settings.gatewayToken = ($('gw-token').value || '').trim();
    await saveSettings(settings);
    setGatewayToken(settings.gatewayToken);
    refreshGateway(); // retry the admin API with the pasted token
  };
  $('gw-det-backend').onchange = () => { setGwDetectorRows(); renderNerStatus(gatewayState && gatewayState.ner); };
  $('gw-det-url').oninput = setGwDetectorRows; // live cloud-warning for a manual URL
  $('gw-save').onclick = saveGateway;
  $('gw-pro-activate').onclick = activateGatewayPro;
  $('gw-dest-all').onclick = () => { gatewayDests = availableDestinations(); renderDestinations(); autoSaveGateway(); };
  $('gw-dest-none').onclick = () => { gatewayDests = []; renderDestinations(); autoSaveGateway(); };
  // Destinations dropdown: toggle the popover; close on outside click / Escape.
  const gwDestSelect = $('gw-dest-select'), gwDestTrigger = $('gw-dest-trigger'), gwDestMenu = $('gw-dest-menu');
  const closeDestMenu = () => {
    if (!gwDestSelect || !gwDestSelect.classList.contains('open')) return;
    gwDestSelect.classList.remove('open'); gwDestMenu.classList.add('hidden');
    gwDestTrigger.setAttribute('aria-expanded', 'false');
  };
  if (gwDestTrigger) {
    gwDestTrigger.onclick = (e) => {
      e.stopPropagation();
      const open = gwDestSelect.classList.toggle('open');
      gwDestMenu.classList.toggle('hidden', !open);
      gwDestTrigger.setAttribute('aria-expanded', String(open));
    };
    gwDestMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeDestMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDestMenu(); });
  }
  $('gw-test-run').onclick = () => runGatewayTest(true);
  $('gw-test-preview').onclick = () => runGatewayTest(false);
  $('gw-logs-refresh').onclick = refreshGatewayLogs;
  $('gw-ner-check').onclick = checkNer;
  // The gateway keeps its own dictionary (it redacts traffic the panel never sees), so the
  // two lists are genuinely separate — but retyping yours is busywork. Merge, don't replace:
  // appending only the lines that are missing can't destroy gateway-only entries.
  const dictCopy = $('gw-dict-copy');
  if (dictCopy) dictCopy.onclick = () => {
    const box = $('gw-dictionary');
    const from = ($('priv-dictionary')?.value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!box || !from.length) { toast('Your ChatPanel dictionary is empty — nothing to copy.'); return; }
    const have = new Set(box.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const added = from.filter((l) => !have.has(l));
    if (!added.length) { toast('Already in the gateway dictionary.'); return; }
    box.value = [...have, ...added].join('\n');
    box.dispatchEvent(new Event('input', { bubbles: true })); // reuse the debounced auto-save
    toast(`Copied ${added.length} entr${added.length === 1 ? 'y' : 'ies'} to the gateway.`);
  };
  // Searchable model registries (Hugging Face) — browse & download, like MCP tools.
  for (const task of ['stt', 'ner']) {
    const ctx = MODEL_REG[task];
    if ($(ctx.btn)) $(ctx.btn).onclick = () => runModelSearch(task);
    if ($(ctx.input)) $(ctx.input).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runModelSearch(task); } };
  }
  // Dictation language override (client-side; drives both the gateway session and
  // the browser fallback). '' = auto-detect.
  if ($('gw-stt-lang')) {
    $('gw-stt-lang').value = settings.ui?.dictation?.lang || '';
    $('gw-stt-lang').onchange = async () => {
      settings.ui = settings.ui || {};
      settings.ui.dictation = { ...(settings.ui.dictation || {}), lang: $('gw-stt-lang').value || '' };
      await saveSettings(settings);
    };
  }

  // Auto-save every config field to the gateway on change (debounced) — so users
  // never lose edits by forgetting "Save to gateway". The explicit button remains.
  // (gw-url/test/pro-token are excluded: connection + write-only token aren't config.)
  const AUTO = ['gw-tier', 'gw-redact-system', 'gw-det-backend', 'gw-det-url', 'gw-det-model',
    'gw-det-key', 'gw-det-timeout', 'gw-dictionary', 'gw-origins', 'gw-log', 'gw-log-detail',
    'gw-tools-data', 'gw-tools-narrow', 'gw-tools-cap', 'gw-tools-narrowall'];
  for (const id of AUTO) {
    const el = $(id);
    if (!el) continue;
    const evt = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
    el.addEventListener(evt, autoSaveGateway);
  }
  // Toggle the capture checkbox reveals the types/values radios; both auto-save.
  $('gw-log-detail').addEventListener('change', setGwDetailRows);
  for (const r of document.querySelectorAll('input[name="gw-detail"]')) r.addEventListener('change', autoSaveGateway);
}

async function refreshBridgeState() {
  bridgeState = await checkBridge(settings.bridgeUrl);
  renderBridgeAgents();
  renderBridgeUpdate();
}

// Show a "bridge update available" notice when /health reports a newer release.
// Compiled-binary installs get a one-click Update (the bridge self-replaces and
// restarts); npm/npx installs get the update command (they can't swap own files).
function renderBridgeUpdate() {
  const el = $('bridge-update');
  if (!el) return;
  const u = bridgeState && bridgeState.ok ? bridgeState.update : null;
  if (!u || !u.updateAvailable) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.className = 'status';
  if (u.canSelfUpdate) {
    el.textContent = `↑ Bridge v${u.latest} available (you have v${u.current}). `;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Update bridge';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Updating…';
      // The download-swap-restart-wait dance lives in js/bridge-update.js so the Channels
      // card can offer the same button instead of only naming the version it needs.
      const { updateBridgeAndWait } = await import('./js/bridge-update.js');
      const r = await updateBridgeAndWait(settings.bridgeUrl, {
        onStatus: (phase) => {
          el.textContent = phase === 'restarting'
            ? 'Bridge is updating and restarting…' : 'Downloading the new bridge…';
        },
      });
      if (!r.ok) {
        el.textContent = `✕ Bridge update failed: ${r.error || 'unknown'}`;
        el.className = 'status err';
        return;
      }
      bridgeState = await checkBridge(settings.bridgeUrl);
      renderBridgeAgents();
      renderBridgeUpdate();
      renderChannels().catch(() => {}); // the card that sent them here should stop complaining
    };
    el.appendChild(btn);
  } else {
    const cmd = u.npmCommand || 'npm i -g @chatpanel/bridge@latest';
    el.innerHTML = `↑ Bridge <b>v${u.latest}</b> available (you have v${u.current}). Update with: <code>${cmd}</code>`;
  }
}

async function testBridge() {
  const url = $('bridge-url').value.trim();
  settings.bridgeUrl = url;
  await saveSettings(settings);
  const status = $('bridge-status');
  status.textContent = 'Checking…';
  status.className = 'status';
  bridgeState = await checkBridge(url);
  if (!bridgeState.ok) {
    status.textContent = `✕ Not reachable (${bridgeState.reason || 'no response'}). Install or start the bridge — see the commands below.`;
    status.className = 'status err';
    const help = $('bridge-install-help');
    if (help) help.open = true; // reveal the macOS/Linux + Windows + npx commands
    renderBridgeAgents();
    return;
  }
  const lines = bridgeState.agents.map((a) => `${a.available ? '✓' : '✕'} ${a.label}${a.available ? '' : ' — ' + (a.reason || 'unavailable')}`);
  const ver = bridgeState.version ? ` (v${bridgeState.version})` : '';
  status.textContent = `Connected${ver}. ${lines.join('   ')}`;
  status.className = 'status ok';
  renderBridgeAgents();
  renderBridgeUpdate();
}

function bridgeAgents() {
  return (settings.agents || []).filter((a) => a.kind === 'bridge');
}

const agentKey = (a) => `agent:${a.id}`;

function renderBridgeAgents() {
  const root = $('bridge-agents');
  root.innerHTML = '';
  const list = bridgeAgents();
  list.forEach((a, i) => {
    const node = bridgeAgentCard(a);
    setCardIndex(node, i, list.length, 'Agent');
    root.appendChild(node);
  });
  wireExpandAll('toggle-agents', list.map(agentKey), renderBridgeAgents);
}

// Human label for a CLI kind, used in the collapsed summary line.
const AGENT_KIND_LABEL = {
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  pi: 'Pi', opencode: 'OpenCode', hermes: 'Hermes', kiro: 'Kiro', copilot: 'GitHub Copilot',
  deepseek: 'DeepSeek Harness',
  custom: 'Custom CLI',
};

function bridgeAgentCard(agent) {
  const node = $('bridge-agent-tpl').content.firstElementChild.cloneNode(true);
  hydrate(node); // the collapse chevron is a data-icon
  const q = (sel) => node.querySelector(sel);
  q('.ba-name').value = agent.name || '';
  q('.ba-enabled').checked = agent.enabled !== false;
  q('.ba-kind').value = agent.bridgeAgent || 'claude';
  q('.ba-workdir').value = agent.workingDir || '';
  // A blank field used to mean "wherever the bridge happened to be" — the filesystem root
  // under launchd — which is why files went missing. Say what blank resolves to, and say
  // it here rather than leaving it to be discovered from where the files did not appear.
  syncWorkdirHint(q);
  q('.ba-extraargs').value = agent.extraArgs || '';
  q('.ba-model').value = agent.model || '';
  q('.ba-acmodel').value = agent.autocompleteModel || '';
  q('.ba-perm').value = agent.permissionMode || 'acceptEdits';
  q('.ba-local').checked = agent.useLocalConfig !== false;
  q('.ba-mcpoff').value = agent.mcpDisabled || '';
  q('.ba-system').value = agent.systemPrompt || '';
  // Custom ("bring your own CLI") fields.
  q('.ba-command').value = agent.command || '';
  q('.ba-args').value = agent.args || '';
  q('.ba-promptvia').value = agent.promptVia || 'stdin';
  q('.ba-format').value = agent.format || 'text';
  q('.ba-listargs').value = agent.listModelsArgs || '';
  q('.ba-modelarg').value = agent.modelArg || '';
  q('.ba-imagearg').value = agent.imageArg || '';
  q('.ba-mcparg').value = agent.mcpArg || '';
  q('.ba-stablemcp').value = agent.stableMcpSetupCommand || '';
  q('.ba-trusttoolsarg').value = agent.trustToolsArg || '';
  gateField('advancedAgent', q('.ba-system')); // per-agent system prompt is Pro
  applyFreeSlot(node, agent, 'bridge'); // Free uses one agent — the user's pick
  // Collapsed by default (addBridgeAgent opens the one it just created).
  const card = wireCollapsible(node, agentKey(agent));
  const syncCardSummary = () => {
    const kind = q('.ba-kind')?.value || agent.bridgeAgent || 'claude';
    const bits = [AGENT_KIND_LABEL[kind] || kind];
    const model = (q('.ba-model')?.value || agent.model || '').trim();
    if (model) bits.push(model);
    if (kind === 'custom' && q('.ba-command')?.value.trim()) bits.push(q('.ba-command').value.trim());
    if (q('.ba-workdir')?.value.trim()) bits.push(q('.ba-workdir').value.trim());
    if (q('.ba-enabled')?.checked === false) bits.push('disabled');
    card.setSummary(bits.filter(Boolean).join(' · '));
  };
  q('.ba-workdir').addEventListener('input', () => syncWorkdirHint(q));
  q('.ba-perm').addEventListener('change', () => syncWorkdirHint(q));
  q('.ba-kind').addEventListener('change', () => syncWorkdirHint(q));
  q('.ba-name').oninput = () => {
    const foot = q('.card-foot-name');
    if (foot) foot.textContent = q('.ba-name').value.trim() || 'Untitled agent';
  };

  const proCustom = can(license, 'customAgents'); // BYO CLI is a hard Pro gate

  // Per-engine model hints. CLIs don't expose a /models list like API endpoints,
  // so we suggest the common ids and accept any string the CLI takes.
  const MODEL_HINT = {
    claude: 'opus · sonnet · haiku  (blank = default)',
    codex: 'model id  (blank = CLI default)',
    antigravity: 'model id  (blank = default · “Load models” for the list)',
    pi: 'provider/model  (blank = default · “Load models” for the list)',
    opencode: 'provider/model  (blank = default · “Load models” for the list)',
    kiro: 'model id  (blank = default · “Load models” for the list)',
    copilot: 'auto · gpt-5.4 · claude-sonnet-5  (blank = CLI default · “Load models” for the list)',
    deepseek: 'deepseek-v4-flash · deepseek-v4-pro  (blank = the dsh profile’s model)',
  };
  // Common model ids per engine, offered through the same custom combobox while
  // still accepting any custom string. The newer CLIs expose a "Load models"
  // command, so their lists fill on demand.
  const MODEL_LIST = {
    claude: ['opus', 'sonnet', 'haiku'],
    antigravity: [],
    codex: [],
    pi: [],
    opencode: [],
    kiro: [],
    // Seeded so the picker is useful before "Load models" runs; the live list
    // comes from `copilot help config` and can differ per account entitlement.
    copilot: ['auto'],
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  };
  let bridgeModelOptions = [];
  const wireBridgeModelFields = (kind, options = bridgeModelOptions) => {
    bridgeModelOptions = options;
    wireCombobox(
      q('.ba-model'),
      bridgeModelOptions,
      q('.ba-model').value,
      MODEL_HINT[kind] || "blank = default  ·  use Load models →",
    );
    wireCombobox(
      q('.ba-acmodel'),
      bridgeModelOptions,
      q('.ba-acmodel').value,
      'last-resort only — CLI autocomplete is slow (~seconds); prefer a fast API endpoint',
    );
  };

  // Show/hide the custom block and refresh the availability line for the kind.
  const syncKind = () => {
    const kind = q('.ba-kind').value;
    const isCustom = kind === 'custom';
    // Colour-code the card by CLI, exactly like the endpoint cards are by provider.
    applyCardBrand(node, agentBrand(kind), q('.ba-name').value, 'Untitled agent');
    syncCardSummary();
    q('.ba-custom').classList.toggle('hidden', !isCustom);
    // local skills/MCP & per-agent system prompt only apply to the built-in CLIs.
    q('.ba-local').closest('.check').classList.toggle('hidden', isCustom);
    // Skipping named MCP servers is a built-in-CLI feature — a custom CLI's config is its own.
    node.querySelectorAll('.ba-mcpoff-row').forEach((el) => el.classList.toggle('hidden', isCustom));
    // Model fields show for every kind — a custom CLI passes the chosen model via
    // its configured "Pass model via" arg. Seed the picker with known ids for
    // built-ins; custom starts empty until "Load models" populates it.
    wireBridgeModelFields(kind, MODEL_LIST[kind] || []);
    if (isCustom && !proCustom) {
      setStatus(q('.ba-avail'), '✨ Pro — upgrade to bring your own CLI', 'err');
    } else if (isCustom) {
      showCustomAvailability(agent, q);
    } else {
      const av = (bridgeState.agents || []).find((x) => x.id === q('.ba-kind').value);
      if (!bridgeState.ok) setStatus(q('.ba-avail'), 'Bridge not running', '');
      else setStatus(q('.ba-avail'), av?.available ? '✓ available' : `✕ ${av?.reason || 'unavailable'}`, av?.available ? 'ok' : 'err');
    }
  };
  q('.ba-kind').onchange = syncKind;
  syncKind();

  q('.ba-check').onclick = () => showCustomAvailability(agent, q, q('.ba-command').value.trim());

  // Load models from the agent's CLI via the unified bridge /list-models endpoint
  // (built-ins return known ids; custom runs its configured "List models with").
  q('.ba-loadmodels').onclick = async () => {
    const st = q('.ba-models-status');
    setStatus(st, 'Loading…');
    try {
      const models = await listBridgeModels({
        bridgeAgent: q('.ba-kind').value,
        command: q('.ba-command').value.trim(),
        listModelsArgs: q('.ba-listargs').value.trim(),
        workingDir: q('.ba-workdir').value.trim(),
        name: q('.ba-name').value.trim(),
      }, settings);
      if (!models.length) {
        setStatus(st, q('.ba-kind').value === 'custom'
          ? 'No models — set “List models with” (e.g. --list-models)'
          : 'This CLI has no model list — type one', '');
        return;
      }
      wireBridgeModelFields(q('.ba-kind').value, models);
      setStatus(st, `✓ ${models.length} models — pick from the Model field ▾`, 'ok');
    } catch (e) {
      setStatus(st, '✕ ' + (e.message || e), 'err');
    }
  };

  q('.ba-save').onclick = async () => {
    const bridgeAgent = q('.ba-kind').value;
    if (bridgeAgent === 'custom' && !proCustom) {
      return setStatus(q('.ba-status'), '✨ Custom CLI agents need ChatPanel Pro', 'err');
    }
    Object.assign(agent, {
      name: q('.ba-name').value.trim() || 'Agent',
      kind: 'bridge',
      bridgeAgent,
      workingDir: q('.ba-workdir').value.trim(),
      extraArgs: q('.ba-extraargs').value.trim(),
      model: q('.ba-model').value.trim(),
      autocompleteModel: q('.ba-acmodel').value.trim(),
      permissionMode: q('.ba-perm').value,
      useLocalConfig: q('.ba-local').checked,
      mcpDisabled: q('.ba-mcpoff').value.trim(),
      systemPrompt: q('.ba-system').value,
      command: q('.ba-command').value.trim(),
      args: q('.ba-args').value.trim(),
      promptVia: q('.ba-promptvia').value,
      format: q('.ba-format').value,
      listModelsArgs: q('.ba-listargs').value.trim(),
      modelArg: q('.ba-modelarg').value.trim(),
      imageArg: q('.ba-imagearg').value.trim(),
      mcpArg: q('.ba-mcparg').value.trim(),
      stableMcpSetupCommand: q('.ba-stablemcp').value.trim(),
      requiresStableMcp: Boolean(q('.ba-stablemcp').value.trim()),
      trustToolsArg: q('.ba-trusttoolsarg').value.trim(),
    });
    await saveSettings(settings);
    syncCardSummary(); // the collapsed line must reflect what was just saved
    setStatus(q('.ba-status'), '✓ Saved', 'ok');
  };

  q('.ba-enabled').onchange = async () => {
    agent.enabled = q('.ba-enabled').checked;
    syncCardSummary();
    await saveSettings(settings);
  };

  q('.ba-del').onclick = async () => {
    const { confirmDelete } = await import('./js/confirm-modal.js');
    const name = (q('.ba-name')?.value || agent.name || 'this agent').trim();
    if (!(await confirmDelete({
      title: `Delete “${name}”?`,
      body: 'This removes the agent and its command, working directory and prompt settings. This can\'t be undone.',
    }))) return;
    settings.agents = settings.agents.filter((a) => a !== agent);
    // Remember deleted built-ins: settings-merge back-fills any built-in missing
    // from a saved list (so new ones appear after an upgrade), and without this
    // the one you just deleted would come straight back on the next load.
    if (agent.builtin && agent.id) {
      const gone = new Set(settings.removedBuiltinAgents || []);
      gone.add(agent.id);
      settings.removedBuiltinAgents = [...gone];
    }
    forgetCard(agentKey(agent));
    await saveSettings(settings);
    renderBridgeAgents();
  };

  return node;
}

// What a Working directory field actually means right now: where files will land, and —
// for Codex — that the sandbox boundary IS that directory. The reported confusion was a
// colleague with "auto-edit files" on who still could not write: the setting was right and
// the folder was wrong, and nothing said so.
function syncWorkdirHint(q) {
  const hint = q('.ba-workdir-hint');
  if (!hint) return;
  const typed = q('.ba-workdir')?.value.trim();
  const dir = typed || bridgeState?.workspace || '';
  const parts = [];
  if (!dir) parts.push('Files go wherever the bridge is running — start the bridge to see where.');
  else parts.push(typed ? `Files are created in ${dir}` : `Blank — files are created in ${dir}`);
  if (q('.ba-kind')?.value === 'codex' && q('.ba-perm')?.value === 'acceptEdits' && dir) {
    parts.push(`Codex can only edit files inside this folder — point it at a project to work on one.`);
  }
  hint.textContent = parts.join(' · ');
}

// Ask the bridge whether a custom agent's command resolves (PATH / full path /
// WSL). `cmd` overrides the saved command (used by the live "Check" button).
async function showCustomAvailability(agent, q, cmd) {
  const command = (cmd ?? agent.command ?? '').trim();
  if (!command) return setStatus(q('.ba-avail'), 'Enter a command', '');
  setStatus(q('.ba-avail'), 'Checking…', '');
  const r = await checkAgentCommand(settings.bridgeUrl, command);
  if (r.legacy) return setStatus(q('.ba-avail'), 'Update the bridge to v0.3.0+ for custom agents', 'err');
  if (r.ok) {
    const where = r.via === 'wsl' ? ' (in WSL)' : r.via === 'cmd' || r.via === 'script' ? ' (shim)' : '';
    setStatus(q('.ba-avail'), `✓ found${where}`, 'ok');
  } else {
    setStatus(q('.ba-avail'), `✕ not found${r.reason ? ' — ' + r.reason : ''}`, 'err');
  }
}

async function addBridgeAgent() {
  if (!isPro(license)) return upsell('Adding agents is a Pro feature. Free includes the built-in agents — pick your one with “Use on Free”.');
  settings.agents = settings.agents || [];
  const agent = {
    id: uid(),
    name: 'New agent',
    kind: 'bridge',
    bridgeAgent: 'claude',
    workingDir: '',
    permissionMode: 'acceptEdits',
    useLocalConfig: true,
    systemPrompt: '',
  };
  settings.agents.push(agent);
  setExpanded(agentKey(agent), true); // you added it to configure it — open it
  await saveSettings(settings);
  renderBridgeAgents();
  $('bridge-agents').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

// --------------------------------------------------------------------------
// MCP tool servers — Streamable HTTP servers whose tools the in-extension API
// agent loop can call (alongside "Act on page").
// --------------------------------------------------------------------------
function renderMcpServers() {
  const root = $('mcp-list');
  if (!root) return;
  root.innerHTML = '';
  const list = settings.mcpServers || [];
  list.forEach((s, i) => {
    const node = mcpServerCard(s, i);
    setCardIndex(node, i, list.length, 'Server'); // "N of M" — one card, one unit
    root.appendChild(node);
  });
  wireExpandAll('toggle-mcp', list.map(mcpCardKey), renderMcpServers);
  renderMcpCatalog(); // keep "Added" state in sync
  renderGateBadges(); // add/import lock depends on the current server count
}

// Parse "KEY=VALUE, KEY2=VALUE2" (comma or newline separated) into an env object.
function parseEnvPairs(str) {
  const env = {};
  for (const pair of String(str || '').split(/[\n,]+/)) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    // Drop empty values: "KEY=" passes an empty-string env var to the server,
    // which breaks tools that validate config (e.g. an empty MCP_LOG_LEVEL). A
    // blank value almost always means "didn't fill it in", so treat it as unset.
    if (k && v) env[k] = v;
  }
  return env;
}

function withIds(servers) {
  return servers.map((s) => ({ id: s.id || uid(), ...s }));
}

function renderMcpToolStatus(status, tools) {
  status.classList.remove('err');
  status.classList.add('ok');
  status.replaceChildren();
  const count = document.createElement('span');
  count.className = 'mcp-tool-count';
  count.textContent = tools.length ? `✓ ${tools.length} tool${tools.length === 1 ? '' : 's'}` : '✓ connected (0 tools)';
  status.appendChild(count);
  if (tools.length) {
    const list = document.createElement('span');
    list.className = 'mcp-tool-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', `${tools.length} MCP tools`);
    for (const tool of tools) {
      const chip = document.createElement('span');
      chip.className = 'mcp-tool';
      chip.setAttribute('role', 'listitem');
      chip.textContent = tool.name || 'unnamed_tool';
      chip.title = tool.description ? `${tool.name}\n${tool.description}` : chip.textContent;
      list.appendChild(chip);
    }
    status.appendChild(list);
  }
}

// Namespaced, and NOT the same thing as the existing `mcpKey` further down — that one is
// an identity for catalog matching, this one keys the card's open/closed state.
const mcpCardKey = (s) => `mcp:${s.id || s.name || ''}`;

// Transport is the one thing that changes what an MCP card even means — a remote URL or a
// local process — so it picks the colour. Everything else about the server is detail.
const MCP_BRANDS = {
  http: { mark: 'HTTP', color: '#0ea5e9' },
  stdio: { mark: 'CLI', color: '#8b5cf6' },
};

function mcpServerCard(server, index = 0) {
  const node = $('mcp-server-tpl').content.firstElementChild.cloneNode(true);
  hydrate(node); // the collapse chevron is a data-icon
  const q = (sel) => node.querySelector(sel);
  const transport = server.command ? 'stdio' : server.transport || 'http';
  q('.mcp-name').value = server.name || '';
  q('.mcp-transport').value = transport;
  q('.mcp-url').value = server.url || '';
  q('.mcp-auth').value = server.headers?.Authorization || '';
  q('.mcp-remote-mode').value = server.remoteMode || 'auto';
  q('.mcp-command').value = server.command || '';
  q('.mcp-args').value = argsToText(server.args);
  q('.mcp-env').value = Object.entries(server.env || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  q('.mcp-enabled').checked = server.enabled !== false;
  const status = q('.mcp-status');

  // Collapsed by default, like every other configuration list. An MCP card is a long form
  // — transport, URL, auth, or command + args + env + a paragraph of registry advice — and
  // a page of them was the same wall the endpoint cards used to be.
  const card = wireCollapsible(node, mcpCardKey(server));
  const syncMcpSummary = () => {
    const t = q('.mcp-transport').value;
    const bits = [t === 'stdio' ? 'Local' : 'Remote'];
    if (t === 'stdio') {
      const cmd = q('.mcp-command').value.trim();
      if (cmd) bits.push(cmd.split(/\s+/)[0]);
    } else if (q('.mcp-url').value.trim()) {
      bits.push(hostLabel(q('.mcp-url').value.trim()));
    }
    const tools = (server.tools || []).length;
    if (tools) bits.push(`${tools} tool${tools === 1 ? '' : 's'}`);
    if (!q('.mcp-enabled').checked) bits.push('disabled');
    card.setSummary(bits.filter(Boolean).join(' · '));
  };
  const paintMcpBrand = () => {
    const t = q('.mcp-transport').value;
    applyCardBrand(node, { ...(MCP_BRANDS[t] || MCP_BRANDS.http), logo: null }, q('.mcp-name').value, 'Untitled server');
  };

  const syncTransport = () => {
    const t = q('.mcp-transport').value;
    q('.mcp-http').classList.toggle('hidden', t !== 'http');
    q('.mcp-stdio').classList.toggle('hidden', t !== 'stdio');
    paintMcpBrand();
    syncMcpSummary();
  };
  syncTransport();
  for (const sel of ['.mcp-name', '.mcp-url', '.mcp-command']) {
    q(sel).addEventListener('input', () => { paintMcpBrand(); syncMcpSummary(); });
  }
  q('.mcp-enabled').addEventListener('change', syncMcpSummary);

  // Free uses up to FREE_LIMITS.mcpServers; servers past that are visible but
  // locked behind a Pro upsell (the runtime cap in toolsetFor matches this).
  const overFreeLimit = !isPro(license) && index >= FREE_LIMITS.mcpServers;
  if (overFreeLimit) {
    node.classList.add('locked');
    // Enforce the gate, don't just grey it: a locked server can't be armed or
    // tested on Free (the runtime + harness already cap usage by position; this
    // stops the UI from letting a Free user toggle/test it past the cap).
    q('.mcp-enabled').disabled = true;
    q('.mcp-test').disabled = true;
    status.innerHTML = `${icon('lock')} Free includes ${FREE_LIMITS.mcpServers} MCP servers — <a href="#" class="mcp-upsell">upgrade to Pro</a> for more`;
    status.querySelector('.mcp-upsell').onclick = (e) => {
      e.preventDefault();
      upsell(`Free includes ${FREE_LIMITS.mcpServers} MCP servers. Pro unlocks unlimited.`);
    };
  }

  const commit = async () => {
    server.name = q('.mcp-name').value.trim();
    server.transport = q('.mcp-transport').value;
    server.enabled = q('.mcp-enabled').checked;
    if (server.transport === 'stdio') {
      server.command = q('.mcp-command').value.trim();
      server.args = parseArgsInput(q('.mcp-args').value);
      server.env = parseEnvPairs(q('.mcp-env').value);
      delete server.url;
      delete server.headers;
    } else {
      server.url = q('.mcp-url').value.trim();
      const auth = q('.mcp-auth').value.trim();
      server.headers = auth ? { Authorization: auth } : {};
      server.remoteMode = q('.mcp-remote-mode').value;
      delete server.command;
      delete server.args;
    }
    await saveSettings(settings);
  };
  q('.mcp-name').onchange = commit;
  q('.mcp-url').onchange = commit;
  q('.mcp-auth').onchange = commit;
  q('.mcp-remote-mode').onchange = commit;
  q('.mcp-command').onchange = commit;
  q('.mcp-args').onchange = commit;
  q('.mcp-env').onchange = commit;
  q('.mcp-enabled').onchange = commit;
  q('.mcp-transport').onchange = () => { syncTransport(); commit(); };

  q('.mcp-test').onclick = async () => {
    await commit();
    if (!server.url && !server.command) { status.textContent = 'Enter a URL or command first'; return; }
    status.classList.remove('ok', 'err');
    status.textContent = 'Connecting…';
    try {
      const tools = await testMcpServer(server, { bridgeUrl: settings.bridgeUrl, bridgeAvailable: bridgeState.ok });
      server.tools = tools;
      await saveSettings(settings);
      renderMcpToolStatus(status, tools);
    } catch (e) {
      status.classList.remove('ok');
      status.classList.add('err');
      // This is where a user is most likely to see a launch failure, and where raw shell
      // output does the most damage: they are configuring, so they will assume they
      // configured it wrong and keep changing fields that were never the problem.
      try {
        const { explainMcpError, packageFromArgs } = await import('./js/events/mcp-errors.js');
        const why = explainMcpError(e.message, { packageName: packageFromArgs(server.args || []) || server.name || '' });
        if (why) {
          status.textContent = '';
          const head = document.createElement('b');
          head.textContent = `✗ ${why.summary}`;
          const detail = document.createElement('div');
          detail.className = 'tiny';
          detail.textContent = `${why.detail} ${why.fix}`;
          const raw = document.createElement('details');
          const sum = document.createElement('summary');
          sum.className = 'tiny';
          sum.textContent = 'Show what the server printed';
          const pre = document.createElement('pre');
          pre.className = 'tj-raw';
          pre.textContent = why.raw;
          raw.append(sum, pre);
          status.append(head, detail, raw);
          return;
        }
      } catch { /* fall through to the plain message */ }
      status.textContent = `✗ ${e.message}`;
    }
  };

  q('.mcp-del').onclick = async () => {
    const { confirmDelete } = await import('./js/confirm-modal.js');
    const name = (q('.mcp-name')?.value || server.name || 'this server').trim();
    if (!(await confirmDelete({
      title: `Delete “${name}”?`,
      body: 'This removes the MCP server and its URL, credentials and tool settings. This can\'t be undone.',
    }))) return;
    settings.mcpServers = (settings.mcpServers || []).filter((x) => x !== server);
    await saveSettings(settings);
    renderMcpServers(); // also refreshes the Discover catalog's Added state
  };

  return node;
}

function addMcpServer() {
  if (mcpAddLocked()) return upsell(`Free includes ${FREE_LIMITS.mcpServers} MCP server. Upgrade to Pro for unlimited.`);
  settings.mcpServers = settings.mcpServers || [];
  settings.mcpServers.push({ id: uid(), name: 'New MCP server', url: '', enabled: true, headers: {} });
  saveSettings(settings);
  renderMcpServers();
  $('mcp-list').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

function toggleMcpImport(show) {
  $('mcp-import-box')?.classList.toggle('hidden', !show);
  if (show) {
    setStatus($('mcp-import-status'), '', '');
    $('mcp-import-text')?.focus();
  }
}

async function importMcpConfig() {
  const status = $('mcp-import-status');
  let servers;
  try {
    servers = withIds(parseMcpConfig($('mcp-import-text').value));
  } catch (e) {
    setStatus(status, `✗ ${e.message}`, 'err');
    return;
  }
  if (!servers.length) {
    setStatus(status, '✗ No MCP servers found in that config', 'err');
    return;
  }
  settings.mcpServers = settings.mcpServers || [];
  settings.mcpServers.push(...servers);
  await saveSettings(settings);
  $('mcp-import-text').value = '';
  toggleMcpImport(false);
  renderMcpServers();
  setStatus(status, `✓ Imported ${servers.length} server${servers.length === 1 ? '' : 's'}`, 'ok');
}

// Discover: official MCP registry plus one-click add of known public servers.
function renderMcpCatalog() {
  const root = $('mcp-catalog');
  if (!root) return;
  root.innerHTML = '';
  renderMcpRegistryStatus();

  if (mcpRegistryState.items.length) {
    root.appendChild(mcpCatalogHeading('Official registry'));
    for (const item of mcpRegistryState.items) root.appendChild(mcpCatalogCard(item));
  } else if (mcpRegistryState.loaded && !mcpRegistryState.loading && !mcpRegistryState.error) {
    root.appendChild(mcpCatalogEmpty('No registry servers matched this search.'));
  }

  root.appendChild(mcpCatalogHeading('Curated'));
  for (const item of MCP_CATALOG) root.appendChild(mcpCatalogCard({ ...item, kind: 'remote', source: 'curated' }));
}

function renderMcpRegistryStatus() {
  const status = $('mcp-registry-status');
  const more = $('mcp-registry-more');
  if (!status || !more) return;
  status.className = `status mcp-registry-status${mcpRegistryState.error ? ' err' : ''}`;
  if (mcpRegistryState.loading) status.textContent = 'Loading official registry…';
  else if (mcpRegistryState.error) status.textContent = mcpRegistryState.error;
  else if (mcpRegistryState.loaded) {
    const q = mcpRegistryState.query ? ` for “${mcpRegistryState.query}”` : '';
    status.textContent = `${mcpRegistryState.items.length} registry result${mcpRegistryState.items.length === 1 ? '' : 's'}${q}`;
  } else {
    status.textContent = '';
  }
  more.classList.toggle('hidden', !mcpRegistryState.nextCursor || mcpRegistryState.loading);
}

function mcpCatalogHeading(text) {
  const h = document.createElement('div');
  h.className = 'mcp-catalog-heading';
  h.textContent = text;
  return h;
}

function mcpCatalogEmpty(text) {
  const div = document.createElement('div');
  div.className = 'mcp-catalog-empty';
  div.textContent = text;
  return div;
}

function mcpCatalogCard(item) {
  const el = document.createElement('div');
  el.className = 'mcp-cat-item';
  const main = document.createElement('div');
  main.className = 'mcp-cat-main';

  const title = document.createElement('div');
  title.className = 'mcp-cat-name';
  title.append(document.createTextNode(item.name || item.registryName || 'MCP server'));
  title.appendChild(mcpPill(item.auth ? 'auth' : 'no auth', item.auth ? 'mcp-cat-auth' : 'mcp-cat-free'));
  title.appendChild(mcpPill(item.kind === 'local' ? 'local' : 'remote', 'mcp-cat-kind'));

  const desc = document.createElement('div');
  desc.className = 'mcp-cat-desc';
  desc.textContent = item.desc || item.registryName || '';

  const url = document.createElement('div');
  url.className = 'mcp-cat-url';
  url.textContent = item.url || [item.command, item.args].filter(Boolean).join(' ');

  main.append(title, desc, url);

  const btn = document.createElement('button');
  btn.className = 'btn mcp-cat-add';
  btn.type = 'button';
  const added = hasMcpServer(item);
  btn.disabled = added;
  btn.textContent = added ? '✓ Added' : '+ Add';
  if (!added && mcpAddLocked()) { btn.classList.add('locked'); btn.appendChild(proBadge()); }
  btn.onclick = async () => {
    if (mcpAddLocked()) return upsell(`Free includes ${FREE_LIMITS.mcpServers} MCP server. Upgrade to Pro for unlimited.`);
    settings.mcpServers = settings.mcpServers || [];
    settings.mcpServers.push(mcpServerFromCatalogItem(item));
    await saveSettings(settings);
    renderMcpServers();
    renderMcpCatalog();
  };

  el.append(main, btn);
  return el;
}

function mcpPill(text, cls) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  return span;
}

function hasMcpServer(item) {
  return (settings.mcpServers || []).some((s) => {
    if (item.url && s.url === item.url) return true;
    if (item.command && s.command === item.command && String(s.args || '') === String(item.args || '')) return true;
    return false;
  });
}

function mcpServerFromCatalogItem(item) {
  const base = {
    id: uid(),
    name: item.name || item.registryName || 'MCP server',
    enabled: true,
  };
  if (item.command) {
    return {
      ...base,
      transport: 'stdio',
      command: item.command,
      args: item.args || '',
      env: item.env || {},
      registryName: item.registryName || '',
      registrySource: item.source || '',
    };
  }
  return {
    ...base,
    transport: 'http',
    url: item.url,
    headers: {},
    registryName: item.registryName || '',
    registrySource: item.source || '',
  };
}

async function loadMcpRegistry({ append = false, reset = false } = {}) {
  const input = $('mcp-registry-search');
  const query = reset || !input ? '' : input.value.trim();
  const cursor = append ? mcpRegistryState.nextCursor : '';
  mcpRegistryState = {
    query,
    items: append ? mcpRegistryState.items : [],
    nextCursor: append ? mcpRegistryState.nextCursor : '',
    loaded: mcpRegistryState.loaded,
    loading: true,
    error: '',
  };
  renderMcpCatalog();
  try {
    const page = await fetchMcpRegistryPage({ search: query, cursor, limit: 30 });
    const seen = new Set(mcpRegistryState.items.map((i) => i.url || `${i.command} ${i.args}`));
    const nextItems = append ? [...mcpRegistryState.items] : [];
    for (const item of page.items) {
      const key = item.url || `${item.command} ${item.args}`;
      if (key && !seen.has(key)) {
        seen.add(key);
        nextItems.push(item);
      }
    }
    mcpRegistryState = {
      query,
      items: nextItems,
      nextCursor: page.nextCursor,
      loaded: true,
      loading: false,
      error: '',
    };
  } catch (e) {
    mcpRegistryState = {
      ...mcpRegistryState,
      loaded: true,
      loading: false,
      error: `Could not load official registry: ${e.message}`,
    };
  }
  renderMcpCatalog();
}

// --------------------------------------------------------------------------
// Skills
// --------------------------------------------------------------------------
const skillKey = (skill) => `skill:${skill.id || skill.command || skill.name || ''}`;

// Typing in the filter must NOT re-render (that would rebuild every card and steal
// focus mid-keystroke), so filtering only toggles visibility on the live cards and
// reads their CURRENT field values — a renamed-but-unsaved skill still matches.
let skillFilter = '';

function renderSkills() {
  const root = $('skills');
  root.innerHTML = '';
  // Skills are a Pro feature — Free sees them locked, behind an upsell banner.
  const locked = !can(license, 'customSkills');
  if (locked) root.appendChild(skillsBanner());
  const list = settings.skills || [];
  list.forEach((skill, i) => {
    const card = skillCard(skill);
    setCardIndex(card, i, list.length, 'Skill'); // "N of M" — one card, one unit
    if (locked) lockCard(card);
    root.appendChild(card);
  });
  wireExpandAll('toggle-skills', list.map(skillKey), renderSkills);
  renderSkillSources(); // fire and forget: a slow or absent bridge must not block the list
  // The filter only earns its space once the list is long enough to scan badly.
  $('skill-filter-bar')?.classList.toggle('hidden', list.length < 6);
  applySkillFilter();
  renderGateBadges();
}

// Show only the cards matching the filter box, and say how many that is.
function applySkillFilter() {
  const root = $('skills');
  if (!root) return;
  const q = skillFilter.trim().toLowerCase().replace(/^\//, '');
  const cards = [...root.querySelectorAll('.s-entity')];
  let shown = 0;
  for (const card of cards) {
    const hay = ['.s-name', '.s-cmd', '.s-desc']
      .map((sel) => card.querySelector(sel)?.value || '')
      .join(' ')
      .toLowerCase();
    const hit = !q || hay.includes(q);
    card.classList.toggle('hidden', !hit);
    if (hit) shown += 1;
  }
  const count = $('skill-count');
  if (count) {
    count.textContent = !cards.length ? ''
      : q ? `${shown} of ${cards.length} skills`
      : `${cards.length} skills`;
  }
}

// A full-width "Skills are Pro" notice with an Upgrade button.
function skillsBanner() {
  const div = document.createElement('div');
  div.className = 'gate-banner';
  const span = document.createElement('span');
  span.innerHTML = icon('upgrade') + ' <b>Skills are a Pro feature.</b> Reusable prompts, the ' + icon('skills') + ' menu, slash-commands and prompt-assist all unlock with Pro.';
  const a = document.createElement('button');
  a.className = 'btn primary';
  a.textContent = 'Upgrade to Pro';
  a.onclick = () => subscribePro(a);
  div.append(span, a);
  return div;
}

// Deactivate every control in a card (used to lock the whole Skills tab on Free).
// The collapse chevron is deliberately spared: a locked card you can't open is a
// card whose prompt you can't even read before deciding to upgrade.
function lockCard(node) {
  node.classList.add('locked-card');
  node.querySelectorAll('input, select, textarea, button').forEach((el) => {
    if (el.classList.contains('card-toggle')) return;
    el.disabled = true;
    el.classList.add('locked');
  });
}

function skillTargets() {
  return [
    ...(settings.endpoints || []).map((e) => ({ id: e.id, name: e.name })),
    ...(settings.agents || []).filter((a) => a.kind === 'bridge').map((a) => ({ id: a.id, name: a.name })),
  ];
}

function enabledMcpServersForSkills() {
  return (settings.mcpServers || []).filter((s) => s && s.enabled !== false && (s.url || s.command));
}

// Skills have no vendor to borrow a colour from, so the card's brand rail comes
// from the skill's own identity: a stable hash of its id picks one of a fixed
// palette, and the chip shows the skill's emoji (falling back to its initial).
// Same { mark, color, logo } shape as providerBrand — one applyCardBrand for all.
const SKILL_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444'];

function skillBrand(skill, icon = skill.icon) {
  const seed = String(skill.id || skill.command || skill.name || '');
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const mark = (icon || '').trim() || (skill.name || '?').trim().charAt(0).toUpperCase() || '?';
  return { mark, color: SKILL_COLORS[h % SKILL_COLORS.length], logo: null };
}

// Offered under the icon field so picking one is a click, not a hunt through the
// system emoji picker. Typing any other emoji still works.
const SKILL_ICON_SUGGESTIONS = ['📝', '💡', '📊', '🔍', '🧭', '🧪', '✅', '🐛', '⚡', '🎯', '📌', '🧠', '✉️', '🗓️', '🎓', '🛠️'];

const SKILL_CONTEXT_LABEL = {
  auto: 'Auto context', page: 'This page', selection: 'Selection', tabs: 'All tabs', none: 'No page context',
};

function skillCard(skill) {
  const node = $('skill-tpl').content.firstElementChild.cloneNode(true);
  hydrate(node); // the collapse chevron and Improve icon are data-icons
  const q = (sel) => node.querySelector(sel);
  q('.s-icon').value = skill.icon || '';
  q('.s-name').value = skill.name || '';
  q('.s-cmd').value = skill.command || '';
  q('.s-desc').value = skill.description || '';
  q('.s-prompt').value = skill.prompt || '';
  q('.s-context').value = skill.context || 'auto';
  q('.s-history').value = skill.historyContext || 'none';
  q('.s-mcp-mode').value = skill.mcpMode || 'none';
  q('.s-meeting').checked = !!skill.meeting;
  q('.s-enabled').checked = isSkillEnabled(skill);
  if (skill.builtin) {
    q('.s-del').classList.add('hidden');
    q('.s-builtin').classList.remove('hidden');
  }

  // "Run on" — Default (the agent picked in the panel) + every endpoint/agent.
  const agentSel = q('.s-agent');
  agentSel.innerHTML = '<option value="">Default (panel’s agent)</option>';
  for (const t of skillTargets()) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    if (t.id === skill.agentId) o.selected = true;
    agentSel.appendChild(o);
  }

  // Collapsed by default (addSkill opens the one it just created); the summary is
  // what you read at rest, so it has to say what this skill actually does.
  const card = wireCollapsible(node, skillKey(skill));
  const paintBrand = () => applyCardBrand(
    node, skillBrand(skill, q('.s-icon').value), q('.s-name').value, 'Untitled skill',
  );
  const syncCardSummary = () => {
    const cmd = q('.s-cmd').value.trim().replace(/^\//, '');
    const target = agentSel.selectedOptions[0];
    const bits = [
      cmd ? `/${cmd}` : '',
      q('.s-desc').value.trim() || SKILL_CONTEXT_LABEL[q('.s-context').value] || '',
      target?.value ? `→ ${target.textContent}` : '',
      q('.s-meeting').checked ? 'Meeting monitor' : '',
      q('.s-enabled').checked ? '' : 'disabled',
    ];
    card.setSummary(bits.filter(Boolean).join(' · '));
  };
  // The head fields feed the chip, the collapsed line, the foot marker AND the
  // filter, so every one of them repaints as you type.
  for (const sel of ['.s-name', '.s-cmd', '.s-desc']) {
    q(sel).addEventListener('input', () => { paintBrand(); syncCardSummary(); applySkillFilter(); });
  }
  q('.s-icon').addEventListener('input', paintBrand);
  q('.s-context').addEventListener('change', syncCardSummary);
  q('.s-meeting').addEventListener('change', syncCardSummary);
  agentSel.addEventListener('change', syncCardSummary);
  paintBrand();
  syncCardSummary();

  // Suggested icons — click to fill the field (and repaint the chip).
  const picks = q('.s-icon-picks');
  for (const emoji of SKILL_ICON_SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-pick';
    b.textContent = emoji;
    b.title = `Use ${emoji}`;
    b.setAttribute('aria-label', `Use icon ${emoji}`);
    b.onclick = () => { q('.s-icon').value = emoji; paintBrand(); };
    picks.appendChild(b);
  }

  // Variable chips — insert at the caret instead of leaving {{input}} & friends
  // to be discovered in a placeholder that vanishes the moment you type.
  for (const chip of node.querySelectorAll('.s-var')) {
    chip.onclick = () => {
      const ta = q('.s-prompt');
      const token = chip.dataset.var;
      const at = ta.selectionStart ?? ta.value.length;
      const to = ta.selectionEnd ?? at;
      ta.value = ta.value.slice(0, at) + token + ta.value.slice(to);
      ta.focus();
      ta.setSelectionRange(at + token.length, at + token.length);
      syncLint();
    };
  }

  // Placeholder lint. An invented {{content}} used to be authored, saved and run
  // with nothing anywhere saying it would never be filled — the prompt just reached
  // the model with the literal characters in it. This is where that becomes visible,
  // at the moment it is written rather than three chats later.
  const syncLint = () => {
    const box = q('.s-lint');
    const prompt = q('.s-prompt').value;
    const { known, unknown, hasInput } = lintSkillPrompt(prompt);
    box.replaceChildren();
    box.classList.toggle('err', unknown.length > 0);
    if (!prompt.trim()) return;
    for (const bad of unknown) {
      const line = document.createElement('div');
      line.className = 's-lint-row';
      const msg = document.createElement('span');
      msg.textContent = `${bad.raw} isn't a ChatPanel variable — it reaches the model as literal text.`;
      line.appendChild(msg);
      if (bad.suggestion) {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'btn ghost s-lint-fix';
        fix.textContent = `Use {{${bad.suggestion}}}`;
        fix.onclick = () => {
          const ta = q('.s-prompt');
          ta.value = ta.value.split(bad.raw).join(`{{${bad.suggestion}}}`);
          syncLint();
          setStatus(q('.s-status'), '✓ Replaced — Save to keep it', 'ok');
        };
        line.appendChild(fix);
      }
      box.appendChild(line);
    }
    if (unknown.length) return;
    // Clean: state which slots are live, and — the part people get wrong — what
    // happens to the user's own text when there is no {{input}} slot to put it in.
    const line = document.createElement('div');
    line.className = 's-lint-row ok';
    line.textContent = known.length
      ? `Fills at run time: ${known.map((n) => `{{${n}}}`).join(', ')}`
      : 'No variables — whatever the user types is appended after this prompt.';
    if (known.length && !hasInput) {
      line.textContent += ' · no {{input}} slot, so the user\u2019s text is appended at the end.';
    }
    box.appendChild(line);
  };
  q('.s-prompt').addEventListener('input', syncLint);
  syncLint();

  // Toggling a skill off hides it everywhere (menu, /commands, #mentions) without
  // deleting it — save immediately, like the endpoint/agent Enabled boxes.
  q('.s-enabled').onchange = async () => {
    skill.enabled = q('.s-enabled').checked;
    node.classList.toggle('is-off', !skill.enabled);
    syncCardSummary();
    settings = await saveSettings(settings);
  };
  node.classList.toggle('is-off', !isSkillEnabled(skill));

  let draftMcpServerIds = Array.isArray(skill.mcpServerIds) ? [...skill.mcpServerIds] : [];
  const currentDraftMcpServerIds = () => [
    ...q('.s-mcp-picks').querySelectorAll('input[type="checkbox"]:checked'),
  ].map((x) => x.value);

  const renderMcpPicks = () => {
    const box = q('.s-mcp-picks');
    if (box.dataset.rendered === '1') draftMcpServerIds = currentDraftMcpServerIds();
    const selected = new Set(draftMcpServerIds);
    const servers = enabledMcpServersForSkills();
    box.classList.toggle('hidden', q('.s-mcp-mode').value !== 'selected');
    box.replaceChildren();
    if (q('.s-mcp-mode').value !== 'selected') return;
    box.dataset.rendered = '1';
    const label = document.createElement('label');
    label.textContent = 'Allowed MCP servers';
    box.appendChild(label);
    const hint = document.createElement('span');
    hint.className = 'skill-mcp-hint';
    hint.textContent = servers.length > 2
      ? `${servers.length} enabled servers. Scroll this list to choose additional servers.`
      : 'Choose which enabled MCP servers this skill can call.';
    box.appendChild(hint);
    const wrap = document.createElement('div');
    wrap.className = 'skill-mcp-pick-list';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Allowed MCP servers for this skill');
    wrap.tabIndex = 0;
    if (servers.length > 2) wrap.classList.add('scrollable');
    if (!servers.length) {
      const empty = document.createElement('span');
      empty.className = 'skill-mcp-empty';
      empty.textContent = 'No enabled MCP servers yet.';
      wrap.appendChild(empty);
    }
    for (const s of servers) {
      const item = document.createElement('label');
      item.className = 'skill-mcp-pick';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = s.id;
      input.checked = selected.has(s.id);
      input.onchange = () => { draftMcpServerIds = currentDraftMcpServerIds(); };
      const text = document.createElement('span');
      text.className = 'skill-mcp-pick-copy';
      const name = document.createElement('span');
      name.className = 'skill-mcp-pick-name';
      name.textContent = s.name || s.id;
      const tools = (s.tools || []).map((t) => t.name).filter(Boolean).slice(0, 8);
      const toolText = document.createElement('span');
      toolText.className = 'skill-mcp-pick-tools';
      toolText.textContent = tools.length ? tools.join(', ') : 'No discovered tools yet';
      text.append(name, toolText);
      item.append(input, text);
      wrap.appendChild(item);
    }
    box.appendChild(wrap);
  };
  q('.s-mcp-mode').onchange = renderMcpPicks;
  renderMcpPicks();

  // ✨ Improve — expand/rewrite the prompt with the user's configured model.
  q('.s-assist').onclick = async () => {
    const ta = q('.s-prompt');
    const btn = q('.s-assist');
    const before = ta.value;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '✨ Improving…';
    setStatus(q('.s-status'), 'Asking your model…');
    let streamed = false;
    try {
      await assistPrompt({ draft: before, settings, onDelta: (full) => { streamed = true; ta.value = full; } });
      syncLint(); // the model just rewrote the prompt — re-check what it put in it
      setStatus(q('.s-status'), '✓ Improved — review & Save', 'ok');
    } catch (e) {
      // Only roll back if nothing came through — never discard a good result
      // because the model threw a late/benign error after streaming.
      if (streamed && ta.value.trim()) {
        setStatus(q('.s-status'), '✓ Improved (note: ' + e.message + ')', 'ok');
      } else {
        ta.value = before;
        setStatus(q('.s-status'), '✕ ' + e.message, 'err');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  };

  q('.s-save').onclick = async () => {
    const mcpMode = q('.s-mcp-mode').value;
    Object.assign(skill, {
      icon: q('.s-icon').value.trim(),
      name: q('.s-name').value.trim() || 'Skill',
      command: q('.s-cmd').value.trim().replace(/^\//, ''),
      description: q('.s-desc').value.trim(),
      prompt: q('.s-prompt').value,
      context: q('.s-context').value,
      historyContext: q('.s-history').value,
      meeting: q('.s-meeting').checked,
      mcpMode,
      mcpServerIds: mcpMode === 'selected'
        ? currentDraftMcpServerIds()
        : [],
      agentId: q('.s-agent').value,
      enabled: q('.s-enabled').checked,
    });
    settings = await saveSettings(settings);
    syncCardSummary(); // the collapsed line must reflect what was just saved
    paintBrand();
    setStatus(q('.s-status'), '✓ Saved', 'ok');
  };
  q('.s-del').onclick = async () => {
    const { confirmDelete } = await import('./js/confirm-modal.js');
    const name = (q('.s-name')?.value || skill.name || 'this skill').trim();
    if (!(await confirmDelete({
      title: `Delete “${name}”?`,
      body: 'This removes the skill and its prompt. This can\'t be undone.',
    }))) return;
    settings.skills = settings.skills.filter((s) => s !== skill);
    forgetCard(skillKey(skill));
    await saveSettings(settings);
    renderSkills();
  };
  return node;
}

async function addSkill() {
  if (!can(license, 'customSkills')) {
    return upsell('Creating custom skills is Pro. You can edit the built-ins on any plan.');
  }
  const skill = { id: uid(), name: 'New skill', command: 'mycmd', icon: '🎓', prompt: '', historyContext: 'none', mcpMode: 'none', mcpServerIds: [], enabled: true };
  settings.skills.push(skill);
  setExpanded(skillKey(skill), true); // you added it to configure it — open it
  skillFilter = ''; // never add a skill straight into a filtered-out gap
  const box = $('skill-filter');
  if (box) box.value = '';
  await saveSettings(settings);
  renderSkills();
  const node = $('skills').lastElementChild;
  node?.scrollIntoView({ behavior: 'smooth' });
  node?.querySelector('.s-name')?.focus();
}

// --------------------------------------------------------------------------
// Skill sources — what other places on this machine can offer (F6 S3)
// --------------------------------------------------------------------------
// A registry, not a panel that knows one API: the bridge is the first registration and a
// hub is the same three functions with a different fetch. Everything here is loaded on
// demand — the Skills tab is not the settings page's first paint, and a source that
// cannot answer right now is simply absent.
let skillSourceReg = null;
// Bound when the sources load; the row renderer runs only after that.
let skillOriginLabel = () => '';

async function skillSources() {
  if (skillSourceReg) return skillSourceReg;
  const [{ createSkillSourceRegistry }, bridgeMod] = await Promise.all([
    import('./js/events/skill-sources.js'),
    import('./js/skill-source-bridge.js'),
  ]);
  const { bridgeSkillSource } = bridgeMod;
  skillOriginLabel = bridgeMod.skillOriginLabel;
  skillSourceReg = createSkillSourceRegistry();
  skillSourceReg.add(bridgeSkillSource({
    // Read at call time: changing the Bridge URL in Settings takes effect without
    // re-registering, and `supported` is the /health capability flag.
    bridgeUrl: () => settings.bridgeUrl,
    supported: () => !!(bridgeState?.ok && bridgeState.skills),
    dirs: () => (Array.isArray(settings.ui?.skillDirs) ? settings.ui.skillDirs : []),
  }));
  return skillSourceReg;
}

// The query goes TO the source, not to a filter over what a source already returned: a
// hub searches server-side over a catalogue it never sends in full, and the local bridge
// filters a bounded list. One call shape covers both, which is the point of the contract.
let skillSourceQuery = '';
let skillSourceSeq = 0;
const SKILL_SOURCE_PAGE = 8;
let skillSourceLimit = SKILL_SOURCE_PAGE;

// Persist the custom skill folders — one absolute path per line, cleaned. Kept in
// settings.ui so it rides the normal backup like every other preference.
async function saveSkillDirs() {
  const el = $('skill-dirs-input');
  if (!el) return;
  const dirs = el.value.split(/\n+/).map((d) => d.trim()).filter(Boolean);
  const prev = settings.ui?.skillDirs || [];
  if (JSON.stringify(dirs) === JSON.stringify(prev)) return;
  settings.ui = { ...(settings.ui || {}), skillDirs: dirs };
  settings = await saveSettings(settings);
}

async function renderSkillSources() {
  const card = $('skill-sources-card');
  const root = $('skill-sources');
  if (!card || !root) return;
  // Searching is async and per-keystroke; only the newest result may paint, or a slow
  // source answering late would overwrite a newer query's results.
  const seq = ++skillSourceSeq;
  const reg = await skillSources();
  const sections = await reg.search({ query: skillSourceQuery });
  if (seq !== skillSourceSeq) return;

  const live = sections.filter((s) => !s.absent);
  // The folders actually scanned, straight from the bridge. Hardcoded copy naming two
  // paths was wrong within a day of the bridge learning to read eight.
  const rootsEl = $('skill-source-roots');
  if (rootsEl) {
    const roots = bridgeState?.skills?.roots || [];
    rootsEl.textContent = roots.length ? `Scanned: ${roots.join('  ·  ')}` : '';
  }
  const dirsEl = $('skill-dirs-input');
  if (dirsEl && document.activeElement !== dirsEl) {
    dirsEl.value = (settings.ui?.skillDirs || []).join('\n');
  }
  // Nothing to offer and nothing wrong → the section does not exist. An empty box that
  // says "no skills" is noise on a machine that was never going to have any. But once a
  // SEARCH is running, keep it visible: "no matches" is an answer, and a section that
  // vanished as you typed would read as a bug.
  card.classList.toggle('hidden', !live.length && !skillSourceQuery.trim());
  root.replaceChildren();

  let shown = 0;
  let total = 0;
  for (const section of live) {
    if (section.error) {
      const err = document.createElement('p');
      err.className = 'status err';
      err.textContent = `✕ ${section.label}: ${section.error}`;
      root.appendChild(err);
      continue;
    }
    total += section.items.length;
    // A header only once there is more than one place to come from — with a single
    // source it repeats what the card title already said.
    if (live.length > 1) {
      const head = document.createElement('div');
      head.className = 'src-group';
      head.textContent = section.label;
      root.appendChild(head);
    }
    if (!section.items.length) {
      const empty = document.createElement('p');
      empty.className = 'muted tiny';
      empty.textContent = skillSourceQuery.trim()
        ? `No matches in ${section.label}.`
        : 'No skill folders found yet. Create one at ~/.chatpanel/skills/<name>/SKILL.md';
      root.appendChild(empty);
      continue;
    }
    // Paged, because this grows with every agent CLI installed — one machine already
    // reaches 18 across four folders, and a hub source would put a catalogue behind the
    // same list. A cap with a visible remainder beats a scroll that never ends; searching
    // narrows first, so the page limit is a floor on browsing, not a lid on finding.
    const page = section.items.slice(0, skillSourceLimit);
    for (const skill of page) {
      root.appendChild(sourceSkillRow(skill, section, skillSourceQuery));
      shown += 1;
    }
    const rest = section.items.length - page.length;
    if (rest > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn add-row src-more';
      more.textContent = `Show ${rest} more from ${section.label}`;
      more.onclick = () => { skillSourceLimit += SKILL_SOURCE_PAGE; renderSkillSources(); };
      root.appendChild(more);
    }
  }
  const count = $('skill-source-count');
  if (count) {
    count.textContent = total
      ? (shown < total ? `${shown} of ${total} skills` : `${total} skill${total === 1 ? '' : 's'}`)
      : '';
  }
  return { shown, total };
}

function sourceSkillRow(skill, section, query = '') {
  const row = document.createElement('div');
  row.className = 'src-skill';

  const main = document.createElement('div');
  main.className = 'src-skill-main';
  const name = document.createElement('span');
  name.className = 'src-skill-name';
  markMatch(name, skill.name || skill.id, query);
  const desc = document.createElement('span');
  desc.className = 'src-skill-desc';
  markMatch(desc, skill.description || 'No description', query);
  main.append(name, desc);

  // Provenance is not decoration here: these files were written by something else, and
  // "which of these did a stranger write" has to be answerable at a glance. The same skill
  // is commonly copied into several agents' folders, so naming WHICH one is the difference
  // between provenance and a label.
  const from = document.createElement('span');
  from.className = 'src-skill-from';
  // Only a LOCAL source may name a folder on this machine. A remote hub is labelled by
  // its own registration whatever its payload claims, so no fetched record can present
  // itself as having come from a trusted directory.
  const found = section.trust === 'local' ? skillOriginLabel(skill.foundIn) : '';
  from.textContent = found || section.label;
  from.title = skill.origin?.id ? `${from.textContent} · ${skill.origin.id}` : from.textContent;

  const files = Object.entries(skill.files || {});
  if (files.length) {
    const tag = document.createElement('span');
    tag.className = 'tag src-skill-files';
    tag.textContent = files.map(([kind, list]) => `${list.length} ${kind}`).join(' · ');
    tag.title = files.map(([kind, list]) => `${kind}/: ${list.join(', ')}`).join('\n');
    main.appendChild(tag);
  }
  // The scanner already ran on the bridge (a dangerous skill never reached this list — it
  // was quarantined). What can still appear is `suspicious`, and a skill you are about to
  // run with page tools attached earns a visible marker before you add it.
  const scanned = skill.origin?.scanned;
  if (scanned && scanned.verdict === 'suspicious') {
    const warn = document.createElement('span');
    warn.className = 'tag src-skill-warn';
    warn.textContent = 'Review';
    warn.title = `The security scan flagged this skill for review (${scanned.findings || 0} finding${scanned.findings === 1 ? '' : 's'}). It installs, but read it first.`;
    main.appendChild(warn);
  }
  // Scripts run on your machine, not in the browser. Say so on the row, not only in a
  // tooltip: it is the one property of a skill that changes what adding it can do.
  if ((skill.files?.scripts || []).length) {
    const sc = document.createElement('span');
    sc.className = 'tag src-skill-scripts';
    sc.textContent = 'Runs code';
    sc.title = `Ships ${skill.files.scripts.length} script(s) that run on your machine via the bridge. These are not executed automatically.`;
    main.appendChild(sc);
  }

  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'btn ghost';
  view.textContent = 'View';
  const body = document.createElement('pre');
  body.className = 'src-skill-body hidden';
  view.onclick = async () => {
    if (!body.classList.contains('hidden')) return body.classList.add('hidden');
    view.disabled = true;
    try {
      const full = await (await skillSources()).read(section.source, skill.id);
      body.textContent = full?.prompt || '(empty)';
      body.classList.remove('hidden');
    } catch (e) {
      body.textContent = `✕ ${e.message}`;
      body.classList.remove('hidden');
    } finally {
      view.disabled = false;
    }
  };

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn';
  add.textContent = 'Pin & edit';
  add.title = 'Copy this skill into your own list to give it a /command or change its prompt. You do not need to do this to use it.';
  add.onclick = () => addSkillFromSource(section, skill, add);

  const actions = document.createElement('div');
  actions.className = 'src-skill-actions';
  actions.append(view, add);
  row.append(main, from, actions, body);
  return row;
}

// Highlight the matched span. Built from text nodes and a <mark> element rather than
// innerHTML: this string is a description written by whoever authored the skill, and a
// settings page is the last place to start interpreting a stranger's markup.
function markMatch(el, text, query) {
  const q = String(query || '').trim().toLowerCase();
  const at = q ? String(text).toLowerCase().indexOf(q) : -1;
  if (at === -1) { el.textContent = text; return; }
  const hit = document.createElement('mark');
  hit.textContent = text.slice(at, at + q.length);
  el.append(text.slice(0, at), hit, text.slice(at + q.length));
}

// The scanner wants flat `<kind>/<name>` paths; the record carries them grouped by kind.
function skillPackageFilesList(skill) {
  const out = [];
  for (const [kind, list] of Object.entries(skill?.files || {})) {
    for (const name of Array.isArray(list) ? list : []) out.push(`${kind}/${name}`);
  }
  return out;
}

// Copy a discovered skill into the user's own list. The BODY is fetched now — the list
// level deliberately carries no prompts — and the record keeps its origin, so the card
// above can say where it came from and an update check has something to compare.
async function addSkillFromSource(section, skill, btn) {
  if (!can(license, 'customSkills')) {
    return upsell('Adding skills is Pro. You can edit the built-ins on any plan.');
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const full = await (await skillSources()).read(section.source, skill.id);
    if (!full) throw new Error('could not read it back');
    // Re-scan the FETCHED body here, rather than trusting the verdict the source reported.
    // The bridge already quarantines dangerous local skills, but a remote hub is not the
    // bridge, and defence in depth means the client that will run the prompt checks the
    // prompt it actually received — not a summary of it.
    const { scanSkill, scanSummary } = await import('./js/events/skill-scan.js');
    const scan = scanSkill({ name: full.name, prompt: full.prompt, files: skillPackageFilesList(full) });
    if (scan.verdict === 'dangerous') {
      // Not a choice: a dangerous skill is simply not added. Say why and stop.
      toast(`✕ Not added — the scan flagged “${full.name}”: ${scanSummary(scan)}`, 5000);
      return;
    }
    if (scan.verdict === 'suspicious') {
      const { confirmDelete } = await import('./js/confirm-modal.js');
      const ok = await confirmDelete({
        title: `Add “${full.name}”?`,
        body: `The security scan flagged this for review: ${scanSummary(scan)}. It runs with your page tools and any MCP servers attached. Add it anyway?`,
        confirmLabel: 'Add anyway',
      });
      if (!ok) return;
    }
    const taken = new Set((settings.skills || []).map((s) => (s.command || '').toLowerCase()));
    let command = (full.command || full.id || 'skill').toLowerCase();
    while (taken.has(command)) command = `${command}-2`;
    const added = {
      ...full, id: uid(), command, enabled: true,
      origin: full.origin ? { ...full.origin, scanned: { verdict: scan.verdict, scanner: scan.scanner, findings: scan.findings.length } } : full.origin,
    };
    settings.skills.push(added);
    setExpanded(skillKey(added), true);
    settings = await saveSettings(settings);
    renderSkills();
    toast(`Added “${added.name}” — edit it above`);
    $('skills').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    toast(`✕ ${e.message}`, 3200);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function resetSkills() {
  const { confirmDelete } = await import('./js/confirm-modal.js');
  if (!(await confirmDelete({ title: 'Reset skills?', body: 'Reset all skills to ChatPanel defaults? This removes custom skills and discards edits to built-in skills.', confirmLabel: 'Reset' }))) return;
  settings = await resetSkillsToDefaults();
  renderSkills();
  toast('Skills reset to defaults');
}

// --------------------------------------------------------------------------
// Web search engines (Tools tab) — editable mirror of settings.ui.webSearch.engines
// --------------------------------------------------------------------------
// The list lives in js/web-search.js. This page had its own copy, which is why a retired
// engine kept appearing here after being removed there — the duplication WAS the bug.
import { DEFAULT_ENGINES as DEFAULT_WS_ENGINES, migrateEngines } from './js/web-search.js';
let webSearchEngines = [];

function renderWebSearchEngines() {
  const root = $('websearch-engines');
  if (!root) return;
  root.innerHTML = '';
  const pro = isPro(license);
  const engineCap = FREE_LIMITS.webSearchEngines;
  // Adding custom engines is Pro; mark the button so Free users see why.
  const addBtn = $('add-websearch');
  if (addBtn) {
    addBtn.innerHTML = pro ? '+ Add engine' : '+ Add engine ' + icon('lock');
    addBtn.title = pro ? '' : 'Custom search engines are a Pro feature';
  }

  // Free-tier hint: engine cap + daily search allowance (Pro = unlimited). The
  // daily count is async; fill it in once it resolves.
  if (!pro) {
    const hint = document.createElement('p');
    hint.className = 'muted sm';
    hint.style.margin = '0 0 4px';
    hint.innerHTML = `${icon('lock')} Free: up to <strong>${engineCap}</strong> engines and <strong>${FREE_LIMITS.webSearchesPerDay}</strong> searches/day. `
      + `<a href="#" class="ws-upsell">Upgrade to Pro</a> for unlimited.`;
    hint.querySelector('.ws-upsell').onclick = (e) => { e.preventDefault(); upsell('Unlimited web search (engines + daily searches) is a Pro feature.'); };
    root.appendChild(hint);
    webSearchUsage().then((u) => {
      if (hint.isConnected) hint.insertAdjacentHTML('beforeend', ` <span class="muted">· ${u.used}/${u.cap} used today.</span>`);
    }).catch(() => {});
  }

  webSearchEngines.forEach((eng, i) => {
    const row = document.createElement('div');
    row.className = 'row ws-engine';
    row.style.cssText = 'gap:6px;margin-top:6px;align-items:center';

    const en = document.createElement('input');
    en.type = 'checkbox';
    en.className = 'ws-en';
    en.checked = eng.enabled !== false;
    en.title = 'Enable this engine';
    // A TOGGLE APPLIES. It used to wait for the tab's Save, which meant a switch the user
    // had flipped was not yet true anywhere — search still used the old set, and any other
    // view of the same state read as stale. A checkbox that needs a second confirmation is
    // not a toggle, it is a form field wearing one.
    en.addEventListener('change', () => {
      // Free can enable at most engineCap engines (matches the runtime cap). Block the
      // checkbox from turning on one too many and upsell instead.
      if (!pro && en.checked) {
        const enabledNow = [...root.querySelectorAll('.ws-en:checked')].length;
        if (enabledNow > engineCap) {
          en.checked = false;
          upsell(`Free includes ${engineCap} web-search engines. Upgrade to Pro to use more.`);
          return;
        }
      }
      persistEngines();
    });

    const name = document.createElement('input');
    name.className = 'ws-name';
    name.placeholder = 'Name';
    name.value = eng.name || '';
    name.style.cssText = 'max-width:130px';

    const url = document.createElement('input');
    url.className = 'ws-url';
    url.placeholder = 'https://…/search?q=%s';
    url.value = eng.url || '';
    url.style.flex = '1';

    const del = document.createElement('button');
    del.className = 'btn ws-del';
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Remove engine';
    del.onclick = () => {
      webSearchEngines = collectWebSearchEngines(); // preserve unsaved edits in other rows
      webSearchEngines.splice(i, 1);
      renderWebSearchEngines();
    };

    row.append(en, name, url, del);
    root.appendChild(row);
  });
}

/**
 * Persist the engine list immediately.
 *
 * Writes only `ui.webSearch.engines`, never the whole prefs form: saving everything from a
 * toggle would commit unrelated half-typed fields the user has not agreed to.
 */
async function persistEngines() {
  try {
    webSearchEngines = collectWebSearchEngines();
    settings.ui = settings.ui || {};
    settings.ui.webSearch = { ...(settings.ui.webSearch || {}), engines: webSearchEngines };
    await saveSettings(settings);
  } catch (e) {
    console.warn('[chatpanel] could not save search engines', e);
  }
}

// Read the engine rows back out of the DOM (so edits survive add/remove and save).
function collectWebSearchEngines() {
  const root = $('websearch-engines');
  if (!root) return webSearchEngines;
  return [...root.querySelectorAll('.ws-engine')]
    .map((row, i) => {
      const name = row.querySelector('.ws-name').value.trim();
      const url = row.querySelector('.ws-url').value.trim();
      const enabled = row.querySelector('.ws-en').checked;
      const prior = webSearchEngines[i] || {};
      const id = prior.id || (name || 'engine').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'engine';
      return { id, name, url, enabled };
    })
    .filter((e) => e.name && e.url);
}

function addWebSearchEngine() {
  // Custom search engines are a Pro feature — Free uses the built-in defaults only.
  if (!isPro(license)) {
    upsell('Custom search engines are a Pro feature. Free includes the built-in engines.');
    return;
  }
  webSearchEngines = collectWebSearchEngines();
  webSearchEngines.push({ id: '', name: '', url: 'https://', enabled: true });
  renderWebSearchEngines();
}

// --------------------------------------------------------------------------
// Preferences
// --------------------------------------------------------------------------

// The shared AI-detection allowance, shown on the privacy screen the way the
// gateway screen shows its own. Free gets FREE_LIMITS.fullRedactions lifetime
// full-tier redactions, spent by BOTH normal ChatPanel chat AND privacy runs;
// Pro is unlimited. Async (reads chrome.storage) — fire-and-forget like the rest.
async function renderPrivFullUsage(pro) {
  const el = $('priv-free-usage');
  if (!el) return;
  if (pro) {
    el.innerHTML = icon('upgrade') + ' <strong>Pro active</strong> — unlimited AI detection (names, orgs &amp; locations).';
    el.classList.remove('warn');
    return;
  }
  const { used, cap, remaining } = await fullRedactionUsage(false);
  const exhausted = remaining === 0;
  el.innerHTML = exhausted
    ? `AI detection <strong>free trial used up</strong> (${cap}/${cap}). Detection now uses always-free patterns + `
      + `dictionary; names/orgs/locations need Pro. <a href="#" class="priv-usage-upsell">Upgrade to Pro</a> for unlimited.`
    : `AI detection (names / orgs / locations) — <strong>free trial: ${remaining} of ${cap} left</strong>. `
      + `You're previewing a Pro feature; after the trial it falls back to always-free patterns + dictionary. `
      + `The allowance is shared with the gateway and counts your ChatPanel chats. `
      + `<a href="#" class="priv-usage-upsell">Upgrade to Pro</a> for unlimited.`;
  el.classList.toggle('warn', exhausted);
  const up = el.querySelector('.priv-usage-upsell');
  if (up) up.onclick = (e) => { e.preventDefault(); upsell(`Free includes ${cap} AI-detection redactions. Pro unlocks unlimited.`); };
}

function renderPrefs() {
  $('pref-theme').value = settings.ui.theme || 'system';
  $('pref-language').value = settings.ui.language || '';
  $('pref-enter').checked = settings.ui.sendOnEnter !== false;
  $('pref-stream').checked = settings.ui.streamResponses !== false;
  $('pref-max-tools').value = String(settings.ui.maxToolsPerTurn ?? 24);
  const ws = settings.ui.webSearch || {};
  $('pref-websearch-enabled').checked = ws.enabled !== false;
  $('pref-websearch-per').value = String(ws.perEngine ?? 5);
  $('pref-websearch-pages').value = String(ws.maxPages ?? 5);
  $('pref-websearch-tabfallback').checked = ws.tabFallback === true;
  $('pref-websearch-reader').checked = ws.reader?.enabled === true;
  $('pref-websearch-reader-url').value = ws.reader?.url || 'https://r.jina.ai/';
  $('pref-websearch-reader-key').value = ws.reader?.key || '';
  // Migrated on load, so the settings page shows what search will ACTUALLY use — a list
  // here that disagrees with the runtime is worse than no list.
  webSearchEngines = migrateEngines(ws.engines, { hasKey: !!ws.reader?.key });
  renderWebSearchEngines();
  const sugg = settings.ui.suggestions || {};
  $('pref-suggestions-enabled').checked = sugg.enabled === true;
  const suggTarget = $('pref-suggestions-target');
  suggTarget.innerHTML = '<option value="">Default (active model/agent)</option>';
  for (const t of skillTargets()) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    if (t.id === sugg.targetId) o.selected = true;
    suggTarget.appendChild(o);
  }
  const topicCfg = settings.ui.topicExtraction || { enabled: true, targetId: '' };
  $('pref-topic-extract').checked = topicCfg.enabled !== false;
  const topicTarget = $('pref-topic-target');
  topicTarget.innerHTML = '<option value="">Default (active model/agent)</option>';
  for (const t of skillTargets()) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    if (t.id === topicCfg.targetId) o.selected = true;
    topicTarget.appendChild(o);
  }
  // Autocomplete is a Pro feature — gate the toggle for Free users.
  const ac = $('pref-autocomplete');
  const pro = isPro(license);
  ac.checked = pro && !!settings.ui.autocomplete;
  ac.disabled = !pro;
  $('pref-autocomplete-row').classList.toggle('locked', !pro);
  $('pref-pageact-mode').value = migratePageActions(settings.ui.pageActions);
  renderPageSites();
  // High-reliability page control is CDP/trusted events, which only Chromium exposes
  // (Firefox has no extension debugger protocol — bug 1316741). Where it can't work,
  // hide the toggle and the developer-JS switch it gates rather than offering a control
  // that silently does nothing; page control still works via the synthetic path.
  $('pref-pageact-cdp').checked = hasDebugger && settings.ui.pageActionsCdp !== false; // default ON
  $('pref-pageact-cdp-row').closest('.pref-item').hidden = !hasDebugger;
  $('pref-pageact-cdp-note').hidden = !hasDebugger;
  $('pref-pageact-devjs-row').closest('.pref-item').hidden = !hasDebugger;
  $('pref-pageact-confirm').checked = settings.ui.pageActionConfirm !== false; // default ON
  $('pref-pageact-devjs').checked = hasDebugger && !!settings.ui.pageActionsDevJs; // default OFF
  // Meetings tab — live scribe behavior.
  $('pref-live-notes').value = String(settings.ui.liveNotesIntervalMin ?? 2);
  $('pref-meeting-window').value = String(settings.ui.meetingWindowMin ?? 0);
  $('pref-meeting-summary-style').value = settings.ui.meetingSummaryStyle === 'detailed' ? 'detailed' : 'concise';
  // Spoken commands. `from` is a security control, so it is stored and shown exactly as
  // chosen — never inferred from whether a name happens to be filled in.
  const voice = settings.ui.voice || {};
  $('pref-voice-enabled').checked = voice.enabled !== false;
  $('pref-voice-wake').value = voice.wakeWord || 'ChatPanel';
  $('pref-voice-from').value = ['me', 'anyone', 'off'].includes(voice.from) ? voice.from : 'me';
  $('pref-voice-names').value = (Array.isArray(voice.selfNames) ? voice.selfNames : []).join(', ');
  // Internal sites — a REACH ceiling, not a redaction rule.
  //
  // The built-ins are TOGGLES, not lines in a textarea. Hand-editing a list that contains
  // `<intranet>` and `fc00::/7` asks the reader to know what those mean before they can turn
  // one off; a labelled checkbox asks nothing. Storage stays a single flat pattern list, so
  // the contract does not have to know this UI exists.
  {
    const priv = settings.privacy || (settings.privacy = {});
    const guard = $('internal-guard');
    const pats = $('internal-patterns');
    const ceil = $('internal-ceiling');
    const note = $('internal-note');
    const cat = $('internal-catalog');
    const restore = $('internal-restore');
    if (guard && pats && ceil && cat) {
      const active = () => new Set(Array.isArray(priv.internalPatterns) ? priv.internalPatterns : DEFAULT_INTERNAL_PATTERNS);
      const boxes = new Map();

      const renderCatalog = () => {
        const on = active();
        cat.replaceChildren();
        boxes.clear();
        for (const { pattern, label } of INTERNAL_PATTERN_CATALOG) {
          const row = document.createElement('label');
          row.className = 'internal-rule';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = on.has(pattern);
          cb.addEventListener('change', write);
          boxes.set(pattern, cb);
          const code = document.createElement('code');
          code.textContent = pattern;
          const desc = document.createElement('span');
          desc.className = 'sub';
          desc.textContent = label;
          row.append(cb, code, desc);
          cat.appendChild(row);
        }
      };

      // Anything saved that is NOT a built-in is the user's own — shown separately so their
      // domains are never mixed in with two dozen address ranges they did not write.
      const renderCustom = () => {
        const known = new Set(DEFAULT_INTERNAL_PATTERNS);
        const mine = (Array.isArray(priv.internalPatterns) ? priv.internalPatterns : []).filter((p) => !known.has(p));
        pats.value = mine.join('\n');
      };

      async function write() {
        const chosen = INTERNAL_PATTERN_CATALOG.map((x) => x.pattern).filter((p) => boxes.get(p)?.checked);
        const mine = pats.value.split(/[\n,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        settings.privacy = settings.privacy || {};
        settings.privacy.internalGuard = guard.checked;
        settings.privacy.internalCeiling = ceil.value === 'trusted' ? 'trusted' : 'device';
        // Deduplicated: a domain typed by hand that is already a built-in must not make the
        // same rule appear twice, where unticking one box would look like it did nothing.
        settings.privacy.internalPatterns = [...new Set([...chosen, ...mine])];
        await saveSettings(settings);
        syncEnabled();
        refresh();
      }

      const refresh = async () => {
        // Say whether the rule can actually be honoured. A ceiling with no model under it
        // means every internal page is refused rather than protected, and the person needs
        // to know that BEFORE they hit it mid-turn.
        try {
          const [{ candidatesFrom }, store] = await Promise.all([
            import('./js/model-router.js'), import('./js/store.js'),
          ]);
          const allowed = ceil.value === 'trusted' ? ['device', 'trusted'] : ['device'];
          // THE CANDIDATE'S OWN REACH, not a second lookup of it. Re-deriving it from the raw
          // target found by id got two things wrong at once: an agent that points at an
          // endpoint carries no baseUrl of its own, so it read as 'any' and was dropped from
          // the list of models that could answer an internal page — and a reach the user had
          // corrected was ignored, because the correction is applied by candidatesFrom and
          // this was reading past it. Resolving the target is also what stops those agents
          // being dropped before they are counted.
          const usable = candidatesFrom(settings, (t) => store.resolveTarget(t, settings))
            .filter((m) => allowed.includes(m.reach));
          note.replaceChildren();
          note.classList.toggle('warn', guard.checked && !usable.length);
          if (!guard.checked) {
            note.textContent = 'Off — content from internal sites is sent to whichever model is selected.';
            return;
          }
          if (!usable.length) {
            note.textContent = 'No local model is configured, so turns that draw on an internal site will be refused rather than sent. Add a local endpoint (Ollama, LM Studio) to answer them.';
            return;
          }
          // EVERY model, not a sample. This is the list of what may answer an internal page —
          // a truncated one leaves the person unable to tell whether the model they care
          // about is on it, which is the only question they are asking.
          const head = document.createElement('span');
          head.textContent = `${usable.length} model${usable.length === 1 ? '' : 's'} can answer these:`;
          const list = document.createElement('span');
          list.className = 'internal-models';
          for (const m of usable) {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = m.label;
            list.appendChild(chip);
          }
          note.append(head, list);
        } catch { note.textContent = ''; }
      };

      // THE MASTER SWITCH DIMS, IT DOES NOT UNTICK.
      //
      // Turning the guard off does mean none of these rules apply — but expressing that by
      // clearing the boxes would throw away the exclusions the user set, and turning it back
      // on could not know what to restore. So the rows go inert and visibly inactive while
      // keeping their state, which says the same thing without destroying anything.
      const syncEnabled = () => {
        const off = !guard.checked;
        setSectionBadge('pv-boundary-badge', off ? 'Off' : 'On', off ? 'off' : 'on');
        cat.classList.toggle('inert', off);
        for (const cb of boxes.values()) cb.disabled = off;
        pats.disabled = off;
        ceil.disabled = off;
        if (restore) restore.disabled = off;
      };

      guard.checked = priv.internalGuard !== false;
      ceil.value = priv.internalCeiling === 'trusted' ? 'trusted' : 'device';
      renderCatalog();
      renderCustom();
      syncEnabled();
      guard.addEventListener('change', write);
      ceil.addEventListener('change', write);
      pats.addEventListener('change', write);
      restore?.addEventListener('click', async () => {
        for (const [p, cb] of boxes) cb.checked = DEFAULT_INTERNAL_PATTERNS.includes(p);
        await write();
      });
      refresh();
    }
  }

  // Privacy tab — reversible PII redaction.
  const pii = settings.ui.piiRedaction || {};
  $('priv-mode').value = pii.mode || 'off';
  const psc = pii.scope || {};
  $('priv-scope-chat').checked = psc.chat !== false;
  $('priv-scope-context').checked = psc.context !== false;
  $('priv-scope-history').checked = psc.history !== false;
  $('priv-scope-tools').checked = psc.toolResults !== false;
  $('priv-tooldata').value = pii.toolData === 'redactRemote' ? 'redactRemote' : 'real';
  $('priv-applyto').value = pii.applyTo === 'remote' ? 'remote' : 'all';
  $('priv-dictionary').value = piiDictToText(pii.dictionary || []);
  // Gate the Pro controls: Free = deterministic secrets on chat only. Pro unlocks
  // the full (name/org) tier, the extra scopes, and an unlimited dictionary.
  const proPii = isPro(license);
  for (const id of ['priv-scope-context', 'priv-scope-history', 'priv-scope-tools']) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !proPii;
    if (!proPii) el.checked = false;
  }
  const proNote = $('priv-pro-note');
  if (proNote) proNote.classList.toggle('hidden', proPii);
  // AI (model) detection is a Pro feature; Free gets a lifetime allowance counted
  // by the shared quota (FREE_LIMITS.fullRedactions). The option is not disabled on
  // Free — Free can select it and the chat path falls back to deterministic once the
  // allowance is spent. The usage line below shows how many remain.
  renderPrivFullUsage(proPii);
  const det = pii.detection || {};
  // "Bundled NER" persists as an endpoint pointed at the gateway's /ner; the
  // `bundled` flag distinguishes it from a hand-typed custom URL on reload.
  const isBundled = det.backend === 'endpoint' && det.bundled === true;
  $('priv-det-backend').value = isBundled ? 'bundled' : (det.backend || 'off');
  $('priv-det-url').value = det.url || '';
  $('priv-det-timeout').value = String(det.timeoutMs || 1500);
  const dt = det.types || {};
  $('priv-det-person').checked = dt.person !== false;
  $('priv-det-org').checked = dt.org !== false;
  $('priv-det-location').checked = dt.location !== false;
  $('priv-det-number').checked = dt.number !== false;
  const showDet = $('priv-mode').value === 'model';
  $('priv-detection').classList.toggle('hidden', !showDet);
  // The end-to-end flow tester works in BOTH "patterns + dictionary" and "AI
  // detection" modes — show it whenever redaction is on.
  $('priv-flow').classList.toggle('hidden', $('priv-mode').value === 'off');
  const modeLabel = { off: 'Off', deterministic: 'Patterns', model: 'AI detection' };
  setSectionBadge('pv-redaction-badge', modeLabel[$('priv-mode').value] || 'Off',
    $('priv-mode').value === 'off' ? 'off' : 'on');
  populateFlowModel();
  renderFlowTools();
  populateDetTargets(det.targetId);
  if (showDet && $('priv-det-backend').value === 'agent') populateDetModels(det.targetId, det.model);
  updateDetVis();
}

// Privacy → detector: the 'agent' backend reuses a CONFIGURED API/agent + a model
// from it (so you don't re-type a URL, and can point detection at a model you trust).
// Map the searchable target field (shows the friendly name) back to a target id.
function detTargetId() {
  const name = (($('priv-det-target') && $('priv-det-target').value) || '').trim();
  const t = skillTargets().find((x) => x.name === name);
  return t ? t.id : '';
}

function populateDetTargets(selectedId) {
  const input = $('priv-det-target');
  if (!input) return;
  const targets = skillTargets();
  const sel = targets.find((t) => t.id === selectedId);
  wireCombobox(input, targets.map((t) => t.name), sel ? sel.name : (input.value || ''),
    targets.length ? 'Search APIs / agents' : 'No APIs / agents configured');
}

async function populateDetModels(targetId, selectedModel) {
  const input = $('priv-det-tmodel');
  if (!input) return;
  // `selectedModel` is authoritative — empty CLEARS the field. So switching the
  // target drops the previous target's model instead of carrying it over (don't
  // fall back to the stale input.value).
  const want = selectedModel || '';
  wireCombobox(input, want ? [want] : [], want, 'Search or type a model id');
  const ep = (settings.endpoints || []).find((e) => e.id === targetId);
  const ag = (settings.agents || []).find((a) => a.id === targetId);
  try {
    let ids = [];
    if (ep) ids = (await listModelOptions(ep) || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    else if (ag) ids = (await listBridgeModels(ag, settings) || []).map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    if (want && !ids.includes(want)) ids = [want, ...ids];
    wireCombobox(input, ids, want, ids.length ? 'Search or type a model id' : 'Type a model id');
  } catch { /* keep the current value */ }
}

function updateDetVis() {
  const b = $('priv-det-backend').value;
  $('priv-det-url-row').classList.toggle('hidden', b !== 'endpoint');
  $('priv-det-target-row').classList.toggle('hidden', b !== 'agent');
  $('priv-det-tmodel-row').classList.toggle('hidden', b !== 'agent');
  const ner = $('priv-ner-block');
  if (ner) ner.classList.toggle('hidden', b !== 'bundled');
  // The "fast & local NER service / contract" note is for custom/agent detectors;
  // bundled has its own explanation in the NER block.
  const note = $('priv-det-agent-note');
  if (note) note.classList.toggle('hidden', b === 'off' || b === 'bundled');
  if (b === 'bundled') checkPrivNer();
}

// Privacy → "Test end-to-end": run one prompt through the whole pipeline and show it
// as a left→right flow (prompt → detected → model sees → tools receive → reply → you
// see), so the user can compare entity toggles / redact-vs-pseudonymize choices.
function flowTargetId() {
  const name = (($('priv-flow-model') && $('priv-flow-model').value) || '').trim();
  const t = skillTargets().find((x) => x.name === name);
  return t ? t.id : '';
}

function populateFlowModel() {
  const input = $('priv-flow-model');
  if (!input) return;
  const targets = skillTargets();
  wireCombobox(input, targets.map((t) => t.name), input.value || (targets[0] && targets[0].name) || '',
    targets.length ? 'Model to run (a configured API / agent)' : 'No APIs / agents configured');
}

function flowCard(n, title, bodyHtml, cls = '', leadIconHtml = '') {
  const badge = n ? `<span class="flow-n">${escapeHtml(String(n))}</span>` : '';
  return `<div class="flow-card ${cls}"><div class="flow-card-h">${badge}${leadIconHtml}${escapeHtml(title)}</div><div class="flow-card-b">${bodyHtml}</div></div>`;
}

// "Your prompt" badge when the de-steganography pass found invisible/format Unicode
// (zero-width-split values, Tag-char ASCII smuggling, bidi, fingerprint markers). The
// pipeline strips these before redaction; this just makes the otherwise-invisible
// removal visible. Returns '' when the text is clean.
function hiddenCharNote(text) {
  const { removed, findings } = sanitizeUnicode(String(text == null ? '' : text));
  if (!removed) return '';
  const kinds = Object.entries(findings).map(([k, v]) => `${v} ${k}`).join(', ');
  return `<div class="flow-warn">⚠ Scrubbed ${removed} hidden character${removed === 1 ? '' : 's'}`
    + ` <span class="muted sm">(${escapeHtml(kinds)})</span> before redaction</div>`;
}

// The gateway un-redacts the model's reply server-side, so the client only ever
// receives REAL values. To show what the destination model ACTUALLY emitted (with
// placeholders still in it, before restoration), reconstruct it by swapping each
// real value back to its token. Longest values first so an overlapping shorter
// value can't corrupt a longer match.
function reRedactReply(text, spans) {
  let out = String(text == null ? '' : text);
  const ordered = [...(spans || [])].filter((s) => s && s.value).sort((a, b) => String(b.value).length - String(a.value).length);
  for (const s of ordered) out = out.split(s.value).join(s.token);
  return out;
}

function renderFlow(t, withModel) {
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const cards = [];
  cards.push(flowCard(1, 'Your prompt', `<div class="flow-text">${esc(t.input)}</div>${hiddenCharNote(t.input)}`));
  if (t.skipped) {
    cards.push(flowCard(2, 'Redaction', '<span class="muted sm">Skipped — “Redact for: Remote only” and this is a <b>local</b> model, so nothing is redacted (faster; the model gets the real text).</span>', 'flow-tools'));
    cards.push(flowCard(3, 'Model sees', `<div class="flow-text">${esc(t.modelSees)}</div>`, 'flow-model'));
  } else {
    const chips = (t.detected || []).length
      ? t.detected.map((d) => `<span class="flow-chip">${esc(d.value)}<em>${esc(d.type)}</em></span>`).join('')
      : '<span class="muted sm">No AI-detected entities (patterns + dictionary still apply).</span>';
    cards.push(flowCard(2, 'Detected', chips));
    cards.push(flowCard(3, 'Model sees', `<div class="flow-text">${esc(t.modelSees)}</div>`, 'flow-model'));
    const maps = (t.spans || []).length
      ? t.spans.map((s) => `<div class="flow-map"><code>${esc(s.token)}</code> → <b>${esc(s.value)}</b>${s.kind === 'alias' ? ' <em>(pseudonym)</em>' : ''}</div>`).join('')
      : '<span class="muted sm">Nothing replaced.</span>';
    const redactRemote = ($('priv-tooldata') && $('priv-tooldata').value) === 'redactRemote';
    const toolsHdr = redactRemote
      ? 'Local history/meeting/page tools get the real values; remote MCP tools keep the <b>redacted</b> token (PII stays off third-party servers):'
      : 'Local search &amp; MCP tools get the real values:';
    cards.push(flowCard(4, 'Tools receive', `<div class="muted sm">${toolsHdr}</div>${maps}`, 'flow-tools'));
  }
  // Actual tool calls the model made this run (real args in, re-redacted result out).
  (t.toolTrace || []).forEach((tt) => {
    const body = tt.error
      ? `<span class="flow-err">✕ ${esc(tt.error)}</span>`
      : `<div class="flow-map">args → tool: <code>${esc(JSON.stringify(tt.realArgs))}</code></div>`
        + '<div class="muted sm" style="margin-top:5px">result → model:</div>'
        + `<div class="flow-text">${esc(tt.modelResult) || '<span class="muted sm">(empty)</span>'}</div>`;
    cards.push(flowCard('', tt.name, body, 'flow-tools', icon('tools')));
  });
  if (withModel) {
    const reply = t.error
      ? `<span class="flow-err">✕ ${esc(t.error)}</span>`
      : `<div class="flow-text">${esc(t.modelRaw) || '<span class="muted sm">(empty)</span>'}</div>`;
    cards.push(flowCard(5, 'Model reply (redacted)', reply, 'flow-model'));
    cards.push(flowCard(6, 'You see (restored)', `<div class="flow-text">${esc(t.youSee) || (t.error ? '—' : '<span class="muted sm">(empty)</span>')}</div>`, 'flow-you'));
  }
  $('priv-flow-out').innerHTML = cards.join('<div class="flow-arrow">→</div>');
}

const FLOW_SAMPLE = 'My name is John. I live in Austin. Email john@adams.com, phone 234-444-4455. Who is the famous president with my name?';

async function previewFlow() {
  const status = $('priv-flow-status');
  if (status) status.textContent = 'Redacting…';
  await savePrefs();
  const sample = (($('priv-flow-input') && $('priv-flow-input').value) || '').trim() || FLOW_SAMPLE;
  try {
    const { redacted, spans, detector } = await previewRedaction(settings, sample);
    renderFlow({ input: sample, detected: detector, modelSees: redacted, spans }, false);
    if (status) status.textContent = `${spans.length} replaced · model not called (preview)`;
  } catch (e) {
    if (status) status.textContent = `✕ ${(e && e.message) || 'redaction failed'}`;
  }
}

function mcpKey(s) { return s.id || s.name || s.url || s.command || ''; }

// Per-server tool selector (History + each enabled MCP server). MCP is OFF by
// default — arming every server is what bloats the prompt and slows the model.
// Re-renders preserve the user's current picks.
function renderFlowTools(boxId = 'priv-flow-tools') {
  const box = $(boxId);
  if (!box) return;
  const prev = new Set([...box.querySelectorAll('input:checked')].map((c) => c.dataset.flowTool));
  const first = box.dataset.rendered !== '1';
  const servers = (settings.mcpServers || []).filter((s) => s && s.enabled !== false && (s.url || s.command));
  const items = [];
  // Auto (default): arm ALL enabled servers and let the ranker pick the relevant
  // few — mirrors the chat's AUTO mode, so "no manual picks" still runs tools.
  const autoOn = first ? true : prev.has('auto');
  items.push(`<label class="check" title="Arm every enabled tool and automatically narrow to the most relevant for your message (like chat AUTO mode)"><input type="checkbox" data-flow-tool="auto"${autoOn ? ' checked' : ''} /> <strong>Auto</strong> — pick relevant</label>`);
  const histOn = first ? settings.ui?.historyTools !== false : prev.has('history');
  items.push(`<label class="check"><input type="checkbox" data-flow-tool="history"${histOn ? ' checked' : ''} /> History</label>`);
  // Web search — the same model-callable tool the chat exposes; armable here so you
  // can test how a search round-trips through redaction / the gateway.
  const wsOn = first ? settings.ui?.webSearch?.enabled !== false : prev.has('websearch');
  items.push(`<label class="check"><input type="checkbox" data-flow-tool="websearch"${wsOn ? ' checked' : ''} /> Web search</label>`);
  // Free uses the first FREE_LIMITS.mcpServers servers (by list position) — match the
  // runtime cap + the Tools-tab lock here so a Free user can't arm/test locked ones.
  const mcpLimit = isPro(license) ? Infinity : FREE_LIMITS.mcpServers;
  servers.forEach((s, i) => {
    const key = `mcp:${mcpKey(s)}`;
    const locked = i >= mcpLimit;
    items.push(`<label class="check${locked ? ' off' : ''}" title="${locked ? 'Pro — Free includes ' + FREE_LIMITS.mcpServers + ' MCP server' + (FREE_LIMITS.mcpServers === 1 ? '' : 's') : ''}"><input type="checkbox" data-flow-tool="${escapeHtml(key)}"${prev.has(key) && !locked ? ' checked' : ''}${locked ? ' disabled' : ''} /> ${escapeHtml(s.name || s.url || s.command)}${locked ? ' ' + icon('lock') : ''}</label>`);
  });
  if (!servers.length) items.push('<span class="muted sm">No MCP servers enabled (Settings → MCP).</span>');
  box.innerHTML = items.join('');
  box.dataset.rendered = '1';
}

// Build the harness toolset from ONLY the armed servers (the checkboxes).
async function buildHarnessTools(boxId = 'priv-flow-tools') {
  const picks = new Set([...document.querySelectorAll(`#${boxId} input:checked`)].map((c) => c.dataset.flowTool));
  const auto = picks.has('auto'); // arm everything; runFlow narrows to the relevant few
  const providers = [];
  if ((auto || picks.has('history')) && settings.ui?.historyTools !== false) {
    providers.push(historyToolProvider({ includeMeetings: true, explicit: false }));
  }
  // Web search (model-callable), same as the chat path — armable via Auto or its pick.
  if ((auto || picks.has('websearch')) && settings.ui?.webSearch?.enabled !== false) {
    providers.push(webSearchToolProvider(webSearchOpts(settings, isPro(license))));
  }
  const want = new Set([...picks].filter((p) => p.startsWith('mcp:')).map((p) => p.slice(4)));
  // Apply the Free MCP cap (first N by position) BEFORE selecting, so the harness
  // can't test more servers than the runtime would actually use.
  const mcpLimit = isPro(license) ? Infinity : FREE_LIMITS.mcpServers;
  const enabled = (settings.mcpServers || [])
    .filter((s) => s && s.enabled !== false && (s.url || s.command))
    .slice(0, mcpLimit);
  const usable = auto ? enabled : enabled.filter((s) => want.has(mcpKey(s)));
  if (usable.length) {
    let bridgeOk = false;
    try { const h = await checkBridge(settings.bridgeUrl); bridgeOk = !!(h && h.ok); } catch { /* bridge down */ }
    try {
      const mcps = await getMcpProviders(usable, { bridgeUrl: settings.bridgeUrl, bridgeAvailable: bridgeOk, onError: () => {} });
      providers.push(...mcps);
    } catch { /* MCP unavailable — run without it */ }
  }
  return buildToolset(providers);
}

// (Tool relevance ranking + narrowing live in ./js/tool-select.js — shared with the
// production chat path so the harness behaves exactly like a real turn.)

async function runFlow() {
  const status = $('priv-flow-status');
  if (status) status.textContent = 'Loading tools…';
  await savePrefs();
  const sample = (($('priv-flow-input') && $('priv-flow-input').value) || '').trim() || FLOW_SAMPLE;
  try {
    const full = await buildHarnessTools();
    const available = (full && full.specs && full.specs.length) || 0;
    // Same cap as the real chat (AUTO mode) — keep the armed set SMALL so weak
    // models aren't overwhelmed by dozens of tools and actually call the right one.
    const tools = narrowToolset(full, sample, { cap: Number(settings.ui?.maxToolsPerTurn) || DEFAULT_AUTO_TOOL_CAP, keep: isLocalToolSpec });
    const armed = (tools && tools.specs && tools.specs.length) || 0;
    if (status) status.textContent = `Running with ${armed} tool${armed === 1 ? '' : 's'}…`;
    const t = await traceFlow(settings, flowTargetId(), sample, { tools });
    renderFlow(t, true);
    const tc = (t.toolTrace || []).length;
    const narrowed = armed < available ? ` (narrowed from ${available})` : '';
    if (status) {
      status.textContent = t.error
        ? `model: ✕ ${t.error}`
        : t.skipped
          ? `redaction skipped (local model · remote-only) · ${armed} tool${armed === 1 ? '' : 's'} armed · ${tc} call${tc === 1 ? '' : 's'} made`
          : `${t.spans.length} replaced · ${armed} tool${armed === 1 ? '' : 's'} armed${narrowed} · ${tc} call${tc === 1 ? '' : 's'} made`;
    }
  } catch (e) {
    if (status) status.textContent = `✕ ${(e && e.message) || 'run failed'}`;
  }
}

async function renderStorageHealth() {
  const el = $('meeting-storage-health');
  if (!el) return;
  el.textContent = 'Checking local storage...';
  const health = await localStorageHealth();
  const meetingLabel = `${health.meetings} recorded meeting${health.meetings === 1 ? '' : 's'}`;
  el.textContent = `${meetingLabel} · ${health.bytesLabel} stored locally. No automatic meeting-count retention cap.`;
}
async function savePrefs() {
  settings.ui.theme = $('pref-theme').value;
  settings.ui.language = $('pref-language').value;
  settings.ui.sendOnEnter = $('pref-enter').checked;
  settings.ui.streamResponses = $('pref-stream').checked;
  settings.ui.maxToolsPerTurn = Math.max(0, Number($('pref-max-tools').value) || 0);
  const clampN = (v, d) => Math.min(10, Math.max(1, Number(v) || d));
  const engines = collectWebSearchEngines();
  settings.ui.webSearch = {
    enabled: $('pref-websearch-enabled').checked,
    perEngine: clampN($('pref-websearch-per').value, 5),
    maxPages: clampN($('pref-websearch-pages').value, 5),
    tabFallback: $('pref-websearch-tabfallback').checked,
    reader: {
      enabled: $('pref-websearch-reader').checked,
      url: ($('pref-websearch-reader-url').value || '').trim() || 'https://r.jina.ai/',
      key: ($('pref-websearch-reader-key').value || '').trim(),
    },
    engines: engines.length ? engines : DEFAULT_WS_ENGINES.map((e) => ({ ...e })),
  };
  settings.ui.topicExtraction = {
    enabled: $('pref-topic-extract').checked,
    targetId: $('pref-topic-target').value,
  };
  settings.ui.suggestions = {
    ...(settings.ui.suggestions || {}),
    enabled: $('pref-suggestions-enabled').checked,
    targetId: $('pref-suggestions-target').value,
  };
  settings.ui.autocomplete = isPro(license) && $('pref-autocomplete').checked;
  settings.ui.liveNotesIntervalMin = Number($('pref-live-notes').value);
  settings.ui.meetingWindowMin = Number($('pref-meeting-window').value);
  settings.ui.meetingSummaryStyle = $('pref-meeting-summary-style').value === 'detailed' ? 'detailed' : 'concise';
  settings.ui.voice = {
    ...(settings.ui.voice || {}),
    enabled: $('pref-voice-enabled').checked,
    // A blank wake word would compile to nothing and either disable the feature silently or
    // match everything — neither is what an empty box means, so it falls back to the default.
    wakeWord: $('pref-voice-wake').value.trim() || 'ChatPanel',
    from: ['me', 'anyone', 'off'].includes($('pref-voice-from').value) ? $('pref-voice-from').value : 'me',
    selfNames: $('pref-voice-names').value.split(',').map((n) => n.trim()).filter(Boolean),
  };
  settings.ui.piiRedaction = {
    ...(settings.ui.piiRedaction || {}),
    mode: $('priv-mode').value,
    // tier is derived from mode now (model = full/entity-aware); no separate control.
    tier: $('priv-mode').value === 'model' ? 'full' : 'basic',
    scope: {
      chat: $('priv-scope-chat').checked,
      context: $('priv-scope-context').checked,
      history: $('priv-scope-history').checked,
      toolResults: $('priv-scope-tools').checked,
    },
    toolData: $('priv-tooldata').value,
    applyTo: $('priv-applyto').value,
    dictionary: piiTextToDict($('priv-dictionary').value),
    detection: (() => {
      const pbk = $('priv-det-backend').value;
      const isBundled = pbk === 'bundled';
      return {
      ...(settings.ui.piiRedaction?.detection || {}),
      // Bundled NER is an endpoint detector aimed at the gateway's in-process NER;
      // persist it as such (+ a `bundled` marker) so the runtime detector needs no
      // special case and reload still shows "Bundled NER".
      backend: isBundled ? 'endpoint' : pbk,
      bundled: isBundled,
      url: isBundled ? gatewayNerEndpoint() : $('priv-det-url').value.trim(),
      targetId: detTargetId(),
      model: (pbk === 'agent' ? $('priv-det-tmodel').value : '').trim(),
      timeoutMs: Number($('priv-det-timeout').value) || 1500,
      types: {
        person: $('priv-det-person').checked,
        org: $('priv-det-org').checked,
        location: $('priv-det-location').checked,
        number: $('priv-det-number').checked,
      },
      };
    })(),
  };
  await saveSettings(settings);
}

// Privacy tab: serialize the custom redaction dictionary to/from the textarea.
// One entry per line, with two operators:
//   => LABEL   reversible redaction   John => PERSON  → model sees [[PERSON_1]], you see "John"
//   -> alias   pseudonymize (permanent) John -> Alex  → you AND the model see "Alex" (never reversed)
// Plain term (John) or /regex/flags also work → default placeholder [[TERM_1]].
function piiDictToText(arr) {
  return (arr || [])
    .map((d) => {
      if (!d) return '';
      const body = d.pattern ? `/${d.pattern}/${d.flags || ''}` : (d.value || '');
      if (!body) return '';
      if (d.alias != null && d.alias !== '') return `${body} -> ${d.alias}`;
      return d.type && d.type !== 'TERM' ? `${body} => ${d.type}` : body;
    })
    .filter(Boolean)
    .join('\n');
}
function piiTextToDict(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      let head = l;
      let type = 'TERM';
      let alias = null;
      const lbl = l.lastIndexOf('=>');
      const als = l.lastIndexOf('->');
      if (lbl > 0 && lbl >= als) {
        const label = l.slice(lbl + 2).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (label) { head = l.slice(0, lbl).trim(); type = label; }
      } else if (als > 0) {
        const a = l.slice(als + 2).trim();
        if (a) { head = l.slice(0, als).trim(); alias = a; }
      }
      const m = /^\/(.+)\/([a-z]*)$/.exec(head);
      const base = m ? { pattern: m[1], flags: m[2] } : { value: head };
      return alias != null ? { ...base, alias } : { ...base, type };
    });
}

// --------------------------------------------------------------------------
// Usage — token accounting across every model call (see js/usage-meter.js).
// The meter + rate table are dynamic-imported so they stay off the settings
// boot path; renderUsage runs only when the Usage tab is opened.
// --------------------------------------------------------------------------
function wireUsage() {
  const rerender = () => renderUsage();
  // The tab click itself is handled by wireTabs → show('usage') → renderUsage();
  // here we only wire the in-panel controls.
  if ($('usage-refresh')) $('usage-refresh').onclick = rerender;
  if ($('usage-groupby')) $('usage-groupby').onchange = rerender;
  if ($('usage-window')) $('usage-window').onchange = rerender;
  if ($('usage-clear')) $('usage-clear').onclick = async () => {
    const { confirmDelete } = await import('./js/confirm-modal.js');
    if (!(await confirmDelete({ title: 'Clear usage history?', body: 'Clear all token-usage history? This can\'t be undone.', confirmLabel: 'Clear' }))) return;
    const { clearUsage } = await import('./js/usage-meter.js');
    await clearUsage();
    renderUsage();
  };
}

async function renderUsage() {
  const box = $('usage-report');
  if (!box) return;
  box.textContent = 'Loading…';
  try {
    const [{ usageSummary }, { formatUsd }] = await Promise.all([
      import('./js/usage-meter.js'), import('./js/usage-pricing.js'),
    ]);
    const groupBy = $('usage-groupby')?.value || 'surface';
    const days = Number($('usage-window')?.value) || null;
    const { groups, total } = await usageSummary({ groupBy, sinceDays: days });
    if (!groups.length) { box.innerHTML = '<p class="sub">No model calls recorded yet.</p>'; return; }
    const n = (v) => (Number(v) || 0).toLocaleString();
    const est = (e) => (e ? '≈' : '');
    const rows = groups.map((g) =>
      `<tr><td>${escapeHtml(String(g.key))}</td><td>${n(g.calls)}</td><td>${n(g.inputTokens)}</td><td>${n(g.outputTokens)}</td><td>${n(g.cacheReadTokens)}</td><td>${est(g.estimated)}${formatUsd(g.usd)}</td></tr>`).join('');
    box.innerHTML =
      `<table class="usage-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th style="text-align:left">${escapeHtml(groupBy)}</th><th>Calls</th><th>Input</th><th>Output</th><th>Cache&nbsp;rd</th><th>Cost</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td><b>Total</b></td><td>${n(total.calls)}</td><td>${n(total.inputTokens)}</td><td>${n(total.outputTokens)}</td><td>${n(total.cacheReadTokens)}</td><td>${est(total.estimated)}${formatUsd(total.usd)}</td></tr></tfoot>
      </table>`;
  } catch {
    box.textContent = 'Could not load usage.';
  }
}

// --------------------------------------------------------------------------
// License
// --------------------------------------------------------------------------
function renderLicense() {
  const plan = planOf(license);
  const active = plan !== 'free';
  const label = planLabel(license);
  $('plan-badge').textContent = label;
  $('plan-badge').classList.toggle('pro', active);
  $('license-state').innerHTML = active
    ? `<p class="status ok">✓ ${label} is active${license.key ? ` — key ${maskKey(license.key)}` : ''}.</p>`
    : '<p class="muted">You are on the Free plan — local agents (Claude Code, Codex) and bring-your-own models are included. Upgrade for power &amp; team features.</p>';
  renderPlanFeatures();
  // Subscribe + restore + key entry are for Free users; active users see Deactivate.
  $('btn-subscribe-pro').classList.toggle('hidden', active);
  $('btn-check-purchase').classList.toggle('hidden', active);
  $('subscribe-hint').classList.toggle('hidden', active);
  $('restore-box').classList.toggle('hidden', active);
  $('license-deactivate').classList.toggle('hidden', !active);
}
function maskKey(k) {
  return k.length > 8 ? k.slice(0, 6) + '…' + k.slice(-2) : k;
}

// Data-driven feature lists so every gated feature (incl. the live meeting scribe)
// is visibly attributed to its tier. A checkmark means the current plan has it.
function renderPlanFeatures() {
  const el = $('plan-features');
  if (!el) return;
  const pro = isPro(license);
  const team = planOf(license) === 'team';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (text, has) => `<li class="${has ? 'has' : 'locked'}">${has ? icon('check') : icon('lock')} ${esc(text)}</li>`;
  const proItems = Object.values(PRO_FEATURES).map((t) => row(t, pro)).join('');
  const teamItems = Object.values(TEAM_FEATURES).map((t) => row(t, team)).join('');
  el.innerHTML =
    `<div class="plan-group"><h3>${icon('upgrade')} Pro</h3><ul class="feature-list">${proItems}</ul></div>` +
    `<div class="plan-group"><h3>${icon('users')} Team</h3><ul class="feature-list">${teamItems}</ul></div>`;
}

// About & updates. Manual ("Load unpacked") builds don't auto-update, so we show
// the current version + a live check against the latest GitHub release. On a Web
// Store install this collapses to a simple "auto-updates" line.
async function renderAbout() {
  const version = currentVersion();
  $('about-version').textContent = `ChatPanel v${version}`;
  $('download-latest').href = DOWNLOAD_URL;
  const status = $('update-status');
  status.textContent = 'Checking for updates…';
  status.className = 'status';
  let info;
  try {
    // Settings is an explicit, user-initiated check — bypass the 12h cache so it
    // always reflects the newest GitHub release (the side-panel banner stays
    // throttled for background checks).
    info = await checkForUpdate({ force: true });
  } catch {
    status.textContent = '';
    return;
  }
  if (info.managed) {
    // Installed from the Web Store — it auto-updates; hide the manual guidance.
    $('manual-install-note').textContent = 'Installed from the Chrome Web Store — updates install automatically.';
    $('download-latest').classList.add('hidden');
    status.textContent = '';
    return;
  }
  if (info.updateAvailable) {
    status.innerHTML = `↑ Update available: <b>v${info.latest}</b> (you have v${info.current}).`;
    status.className = 'status';
    $('download-latest').textContent = `Download v${info.latest}`;
  } else if (info.latest) {
    setStatus(status, `✓ You’re on the latest build (v${info.current}).`, 'ok');
  } else {
    // Couldn't reach GitHub; keep it quiet, just offer the link.
    status.textContent = '';
  }
}

// Flip the whole UI to Pro once an entitlement goes live.
function onProActivated(lic, announce = true) {
  license = lic;
  renderLicense();
  renderEndpoints();
  renderBridgeAgents();
  renderMcpServers();
  renderSkills();
  renderPrefs(); // re-enable the Pro-gated Autocomplete toggle
  renderGateBadges(); // re-enable MCP add + Meetings controls
  if (announce) setStatus($('license-msg'), '✓ Pro is now active. Thank you!', 'ok');
}

// Seamless, keyless subscribe used by every "Upgrade"/"Subscribe" affordance:
// opens checkout (carrying this install's id) and auto-activates on return.
async function subscribePro(btn) {
  setStatus($('license-msg'), 'Opening checkout… Pro will activate here automatically once you finish.', '');
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Waiting for checkout…'; }
  const restore = () => {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Subscribe to Pro'; }
  };
  await subscribe('pro', { onActivated: (lic) => { restore(); onProActivated(lic); } });
  // Re-enable after the poll window so a cancelled checkout isn't stuck, and point
  // at the manual check rather than leaving a buyer staring at "Waiting…".
  setTimeout(() => {
    if (planOf(license) !== 'free') return;
    restore();
    setStatus($('license-msg'), 'Finished checkout? Click “Check for my purchase”.', '');
  }, 15 * 60 * 1000 + 1000);
}

// --------------------------------------------------------------------------
// Pro gating (visible). The allow/deny logic lives in license.js; these helpers
// just make the gate visible in the UI and stop free users editing Pro fields.
// --------------------------------------------------------------------------
function proBadge() {
  const b = document.createElement('span');
  b.className = 'pro-badge';
  b.innerHTML = icon('upgrade') + ' Pro';
  b.title = 'Pro feature';
  return b;
}

// Disable a control the current plan can't use, and badge its row label.
function gateField(feature, input) {
  if (!input || can(license, feature)) return;
  input.disabled = true;
  input.classList.add('locked');
  const label = input.closest('.row')?.querySelector('label');
  if (label && !label.querySelector('.pro-badge')) label.appendChild(proBadge());
}

// Add or clear a ✨ Pro badge on a header "+ Add" button based on a gate.
function badgeButton(btn, locked) {
  if (!btn) return;
  const existing = btn.querySelector('.pro-badge');
  if (locked && !existing) btn.appendChild(proBadge());
  else if (!locked && existing) existing.remove();
}

// Refresh the badges on the section action buttons. Called on load, whenever
// endpoints change, and after the plan changes.
// Free includes FREE_LIMITS.mcpServers (1) addable server; adding more is Pro.
// Search/Discover stays free.
function mcpAddLocked() {
  return !isPro(license) && (settings.mcpServers || []).length >= FREE_LIMITS.mcpServers;
}

function renderGateBadges() {
  ['add-skill', 'add-skill-bottom'].forEach((id) => badgeButton($(id), !can(license, 'customSkills')));
  // Agents: free uses the built-in CLIs (one active) — adding more is Pro.
  const proLocked = !isPro(license);
  ['add-agent', 'add-agent-bottom'].forEach((id) => {
    const b = $(id);
    if (b) { badgeButton(b, proLocked); b.classList.toggle('locked', proLocked); }
  });
  // Endpoints: Free gets FREE_LIMITS.apiEndpoints of its OWN (the built-ins are
  // just zero-setup defaults — a Free user must be able to point ChatPanel at
  // their own provider). Badge it once the allowance is spent, but never add
  // `.locked`: that sets pointer-events:none, which made the button silently
  // dead instead of explaining why. Clicking still surfaces the upsell.
  ['add-endpoint', 'add-endpoint-bottom'].forEach((id) => badgeButton($(id), endpointAddLocked()));
  // MCP: free can search/discover + add one; adding beyond the free limit is Pro.
  const mcpLocked = mcpAddLocked();
  ['add-mcp', 'import-mcp'].forEach((id) => { const b = $(id); if (b) { badgeButton(b, mcpLocked); b.classList.toggle('locked', mcpLocked); } });
  // Meetings: Pro-only.
  const mLocked = !can(license, 'liveMeetings');
  const md = $('open-meetings-dashboard');
  if (md) { badgeButton(md, mLocked); md.classList.toggle('locked', mLocked); }
  ['pref-live-notes', 'pref-meeting-window'].forEach((id) => { const el = $(id); if (el) { el.disabled = mLocked; el.classList.toggle('locked', mLocked); } });
}

// On Free, exactly one endpoint and one bridge agent are usable — the user's
// pick. Drop a "★ Free" marker on the chosen one and a "Use on Free" button on
// the others so they can change it. Pro users see none of this (all usable).
function applyFreeSlot(node, item, kind) {
  if (isPro(license)) return;
  const head = node.querySelector('.entity-head');
  if (!head) return;
  const chosen =
    kind === 'bridge' ? item.id === freeAgentId(settings) : item.id === freeEndpointId(settings);
  if (chosen) {
    const star = document.createElement('span');
    star.className = 'free-slot on';
    star.innerHTML = icon('star') + ' Free';
    star.title = 'Your free ' + (kind === 'bridge' ? 'agent' : 'endpoint');
    head.appendChild(star);
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'btn ghost free-slot';
  btn.textContent = 'Use on Free';
  btn.title = 'Make this your one free ' + (kind === 'bridge' ? 'agent' : 'endpoint');
  btn.onclick = async () => {
    if (kind === 'bridge') settings.freeAgentId = item.id;
    else settings.freeEndpointId = item.id;
    await saveSettings(settings);
    kind === 'bridge' ? renderBridgeAgents() : renderEndpoints();
  };
  head.appendChild(btn);
}

// --------------------------------------------------------------------------
// Wiring + helpers
// --------------------------------------------------------------------------
function wire() {
  $('add-endpoint').onclick = addEndpoint;
  $('add-agent').onclick = addBridgeAgent;
  $('local-recheck').onclick = () => renderLocalRuntime({ recheck: true });
  // The "what the gateway adds" link jumps to the Gateway section, it doesn't navigate away.
  $('local-runtime').addEventListener('click', (e) => {
    const a = e.target.closest('a.runtime-link');
    if (!a) return;
    e.preventDefault();
    openGatewaySection();
  });
  wireSectionJumps();
  // Duplicated under each list so "add another" is in reach after scrolling past
  // the cards above it.
  $('add-endpoint-bottom').onclick = addEndpoint;
  $('add-agent-bottom').onclick = addBridgeAgent;
  $('add-mcp').onclick = addMcpServer;
  $('add-websearch').onclick = addWebSearchEngine;
  $('import-mcp').onclick = () => {
    if (mcpAddLocked()) return upsell(`Free includes ${FREE_LIMITS.mcpServers} MCP server. Upgrade to Pro for unlimited.`);
    toggleMcpImport(true);
  };
  $('mcp-import-cancel').onclick = () => toggleMcpImport(false);
  $('mcp-import-apply').onclick = importMcpConfig;
  $('add-skill').onclick = addSkill;
  $('add-skill-bottom').onclick = addSkill;
  $('skill-filter').oninput = (e) => { skillFilter = e.target.value; applySkillFilter(); };
  // Debounced: a keystroke can reach a remote hub, and one request per character is
  // both slow and rude to whoever is hosting it.
  let skillSearchTimer = null;
  $('skill-source-search').oninput = (e) => {
    skillSourceQuery = e.target.value;
    skillSourceLimit = SKILL_SOURCE_PAGE; // a new search starts at page one
    clearTimeout(skillSearchTimer);
    skillSearchTimer = setTimeout(() => renderSkillSources(), 180);
  };
  $('skill-sources-refresh').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    // Persist the custom folders before rescanning, so the scan uses what's in the box now.
    await saveSkillDirs();
    // Re-check /health first: the usual reason nothing shows is that the bridge was
    // started after this page was opened.
    bridgeState = await checkBridge(settings.bridgeUrl);
    await renderSkillSources();
    btn.disabled = false;
  };
  // Save the custom folders on blur — a rescan also saves first, but leaving the field
  // shouldn't silently discard what was typed.
  $('skill-dirs-input').onchange = () => saveSkillDirs();
  $('reset-skills').onclick = resetSkills;
  $('mcp-registry-search-btn').onclick = () => loadMcpRegistry();
  $('mcp-registry-more').onclick = () => loadMcpRegistry({ append: true });
  $('mcp-registry-search').onkeydown = (e) => {
    if (e.key === 'Enter') loadMcpRegistry();
  };

  $('bridge-test').onclick = testBridge;
  $('bridge-token').onchange = async () => {
    settings.bridgeToken = $('bridge-token').value.trim();
    await saveSettings(settings);
    // The token exists to make the Channels card work, so prove it did — re-reading the
    // status here is the difference between "saved" and "saved and it helped".
    renderChannels().catch(() => {});
  };
  $('bridge-url').onchange = async () => {
    settings.bridgeUrl = $('bridge-url').value.trim();
    await saveSettings(settings);
  };

  $('pref-theme').onchange = savePrefs;
  $('pref-enter').onchange = savePrefs;
  $('pref-stream').onchange = savePrefs;
  $('pref-max-tools').onchange = savePrefs;
  $('pref-topic-extract').onchange = savePrefs;
  $('pref-topic-target').onchange = savePrefs;
  $('pref-suggestions-enabled').onchange = savePrefs;
  $('pref-suggestions-target').onchange = savePrefs;
  $('pref-live-notes').onchange = savePrefs;
  $('pref-meeting-window').onchange = savePrefs;
  $('pref-meeting-summary-style').onchange = savePrefs;
  { const a = $('meetings-open-skills'); if (a) a.onclick = (e) => { e.preventDefault(); document.querySelector('[data-tab="skills"]')?.click(); }; }
  $('priv-mode').onchange = () => { savePrefs(); renderPrefs(); };
  $('priv-scope-chat').onchange = savePrefs;
  $('priv-scope-context').onchange = savePrefs;
  $('priv-scope-history').onchange = savePrefs;
  $('priv-scope-tools').onchange = savePrefs;
  $('priv-tooldata').onchange = savePrefs;
  $('priv-applyto').onchange = savePrefs;
  $('priv-dictionary').onchange = savePrefs;
  $('priv-det-backend').onchange = () => { savePrefs(); renderPrefs(); };
  $('priv-det-url').onchange = savePrefs;
  if ($('priv-ner-check')) $('priv-ner-check').onclick = checkPrivNer;
  $('priv-det-target').onchange = () => { populateDetModels(detTargetId(), ''); savePrefs(); };
  $('priv-det-tmodel').onchange = savePrefs;
  $('priv-flow-run').onclick = runFlow;
  $('priv-flow-preview').onclick = previewFlow;
  $('priv-det-timeout').onchange = savePrefs;
  $('priv-det-person').onchange = savePrefs;
  $('priv-det-org').onchange = savePrefs;
  $('priv-det-location').onchange = savePrefs;
  $('priv-det-number').onchange = savePrefs;
  $('pref-autocomplete').onchange = () => {
    if (!isPro(license)) { upsell('Autocomplete is a Pro feature'); $('pref-autocomplete').checked = false; return; }
    savePrefs();
  };
  // High-reliability page control. `debugger` is a required permission, so
  // there's nothing to request — just persist the choice.
  // Act on page — the mode, plus the per-site answers the composer offer records.
  $('pref-pageact-mode').onchange = async (e) => {
    const v = e.currentTarget.value;
    settings.ui.pageActions = Object.values(PAGE_MODES).includes(v) ? v : PAGE_MODES.ASK;
    await saveSettings(settings);
    renderPageSites();
  };
  $('pref-pageact-cdp').onchange = async (e) => {
    settings.ui.pageActionsCdp = e.currentTarget.checked;
    await saveSettings(settings);
  };
  // Confirm-before-page-actions gate (default on). Persist the choice.
  $('pref-pageact-confirm').onchange = async (e) => {
    settings.ui.pageActionConfirm = e.currentTarget.checked;
    await saveSettings(settings);
  };
  // Developer JS execution. Opt-in only, and pointless without trusted events —
  // so turning it on turns High-reliability on too rather than failing silently
  // at the first call. Every call still prompts; that is not configurable.
  $('pref-pageact-devjs').onchange = async (e) => {
    const on = e.currentTarget.checked;
    settings.ui.pageActionsDevJs = on;
    // Only meaningful if high-reliability control is on; it defaults on, so this
    // only has to undo an explicit opt-out.
    if (on && settings.ui.pageActionsCdp === false) {
      settings.ui.pageActionsCdp = true;
      $('pref-pageact-cdp').checked = true;
      toast('High-reliability page control turned back on — running JavaScript needs it');
    }
    await saveSettings(settings);
  };

  $('check-updates').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await renderAbout(); } finally { btn.disabled = false; }
  };

  $('btn-subscribe-pro').onclick = () => subscribePro($('btn-subscribe-pro'));

  // Explicit "I paid, look again" — the escape hatch when the automatic poll was
  // closed with the tab or the purchase landed late. Checks this device's seat
  // AND the sync claim, so it also covers a sub bought on another device.
  $('btn-check-purchase').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    setStatus($('license-msg'), 'Checking…', '');
    try {
      const lic = await recheckEntitlement({ explicit: true });
      if (lic) return onProActivated(lic);
      setStatus(
        $('license-msg'),
        '✕ No active subscription found for this device yet. If you just paid, give it a few seconds and try again — or restore by email below.',
        'err',
      );
    } finally {
      btn.disabled = false;
    }
  };

  $('open-meetings-dashboard')?.addEventListener('click', () => {
    if (!can(license, 'liveMeetings')) return upsell('The meeting scribe & dashboard are a Pro feature.');
    chrome.tabs.create({ url: chrome.runtime.getURL('meetings.html') });
  });
  $('open-history-dashboard')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  });

  $('btn-restore').onclick = async () => {
    const email = $('restore-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setStatus($('license-msg'), '✕ Enter the email you bought Pro with.', 'err');
      return;
    }
    await restoreByEmail(email);
    setStatus($('license-msg'), '✓ If that email has a subscription, a one-tap link is on its way. Open it on this device.', 'ok');
  };

  $('license-deactivate').onclick = async () => {
    license = await deactivate();
    renderLicense();
    renderEndpoints();
    renderBridgeAgents();
    renderMcpServers();
    renderSkills();
  };

  wireBackup();
}

// Restore full encrypted backups (and legacy ZIP exports) from disk. New backups
// are created only by runAutoBackup(), which always compresses and encrypts them.
function wireBackup() {
  const msg = $('backup-msg');

  const restoreBackupData = async (data, status = msg, {
    historyOnly = false, modeOverride = '', password = '', quiet = false,
  } = {}) => {
    if (isEncryptedBackup(data)) data = await decryptBackup(data, password || $('backup-password').value);
    const mode = modeOverride || ($('backup-replace').checked ? 'replace' : 'merge');
    // At the call site, not the module top: the four late stores are ~137 KB that a
    // settings page which never restores a backup should not load. See js/backup-payload.js.
    const { backupExtras } = await import('./js/backup-payload.js');
    const { conversations, meetings, notes, settings: settingsRestored } = await importAllData(data, {
      mode,
      includeSettings: !historyOnly,
      includeOAuthTokens: !historyOnly,
      extras: backupExtras,
    });
    const parts = [`${conversations.imported} conversation${conversations.imported === 1 ? '' : 's'}`];
    if (meetings.imported) parts.push(`${meetings.imported} meeting${meetings.imported === 1 ? '' : 's'}`);
    if (notes?.imported) parts.push(`${notes.imported} note${notes.imported === 1 ? '' : 's'}`);
    if (settingsRestored) {
      settings = await getSettings();
      parts.push('settings');
      renderEndpoints();
      renderBridge();
      renderBridgeAgents();
      renderMcpServers();
      renderSkills();
      renderPrefs();
      renderGateBadges();
    }
    renderStorageHealth();
    const skipped = (conversations.total - conversations.imported) + (meetings.total - meetings.imported);
    if (!quiet) {
      const scope = historyOnly ? ' History was merged; this device’s settings and sign-ins were kept.' : '';
      setStatus(status, `✓ Restored ${parts.join(' + ')}${skipped ? ` (${skipped} skipped)` : ''}.${scope} Reopen ChatPanel to see everything.`, 'ok');
    }
    return { conversations, meetings, notes, settingsRestored };
  };

  $('backup-import').onclick = () => {
    if (!can(license, 'exportChats')) {
      return setStatus(msg, '✨ Backup & restore is a Pro feature — upgrade above.', 'err');
    }
    $('backup-file').click();
  };

  $('backup-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setStatus(msg, 'Restoring…');
    try {
      // Accept our .zip export (pull the JSON out of it) or a bare .json backup.
      // Detect by magic bytes ('PK') so a renamed file still works.
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, 2);
      let text;
      if (head[0] === 0x50 && head[1] === 0x4b) {
        text = await readZipEntry(buf, 'chatpanel-data.json');
        if (!text) throw new Error('That zip has no chatpanel-data.json — is it a ChatPanel export?');
      } else {
        text = new TextDecoder().decode(buf);
      }
      let data = JSON.parse(text);
      await restoreBackupData(data, msg);
    } catch (err) {
      setStatus(msg, '✕ ' + (err.message || err), 'err');
    }
  };

  wireAutoBackup(restoreBackupData);
}

// Daily encrypted backup to disk (Pro), written to Downloads/ChatPanel Backups/
// on the preferred schedule by the service worker. Here we only drive the toggle /
// "Back up now" and reflect the saved state.
function wireAutoBackup(restoreBackupData) {
  const toggle = $('autobackup-enabled');
  const status = $('autobackup-status');
  const pw = $('backup-password');
  if (!toggle) return; // defensive — UI not present

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');
  const fmtSize = (n) => {
    if (!n) return '';
    const mb = n / (1024 * 1024);
    return mb >= 1 ? ` (${mb.toFixed(1)} MB)` : ` (${Math.max(1, Math.round(n / 1024))} KB)`;
  };
  const hourSel = $('autobackup-hour');
  const destination = $('autobackup-destination');
  const deviceName = $('autobackup-device-name');
  const driveStatus = $('drive-status');
  const driveList = $('drive-backup-list');
  let driveBackupFiles = [];
  // Populate 12am–11pm once (value = 0–23 local hour).
  if (hourSel && hourSel.options.length <= 1) {
    for (let h = 0; h < 24; h++) {
      const label = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`;
      hourSel.add(new Option(`Daily at ${label}`, String(h)));
    }
  }
  const hourText = (st) => ` · daily at ${st.hour % 12 || 12}${st.hour < 12 ? 'am' : 'pm'}`;
  const destinationText = (value) => value === 'drive' ? 'Google Drive' : value === 'both' ? 'Downloads + Google Drive' : 'Downloads → ChatPanel Backups';
  const showState = (st) => {
    if (!st.enabled) return setStatus(status, 'Daily schedule is off.', '');
    if (!st.passphrase) return setStatus(status, 'Paused — set the backup password again on this device.', 'err');
    if (st.lastError) return setStatus(status, '✕ ' + st.lastError, 'err');
    const gatewayWarning = st.lastGatewayError ? ` Gateway indexing warning: ${st.lastGatewayError}.` : '';
    setStatus(status, `On 🔒 compressed + encrypted${hourText(st)} — ${destinationText(st.destination)}. Last completed backup: ${fmt(st.lastAt)}${fmtSize(st.lastBytes)}.${gatewayWarning}`, st.lastAt ? 'ok' : '');
  };
  // Store a device-wrapped copy before any backup runs so the unattended
  // service-worker write uses the latest value after browser restarts.
  const syncPass = () => setAutoBackupPassphrase(pw ? pw.value : '');

  getBackupState().then((st) => {
    toggle.checked = !!st.enabled;
    if (pw) pw.value = st.passphrase || '';
    if (hourSel) hourSel.value = Number.isInteger(st.hour) ? String(st.hour) : '';
    if (destination) destination.value = st.destination || 'local';
    if (deviceName) deviceName.value = st.deviceName || '';
    $('local-download-help')?.classList.toggle('hidden', !backupDestinationIncludes(st.destination, 'local'));
    showState(st);
  });

  try { $('drive-redirect-uri').value = googleDriveRedirectUri(); } catch { $('drive-redirect-uri').value = 'Available only inside a supported browser extension'; }

  const saveDriveConfig = async () => {
    await setAutoBackupDestination(destination?.value || 'local');
  };

  const showDriveConnection = async () => {
    const connection = await getGoogleDriveConnection();
    const backupState = await getBackupState();
    const disconnected = connection.reconnectRequired
      ? 'Reconnect once to upgrade Google Drive for reliable scheduled backups.'
      : 'Not connected.';
    const connected = `✓ Google Drive connected. Current backup destination: ${destinationText(backupState.destination)}. Only encrypted ChatPanel backup files are accessible.`;
    setStatus(driveStatus, connection.connected ? connected : disconnected, connection.connected ? 'ok' : '');
    return connection;
  };

  const refreshDriveBackups = async () => {
    setStatus(driveStatus, 'Loading encrypted Drive backups…');
    const files = await listGoogleDriveBackups();
    driveBackupFiles = files;
    driveList.replaceChildren();
    if (!files.length) driveList.add(new Option('No ChatPanel backups found', ''));
    for (const file of files) {
      const device = googleDriveBackupDevice(file);
      const when = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : 'unknown date';
      const size = file.size ? fmtSize(Number(file.size)).trim() : '';
      driveList.add(new Option(`${device.name} — ${file.name} — ${when}${size}`, file.id));
    }
    const devices = new Set(files.map((file) => googleDriveBackupDevice(file).id));
    setStatus(driveStatus, `✓ Found ${files.length} encrypted backup${files.length === 1 ? '' : 's'} from ${devices.size} device${devices.size === 1 ? '' : 's'} in Drive.`, 'ok');
  };

  showDriveConnection().catch((e) => setStatus(driveStatus, '✕ ' + (e.message || e), 'err'));

  if (destination) destination.onchange = async () => {
    await saveDriveConfig();
    $('local-download-help')?.classList.toggle('hidden', !backupDestinationIncludes(destination.value, 'local'));
    showState(await getBackupState());
  };
  $('drive-connect').onclick = async () => {
    try {
      setStatus(driveStatus, 'Connecting…');
      await saveDriveConfig();
      await connectGoogleDrive();
      const nextDestination = destinationAfterDriveConnect(destination?.value);
      if (destination) destination.value = nextDestination;
      await setAutoBackupDestination(nextDestination);
      $('local-download-help')?.classList.toggle('hidden', !backupDestinationIncludes(nextDestination, 'local'));
      if (nextDestination === 'drive') toast('Google Drive connected. Backup destination set to Google Drive only.');
      await showDriveConnection();
      showState(await getBackupState());
      await refreshDriveBackups();
    } catch (e) { setStatus(driveStatus, '✕ ' + (e.message || e), 'err'); }
  };
  $('drive-disconnect').onclick = async () => {
    await disconnectGoogleDrive();
    driveBackupFiles = [];
    driveList.replaceChildren(new Option('Connect and refresh to list backups', ''));
    await showDriveConnection();
  };
  $('drive-refresh').onclick = () => refreshDriveBackups().catch((e) => setStatus(driveStatus, '✕ ' + (e.message || e), 'err'));
  $('drive-backup-restore').onclick = async () => {
    if (!driveList.value) return setStatus(driveStatus, 'Select a Drive backup first.', 'err');
    try {
      setStatus(driveStatus, 'Downloading encrypted backup into memory…');
      const data = await downloadGoogleDriveBackup(driveList.value);
      await restoreBackupData(data, driveStatus, {
        historyOnly: true,
        modeOverride: 'merge',
        password: pw?.value || '',
      });
    } catch (e) { setStatus(driveStatus, '✕ ' + (e.message || e), 'err'); }
  };
  $('drive-backup-restore-all').onclick = async () => {
    // Import older device snapshots first. If the same record exists on several
    // devices, the most recently completed device snapshot is applied last.
    const latest = latestGoogleDriveBackupsByDevice(driveBackupFiles)
      .sort((a, b) => (Date.parse(a?.modifiedTime || '') || 0) - (Date.parse(b?.modifiedTime || '') || 0));
    if (!latest.length) return setStatus(driveStatus, 'Refresh Drive backups first.', 'err');
    try {
      let conversationCount = 0;
      let meetingCount = 0;
      let notesCount = 0;
      const password = pw?.value || '';
      for (let i = 0; i < latest.length; i++) {
        const file = latest[i];
        const device = googleDriveBackupDevice(file);
        setStatus(driveStatus, `Merging ${device.name} (${i + 1} of ${latest.length})…`);
        const data = await downloadGoogleDriveBackup(file.id);
        const result = await restoreBackupData(data, driveStatus, {
          historyOnly: true,
          modeOverride: 'merge',
          password,
          quiet: true,
        });
        conversationCount += result.conversations.imported;
        meetingCount += result.meetings.imported;
        notesCount += result.notes?.imported || 0;
      }
      const parts = [`${conversationCount} conversation record${conversationCount === 1 ? '' : 's'}`];
      if (meetingCount) parts.push(`${meetingCount} meeting record${meetingCount === 1 ? '' : 's'}`);
      if (notesCount) parts.push(`${notesCount} note record${notesCount === 1 ? '' : 's'}`);
      setStatus(driveStatus, `✓ Merged the latest backup from ${latest.length} device${latest.length === 1 ? '' : 's'}: ${parts.join(' + ')}. Duplicate IDs were updated; this device’s settings and sign-ins were kept.`, 'ok');
    } catch (e) { setStatus(driveStatus, '✕ ' + (e.message || e), 'err'); }
  };

  if (hourSel) {
    hourSel.onchange = async () => {
      await setAutoBackupHour(hourSel.value);
      showState(await getBackupState());
    };
  }

  if (deviceName) {
    deviceName.onchange = async () => {
      const saved = await setBackupDeviceName(deviceName.value);
      deviceName.value = saved.deviceName;
      toast(`Drive backup device name saved as “${saved.deviceName}”.`);
    };
  }

  // Saving a password never starts an unexpected download. The schedule is the
  // only automatic path; "Back up now" remains explicit.
  if (pw) {
    pw.onchange = async () => {
      await syncPass();
      showState(await getBackupState());
      toast('Backup password saved. Use “Back up now” to apply it immediately, or wait for the scheduled time.');
    };
  }

  toggle.onchange = async () => {
    // Pro-gate: same entitlement as the rest of backup/restore.
    if (!can(license, 'autoBackup')) {
      toggle.checked = false;
      return setStatus(status, '✨ Automatic backup is a Pro feature — upgrade above.', 'err');
    }
    const enabled = toggle.checked;
    setStatus(status, enabled ? 'Enabling the daily schedule…' : 'Turning off…');
    await syncPass();
    await saveDriveConfig();
    if (enabled && backupDestinationIncludes(destination?.value, 'drive') && !(await getGoogleDriveConnection()).connected) {
      toggle.checked = false;
      return setStatus(status, '✕ Connect Google Drive before enabling this destination.', 'err');
    }
    const res = await setAutoBackupEnabled(enabled);
    if (enabled && res && res.ok === false) {
      toggle.checked = false;
      if (res.reason === 'passphrase-required') setStatus(status, '✕ Set a backup password before enabling automatic backup.', 'err');
      return;
    }
    showState(await getBackupState());
  };

  $('autobackup-now').onclick = async () => {
    if (!can(license, 'autoBackup')) {
      return setStatus(status, '✨ Automatic backup is a Pro feature — upgrade above.', 'err');
    }
    setStatus(status, 'Backing up…');
    await syncPass();
    if (!pw?.value) return setStatus(status, '✕ Enter a backup encryption password first.', 'err');
    await saveDriveConfig();
    // At the call site (see js/backup-payload.js): the settings page must not carry the
    // backup's late stores on first paint just because it can take a backup.
    const { backupExtras } = await import('./js/backup-payload.js');
    const res = await runAutoBackup({ force: true, extras: backupExtras });
    if (res.ok) {
      const parts = [`${res.count} conversation${res.count === 1 ? '' : 's'}`];
      if (res.meetingsCount) parts.push(`${res.meetingsCount} meeting${res.meetingsCount === 1 ? '' : 's'}`);
      setStatus(status, `✓ Backed up ${parts.join(' + ')} to ${destinationText(res.destination)}.`, 'ok');
    } else if (res.reason === 'empty') {
      setStatus(status, 'No data to back up yet.', '');
    } else {
      setStatus(status, '✕ ' + (res.error || 'Backup failed.'), 'err');
    }
  };
}

function setStatus(el, text, cls = '') {
  if (!el) return; // defensive — never throw from a status update
  el.textContent = text;
  // Toggle only the state class; preserve the element's identifying class
  // (.s-status / .ep-status / .ba-status / .ba-avail) so it can be re-queried.
  el.classList.add('status');
  el.classList.remove('ok', 'err');
  if (cls) el.classList.add(cls);
}

// --------------------------------------------------------------------------
// Channels — message your own agent from your phone.
//
// This screen is a REMOTE CONTROL for the bridge, which is where the adapter actually lives
// (the loop has to run while the browser is closed, and an MV3 service worker is suspended
// within seconds). Everything here is one call to js/channels.js, loaded on demand: someone who
// never opens this tab never pays for it.
//
// The bot token is typed here and immediately forgotten here. It goes to the bridge, which
// verifies it with Telegram and writes it 0600 — it is never put in extension storage and never
// comes back from /channels, so this page cannot leak what it does not keep.
// --------------------------------------------------------------------------
let channelsApi = null;
const channelsMod = () => (channelsApi ||= import('./js/channels.js'));
// URL + optional token together: the channels client takes one connection, so a token typed
// into the Bridge card reaches every channels request without six call sites remembering it.
const bridgeConn = () => ({ url: settings.bridgeUrl, token: settings.bridgeToken || '' });
// The paired list as of the last render — the baseline watchPairing() diffs against.
let chLastPaired = [];
let channelsBusy = false;

function chError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// The card that DETECTS a too-old bridge is where the fix belongs. Naming a version and
// pointing at another tab is how "update it" becomes a support thread — especially for the
// non-technical user this whole screen is aimed at. So: a button when the bridge can update
// itself, the exact command when it cannot, and the install lines when there is nothing
// running to update at all.
async function renderChannelsFix(st) {
  const box = $('ch-fix');
  if (!box) return;
  box.innerHTML = '';
  box.classList.remove('hidden');

  const { bridgeInstallCommands, updateBridgeAndWait } = await import('./js/bridge-update.js');
  // The Channels tab can be opened before the Agents tab has ever rendered, so `bridgeState`
  // may be empty even though a bridge is running. Ask once rather than telling someone with a
  // healthy bridge to go install one.
  if (st.code !== 'no-bridge' && !bridgeState?.ok) bridgeState = await checkBridge(settings.bridgeUrl);
  const reachable = st.code !== 'no-bridge' && bridgeState?.ok;
  const up = reachable ? bridgeState.update : null;

  const say = (text, cls = 'status') => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    box.appendChild(el);
    return el;
  };
  const commands = (list) => {
    const pre = document.createElement('pre');
    pre.appendChild(document.createTextNode(
      list.map(({ label, cmd }) => `# ${label}\n${cmd}`).join('\n\n'),
    ));
    box.appendChild(pre);
  };

  // A standalone binary can replace itself. Offer that first — it is one click and no terminal.
  // Deliberately NOT gated on `up.updateAvailable`: that flag comes from a 6-hour cached check
  // that can be stale (or was answered by a rate-limited GitHub), while the update itself
  // re-checks with `force`. A button that does nothing is better than a fix we hid.
  if (reachable && up?.canSelfUpdate) {
    const line = say(up.updateAvailable && up.latest
      ? `v${up.latest} is ready to install. `
      : 'This bridge can update itself. ');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Update bridge now';
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await updateBridgeAndWait(settings.bridgeUrl, {
        onStatus: (phase) => { btn.textContent = phase === 'restarting' ? 'Restarting…' : 'Downloading…'; },
      });
      if (!r.ok) {
        btn.disabled = false;
        btn.textContent = 'Update bridge now';
        say(`✕ Update failed: ${r.error || 'unknown'}. Install it by hand instead:`, 'status err');
        commands(bridgeInstallCommands());
        return;
      }
      bridgeState = await checkBridge(settings.bridgeUrl);
      renderBridgeUpdate();
      renderBridgeAgents();
      renderChannels().catch(() => {}); // re-reads status; the card clears itself on success
    };
    line.appendChild(btn);
    return;
  }

  // An npm install updates through npm — the bridge cannot swap a file it does not own.
  if (reachable && up?.npmCommand) {
    say('This bridge was installed with npm, so update it there:');
    commands(bridgeInstallCommands({ npmCommand: up.npmCommand }));
    return;
  }

  // Either nothing is running, or it is too old to report how it was installed. Both end in
  // the same place: run one of these, then press Re-check.
  say(reachable
    ? 'Update the bridge with the same command you installed it with:'
    : 'Start or install the bridge, then re-check:');
  commands(bridgeInstallCommands());
  const again = document.createElement('button');
  again.className = 'btn';
  again.textContent = 'Re-check';
  again.onclick = async () => {
    again.disabled = true;
    again.textContent = 'Checking…';
    bridgeState = await checkBridge(settings.bridgeUrl);
    await renderChannels();
  };
  box.appendChild(again);
}

async function renderChannels() {
  const badge = $('ch-badge');
  if (!badge) return;
  const { channelStatus } = await channelsMod();
  let st;
  try {
    st = await channelStatus(bridgeConn());
  } catch (e) {
    st = { supported: false, reason: e.message };
  }

  const setup = $('ch-setup');
  const live = $('ch-live');
  const unsupported = $('ch-unsupported');

  // Nothing on this screen is fixable by typing when the bridge is absent or too old. Say the
  // one sentence that IS the fix, and hide the controls rather than letting them fail on click.
  if (!st.supported) {
    badge.textContent = 'unavailable';
    badge.className = 'pv-badge warn';
    unsupported.textContent = st.reason;
    unsupported.classList.remove('hidden');
    stopPairWatch(); // nothing to wait for while the bridge cannot answer
    renderChannelsFix(st).catch(() => {});
    setup.classList.add('hidden');
    live.classList.add('hidden');
    return;
  }
  unsupported.classList.add('hidden');
  $('ch-fix')?.classList.add('hidden');

  if (!st.configured) {
    badge.textContent = 'not connected';
    badge.className = 'pv-badge';
    setup.classList.remove('hidden');
    live.classList.add('hidden');
    return;
  }

  badge.textContent = st.running ? 'connected' : 'stopped';
  badge.className = `pv-badge ${st.running ? 'on' : 'warn'}`;
  setup.classList.add('hidden');
  live.classList.remove('hidden');

  $('ch-bot-name').textContent = st.bot?.username ? `@${st.bot.username}` : 'your bot';
  const run = $('ch-run');
  run.textContent = st.running ? 'polling' : (st.error || 'stopped');
  run.className = `pv-badge ${st.running ? 'on' : 'warn'}`;

  // Which agent answers. Only agents this bridge actually has — offering one that is not
  // installed is a setting that silently fails on the phone, where nobody can see why.
  // Two sources, one picker: the agents this bridge runs, and — if a gateway is configured —
  // every destination it routes to, which is where the user's API providers actually live.
  // Grouped rather than merged, because "a CLI on this machine" and "an API key in the
  // gateway" fail in different ways and the user should be able to tell which they picked.
  const agentSel = $('ch-agent');
  // The Channels tab can render before the Agents tab has ever checked the bridge, and an
  // empty agent list silently drops the whole "Agents" group — the models then reappear at the
  // bottom labelled (chatpanel-bridge), which is the same list with the structure removed.
  if (!bridgeState?.ok) bridgeState = await checkBridge(settings.bridgeUrl);
  const { channelTargets } = await channelsMod();
  // The configured destinations are what the user actually set up, so they decide which model
  // represents each provider. Best-effort: without the admin token channelTargets falls back
  // to what /v1/models reported, and the picker still works.
  let gwDests = [];
  const gwUrlForChannels = normalizeGatewayUrl(settings.gatewayUrl || '');
  if (gwUrlForChannels) {
    try {
      await handshakeGatewayToken(gwUrlForChannels);
      gwDests = (await getGatewayConfig(gwUrlForChannels))?.destinations || [];
    } catch { /* no gateway, or no admin access — the fallback covers it */ }
  }
  const { agents, providers, models, gateway: gatewayReachable } = await channelTargets({
    bridgeAgents: bridgeState?.agents || [],
    gatewayUrl: settings.gatewayUrl || '',
    destinations: gwDests,
  });
  agentSel.innerHTML = '';
  // A native <select> honours almost no CSS on an optgroup, and the default label is a faint
  // grey line that reads as another entry. Rules drawn INTO the label survive everywhere and
  // make the boundaries unmistakable, which is the whole job here: 600+ options with invisible
  // seams is one list, not four groups.
  const RULE = '──────────';
  const group = (label, items) => {
    if (!items.length) return;
    const g = document.createElement('optgroup');
    g.label = `${RULE}  ${label}  ${RULE}`;
    for (const it of items) g.append(new Option(it.label, `${it.kind}:${it.id}`));
    agentSel.append(g);
  };
  // Order is the whole point here: the things a person actually picks — an agent on this
  // machine, or a provider they configured — sit at the top, and the provider's full catalogue
  // (624 models on this machine) goes underneath where it is available but not in the way.
  group('Agents — on this machine', agents);
  group('Your providers — via the gateway', providers);
  // Only when a gateway is actually there to publish to. Offering this without one would be a
  // dead option, and telling someone to install a second component to answer a text is exactly
  // the onboarding we said we would not have.
  const toPublish = gatewayReachable ? publishableEndpoints(gwDests.map((d) => d && d.id)) : [];
  group('Your APIs — one tap to enable', toPublish);
  group(`All models (${models.length})`, models);

  // Name what was left out. A user who configured a signed-in endpoint and cannot find it in
  // this list has no way to tell whether it is unsupported, broken, or their mistake.
  const signedIn = (settings.endpoints || [])
    .filter((e) => e && !e.builtin && e.enabled !== false && isOAuthEndpoint(e))
    .map((e) => e.name || e.model)
    .filter(Boolean);
  const note = $('ch-oauth-note');
  if (note) {
    note.classList.toggle('hidden', !signedIn.length);
    note.textContent = signedIn.length
      ? `${signedIn.join(', ')} ${signedIn.length === 1 ? 'signs' : 'sign'} in with your account rather `
        + 'than an API key, so it cannot answer your phone yet: the session is short-lived and only '
        + 'your browser can renew it. Use an API-key endpoint or an agent for now.'
      : '';
  }
  const current = st.settings.model ? `model:${st.settings.model}` : `agent:${st.settings.agent}`;
  // A target that is configured but not currently offered (the gateway is down, an agent was
  // uninstalled) must still show as the selection — silently switching what answers is worse
  // than showing something unavailable.
  if (current && ![...agentSel.options].some((o) => o.value === current)) {
    agentSel.append(new Option(`${st.settings.model || st.settings.agent} (unavailable)`, current));
  }
  agentSel.value = current;
  $('ch-privacy').value = st.settings.privacy;

  chLastPaired = st.paired || [];
  renderPairedPhones(chLastPaired).catch(() => {});
}

async function renderPairedPhones(paired) {
  const root = $('ch-paired');
  root.textContent = '';
  // Reused, not re-written: notes-util is dependency-free and already owns "how long ago".
  // Imported at the call site so a settings page that never opens Channels doesn't carry it.
  const { relTime } = await import('./js/notes-util.js');
  if (!paired.length) {
    const empty = document.createElement('p');
    empty.className = 'muted tiny';
    empty.textContent = 'No phone is paired yet. Until one is, the bot refuses every message it receives.';
    root.append(empty);
    return;
  }
  for (const p of paired) {
    const row = document.createElement('div');
    row.className = 'ch-row';
    const who = document.createElement('span');
    who.className = 'ch-who';
    // Lead with the name the platform gave, because that is what a person recognises and this
    // list exists to be recognised — deciding whether to revoke one is the only thing you do
    // here. The id stays alongside: it is what authorization is actually keyed on, and two
    // phones can carry the same first name. Both are escaped; the label is remote text.
    const when = p.at ? ` · paired ${relTime(p.at)}` : '';
    who.innerHTML = p.label
      ? `${icon('who')} <b>${escapeHtml(p.label)}</b> <code>${escapeHtml(p.actorId)}</code><span class="muted tiny">${escapeHtml(when)}</span>`
      : `${icon('who')} <code>${escapeHtml(p.actorId)}</code><span class="muted tiny">${escapeHtml(when)}</span>`;
    const reach = document.createElement('span');
    reach.className = 'muted tiny';
    // Say what the tier MEANS. "trusted" is a word; "can read, cannot write or browse" is a
    // permission the person can actually consent to.
    reach.textContent = p.reach === 'any'
      ? 'full access — reads, writes and shell'
      : p.reach === 'device' ? 'conversation only — no files'
        : 'can read your files · cannot write, run commands or browse';
    const off = document.createElement('button');
    off.className = 'btn sm';
    off.textContent = 'Unpair';
    off.onclick = async () => {
      const { confirmDelete } = await import('./js/confirm-modal.js');
      if (!(await confirmDelete({
        title: 'Unpair this phone?',
        body: 'It stops being able to drive anything on its very next message. You can pair it again with a new code.',
      }))) return;
      const { unpairPhone } = await channelsMod();
      try { await unpairPhone(bridgeConn(), p.actorId); toast('Unpaired'); } catch (e) { toast(e.message, 4000); }
      renderChannels();
    };
    row.append(who, reach, off);
    root.append(row);
  }
}

// A pairing code is a live thing and this screen knows neither of the two events that end it:
// the phone talks to the BRIDGE, not to this page. So the page sat there showing a QR that had
// already been used, under a promise of "10 minutes" that never counted down, while the list
// below went on saying no phone was paired until someone happened to reload.
//
// One watcher fixes all three: tick the clock every second, ask the bridge who is paired every
// few seconds, and stop on whichever comes first. Polling rather than a push because the bridge
// has no channel to this page — and it only runs while a live code is on screen, so it is
// bounded by the code's own ten minutes rather than being a background poll.
let pairWatch = null;

function stopPairWatch() {
  if (pairWatch) clearInterval(pairWatch.timer);
  pairWatch = null;
}

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function watchPairing(expiresAt) {
  stopPairWatch();
  const known = new Set((chLastPaired || []).map((p) => p.actorId));
  const deadline = Number(expiresAt) || (Date.now() + 10 * 60_000);
  const countdown = $('ch-pair-countdown');
  let ticks = 0;
  let checking = false;

  const expire = () => {
    stopPairWatch();
    // Hide the code rather than leaving a dead QR on screen looking like the thing to scan.
    $('ch-pair-live')?.classList.add('hidden');
    $('ch-pair-expired')?.classList.remove('hidden');
  };

  const timer = setInterval(async () => {
    const left = deadline - Date.now();
    if (countdown) countdown.textContent = `expires in ${mmss(left)}`;
    if (left <= 0) return expire();

    // Every third tick: has the phone redeemed it? A burned code is as dead as an expired one.
    ticks += 1;
    if (ticks % 3 || checking) return;
    checking = true;
    try {
      const { channelStatus } = await channelsMod();
      const st = await channelStatus(bridgeConn());
      const fresh = (st.paired || []).find((p) => !known.has(p.actorId));
      if (fresh) {
        stopPairWatch();
        $('ch-pair-out').classList.add('hidden');
        toast(`Paired ${fresh.label || fresh.actorId}`);
        await renderChannels();
      }
    } catch { /* the bridge blinked; the next tick tries again */ } finally {
      checking = false;
    }
  }, 1000);

  pairWatch = { timer, deadline };
  if (countdown) countdown.textContent = `expires in ${mmss(deadline - Date.now())}`;
}

// The endpoints the user has configured here that the gateway cannot route yet.
//
// SECURITY, STATED PLAINLY. A phone-driven turn happens with the browser closed, so whatever
// answers it must hold the credential outside the browser — there is no arrangement where an
// API key stays only in extension storage AND a text message gets an answer from it. That is a
// constraint, not a preference. Given it, the gateway is the right holder: it already writes
// its config 0600, guards SSRF, redacts, and meters spend.
//
// What we do NOT do is move keys on the user's behalf. Publishing happens one endpoint at a
// time, at the moment they choose it, with the consequence on screen — least privilege, and
// consent where it is actually meaningful. Bulk-migrating every key the moment a gateway
// appears would be the easy version and exactly the thing that costs a privacy product trust.
// Endpoints that sign in rather than carry a key. Detected the same way the request path
// detects them, so the picker and the actual call agree about what an endpoint is.
function isOAuthEndpoint(ep) {
  return !!(ep?.authMode && ep.authMode !== 'key' && ep.authMode !== 'none');
}

function publishableEndpoints(publishedIds) {
  // Matched on the DESTINATION id, not on model ids. Matching on models hid any endpoint whose
  // model some OTHER provider also offers — with 621 models aggregated from three providers
  // that is most of them, so a configured Groq or Together endpoint simply never appeared and
  // looked unsupported. A destination exists or it does not; what other providers happen to
  // serve says nothing about whether YOURS is published.
  const known = new Set(publishedIds);
  return (settings.endpoints || [])
    .filter((e) => e && !e.builtin && e.baseUrl && e.enabled !== false && (e.model || e.name))
    .filter((e) => !known.has(e.name || e.model))
    // A signed-in endpoint cannot be published, and offering it would be worse than hiding it.
    // Its credential is not a key we could copy — it is a short-lived access token that the
    // BROWSER refreshes with a refresh token when it expires. Publishing a snapshot of it gives
    // a phone that works for an hour and then returns 401 with nothing to explain it: a
    // time-delayed failure is harder to diagnose than an absent feature. See the note below the
    // picker, which names them rather than leaving the user to wonder where they went.
    .filter((e) => !isOAuthEndpoint(e))
    .map((e) => ({ kind: 'publish', id: e.model || e.name, label: `${e.name || e.model}`, endpoint: e }));
}

/** Publish ONE endpoint as a gateway destination, merging rather than replacing. */
async function publishEndpointToGateway(endpoint) {
  const url = normalizeGatewayUrl(settings.gatewayUrl || 'http://127.0.0.1:4320');
  await handshakeGatewayToken(url);
  // Read-modify-write: posting a destinations array built from a half-loaded editor would
  // silently drop the ones the user already had.
  const cfg = await getGatewayConfig(url);
  const existing = Array.isArray(cfg?.destinations) ? cfg.destinations : [];
  const dest = {
    id: endpoint.name || endpoint.model,
    type: 'api',
    baseUrl: endpoint.baseUrl,
    protocol: endpoint.kind === 'anthropic' ? 'anthropic' : 'openai',
    models: [endpoint.model].filter(Boolean),
    ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
  };
  const merged = [...existing.filter((d) => d?.id !== dest.id), dest];
  await setGatewayConfig(url, { destinations: merged });
  return dest.models[0] || dest.id;
}

// The QR for a pairing link. Drawn locally (js/qr.js) — a code that enrolls a phone against
// this machine must not be handed to a third-party chart service to render, and the CSP would
// refuse the script anyway. Imported at the call site: nobody pays for an encoder until they
// press Pair.
async function renderPairQr(link) {
  const box = $('ch-pair-qr');
  if (!box) return;
  box.textContent = '';
  try {
    const { qrSvg } = await import('./js/qr.js');
    // EC M with a 4-module quiet zone: enough redundancy for a phone camera at an angle,
    // without pushing a link this short to a denser version than it needs.
    box.innerHTML = qrSvg(link, { level: 'M', quiet: 4, size: 168, label: 'Scan to pair this phone' });
  } catch (e) {
    // Never let a drawing failure hide the link — that is the part that actually pairs.
    const note = document.createElement('span');
    note.className = 'ch-qr-fail';
    note.textContent = `Could not draw the QR (${e.message}). Use the link below.`;
    box.appendChild(note);
  }
}

function wireChannels() {
  const connect = $('ch-connect');
  if (!connect) return; // older markup — nothing to wire

  connect.onclick = async () => {
    const input = $('ch-token');
    const token = (input.value || '').trim();
    if (!token) return chError('ch-error', 'Paste the token @BotFather gave you.');
    if (channelsBusy) return;
    channelsBusy = true;
    connect.disabled = true;
    connect.textContent = 'Checking with Telegram…';
    chError('ch-error', '');
    try {
      const { connectChannel } = await channelsMod();
      await connectChannel(bridgeConn(), { token });
      // Typed once, kept nowhere: the field is cleared the moment the bridge has it.
      input.value = '';
      toast('Connected');
      await renderChannels();
      $('ch-pair')?.click(); // the next thing they need is a code — don't make them find it
    } catch (e) {
      chError('ch-error', e.message);
    } finally {
      channelsBusy = false;
      connect.disabled = false;
      connect.textContent = 'Connect';
    }
  };

  $('ch-pair').onclick = async () => {
    chError('ch-error-live', '');
    try {
      const { pairPhone } = await channelsMod();
      const { code, link, expiresAt } = await pairPhone(bridgeConn());
      $('ch-pair-link').textContent = link;
      $('ch-pair-code').textContent = `/pair ${code}`;
      await renderPairQr(link);
      $('ch-pair-live').classList.remove('hidden');
      $('ch-pair-expired').classList.add('hidden');
      $('ch-pair-out').classList.remove('hidden');
      watchPairing(expiresAt);
    } catch (e) {
      chError('ch-error-live', e.message);
    }
  };

  $('ch-pair-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('ch-pair-link').textContent || '');
      toast('Link copied — open it on your phone');
    } catch { toast('Copy failed — select the link and copy it'); }
  };

  const push = async (patch) => {
    try {
      const { updateChannel } = await channelsMod();
      await updateChannel(bridgeConn(), patch);
      toast('Saved');
      renderChannels();
    } catch (e) { chError('ch-error-live', e.message); }
  };
  $('ch-agent').onchange = async () => {
    const sel = $('ch-agent');
    const [kind, ...rest] = String(sel.value).split(':');
    const id = rest.join(':');
    if (kind === 'publish') {
      const ep = (settings.endpoints || []).find((e) => (e.model || e.name) === id);
      const { confirmDelete } = await import('./js/confirm-modal.js');
      const ok = ep && await confirmDelete({
        title: `Let your phone use ${ep.name || ep.model}?`,
        // Say what actually happens. A phone answers with the browser closed, so the key has
        // to live somewhere that is awake — this names where, and who can read it.
        body: `This copies the API key for ${ep.name || ep.model} into the gateway's config on `
          + 'this machine, readable only by your user account, so it can answer while your '
          + 'browser is closed. Nothing is uploaded. Remove it any time from the Gateway tab.',
        confirmLabel: 'Publish to gateway',
        // A key icon, not the default trash: this dialog is about moving a credential, and a
        // bin glyph above "Publish" reads as the opposite of what the button does.
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/>'
          + '<path d="M10.7 12.3 21 2"/><path d="m18 5 3 3"/><path d="m15 8 3 3"/></svg>',
      });
      if (!ok) { await renderChannels(); return; }
      try {
        const model = await publishEndpointToGateway(ep);
        await push({ model });
        toast(`${ep.name || ep.model} can now answer your phone`);
      } catch (e) {
        toast(`Could not publish: ${e.message}`, 5000);
      }
      await renderChannels();
      return;
    }
    // One choice: the service clears whichever field was not sent, so a stale target cannot
    // win over the one just picked.
    push(kind === 'model' ? { model: id } : { agent: id });
  };
  $('ch-privacy').onchange = () => push({ privacy: $('ch-privacy').value });

  $('ch-disconnect').onclick = async () => {
    const { confirmDelete } = await import('./js/confirm-modal.js');
    if (!(await confirmDelete({
      title: 'Disconnect Telegram?',
      body: 'This stops polling, deletes the bot token stored on this machine, and unpairs every phone. Your bot itself still exists — reconnect any time by pasting its token again.',
    }))) return;
    try {
      const { disconnectChannel } = await channelsMod();
      stopPairWatch(); // the code it was waiting on dies with the connection
      await disconnectChannel(bridgeConn(), { forget: true });
      toast('Disconnected');
      $('ch-pair-out').classList.add('hidden');
      renderChannels();
    } catch (e) { chError('ch-error-live', e.message); }
  };
}

function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// Consistent paywall nudge: a toast with a real "Upgrade to Pro" → checkout.
function upsell(text) {
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.innerHTML = icon('upgrade') + ' ' + escapeHtml(text) + '  ';
  const a = document.createElement('button');
  a.className = 'toast-action';
  a.textContent = 'Upgrade to Pro';
  a.onclick = () => subscribePro();
  t.append(span, a);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 6000);
}

init();


// A site the user blocked is SHOWN, not hidden: a denial should be inspectable and
// reversible, never a mystery about why nothing happens on some page.
function renderPageSites() {
  const box = $('pref-pageact-sites');
  if (!box) return;
  const rows = listSites(settings.ui?.pageSites);
  box.textContent = '';
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'muted tiny';
    empty.textContent = 'No site answers recorded yet.';
    box.append(empty);
    return;
  }
  for (const { siteKey, state } of rows) {
    const row = document.createElement('div');
    row.className = `site-row site-${state}`;

    const key = document.createElement('span');
    key.className = 'site-key';
    key.textContent = siteKey;

    const tag = document.createElement('span');
    tag.className = 'site-state';
    tag.textContent = state === 'granted' ? 'allowed' : 'blocked';

    const toggle = document.createElement('button');
    toggle.className = 'btn-tiny';
    toggle.textContent = state === 'granted' ? 'Block' : 'Unblock';
    toggle.onclick = async () => {
      settings.ui.pageSites = state === 'granted'
        ? denySite(settings.ui?.pageSites, siteKey)
        : forgetSite(settings.ui?.pageSites, siteKey);
      await saveSettings(settings);
      renderPageSites();
    };

    const forget = document.createElement('button');
    forget.className = 'btn-tiny';
    forget.textContent = 'Forget';
    forget.onclick = async () => {
      settings.ui.pageSites = forgetSite(settings.ui?.pageSites, siteKey);
      await saveSettings(settings);
      renderPageSites();
    };

    row.append(key, tag, toggle, forget);
    box.append(row);
  }
}


// --------------------------------------------------------------------------
// Activity — the local event log, read back as runs.
//
// Loaded on demand: the log module and the analysis both stay off settings' own boot
// path, and a user who never opens this tab never pays for it.
// --------------------------------------------------------------------------
const fmtBytes = (n) => (n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`);

const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

/**
 * What ChatPanel loads, and what the user may switch off.
 *
 * Four registries — adapters, tool groups, search engines, sources — each answer "what
 * matches" on their own. None of them can answer "what is installed, and can I turn that
 * off?", and answering it in four places would repeat the duplication that already produced
 * a retired search engine lingering in this very page.
 *
 * Registries decide what MATCHES; the manifest decides what may RUN. Keeping those separate
 * is what lets a user disable one adapter without any registry needing to know a user
 * exists.
 */
async function renderPlugins() {
  const box = $('plugins-list');
  if (!box) return;
  box.textContent = 'Loading…';
  let manifest;
  try {
    // Importing the registries is what makes them DECLARE themselves — the list is built
    // from what actually loaded, never from a second copy of it maintained here. A second
    // copy is precisely the bug this page is meant to end.
    const [{ pluginManifest }, adapters, groups, meetings, analyzers, router] = await Promise.all([
      import('./js/plugins.js'),
      import('./js/adapters/index.js'),
      import('./js/tool-groups/index.js'),
      import('./js/meeting-platforms.js'),
      import('./js/meeting-analyzers-builtin.js'),
      import('./js/model-router.js'),
    ]);
    // Importing a registry is what makes it declare itself, so the list is built from what
    // actually loaded rather than from a second copy maintained here.
    await Promise.all([
      adapters.adapterRegistry(),
      groups.toolGroupRegistry(),
      meetings.declareMeetingPlatforms(),
      analyzers.analyzerRegistry(),
      router.declareRouterPlugins(),
    ]);
    manifest = await pluginManifest();
  } catch (e) {
    box.textContent = `Could not load plugins: ${e?.message || e}`;
    return;
  }

  // Everything ChatPanel loads, including the categories that keep their own state.
  const rows = [...manifest.list(), ...externalPlugins()];
  rows.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)));
  if (!rows.length) { box.innerHTML = '<p class="muted tiny">Nothing registered yet.</p>'; return; }

  box.textContent = '';
  let lastKind = null;
  for (const p of rows) {
    if (p.kind !== lastKind) {
      lastKind = p.kind;
      const h = document.createElement('div');
      h.className = 'plugins-kind';
      h.textContent = KIND_TITLE[p.kind] || p.kind;
      box.append(h);
    }
    // A row whose state is owned somewhere else is a LINK, not a checkbox.
    //
    // Search engines and MCP servers already store their own enabled flag alongside a URL,
    // a key, a command. Adding a second switch here would be two places holding one truth —
    // exactly the duplication that left a retired engine lingering in this page. And a
    // checkbox cannot express a form: an MCP server needs a command, an engine needs a URL
    // template. So this page owns the INVENTORY and sends configuration where it lives.
    if (p.configTab) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'plugin-row plugin-link';
      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = p.label;
      const desc = document.createElement('i');
      desc.textContent = p.description || '';
      text.append(name, desc);
      const go = document.createElement('span');
      go.className = 'plugin-go';
      go.textContent = p.state ? `${p.state} · Configure →` : 'Configure →';
      link.append(text, go);
      link.addEventListener('click', () => {
        document.querySelector(`.tab[data-tab="${p.configTab}"]`)?.click();
        // Land ON the control, not merely on the panel that contains it. A tab with six
        // sections is not an answer to "where do I configure this", and a brief highlight
        // is what tells the eye which of them it was.
        const target = p.configAnchor && $(p.configAnchor);
        if (!target) return;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('config-flash');
        setTimeout(() => target.classList.remove('config-flash'), 1400);
      });
      box.append(link);
      continue;
    }

    const row = document.createElement('label');
    row.className = `plugin-row${p.required ? ' required' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    // Required plugins are shown, disabled, rather than hidden: "you cannot turn this off"
    // is information, and omitting them would make the list look incomplete.
    cb.disabled = p.required;
    cb.addEventListener('change', () => {
      try {
        manifest.setEnabled(p.id, cb.checked);
      } catch (err) {
        cb.checked = true;
        toast(err?.message || 'This plugin is required.');
      }
    });
    const text = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = p.label;
    const desc = document.createElement('i');
    desc.textContent = p.required ? 'Required — always on.' : (p.description || '');
    text.append(name, desc);
    row.append(cb, text);
    box.append(row);
  }
}

const KIND_TITLE = {
  kernel: 'Kernel', 'tool-group': 'Tool groups', adapter: 'App adapters',
  source: 'Sources', 'meeting-analysis': 'Meeting analysis', meeting: 'Meeting platforms',
  'route-strategy': 'Routing strategies', 'route-step': 'Routing steps',
  engine: 'Search engines', server: 'MCP servers', agent: 'Agents', skill: 'Skills',
};
// Ordered by how central each is to a turn, not alphabetically — the kernel first because
// it is the part that cannot be switched off, then what the model is given, then where the
// data comes from.
const KIND_ORDER = {
  kernel: 0, 'route-strategy': 1, 'route-step': 2, 'tool-group': 3, adapter: 4, source: 5,
  'meeting-analysis': 6, meeting: 7, engine: 8, server: 9, agent: 10, skill: 11,
};

/**
 * The categories that keep their own enabled state.
 *
 * Listed here so the page is a complete inventory, and rendered as links so there is still
 * exactly ONE switch per thing. Duplicating the toggle would recreate the two-lists bug
 * this page exists to end.
 */
function externalPlugins() {
  const out = [];
  // NO STATE SHOWN HERE, deliberately.
  //
  // These cannot be switched on or off from this page — their toggle sits beside the URL,
  // key or command it belongs with — so repeating their state here creates a second copy
  // of a truth that can disagree with the first, which it promptly did: a switch flipped in
  // Tools still read as off here, because that edit is unsaved until Tools is saved.
  //
  // The capability-level switch is a Source (see Sources above): "use web search at all"
  // belongs on this page, "which engines, in what order" belongs with the engines.
  const ws = settings?.ui?.webSearch || {};
  let engines = [];
  try { engines = migrateEngines(ws.engines, { hasKey: !!ws.reader?.key }); } catch { engines = []; }
  for (const e of engines) {
    if (e.retired) continue;
    out.push({
      id: `engine:${e.id}`, kind: 'engine', label: e.name || e.id,
      description: e.needsKey ? 'Search API — needs a key.' : 'Search engine.',

      // The engine editor lives in the MCP/Tools panel, not the API one. Pointing at the
      // wrong tab is worse than not linking: the user lands somewhere plausible, cannot
      // find the control, and concludes it is missing.
      configTab: 'mcp',
      configAnchor: 'websearch-engines',
    });
  }
  for (const srv of (settings?.mcpServers || [])) {
    out.push({
      id: `mcp:${srv.id || srv.name}`, kind: 'server', label: srv.name || srv.url || srv.command || 'MCP server',
      description: srv.command ? 'Local server, run through the bridge.' : 'Remote MCP server.',

      configTab: 'mcp',
      configAnchor: 'mcp-list',
    });
  }
  // Skills, with their DECLARED ACCESS — F3.5's honest gallery. A skill is a plugin that
  // carries guidance plus capabilities, and the reach it can have (page, history, MCP,
  // scripts) is computable from its record before it runs. That is the whole argument for
  // showing it here: a user approves a set they can see, rather than discovering it in use.
  for (const sk of (settings?.skills || [])) {
    out.push({
      id: `skill:${sk.id}`, kind: 'skill', label: sk.name || sk.command || 'Skill',
      description: skillAccessLine(sk),
      state: isSkillEnabled(sk) ? '' : 'off',
      configTab: 'skills',
      configAnchor: 'skills',
    });
  }
  return out;
}

// A one-line reach statement, derived from the record — never read from a field the record
// could set. "what can this thing touch" answered the same way for every skill.
function skillAccessLine(skill) {
  const bits = [];
  const provenance = skill.origin?.source ? 'from another tool' : (skill.builtin ? 'built-in' : 'yours');
  bits.push(provenance);
  const ctx = skill.context && skill.context !== 'none' ? 'reads the page' : '';
  if (ctx) bits.push(ctx);
  const h = skill.historyContext;
  if (h === 'chats' || h === 'all') bits.push('reads chats');
  if (h === 'meetings' || h === 'all') bits.push('reads meetings');
  if (skill.mcpMode === 'default') bits.push('all MCP tools');
  else if (skill.mcpMode === 'selected') bits.push('selected MCP tools');
  if ((skill.files?.scripts || []).length) bits.push('runs code');
  if ((skill.files?.references || []).length) bits.push('has reference files');
  const scan = skill.origin?.scanned?.verdict;
  if (scan === 'suspicious') bits.push('flagged for review');
  return bits.join(' · ');
}

/**
 * Show the routing decision for a request you describe.
 *
 * The point is not the answer but the REASONS: a router you cannot interrogate is one you
 * have to trust, and the whole argument for routing being a rule rather than a model call is
 * that it can be checked. Rejections are shown with why each candidate lost, because "it
 * used the wrong model" is unanswerable without them.
 */
/**
 * Correct what the router guessed about each model.
 *
 * The defaults come from a name matched against a regex and a URL judged local — useful, and
 * wrong often enough that someone who knows their own setup has to be able to say so. A
 * router that cannot be corrected is one people work around.
 */
async function renderRoutingModels() {
  const box = $('routing-models');
  if (!box) return;
  box.textContent = '';
  let candidates = [];
  // WHAT WE GUESSED, KEPT BESIDE WHAT THE USER SAID.
  //
  // A control rendered only from the effective value cannot offer the way back: once an
  // override is saved it becomes the thing the options are derived from, and the option that
  // would undo it is the first one to stop being offered. That is exactly how "third party"
  // became a door with no handle on the other side. Every control below therefore chooses
  // its options from the GUESS and shows the saved value as the selection.
  let guessed = new Map();
  try {
    const [{ candidatesFrom }, store] = await Promise.all([
      import('./js/model-router.js'), import('./js/store.js'),
    ]);
    const resolve = (t) => store.resolveTarget(t, settings);
    candidates = candidatesFrom(settings, resolve);
    guessed = new Map(candidatesFrom(settings, resolve, { ignoreOverrides: true }).map((c) => [c.id, c]));
  } catch (e) {
    // Say what went wrong. A silent return turned a thrown error into "the section
    // disappeared", which is the hardest kind of bug to report and the easiest to prevent.
    box.textContent = `Could not read your models: ${e?.message || e}`;
    return;
  }
  if (!candidates.length) {
    box.innerHTML = '<p class="muted tiny">No models configured yet — add one in API or Agents.</p>';
    return;
  }

  const saved = settings?.ui?.routing?.models || {};
  const { KNOWN_CAPABILITIES: CAPS, reachChoicesFor } = await import('./js/model-router.js');
  const CAP_SHORT_LABELS = {
    reasoning: 'Reason', 'long-context': 'Long', coding: 'Code', json: 'JSON',
  };
  // The effective order, so "auto" can show the position a model currently holds rather than
  // an opaque internal number. A ranking control that cannot tell you where something ranks
  // is not a ranking control.
  const order = [...candidates]
    .sort((a, b) => a.providerRank - b.providerRank || a.label.localeCompare(b.label))
    .map((c) => c.id);
  const write = (id, patch) => {
    settings.ui = settings.ui || {};
    settings.ui.routing = settings.ui.routing || {};
    settings.ui.routing.models = { ...(settings.ui.routing.models || {}), [id]: { ...(saved[id] || {}), ...patch } };
    saveSettings(settings).then(() => { renderRouting(); renderRoutingModels(); }).catch(() => {});
  };
  // Back to the guess, for the whole row at once.
  //
  // Each select carries its own "default" option, but the capability checkboxes are a set
  // with no such option: touching one pins the entire array, and there is then no way to ask
  // what we would have detected. Deleting the row's entry — rather than writing nulls over
  // it — is also what keeps a stale correction from re-applying if the endpoint's URL later
  // changes what we detect.
  const clear = (id) => {
    const models = { ...(settings?.ui?.routing?.models || {}) };
    delete models[id];
    settings.ui = settings.ui || {};
    settings.ui.routing = { ...(settings.ui.routing || {}), models };
    saveSettings(settings).then(() => { renderRouting(); renderRoutingModels(); }).catch(() => {});
  };

  for (const m of candidates) {
    const row = document.createElement('div');
    row.className = 'routing-model';
    // A disabled model is still LISTED — hiding it would silently strip the tuning saved
    // against it — but it must not read as an active candidate. The class dims the row so
    // "switched off" is visible at a glance, not just a grey word in the meta line.
    if (m.available === false) row.classList.add('is-off');

    const name = document.createElement('b');
    name.textContent = m.label;
    // Anything actually stored for this model. `null` is what a cleared control writes, so
    // it does not count — a row read as "corrected" for a correction the user took back
    // would leave a Reset button that resets nothing.
    const override = saved[m.id] || {};
    const corrected = Object.keys(override).some((k) => override[k] != null);
    const meta = document.createElement('i');
    meta.textContent = `class ${m.classUsed}${m.available === false ? ' · unavailable' : ''}${m.rateLimited ? ' · rate limited' : ''}${corrected ? ' · corrected' : ''}`;

    const quality = document.createElement('select');
    for (const [v, t] of [['', 'Quality: unrated'], ['0.9', 'Quality: high'], ['0.5', 'Quality: medium'], ['0.2', 'Quality: low']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; quality.append(o);
    }
    quality.value = saved[m.id]?.quality == null ? '' : String(saved[m.id].quality);
    quality.onchange = () => write(m.id, { quality: quality.value === '' ? null : Number(quality.value) });

    const caps = document.createElement('span');
    caps.className = 'routing-caps';
    for (const cap of CAPS) {
      const lbl = document.createElement('label');
      lbl.className = 'check tiny';
      lbl.title = `${cap.label}: ${cap.hint}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = m.capabilities.includes(cap.id);
      const wasDetected = (guessed.get(m.id)?.capabilities || []).includes(cap.id);
      if (Array.isArray(override.capabilities) && cb.checked !== wasDetected) {
        lbl.title += `\n(You set this. ChatPanel detected: ${wasDetected ? 'yes' : 'no'}.)`;
      }
      cb.onchange = () => {
        const next = new Set(m.capabilities);
        if (cb.checked) next.add(cap.id); else next.delete(cap.id);
        // Back to exactly what we detected → drop the override rather than storing a copy of
        // the guess, so a later re-detection is still free to change its mind.
        const detected = guessed.get(m.id)?.capabilities || [];
        const same = next.size === detected.length && detected.every((c) => next.has(c));
        write(m.id, { capabilities: same ? null : [...next] });
      };
      lbl.append(cb, document.createTextNode(` ${CAP_SHORT_LABELS[cap.id] || cap.label}`));
      caps.append(lbl);
    }

    const speed = document.createElement('select');
    speed.title = 'Roughly how fast it starts answering. Routing prefers faster models when you ask for speed.';
    for (const [v, t] of [['', 'Speed: default'], ['400', 'Speed: fast'], ['1200', 'Speed: medium'], ['3000', 'Speed: slow']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; speed.append(o);
    }
    speed.value = saved[m.id]?.latencyMs == null ? '' : String(saved[m.id].latencyMs);
    speed.onchange = () => write(m.id, { latencyMs: speed.value === '' ? null : Number(speed.value) });

    const price = document.createElement('select');
    price.title = 'Relative cost. Only ever compared against your other models — never a bill.';
    for (const [v, t] of [['', 'Cost: default'], ['0', 'Cost: free'], ['1', 'Cost: cheap'], ['3', 'Cost: moderate'], ['8', 'Cost: expensive']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; price.append(o);
    }
    price.value = saved[m.id]?.costPer1k == null ? '' : String(saved[m.id].costPer1k);
    price.onchange = () => write(m.id, { costPer1k: price.value === '' ? null : Number(price.value) });

    // Reach moves OUTWARD only, so the options offered are exactly the ones that would be
    // accepted — a control that silently refuses half its own values is worse than no
    // control. See applyOverride for why the other direction cannot be allowed.
    // A FULL ORDERING, 1..N. Three buckets could not express "this one third, that one
    // seventh" across ten providers — everything landed in the same bucket and the tiebreak
    // had nothing left to break with.
    //
    // Still ONLY a tiebreak. Position 1 does not win a race it lost on speed, cost or
    // capability; it wins when the candidates are otherwise equal, which is exactly the case
    // where the same model is served from several places.
    const prefer = document.createElement('select');
    prefer.title = 'Order to prefer providers when several can serve the same request equally well — 1 is tried first. Decides outright between two routes to the SAME model; between different models it breaks a near-tie, and never overrides a real difference in speed, cost or capability.';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = `Order: auto (${order.indexOf(m.id) + 1})`;
    prefer.append(blank);
    for (let n = 1; n <= candidates.length; n++) {
      const o = document.createElement('option');
      o.value = String(n);
      // Say which end wins. A bare number leaves the user guessing whether 1 or N is first.
      o.textContent = n === 1 ? 'Order: 1 (first)' : n === candidates.length ? `Order: ${n} (last)` : `Order: ${n}`;
      prefer.append(o);
    }
    prefer.value = saved[m.id]?.providerRank == null ? '' : String(saved[m.id].providerRank);
    prefer.onchange = () => write(m.id, { providerRank: prefer.value === '' ? null : Number(prefer.value) });

    const reach = document.createElement('select');
    reach.title = 'How far a request travels to reach it. You can declare it further out than ChatPanel detected, never closer in — and you can always come back to what was detected.';
    // The steps come from the router (reachChoicesFor), never from a list kept here — a
    // second copy of the rule is what made this a one-way door in the first place. It also
    // ends the shadowing hazard that once put the provider ordering computed above into the
    // temporal dead zone and rendered the whole list empty.
    const REACH_LABEL = { device: 'On this device', trusted: 'My machine/network', any: 'Third party' };
    // OFFERED FROM WHAT WE DETECTED — NOT FROM WHAT IS SAVED.
    //
    // Reach still only ever moves outward; that is the privacy rule and applyOverride is what
    // enforces it. But slicing from the CURRENT value made every step permanent: saving
    // 'Third party' left 'Third party' as the only option, so a mis-click could not be taken
    // back and the control looked broken while enforcing the rule perfectly. Slicing from the
    // DETECTED reach keeps the rule — nothing closer in than we detected is ever offered —
    // and returns the handle, because the detected step is always on the list.
    const detectedReach = guessed.get(m.id)?.reach || m.reach;
    const steps = reachChoicesFor(detectedReach);
    for (const r of steps) {
      const o = document.createElement('option'); o.value = r;
      // Say which one is ours. Without it, "the way back" is a guess about which entry was
      // the original — and the user is picking among values that all look equally chosen.
      o.textContent = r === detectedReach ? `${REACH_LABEL[r]} (detected)` : REACH_LABEL[r];
      reach.append(o);
    }
    reach.value = steps.includes(m.reach) ? m.reach : detectedReach;
    // Choosing the detected step CLEARS the override instead of storing a no-op copy of it:
    // a stored 'trusted' would silently start overriding if the endpoint's URL later made us
    // detect 'device'.
    reach.onchange = () => write(m.id, { reach: reach.value === detectedReach ? null : reach.value });

    // One way back for the whole row. The selects each have a "default" entry, but the
    // capability checkboxes do not, and a row with several corrections is tedious to undo one
    // control at a time.
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn sm routing-reset';
    reset.textContent = 'Reset';
    reset.disabled = !corrected;
    reset.title = corrected
      ? 'Forget every correction for this model and go back to what ChatPanel detects.'
      : 'Nothing corrected — this row is what ChatPanel detected.';
    reset.onclick = () => clear(m.id);

    const text = document.createElement('span');
    text.className = 'routing-model-name';
    text.append(name, meta);
    row.append(text, caps, quality, speed, price, prefer, reach, reset);
    box.append(row);
  }
}

/** The dials, read once so the preview and the saved settings cannot disagree. */
function routingNeedFromForm() {
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  return {
    reach: $('routing-reach')?.value || 'any',
    capabilities: $('routing-tools')?.checked ? ['tools'] : [],
    prefer: $('routing-prefer')?.value || 'balanced',
    maxLatencyMs: num($('routing-latency')?.value) || 0,
    maxCostPer1k: num($('routing-cost')?.value),
  };
}

async function renderRouting() {
  const out = $('routing-out');
  if (!out) return;
  out.textContent = 'Checking…';
  try {
    const [{ previewRoute }, store] = await Promise.all([
      import('./js/model-router.js'),
      import('./js/store.js'),
    ]);
    // NOT SAVED. These controls describe a hypothetical request so you can see what would be
    // chosen for it — they are a test harness, not configuration. Persisting them made a
    // value someone set while exploring silently constrain every turn afterwards.
    //
    // The one thing here that IS a setting is observation, which only decides whether the
    // router records its opinion when it is not the one answering.
    const need = routingNeedFromForm();
    settings.ui = settings.ui || {};
    settings.ui.routing = {
      ...(settings.ui.routing || {}),   // merge: the per-model facts live on this branch
      mode: $('routing-mode')?.value || 'observe',
    };
    saveSettings(settings).catch(() => {});
    const r = await previewRoute(settings, store.resolveTarget, need);
    out.textContent = '';

    const head = document.createElement('b');
    head.className = r.chosen ? 'ok' : 'err';
    head.textContent = r.chosen
      ? `Would route to: ${r.chosen}`
      : 'No model satisfies these constraints';
    out.append(head);

    const pre = document.createElement('pre');
    pre.className = 'tj-raw';
    const lines = [];
    for (const why of r.reasons || []) lines.push(`  ${why}`);
    if (r.runnersUp?.length) lines.push(`  runners-up: ${r.runnersUp.join(', ')}`);
    if (r.rejected?.length) {
      lines.push('', 'Rejected:');
      // Naming the loser AND the reason is the difference between a decision and an oracle.
      for (const x of r.rejected) lines.push(`  ${x.id} — ${x.why}`);
    }
    if (!r.chosen && !r.rejected?.length) lines.push('  no models configured — add one in API or Agents');
    pre.textContent = lines.join('\n');
    out.append(pre);
  } catch (e) {
    out.textContent = `Could not check routing: ${e?.message || e}`;
  }
}

/** Put the saved dials back on the form, so what you see is what will run. */
/**
 * Only observation is restored. The rest describe a hypothetical request and reset each time
 * the panel opens — a test harness that remembered its last input would look like
 * configuration, which is exactly the confusion this separation exists to remove.
 */
function loadRoutingForm() {
  const r = settings?.ui?.routing || {};
  if ($('routing-mode')) $('routing-mode').value = r.mode || 'observe';
}

for (const id of ['routing-refresh', 'routing-reach', 'routing-tools', 'routing-prefer', 'routing-mode', 'routing-latency', 'routing-cost']) {
  const el = $(id);
  el?.addEventListener(id === 'routing-refresh' ? 'click' : 'change', renderRouting);
}

$('plugins-refresh')?.addEventListener('click', renderPlugins);

// Surface labels for activity rows. Every entry point reports through the one
// chokepoint, so this list is what the log can actually contain.
const KIND_LABEL = {
  chat: 'Chat', note: 'Note', meeting: 'Meeting', assist: 'Assist',
  watch: 'Watch', suggestion: 'Suggestion', other: 'Other',
};

// Observability dashboard — storage per tier + which agents read your data. Everything
// here loads lazily (only when the Activity tab is opened) so it never touches first paint.
function obsAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function obsTierCard(fmt, { tier, label, present, records, bytes, newest, note, aside }) {
  const state = present ? 'on' : 'off';
  const dot = `<span class="obs-dot ${state}"></span>`;
  const metric = present && records != null
    ? `<div class="obs-metric">${records.toLocaleString()}<span>records</span></div>`
    : `<div class="obs-metric muted">—</div>`;
  const sub = [];
  if (present && bytes != null) sub.push(fmt(bytes));
  if (present && newest) sub.push(`fresh to ${obsAgo(newest)}`);
  return `<div class="obs-tier ${state}">
    <div class="obs-tier-head">${dot}<b>${tier}</b><span class="sub">${escapeHtml(label)}</span></div>
    ${metric}
    <div class="obs-tier-sub sub">${escapeHtml(sub.join(' · ') || note || '')}</div>
    ${present && sub.length && note ? `<div class="obs-tier-note tiny muted">${escapeHtml(note)}</div>` : (!present ? `<div class="obs-tier-note tiny muted">${escapeHtml(note || '')}</div>` : '')}
    ${aside ? `<div class="obs-tier-note tiny muted">${escapeHtml(aside)}</div>` : ''}
  </div>`;
}
async function renderObservability() {
  const storageEl = $('obs-storage');
  const accessEl = $('obs-access');
  if (!storageEl || !accessEl) return;

  // Lazy: pull formatting + the store indexes only now (Activity tab is open).
  const [{ formatBytes }, store, meetings, notes] = await Promise.all([
    import('./js/events/observability.js'),
    import('./js/store.js'),
    import('./js/store-meetings.js'),
    import('./js/store-notes.js'),
  ]);

  // HOT — the browser stores on this device.
  //
  // Measure chrome.storage.local, because that is where the records counted below live.
  // navigator.storage.estimate() reports the origin's quota-managed pools instead (Cache
  // Storage, IndexedDB) — the in-browser model weights and the event log — which contain
  // none of them. Reporting that as the hot size showed a 1 GB model download as a
  // gigabyte of history sitting next to a record count it had nothing to do with. It is
  // still worth showing, as its own line, so the disk it uses stays visible.
  const hotBytes = await localBytesInUse().catch(() => 0);
  let est = {}; try { est = (await navigator.storage?.estimate?.()) || {}; } catch { /* not exposed */ }
  const [convs, mtgs, nts] = await Promise.all([
    store.getIndex?.().catch(() => []) || [],
    meetings.getMeetingIndex?.().catch(() => []) || [],
    notes.getNoteIndex?.().catch(() => []) || [],
  ]);
  // Hot freshness from the same fields warm sync stamps as each record's date, so hot-newest
  // and warm-newest are comparable: a gap between them IS the sync lag (not "no new activity").
  const maxOf = (arr, pick) => arr.reduce((m, e) => Math.max(m, pick(e) || 0), 0);
  const hotNewest = Math.max(
    maxOf(convs, (e) => e.updatedAt),
    maxOf(mtgs, (e) => e.endedAt || e.startedAt || e.persistedAt),
    maxOf(nts, (e) => e.updatedAt || e.createdAt),
  ) || null;
  const hot = {
    tier: 'Hot', label: 'Browser · this device', present: true,
    records: (convs?.length || 0) + (mtgs?.length || 0) + (nts?.length || 0),
    bytes: hotBytes || null, newest: hotNewest,
    note: `${convs?.length || 0} chats · ${mtgs?.length || 0} meetings · ${nts?.length || 0} notes`,
    aside: est.usage
      ? `Plus ${formatBytes(est.usage)} of browser cache — in-browser model weights and the event log. Not history, and not part of a backup.`
      : '',
  };

  // WARM — the local gateway mirror. /v1/observability is admin-gated, and Chrome omits
  // Origin on GET to a permitted host, so it rides the admin token. Make sure we have one
  // (POSTs DO carry Origin, so the handshake can fetch it) before the read.
  const gwUrl = normalizeGatewayUrl(settings.gatewayUrl || 'http://127.0.0.1:4320');
  if (settings.gatewayToken) setGatewayToken(settings.gatewayToken);
  await handshakeGatewayToken(gwUrl).catch(() => {});
  const obs = await getGatewayObservability(gwUrl).catch(() => null);

  const warm = obs
    ? { tier: 'Warm', label: 'Local gateway', present: true, records: obs.storage?.warm?.records ?? 0, bytes: obs.storage?.warm?.bytes ?? null, newest: obs.storage?.warm?.newest ?? null, note: 'Searchable by any connected CLI agent' }
    : { tier: 'Warm', label: 'Local gateway', present: false, records: null, bytes: null, newest: null, note: 'Not running — start the gateway to mirror + search from CLI agents' };
  const cold = { tier: 'Cold', label: 'Encrypted cloud', present: false, records: null, bytes: null, newest: null, note: 'Not configured · planned: zero-knowledge cloud + Teams shared store' };

  // Auto-sync is what keeps the gateway current after every chat/meeting/note. It's off by
  // default (pushing decrypted history to the gateway is opt-in), which is the usual reason
  // the mirror lags: the gateway was configured for CLI agents, but nothing keeps it fresh.
  // Surface it here with a one-click enable, so the fix isn't buried in the Gateway tab.
  const autoSync = !!settings.ui?.warmSearch?.enabled;
  const autoEl = $('obs-autosync');
  if (autoEl) {
    // A symmetric toggle — on OR off, always with the opposite action available.
    autoEl.innerHTML = autoSync
      ? `<span class="obs-auto on"><span class="obs-dot on"></span>Auto-sync on</span> <span class="sub">— re-indexes ~30s after each chat, meeting or note, and on startup. It's a second on-disk copy, readable by the CLI agents you've connected.</span> <button id="obs-toggle-auto" class="btn" type="button" data-to="off">Turn off</button>`
      : `<span class="obs-auto off"><span class="obs-dot off"></span>Auto-sync off</span> <span class="sub">— the gateway only updates when you click Sync now, so CLI agents can see stale data.</span> <button id="obs-toggle-auto" class="btn" type="button" data-to="on">Turn on auto-sync</button>`;
    $('obs-toggle-auto')?.addEventListener('click', async () => {
      const b = $('obs-toggle-auto');
      const turnOn = b?.dataset.to === 'on';
      if (b) { b.disabled = true; b.textContent = turnOn ? 'Turning on…' : 'Turning off…'; }
      settings.ui = settings.ui || {};
      settings.ui.warmSearch = { enabled: turnOn, url: gwUrl };
      try { await saveSettings(settings); } catch { /* surfaced below */ }
      // Turning ON force-syncs once so it's current immediately. Turning OFF just stops future
      // syncs; the copy already in the gateway stays until you use "Clear gateway copy".
      if (turnOn) { try { const { syncHistoryToGateway } = await import('./js/warm-sync.js'); await syncHistoryToGateway(gwUrl, { force: true }); } catch { /* ignore */ } }
      toast(turnOn
        ? 'Auto-sync on — the gateway stays current after every chat, meeting and note'
        : 'Auto-sync off — the gateway keeps what it has but will not update until you Sync now');
      renderObservability();
    });
  }

  // A meaningful gap (>5 min) between hot's newest and warm's means the mirror is behind.
  // Frame it by WHY: auto-sync off (the fix is the toggle above) vs. a transient lag while a
  // sync catches up (the fix is Sync now). Equal newness within the window isn't a lag at all.
  const LAG_MS = 5 * 60 * 1000;
  const behind = obs && hotNewest && (hotNewest - (warm.newest || 0) > LAG_MS);
  const lagHint = behind
    ? `<div class="obs-lag">The gateway copy is behind this browser (newest here: ${obsAgo(hotNewest)}, in the gateway: ${obsAgo(warm.newest)}). CLI agents search the gateway copy, so ${autoSync ? 'click <b>Sync now</b> to catch up' : 'turn on <b>auto-sync</b> above (or click <b>Sync now</b> once)'}.</div>`
    : '';
  storageEl.innerHTML = lagHint + [hot, warm, cold].map((t) => obsTierCard(formatBytes, t)).join('');

  // AGENT ACCESS — the cross-agent read log from the gateway.
  if (!obs) {
    accessEl.innerHTML = `<p class="muted tiny">The gateway isn't running, so there's no cross-agent access to show. Start it to let Codex, Claude Code and other CLIs search your history — and to see every read here. <a href="#" id="obs-gw-jump">Set up the gateway →</a></p>`;
    $('obs-gw-jump')?.addEventListener('click', (e) => { e.preventDefault(); openGatewaySection(); });
    return;
  }
  const access = obs.access || [];
  if (!access.length) {
    accessEl.innerHTML = `<p class="muted tiny">No tool calls recorded since the gateway last started. This log is <b>in-memory</b> — it resets whenever the gateway restarts (e.g. an update), and it fills only when an agent actually runs a query, not just from being connected. Run a history search in a connected agent (Codex, Claude&nbsp;Code, OpenCode) and it appears here: which agent, which tool, when. <a href="#" id="obs-gw-jump">Manage connected agents →</a></p>`;
    $('obs-gw-jump')?.addEventListener('click', (e) => { e.preventDefault(); openGatewaySection(); });
    return;
  }
  obsAccessRows = access;
  renderAgentAccess();
}

// ---------------------------------------------------------------------------
// Agent access — the cross-agent read log, a page at a time.
//
// An agent that is actually being used produces hundreds of these, and the whole log was
// rendered into one table: a wall you scroll past to reach everything below it, and a DOM
// that grows without limit while the page is open. The rows are already newest-first, so a
// page of them is the useful part and the rest is history.
// ---------------------------------------------------------------------------
const OBS_ACCESS_PAGE_SIZE = 25;
let obsAccessRows = [];
let obsAccessPage = 1;

function renderAgentAccess() {
  const accessEl = $('obs-access');
  if (!accessEl) return;
  // Clamped, not reset: a refresh (or new reads arriving) must not throw you back to page 1,
  // and a page that no longer exists resolves to the last one that does.
  const pageData = paginateEntries(obsAccessRows, { page: obsAccessPage, pageSize: OBS_ACCESS_PAGE_SIZE });
  obsAccessPage = pageData.page;
  const rows = pageData.items.map((e) => `<tr class="${e.ok ? '' : 'obs-err'}">
    <td class="obs-when" title="${new Date(e.ts).toLocaleString()}">${obsAgo(e.ts)}</td>
    <td class="obs-client">${escapeHtml(e.client || 'unknown')}</td>
    <td><code class="obs-tool">${escapeHtml(e.tool || '')}</code></td>
    <td class="obs-note sub">${escapeHtml(e.note || (e.ok ? '' : (e.error || 'failed')))}</td>
  </tr>`).join('');
  const pager = pageData.total > OBS_ACCESS_PAGE_SIZE
    ? `<div class="obs-pager">
        <button id="obs-access-prev" class="btn" type="button"${pageData.hasPrev ? '' : ' disabled'}>‹ Newer</button>
        <span class="sub">${pageData.start}–${pageData.end} of ${pageData.total}</span>
        <button id="obs-access-next" class="btn" type="button"${pageData.hasNext ? '' : ' disabled'}>Older ›</button>
      </div>`
    : '';
  accessEl.innerHTML = `<div class="obs-table-wrap"><table class="obs-table">
    <thead><tr><th>When</th><th>Agent</th><th>Tool</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${pager}
    <p class="tiny muted" style="margin-top:6px">Newest first · ${pageData.total} recent read(s) · the query text is never logged.</p>`;
  // Re-render only: the rows are already in memory, so paging never asks the gateway again.
  $('obs-access-prev')?.addEventListener('click', () => { obsAccessPage -= 1; renderAgentAccess(); });
  $('obs-access-next')?.addEventListener('click', () => { obsAccessPage += 1; renderAgentAccess(); });
}

async function renderActivity() {
  const statsBox = $('activity-stats');
  const runsBox = $('activity-runs');
  if (!statsBox || !runsBox) return;
  statsBox.textContent = '';
  runsBox.textContent = '';

  let log; let rd; let tj;
  try {
    [log, rd, tj] = await Promise.all([
      import('./js/event-log.js'), import('./js/run-details.js'), import('./js/events/trajectory.js'),
    ]);
  } catch (e) {
    // Say WHY. "Unavailable" sent me looking at the markup when the real cause was an
    // IndexedDB upgrade blocked by another open view.
    runsBox.innerHTML = '<p class="activity-empty"></p>';
    runsBox.firstChild.textContent = `Activity log unavailable: ${e?.message || e}`;
    return;
  }

  let stat; let events;
  try {
    [stat, events] = await Promise.all([log.stats(), log.all()]);
  } catch (e) {
    // Reading can fail for the same reason opening can (a blocked upgrade), and a silent
    // empty panel is the least useful way to say so.
    runsBox.innerHTML = '<p class="activity-empty"></p>';
    runsBox.firstChild.textContent = `Could not read the activity log: ${e?.message || e}`;
    return;
  }
  const bits = [
    ['Runs recorded', String(rd.groupRuns(events).runs.length)],
    ['Events', `${stat.events.toLocaleString()} of ${stat.cap.toLocaleString()} (${stat.pctOfCap}%)`],
    ['On disk', fmtBytes(stat.bytes)],
    ['Oldest', fmtWhen(stat.oldest)],
  ];
  for (const [k, v] of bits) {
    const span = document.createElement('span');
    span.innerHTML = `${k}: <b></b>`;
    span.querySelector('b').textContent = v;
    statsBox.append(span);
  }

  // WHAT THE PRIVACY LAYER CAUGHT, over the same window. Redaction is ChatPanel's core
  // promise and it was invisible — the log could say a turn was redacted, but not what it
  // found. privacy.redacted carries counts per entity type and NEVER the values, so this
  // whole view is safe to show and safe to have been persisted.
  try {
    const counts = new Map();
    for (const e of events) {
      if (e?.type !== 'privacy.redacted') continue;
      for (const [type, n] of Object.entries(e.payload?.counts || {})) {
        counts.set(type, (counts.get(type) || 0) + (Number(n) || 0));
      }
    }
    const box = $('activity-redaction');
    if (box) {
      box.textContent = '';
      if (!counts.size) {
        box.innerHTML = '<p class="muted tiny">No PII redacted in this window — either nothing sensitive was sent, or redaction is off (Privacy tab).</p>';
      } else {
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const head = document.createElement('p');
        head.className = 'tiny muted';
        head.textContent = `${total.toLocaleString()} value(s) replaced with placeholders before leaving this device — counts only; the values themselves are never logged.`;
        const chips = document.createElement('div');
        chips.className = 'redaction-chips';
        for (const [type, n] of rows) {
          const chip = document.createElement('span');
          chip.className = 'redaction-chip';
          chip.innerHTML = '<b></b><span></span>';
          chip.querySelector('b').textContent = String(n);
          chip.querySelector('span').textContent = type.toLowerCase().replace(/_/g, ' ');
          chips.append(chip);
        }
        box.append(chips, head);
      }
    }
  } catch { /* the rest of Activity still renders */ }

  const { runs: allRuns } = rd.groupRuns(events);
  // Price the runs here rather than inside run-details: the rate table is data on its own
  // release schedule, and a pure analysis module that must be edited when a price moves is
  // the wrong shape.
  try {
    const { costFor } = await import('./js/usage-pricing.js');
    rd.withCost(allRuns, costFor);
  } catch { /* unpriced runs still render */ }

  // Every surface reports here now (chat, note, meeting, assist, watch), so the list
  // needs to be narrowable — and background helper calls (title, topic extraction,
  // grammar pass) have to fold away by default, or one note buries its own run under a
  // dozen one-token rows. Nothing is dropped from the log; only from this view.
  const kindSel = $('activity-kind');
  const showBg = $('activity-background')?.checked;
  if (kindSel) {
    const kinds = [...new Set(allRuns.map((r) => r.kind))].sort();
    const keep = kindSel.value;
    kindSel.textContent = '';
    for (const [v, label] of [['', 'All surfaces'], ...kinds.map((k) => [k, KIND_LABEL[k] || k])]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      kindSel.append(o);
    }
    if (kinds.includes(keep)) kindSel.value = keep;
  }
  const wantKind = kindSel?.value || '';
  const hiddenBg = allRuns.filter((r) => r.background).length;
  const runs = allRuns.filter((r) => (showBg || !r.background) && (!wantKind || r.kind === wantKind));

  if (!runs.length) {
    runsBox.innerHTML = hiddenBg && !showBg
      ? '<p class="activity-empty">Only background work recorded so far — tick &ldquo;Show background work&rdquo; to see it.</p>'
      : '<p class="activity-empty">Nothing recorded yet. Send a message that uses tools and come back.</p>';
    return;
  }
  if (hiddenBg && !showBg) {
    const note = document.createElement('p');
    note.className = 'muted tiny';
    note.textContent = `${hiddenBg} background call${hiddenBg === 1 ? '' : 's'} hidden (titles, topic extraction, grammar passes).`;
    runsBox.append(note);
  }

  // THREADS, THEN TURNS. A flat list of 1,205 rows has no structure: nobody asks what run
  // 847 did, they ask what happened in a conversation — and a conversation is many turns,
  // as a meeting is its monitors and summaries and a note is every pass over it.
  const threads = tj.threadsOf(runs).slice(0, 40);
  const titles = await threadTitles(threads).catch(() => new Map());
  for (const thread of threads) {
    const group = document.createElement('details');
    group.className = 'thread-row';
    // Open when there is one turn: a disclosure that hides a single row is pure friction.
    group.open = thread.turns === 1;
    const gh = document.createElement('summary');
    gh.className = 'thread-head';
    const name = document.createElement('span');
    name.className = 'thread-name';
    name.textContent = titles.get(thread.key) || tj.threadTitle(thread);
    const kindTag = document.createElement('span');
    kindTag.className = 'run-kind';
    kindTag.textContent = KIND_LABEL[thread.surface] || thread.surface || 'Run';
    const gmeta = document.createElement('span');
    gmeta.className = 'thread-meta';
    const bits = [
      `${thread.turns} turn${thread.turns === 1 ? '' : 's'}`,
      thread.ms ? `${(thread.ms / 1000).toFixed(1)}s` : '',
      thread.calls ? `${thread.calls} call${thread.calls === 1 ? '' : 's'}` : '',
      // Errors on the heading, so a thread that went wrong is visible without opening it.
      thread.errors ? `${thread.errors} failed` : '',
    ].filter(Boolean);
    gmeta.textContent = bits.join(' · ');
    if (thread.errors) gmeta.classList.add('warn');
    gh.append(name, kindTag, gmeta);
    group.append(gh);
    runsBox.append(group);

  for (const run of thread.runs) {
    const v = rd.verdict(run);
    const row = document.createElement('details');
    row.className = 'run-row';

    // Summary answers "should I look at this?" — expanding answers "what happened".
    const head = document.createElement('summary');
    head.className = 'run-head';
    const when = document.createElement('span');
    when.className = 'run-when';
    when.textContent = fmtWhen(run.at);
    const verdict = document.createElement('span');
    verdict.className = `run-verdict ${v.level}`;
    verdict.textContent = v.text;
    const meta = document.createElement('span');
    meta.className = 'run-meta';
    const dur = run.ms != null ? `${(run.ms / 1000).toFixed(1)}s` : '';
    // Setup time is called out separately once it is worth noticing: a turn that spent
    // four seconds connecting to MCP servers before the model saw anything is a very
    // different problem from a slow model, and one number cannot say which.
    // Break the wall time down, because one number cannot say whether a slow turn was
    // slow to START (setup, connecting to MCP servers) or slow to WRITE.
    const prep = run.prepMs;
    const setup = prep != null && prep >= 250 ? `${(prep / 1000).toFixed(1)}s setup` : '';
    const ttft = run.ttftMs != null && run.ttftMs >= 500 ? `${(run.ttftMs / 1000).toFixed(1)}s to first word` : '';
    // Spend first, prompt size second — they answer different questions and the old row
    // showed only the second under a label that read like the first.
    const spent = run.tokens
      ? `${run.tokens.toLocaleString()} tok${run.estimated ? '~' : ''}`
      : '';
    // What THIS turn cost. The totals card above answers "how much have I spent"; only the
    // row can answer "which turn spent it", and that is the question that changes what a
    // user does next.
    const cost = run.usd != null ? `${run.estimated ? '≈' : ''}$${run.usd < 0.01 ? run.usd.toFixed(4) : run.usd.toFixed(2)}` : '';
    const ctxCost = run.contextTokens ? `${run.contextTokens.toLocaleString()} ctx` : '';
    // The models that answered, not just the one that finished — and a failover count,
    // because "three models declined before this one" is the most important thing a slow or
    // odd-looking turn can tell you.
    const models = run.models?.length ? run.models.join(' → ') : (run.model || '');
    const fails = run.failovers ? `${run.failovers} failover${run.failovers === 1 ? '' : 's'}` : '';
    meta.textContent = [dur, setup, ttft, spent, cost, ctxCost, models, fails, `${run.toolCalls.length} call${run.toolCalls.length === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · ');
    const kind = document.createElement('span');
    kind.className = `run-kind kind-${run.kind}`;
    kind.textContent = KIND_LABEL[run.kind] || run.kind;
    head.append(when, kind, verdict, meta);
    row.append(head);

    // THE WATERFALL, before anything else. DevTools' real lesson is that phases laid out
    // proportionally answer "why was this slow" without a single click — and a turn that
    // spent 45s connecting to MCP servers looks nothing like one that spent 45s writing,
    // while one total made them identical.
    const phases = tj.phasesOf(run);
    if (phases) {
      const wf = document.createElement('div');
      wf.className = 'tj-waterfall';
      for (const part of phases.parts) {
        const seg = document.createElement('span');
        seg.className = `tj-phase tj-${part.key}`;
        seg.style.width = `${part.pct}%`;
        seg.title = `${part.label} — ${(part.ms / 1000).toFixed(1)}s (${Math.round(part.pct)}%)`;
        wf.append(seg);
      }
      row.append(wf);
    }

    // WHERE THE TIME WENT. On a forty-call run the useful question is never "what ran"
    // but "what did it spend the time on", and a flat list of forty identical chips
    // answers neither.
    if (run.actions?.length) {
      const bar = document.createElement('div');
      bar.className = 'run-bar';
      const total = Math.max(1, run.toolMs);
      for (const act of run.actions.slice(0, 8)) {
        const seg = document.createElement('span');
        seg.className = `run-seg${act.failed ? ' failed' : ''}`;
        seg.style.flexGrow = String(Math.max(1, act.ms));
        seg.title = `${act.name} — ${act.count}× · ${act.ms}ms · ${Math.round((act.ms / total) * 100)}% of tool time`;
        bar.append(seg);
      }
      row.append(bar);

      const legend = document.createElement('div');
      legend.className = 'run-actions';
      for (const act of run.actions.slice(0, 12)) {
        const chip = document.createElement('span');
        chip.className = `run-action${act.failed ? ' failed' : ''}`;
        chip.innerHTML = '<b></b><i></i>';
        chip.querySelector('b').textContent = act.name;
        chip.querySelector('i').textContent = `${act.count}× · ${act.ms}ms${act.failed ? ` · ${act.failed} failed` : ''}`;
        legend.append(chip);
      }
      row.append(legend);
    }

    // THE TRAJECTORY. Every step of the turn as one short row — prompt, context, each
    // call, each result, the answer — with a detail pane beside it. Rows stay short so the
    // SHAPE of the turn is legible at a glance; the pane is where length is allowed.
    //
    // Built lazily, on first expand. Sixty runs' worth of entries and blob reads on every
    // render would make opening the tab slower than the turns it describes.
    const tjBox = document.createElement('div');
    tjBox.className = 'tj';
    row.append(tjBox);
    let tjBuilt = false;
    row.addEventListener('toggle', () => {
      if (!row.open || tjBuilt) return;
      tjBuilt = true;
      const entries = tj.buildTrajectory(run.raw || []);
      renderRequests(tjBox, run, tj);
      renderTrajectory(tjBox, entries, log, tj.lanesOf(entries, run));
    });

    // The full sequence, in order, with arguments — the part that turns "it failed" into
    // "it failed THIS way, six times, with these inputs".
    if (run.toolCalls.length) {
      const list = document.createElement('ol');
      list.className = 'run-calls';
      for (const c of run.toolCalls) {
        const li = document.createElement('li');
        li.className = `run-call${c.ok === false ? ' failed' : ''}`;
        const nm = document.createElement('b');
        nm.textContent = c.label || c.name;
        const args = document.createElement('code');
        const shown = { ...(c.args || {}) };
        delete shown.action; delete shown.tool;
        args.textContent = Object.keys(shown).length ? JSON.stringify(shown) : '';
        const ms = document.createElement('span');
        ms.className = 'run-call-ms';
        ms.textContent = c.ms != null ? `${c.ms}ms` : '';
        li.append(nm, args, ms);
        if (c.summary) {
          const out = document.createElement('div');
          out.className = 'run-call-out';
          out.textContent = c.summary;
          li.append(out);
        }
        list.append(li);
      }
      row.append(list);
    }
    group.append(row);
  }
  }
}

/**
 * Real names for threads, so the list reads as conversations rather than as ids.
 *
 * Best-effort and batched: a heading is worth a lookup, but not worth blocking the view or
 * making one request per row. Anything that fails keeps its fallback heading, which still
 * distinguishes one thread from another.
 */
async function threadTitles(threads) {
  const out = new Map();
  try {
    const store = await import('./js/store.js');
    const wanted = threads.filter((t) => t.sourceId);
    if (!wanted.length) return out;
    // The conversation INDEX, not the conversations: it already holds {id,title} and is one
    // read, where loading each thread's messages to find its title would be forty.
    const convs = (await store.getIndex?.().catch(() => [])) || [];
    const byId = new Map(convs.map((c) => [c.id, c.title]));
    for (const t of wanted) {
      const title = byId.get(t.sourceId);
      if (title) out.set(t.key, title);
    }
  } catch { /* fallback headings are already readable */ }
  return out;
}

/**
 * One row per model round-trip.
 *
 * A turn is not one model call: in a tool loop the model is asked, answers with a call, is
 * given the result, and is asked again. Reporting a single total for four requests hides
 * which one went wrong — and "request #2 is where it went wrong" is a sentence a user can
 * act on, while "the turn went wrong" is not.
 *
 * Throughput and generation time are DERIVED here, never stored: a computed number cannot
 * drift from the tokens it came from, and a stored copy eventually does.
 */
function renderRequests(box, run, tj) {
  const reqs = run.requests;
  if (!reqs?.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'tj-reqs';
  const head = document.createElement('div');
  head.className = 'tj-reqs-head';
  head.textContent = `${reqs.length} model request${reqs.length === 1 ? '' : 's'}`;
  wrap.append(head);

  for (const r of reqs) {
    const m = tj.requestMetrics(r);
    const el = document.createElement('div');
    el.className = 'tj-req';
    const bits = [
      `#${r.index}`,
      m.model || '',
      m.tokensTotal ? `${m.tokensTotal.toLocaleString()} tok` : '',
      m.tokensOut ? `${m.tokensOut.toLocaleString()} out` : '',
      // A missing measurement is left out rather than shown as zero — "we did not measure"
      // and "it took no time" are different claims.
      m.ttftMs != null ? `${(m.ttftMs / 1000).toFixed(2)}s to first word` : '',
      m.generationMs != null ? `${(m.generationMs / 1000).toFixed(2)}s writing` : '',
      m.throughput != null ? `${m.throughput} tok/s` : '',
    ].filter(Boolean);
    el.textContent = bits.join('  ·  ');
    wrap.append(el);
  }
  box.append(wrap);
}

/**
 * The entry list plus detail pane.
 *
 * Content is resolved from the blob store only when a row is SELECTED — a trajectory is
 * cheap to build and expensive to read, and most rows are never opened. A ref whose blob
 * has been pruned or shredded says so, rather than rendering blank: "no longer stored" is
 * a true answer and an empty pane is not.
 */
function renderTrajectory(box, entries, log, lanes) {
  box.textContent = '';
  if (!entries.length) {
    box.innerHTML = '<p class="muted tiny">No trajectory recorded for this run.</p>';
    return;
  }

  // LANES FIRST. Which layer was active, and when — a stacked bar says how the time
  // divided, which is a different question. Two tool calls with thinking between them is a
  // different shape from one long call, and a single bar draws them identically.
  if (lanes) {
    const rail = document.createElement('div');
    rail.className = 'tj-lanes';
    for (const [name, spans] of Object.entries(lanes)) {
      const lane = document.createElement('div');
      lane.className = 'tj-lane';
      const label = document.createElement('span');
      label.className = 'tj-lane-name';
      label.textContent = name;
      const track = document.createElement('span');
      track.className = 'tj-track';
      for (const sp of spans) {
        const seg = document.createElement('i');
        seg.className = `tj-span tj-span-${name}`;
        seg.style.left = `${sp.left}%`;
        seg.style.width = `${sp.width}%`;
        seg.title = sp.label;
        track.append(seg);
      }
      lane.append(label, track);
      rail.append(lane);
    }
    box.append(rail);
  }

  const search = document.createElement('input');
  search.className = 'input tj-search';
  search.placeholder = 'Filter steps…';
  const list = document.createElement('div');
  list.className = 'tj-list';
  box.append(search, list);

  // Full-width rows that show their content inline, rather than a list beside a pane. The
  // point of a trajectory is to be READ in order; a two-column layout makes every step a
  // click, and the preview is usually all you need.
  const paint = (query) => {
    list.textContent = '';
    const shown = entries.filter((e) => !query || `${e.title} ${e.detail || ''}`.toLowerCase().includes(query));
    if (!shown.length) { list.innerHTML = '<p class="muted tiny">No matching steps.</p>'; return; }
    for (const entry of shown) {
      const el = document.createElement('details');
      el.className = `tj-row tj-${entry.kind}${entry.ok === false ? ' failed' : ''}`;
      const head = document.createElement('summary');
      const tag = document.createElement('span');
      tag.className = 'tj-tag';
      tag.textContent = entry.kind;
      const preview = document.createElement('span');
      preview.className = 'tj-preview';
      preview.textContent = entry.detail ? `${entry.title} — ${entry.detail}` : entry.title;
      const when = document.createElement('span');
      when.className = 'tj-when';
      when.textContent = entry.offsetMs != null ? `+${(entry.offsetMs / 1000).toFixed(1)}s` : '';
      head.append(tag, preview, when);
      el.append(head);

      const body = document.createElement('pre');
      body.className = 'tj-raw';
      el.append(body);

      // Content is fetched when the row is OPENED, not when the list is built. Most rows
      // are never opened, and reading every blob up front would make the tab slower than
      // the turns it describes.
      let loaded = false;
      el.addEventListener('toggle', async () => {
        if (!el.open || loaded) return;
        loaded = true;
        // A ROUTE IS DRAWN, NOT DUMPED. The blob is the record; the picture is the
        // explanation — what nearly won, what was eliminated and why, and where this turn
        // goes if the model declines. Loaded on demand, like every other row's content, so
        // it costs nothing on a trace nobody opens.
        if (entry.kind === 'route' && entry.data?.graph) {
          const { renderRouteGraph } = await import('./js/route-graph-view.js');
          const view = renderRouteGraph(entry.data.graph);
          if (view) { el.insertBefore(view, body); body.classList.add('rg-raw'); }
        }
        if (!entry.ref) { body.textContent = JSON.stringify(entry.data ?? { detail: entry.detail }, null, 2); return; }
        body.textContent = 'Loading…';
        const text = await log.getBlob(entry.ref);
        // A ref whose blob is gone says so. Blank would read as "there was nothing here",
        // which is a different and false claim.
        body.textContent = text ?? 'No longer stored — pruned or cleared.';
      });
      list.append(el);
    }
  };

  paint('');
  search.addEventListener('input', () => paint(search.value.trim().toLowerCase()));
}

/**
 * Re-run the recorded log and report whether it reconstructs.
 *
 * This is the determinism claim made checkable on the user's OWN data rather than in a test
 * fixture. It verifies the three things we actually promise: that ordering comes from
 * causes and sequence rather than a clock, that the invariants hold, and that every
 * recorded Ref still resolves to the content it named.
 *
 * What it deliberately does NOT do is re-execute anything. A replay that re-ran tool calls
 * would send emails and click buttons again; the claim is that the RECORD reconstructs, not
 * that the world can be rewound.
 */
async function verifyReplay() {
  const out = $('activity-replay-out');
  if (!out) return;
  out.classList.remove('hidden');
  out.textContent = 'Replaying…';
  try {
    const [log, harness] = await Promise.all([
      import('./js/event-log.js'),
      import('./js/events/harness.js'),
    ]);
    const [events, blobs] = await Promise.all([log.all(), log.blobLookupTable()]);
    if (!events.length) { out.textContent = 'Nothing recorded yet.'; return; }
    const report = harness.replay(events, { blobs });
    out.textContent = '';
    const head = document.createElement('b');
    head.className = report.ok ? 'ok' : 'err';
    head.textContent = report.ok
      ? `PASS — ${report.events} events reconstruct exactly`
      : `FAIL — ${report.events} events, ${report.violations.length} invariant violation(s), ${report.refs.drifted.length} drifted`;
    const pre = document.createElement('pre');
    pre.className = 'tj-raw';
    // A shredded blob is a PASS and says so, because deletion is a feature — reporting it
    // as damage would make "delete my data" look like corruption.
    pre.textContent = harness.formatReport(report);
    out.append(head, pre);
  } catch (e) {
    out.textContent = `Could not replay: ${e?.message || e}`;
  }
}

$('activity-replay')?.addEventListener('click', verifyReplay);
$('obs-refresh')?.addEventListener('click', renderObservability);
$('obs-clear')?.addEventListener('click', async () => {
  const gwUrl = normalizeGatewayUrl(settings.gatewayUrl || 'http://127.0.0.1:4320');
  const { confirmDelete } = await import('./js/confirm-modal.js');
  const ok = await confirmDelete({
    title: 'Clear the gateway copy?',
    body: 'Deletes the gateway\'s on-disk mirror of your chats, meetings and notes — the copy that CLI agents (Codex, Claude Code) search. Useful to reclaim disk space, remove that second copy for privacy, or rebuild a stale index. Your browser data — the source of truth — is untouched. To refill the gateway afterward: turn on auto-sync, or click Sync now.',
    confirmLabel: 'Clear copy',
  });
  if (!ok) return;
  const btn = $('obs-clear'); const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Clearing…'; }
  try {
    const r = await clearGatewayHistory(gwUrl);
    // Reset the sync watermark so a later sync re-pushes from scratch instead of assuming
    // the gateway still holds what we last sent.
    try { const { resetWarmSyncBaseline } = await import('./js/warm-sync.js'); await resetWarmSyncBaseline(); } catch { /* ignore */ }
    toast(`Cleared ${r?.dropped ?? 0} record(s). Turn on auto-sync (or click Sync now) to refill the gateway.`);
  } catch (e) {
    toast(`Clear failed: ${e?.message || e}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    renderObservability();
  }
});
$('obs-sync')?.addEventListener('click', async () => {
  const btn = $('obs-sync');
  if (!btn || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const gwUrl = normalizeGatewayUrl(settings.gatewayUrl || 'http://127.0.0.1:4320');
    const { syncHistoryToGateway } = await import('./js/warm-sync.js');
    // Manual reindex = force a full push (re-seed the watermark), not just the delta.
    const r = await syncHistoryToGateway(gwUrl, { force: true });
    if (r?.ok) { btn.textContent = 'Synced ✓'; toast(`Reindexed ${r.sent ?? 0} record(s) to the gateway`); }
    else if (r?.skipped) { toast('Sync skipped — is the gateway running and its URL loopback?'); btn.textContent = label; }
    else { toast(`Sync failed: ${r?.error || 'gateway not reachable'}`); btn.textContent = label; }
  } catch (e) {
    toast(`Sync failed: ${e?.message || e}`); btn.textContent = label;
  } finally {
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = label; } }, 1200);
    renderObservability();
  }
});
$('activity-refresh')?.addEventListener('click', renderActivity);
$('activity-kind')?.addEventListener('change', renderActivity);
$('activity-background')?.addEventListener('change', renderActivity);

$('activity-export')?.addEventListener('click', async () => {
  const [log, ev] = await Promise.all([import('./js/event-log.js'), import('./js/events/harness.js')]);
  const blob = new Blob([ev.toJsonl(await log.all())], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chatpanel-activity-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('activity-clear')?.addEventListener('click', async () => {
  const { confirmDelete } = await import('./js/confirm-modal.js');
  const ok = await confirmDelete({
    title: 'Clear activity?',
    body: 'Deletes the local record of what your runs did. Your chats, notes and meetings are not affected.',
    confirmLabel: 'Clear',
  });
  if (!ok) return;
  const log = await import('./js/event-log.js');
  await log.clear();
  renderActivity();
});
