// ChatPanel options page — tabs: API · Agents · Skills · License.
//
//   API     — endpoints: a connection (provider + base URL + key) with a chosen
//             model and optional system prompt/tuning. Chat with one directly.
//   Agents  — the local bridge (CLI) agents: Claude Code, Codex, Antigravity CLI,
//             plus the bridge connection itself.
import { getSettings, saveSettings, uid, exportAllData, exportDataArchive, importAllData, resetSkillsToDefaults } from './js/store.js';
import { readZipEntry } from './js/zip.js';
import { icon, iconForEmoji, hydrate } from './js/icons.js';
import { getBackupState, setAutoBackupEnabled, setAutoBackupPassphrase, setAutoBackupHour, runAutoBackup } from './js/auto-backup.js';
import { encryptBackup, decryptBackup, isEncryptedBackup } from './js/crypto-backup.js';
import { checkBridge, updateBridge, testAgent, listModelOptions, listBridgeModels, checkAgentCommand, previewRedaction, traceFlow } from './js/providers.js';
import { buildToolset } from './js/toolset.js';
import { getMcpProviders } from './js/mcp-manager.js';
import { historyToolProvider } from './js/history-rag.js';
import { webSearchToolProvider, webSearchOpts, webSearchUsage } from './js/web-search.js';
import { fullRedactionUsage } from './js/pii-usage.js';
import { sanitizeUnicode } from './js/sanitize.js';
import { narrowToolset, isLocalToolSpec } from './js/tool-select.js';
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
import { assistPrompt } from './js/assist.js';
import { checkForUpdate, currentVersion, DOWNLOAD_URL } from './js/update.js';
import { applyProviderPreset, orderedProviderPresets, providerBrand, providerPresetById, providerPresetForEndpoint } from './js/provider-presets.js';
import { filterComboboxOptions, normalizeComboboxOptions } from './js/combobox.js';
import { parseJsonObject, prettyJson, sanitizeExtraBody, sanitizeExtraHeaders } from './js/request-options.js';
import { clearEndpointModelState, endpointErrorAuthStatus, modelListAuthStatus } from './js/settings-endpoint.js';
import { localStorageHealth } from './js/storage-health.js';
import { checkGateway, getGatewayConfig, getGatewayLogs, setGatewayConfig, normalizeGatewayUrl, parseDictionary, stringifyDictionary, getNerModels, setNerModel } from './js/gateway.js';
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
  fetchEntitlement,
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
  // unless the user deliberately released Pro on this device (opt-out).
  isOptedOut().then((opted) => {
    if (opted) return;
    fetchEntitlement().then((lic) => {
      if (lic && isPro(lic)) {
        license = lic;
        renderLicense();
        renderEndpoints();
        renderBridgeAgents();
        renderMcpServers();
        renderSkills();
        renderPrefs(); // re-enable the Pro-gated Autocomplete toggle
      }
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
  renderLicense();
  wireGateway();
  renderGateway();
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
  };
  const exists = (name) => !!document.querySelector(`.tab[data-tab="${name}"]`);
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
  // Priority: an explicit #hash (e.g. the Pro chip opens #license), else the
  // last-opened tab, else the default (API).
  const fromHash = (location.hash || '').replace('#', '');
  if (fromHash && exists(fromHash)) {
    show(fromHash);
    return;
  }
  chrome.storage.local.get(K_SETTINGS_TAB).then((g) => {
    const last = g[K_SETTINGS_TAB];
    if (last && exists(last)) show(last);
  });
}
const K_SETTINGS_TAB = 'chatpanel:settingsTab';

// --------------------------------------------------------------------------
// Notes tab — the notes editor's own preferences. Editor view + co-writer live
// in localStorage (shared across every extension page, the same source the notes
// editor reads, so it picks changes up on next load). The @insert tool overrides
// live in settings.ui.notes so buildTurnTools can honor them per surface.
// --------------------------------------------------------------------------
const NOTES_MODE_KEY = 'chatpanel.notes.mode';
const NOTES_COWRITER_KEY = 'chatpanel.notes.cowriter';

function setupNotesPrefs() {
  const mode = $('notes-default-mode');
  if (mode) {
    const cur = localStorage.getItem(NOTES_MODE_KEY);
    mode.value = ['write', 'split', 'read'].includes(cur) ? cur : 'write';
    mode.onchange = () => localStorage.setItem(NOTES_MODE_KEY, mode.value);
  }
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

function renderEndpoints() {
  const root = $('endpoints');
  root.innerHTML = '';
  for (const ep of settings.endpoints || []) root.appendChild(endpointCard(ep));
  renderGateBadges();
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
  wireModelSelect(q('.ep-model'), q('.ep-model-custom'), ep.models, ep.model, ep.modelOptions);
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
        ? 'optional override; blank uses ChatPanel hosted client'
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
  q('.ep-provider').onchange = () => {
    const previous = q('.ep-provider').dataset.providerPreset;
    if (previous === 'custom') snapshotCustomDraft();
    const selected = readProviderPresetId();
    writeProviderPresetId(selected);
    if (selected !== 'custom') {
      writeConn(applyProviderPreset({ ...rawConn(), providerPreset: selected }));
    } else if (customDraft) {
      restoreCustomDraft(customDraft);
    }
    resetModelPickers();
    setAuthStatus('Run Load models or Test to check authentication.');
    syncAuthMode();
    syncProviderHelp();
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
    await saveSettings(settings);
    setStatus(q('.ep-status'), ep.enabled ? 'Enabled' : 'Disabled — hidden from pickers, autocomplete & gateway', ep.enabled ? 'ok' : '');
  };

  q('.ep-del').onclick = async () => {
    if ((settings.endpoints || []).length <= 1) {
      return setStatus(q('.ep-status'), 'Keep at least one endpoint', 'err');
    }
    settings.endpoints = settings.endpoints.filter((e) => e !== ep);
    await saveSettings(settings);
    renderEndpoints();
  };

  return node;
}

function addEndpoint() {
  if (!isPro(license)) return upsell('Adding endpoints is a Pro feature. Free includes one endpoint — set it up below.');
  settings.endpoints = settings.endpoints || [];
  settings.endpoints.push({
    id: uid(),
    name: 'New endpoint',
    kind: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    models: [],
    systemPrompt: '',
  });
  saveSettings(settings);
  renderEndpoints();
  $('endpoints').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

// --------------------------------------------------------------------------
// Agents (local bridge: Claude Code / Codex / Antigravity CLI)
// --------------------------------------------------------------------------
function renderBridge() {
  $('bridge-url').value = settings.bridgeUrl || '';
  renderBridgeAgents();
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
  fetch(gwUrl() + '/v1/history/key').then((r) => r.json()).then((d) => { box.checked = !!d?.hasKey; }).catch(() => { box.checked = false; });

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
        say(`✓ Indexed ${d.ingested ?? 0} records${d.file ? ` from ${d.file.split('/').pop()}` : ''}.`);
      } else {
        await fetch(gwUrl() + '/v1/history/key', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: '' }),
        });
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

// Show the free trial's lifetime usage (read-only — the cap is fixed and the count
// is server-authoritative; the gateway never accepts a client-set value).
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
  if (!url) { status.textContent = 'Enter the gateway URL.'; status.className = 'status'; return; }
  status.textContent = 'Checking…'; status.className = 'status';
  gatewayState = await checkGateway(url);
  if (!gatewayState.ok) {
    status.textContent = `✕ Not reachable: ${gatewayState.error || 'no response'}`;
    status.className = 'status err';
    $('gw-config').classList.add('hidden');
    return;
  }
  status.innerHTML = `✓ Connected — v${gatewayState.version} · backend: <strong>${gatewayState.backend}</strong> · ${gatewayState.pro?.unlocked ? 'Pro' : 'Free'}`;
  status.className = 'status ok';
  try {
    fillGatewayForm(await getGatewayConfig(url));
    $('gw-config').classList.remove('hidden');
    renderGatewayMonitor(gatewayState);
    renderNerStatus(gatewayState.ner);
    refreshNerModels();
  } catch (e) {
    status.textContent = `✓ Connected, but config load failed: ${e.message}`;
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

// NER-model UI is shared by both tabs; a context picks which DOM nodes + gateway
// URL to use so the same render/refresh/select logic drives either one.
const GW_NER = { url: () => normalizeGatewayUrl($('gw-url').value), models: 'gw-models', mstatus: 'gw-models-status', onHealth: (ner) => renderNerStatus(ner) };
const PRIV_NER = { url: () => gatewayBaseUrl(), models: 'priv-models', mstatus: 'priv-models-status', onHealth: (ner) => renderPrivNerHealth(ner) };

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
  // The free trial cap is fixed and its usage is server-authoritative — the client
  // only ever sends a Pro token (never a cap or usage count).
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
    fillGatewayForm(await setGatewayConfig(url, { pro: { entitlementToken: token } }));
    gatewayState = await checkGateway(url);
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
      const r = await updateBridge(settings.bridgeUrl);
      if (!r.ok) {
        el.textContent = `✕ Bridge update failed: ${r.error || 'unknown'}`;
        el.className = 'status err';
        return;
      }
      el.textContent = 'Bridge is updating and restarting…';
      // The bridge restarts (connection drops); poll until it's back on the new version.
      await new Promise((res) => setTimeout(res, 4000));
      for (let i = 0; i < 8; i++) {
        bridgeState = await checkBridge(settings.bridgeUrl);
        if (bridgeState.ok && bridgeState.version === r.to) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
      renderBridgeAgents();
      renderBridgeUpdate();
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

function renderBridgeAgents() {
  const root = $('bridge-agents');
  root.innerHTML = '';
  for (const a of bridgeAgents()) root.appendChild(bridgeAgentCard(a));
}

function bridgeAgentCard(agent) {
  const node = $('bridge-agent-tpl').content.firstElementChild.cloneNode(true);
  const q = (sel) => node.querySelector(sel);
  q('.ba-name').value = agent.name || '';
  q('.ba-enabled').checked = agent.enabled !== false;
  q('.ba-kind').value = agent.bridgeAgent || 'claude';
  q('.ba-workdir').value = agent.workingDir || '';
  q('.ba-extraargs').value = agent.extraArgs || '';
  q('.ba-model').value = agent.model || '';
  q('.ba-acmodel').value = agent.autocompleteModel || '';
  q('.ba-perm').value = agent.permissionMode || 'acceptEdits';
  q('.ba-local').checked = agent.useLocalConfig !== false;
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
    q('.ba-custom').classList.toggle('hidden', !isCustom);
    // local skills/MCP & per-agent system prompt only apply to the built-in CLIs.
    q('.ba-local').closest('.check').classList.toggle('hidden', isCustom);
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
    setStatus(q('.ba-status'), '✓ Saved', 'ok');
  };

  q('.ba-enabled').onchange = async () => {
    agent.enabled = q('.ba-enabled').checked;
    await saveSettings(settings);
  };

  q('.ba-del').onclick = async () => {
    settings.agents = settings.agents.filter((a) => a !== agent);
    await saveSettings(settings);
    renderBridgeAgents();
  };

  return node;
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

function addBridgeAgent() {
  if (!isPro(license)) return upsell('Adding agents is a Pro feature. Free includes the built-in agents — pick your one with “Use on Free”.');
  settings.agents = settings.agents || [];
  settings.agents.push({
    id: uid(),
    name: 'New agent',
    kind: 'bridge',
    bridgeAgent: 'claude',
    workingDir: '',
    permissionMode: 'acceptEdits',
    useLocalConfig: true,
    systemPrompt: '',
  });
  saveSettings(settings);
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
  list.forEach((s, i) => root.appendChild(mcpServerCard(s, i)));
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

function mcpServerCard(server, index = 0) {
  const node = $('mcp-server-tpl').content.firstElementChild.cloneNode(true);
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

  const syncTransport = () => {
    const t = q('.mcp-transport').value;
    q('.mcp-http').classList.toggle('hidden', t !== 'http');
    q('.mcp-stdio').classList.toggle('hidden', t !== 'stdio');
  };
  syncTransport();

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
      status.textContent = `✗ ${e.message}`;
    }
  };

  q('.mcp-del').onclick = async () => {
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
function renderSkills() {
  const root = $('skills');
  root.innerHTML = '';
  // Skills are a Pro feature — Free sees them locked, behind an upsell banner.
  const locked = !can(license, 'customSkills');
  if (locked) root.appendChild(skillsBanner());
  for (const skill of settings.skills) {
    const card = skillCard(skill);
    if (locked) lockCard(card);
    root.appendChild(card);
  }
  renderGateBadges();
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
function lockCard(node) {
  node.classList.add('locked-card');
  node.querySelectorAll('input, select, textarea, button').forEach((el) => {
    el.disabled = true;
    el.classList.add('locked');
  });
}

// Chat targets a skill can be pinned to run on: any endpoint or bridge agent.
function skillTargets() {
  return [
    ...(settings.endpoints || []).map((e) => ({ id: e.id, name: e.name })),
    ...(settings.agents || []).filter((a) => a.kind === 'bridge').map((a) => ({ id: a.id, name: a.name })),
  ];
}

function enabledMcpServersForSkills() {
  return (settings.mcpServers || []).filter((s) => s && s.enabled !== false && (s.url || s.command));
}

function skillCard(skill) {
  const node = $('skill-tpl').content.firstElementChild.cloneNode(true);
  hydrate(node);
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
  if (skill.builtin) q('.s-del').classList.add('hidden');

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
    });
    settings = await saveSettings(settings);
    setStatus(q('.s-status'), '✓ Saved', 'ok');
  };
  q('.s-del').onclick = async () => {
    settings.skills = settings.skills.filter((s) => s !== skill);
    await saveSettings(settings);
    renderSkills();
  };
  return node;
}

function addSkill() {
  if (!can(license, 'customSkills')) {
    return upsell('Creating custom skills is Pro. You can edit the built-ins on any plan.');
  }
  settings.skills.push({ id: uid(), name: 'New skill', command: 'mycmd', icon: '🎓', prompt: '', historyContext: 'none', mcpMode: 'none', mcpServerIds: [] });
  saveSettings(settings);
  renderSkills();
  $('skills').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

async function resetSkills() {
  if (!confirm('Reset all skills to ChatPanel defaults? This removes custom skills and discards edits to built-in skills.')) return;
  settings = await resetSkillsToDefaults();
  renderSkills();
  toast('Skills reset to defaults');
}

// --------------------------------------------------------------------------
// Web search engines (Tools tab) — editable mirror of settings.ui.webSearch.engines
// --------------------------------------------------------------------------
const DEFAULT_WS_ENGINES = [
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', enabled: true },
  { id: 'mojeek', name: 'Mojeek', url: 'https://www.mojeek.com/search?q=%s', enabled: true },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=%s', enabled: false },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', enabled: false },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', enabled: false },
];
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
    // Free can enable at most engineCap engines (matches the runtime cap). Block the
    // checkbox from turning on a 4th and upsell instead.
    if (!pro) {
      en.onchange = () => {
        if (!en.checked) return;
        const enabledNow = [...root.querySelectorAll('.ws-en:checked')].length;
        if (enabledNow > engineCap) {
          en.checked = false;
          upsell(`Free includes ${engineCap} web-search engines. Upgrade to Pro to use more.`);
        }
      };
    }

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
  el.innerHTML = `AI detection (names / orgs / locations) is a <strong>Pro</strong> feature — Free includes `
    + `<strong>${cap} full redactions</strong> total to try it out, then it falls back to patterns + dictionary. `
    + `<strong>${remaining} of ${cap} left.</strong> The same allowance is shared with the gateway and counts your `
    + `ChatPanel chats too. <a href="#" class="priv-usage-upsell">Upgrade to Pro</a> for unlimited.`;
  el.classList.toggle('warn', remaining === 0);
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
  webSearchEngines = (Array.isArray(ws.engines) && ws.engines.length ? ws.engines : DEFAULT_WS_ENGINES).map((e) => ({ ...e }));
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
  $('pref-pageact-cdp').checked = !!settings.ui.pageActionsCdp;
  $('pref-pageact-confirm').checked = settings.ui.pageActionConfirm !== false; // default ON
  // Meetings tab — live scribe behavior.
  $('pref-live-notes').value = String(settings.ui.liveNotesIntervalMin ?? 2);
  $('pref-meeting-window').value = String(settings.ui.meetingWindowMin ?? 0);
  $('pref-meeting-summary-style').value = settings.ui.meetingSummaryStyle === 'detailed' ? 'detailed' : 'concise';
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
  // AI (model) detection is a Pro feature, but — like the gateway — Free gets a
  // lifetime taste counted by the shared quota (FREE_LIMITS.fullRedactions). So we
  // DON'T hard-disable the option anymore; Free can select it and the chat path
  // falls back to deterministic once the allowance is spent. The usage line below
  // shows how many remain.
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
  if (b === 'bundled') { refreshNerModels(PRIV_NER); checkPrivNer(); }
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
  document.querySelector('.tab[data-tab="usage"]')?.addEventListener('click', rerender);
  if ($('usage-refresh')) $('usage-refresh').onclick = rerender;
  if ($('usage-groupby')) $('usage-groupby').onchange = rerender;
  if ($('usage-window')) $('usage-window').onchange = rerender;
  if ($('usage-clear')) $('usage-clear').onclick = async () => {
    if (!confirm('Clear all token-usage history?')) return;
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
function onProActivated(lic) {
  license = lic;
  renderLicense();
  renderEndpoints();
  renderBridgeAgents();
  renderMcpServers();
  renderSkills();
  renderPrefs(); // re-enable the Pro-gated Autocomplete toggle
  renderGateBadges(); // re-enable MCP add + Meetings controls
  setStatus($('license-msg'), '✓ Pro is now active. Thank you!', 'ok');
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
  // Re-enable after the poll window so a cancelled checkout isn't stuck.
  setTimeout(() => { if (planOf(license) === 'free') restore(); }, 5 * 60 * 1000 + 1000);
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
  badgeButton($('add-skill'), !can(license, 'customSkills'));
  // Agents & endpoints: free uses the built-ins (one active each); adding more is Pro.
  const proLocked = !isPro(license);
  ['add-agent', 'add-endpoint'].forEach((id) => { const b = $(id); if (b) { badgeButton(b, proLocked); b.classList.toggle('locked', proLocked); } });
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
  $('add-mcp').onclick = addMcpServer;
  $('add-websearch').onclick = addWebSearchEngine;
  $('import-mcp').onclick = () => {
    if (mcpAddLocked()) return upsell(`Free includes ${FREE_LIMITS.mcpServers} MCP server. Upgrade to Pro for unlimited.`);
    toggleMcpImport(true);
  };
  $('mcp-import-cancel').onclick = () => toggleMcpImport(false);
  $('mcp-import-apply').onclick = importMcpConfig;
  $('add-skill').onclick = addSkill;
  $('reset-skills').onclick = resetSkills;
  $('mcp-registry-search-btn').onclick = () => loadMcpRegistry();
  $('mcp-registry-more').onclick = () => loadMcpRegistry({ append: true });
  $('mcp-registry-search').onkeydown = (e) => {
    if (e.key === 'Enter') loadMcpRegistry();
  };

  $('bridge-test').onclick = testBridge;
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
  $('pref-pageact-cdp').onchange = async (e) => {
    settings.ui.pageActionsCdp = e.currentTarget.checked;
    await saveSettings(settings);
  };
  // Confirm-before-page-actions gate (default on). Persist the choice.
  $('pref-pageact-confirm').onchange = async (e) => {
    settings.ui.pageActionConfirm = e.currentTarget.checked;
    await saveSettings(settings);
  };

  $('check-updates').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await renderAbout(); } finally { btn.disabled = false; }
  };

  $('btn-subscribe-pro').onclick = () => subscribePro($('btn-subscribe-pro'));

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

// Back up & restore all data — conversations AND captured meetings (Pro). Pure
// client-side: the export is a JSON file the user keeps; restore reads it back.
// Gated like other Pro exports.
function wireBackup() {
  const msg = $('backup-msg');

  $('backup-export').onclick = async () => {
    if (!can(license, 'exportChats')) {
      return setStatus(msg, '✨ Backup & restore is a Pro feature — upgrade above.', 'err');
    }
    setStatus(msg, 'Exporting…');
    try {
      const pass = $('backup-password').value;
      const stamp = new Date().toISOString().slice(0, 10);
      let blob, name, count, meetingsCount, kind;
      if (pass) {
        // Encrypted export: a single envelope file. We can't ship the browsable
        // Markdown archive here — that would defeat the encryption — so this is
        // the JSON backup only, wrapped in AES-GCM.
        const data = await exportAllData();
        count = data.count;
        meetingsCount = data.meetingsCount;
        if (!count && !meetingsCount) return setStatus(msg, 'No data to export yet.', '');
        const envelope = await encryptBackup(data, pass);
        blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
        name = `chatpanel-data-${stamp}.encrypted.json`;
        kind = 'encrypted';
      } else {
        const archive = await exportDataArchive();
        count = archive.count;
        meetingsCount = archive.meetingsCount;
        if (!count && !meetingsCount) return setStatus(msg, 'No data to export yet.', '');
        blob = archive.blob;
        name = `chatpanel-data-${stamp}.zip`;
        kind = 'zip';
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const parts = [`${count} conversation${count === 1 ? '' : 's'}`];
      if (meetingsCount) parts.push(`${meetingsCount} meeting${meetingsCount === 1 ? '' : 's'}`);
      parts.push('settings'); // always included — endpoints/keys, agents, MCP, skills, prefs
      const tail = kind === 'encrypted' ? '🔒 password-protected — keep the password safe.' : '.zip — JSON backup + Markdown.';
      setStatus(msg, `✓ Exported ${parts.join(' + ')} (${tail})`, 'ok');
    } catch (e) {
      setStatus(msg, '✕ ' + (e.message || e), 'err');
    }
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
      // Encrypted backup? Decrypt with the password from the box (same field used
      // for export). A wrong/empty password throws a friendly message.
      if (isEncryptedBackup(data)) {
        data = await decryptBackup(data, $('backup-password').value);
      }
      const mode = $('backup-replace').checked ? 'replace' : 'merge';
      const { conversations, meetings, settings: settingsRestored } = await importAllData(data, { mode });
      const parts = [`${conversations.imported} conversation${conversations.imported === 1 ? '' : 's'}`];
      if (meetings.imported) parts.push(`${meetings.imported} meeting${meetings.imported === 1 ? '' : 's'}`);
      if (settingsRestored) {
        // Settings (endpoints, agents, MCP, skills, prefs) changed — reload & repaint.
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
      setStatus(msg, `✓ Restored ${parts.join(' + ')}${skipped ? ` (${skipped} skipped)` : ''}. Reopen ChatPanel to see everything.`, 'ok');
    } catch (err) {
      setStatus(msg, '✕ ' + (err.message || err), 'err');
    }
  };

  wireAutoBackup();
}

// Daily automatic backup to disk (Pro). Same .zip as manual export, written to
// Downloads/ChatPanel Backups/ on a schedule by the service worker. Here we only
// drive the toggle / "Back up now" and reflect the saved state.
function wireAutoBackup() {
  const toggle = $('autobackup-enabled');
  const status = $('autobackup-status');
  const pw = $('autobackup-password');
  if (!toggle) return; // defensive — UI not present

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');
  const fmtSize = (n) => {
    if (!n) return '';
    const mb = n / (1024 * 1024);
    return mb >= 1 ? ` (${mb.toFixed(1)} MB)` : ` (${Math.max(1, Math.round(n / 1024))} KB)`;
  };
  const hourSel = $('autobackup-hour');
  // Populate 12am–11pm once (value = 0–23 local hour).
  if (hourSel && hourSel.options.length <= 1) {
    for (let h = 0; h < 24; h++) {
      const label = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`;
      hourSel.add(new Option(`Daily at ${label}`, String(h)));
    }
  }
  const hourText = (st) => (Number.isInteger(st.hour) ? ` · daily at ${st.hour % 12 || 12}${st.hour < 12 ? 'am' : 'pm'}` : '');
  const showState = (st) => {
    if (st.lastError) return setStatus(status, '✕ ' + st.lastError, 'err');
    if (!st.enabled) return setStatus(status, 'Off — your data is only inside the extension.', '');
    const lock = st.passphrase ? ' 🔒 encrypted' : '';
    setStatus(status, `On${lock}${hourText(st)} — saved to Downloads → ChatPanel Backups. Last backup: ${fmt(st.lastAt)}${fmtSize(st.lastBytes)}.`, st.lastAt ? 'ok' : '');
  };
  // Persist the encryption passphrase from the field before any backup runs so
  // the unattended service-worker write uses the latest value.
  const syncPass = () => setAutoBackupPassphrase(pw ? pw.value : '');

  getBackupState().then((st) => {
    toggle.checked = !!st.enabled;
    if (pw) pw.value = st.passphrase || '';
    if (hourSel) hourSel.value = Number.isInteger(st.hour) ? String(st.hour) : '';
    showState(st);
  });

  if (hourSel) {
    hourSel.onchange = async () => {
      await setAutoBackupHour(hourSel.value === '' ? null : hourSel.value);
      showState(await getBackupState());
    };
  }

  // Changing the passphrase must rewrite the on-disk file immediately: the
  // change-detector hashes plaintext, so without this a newly-set password
  // wouldn't take effect until the data itself next changes.
  if (pw) {
    pw.onchange = async () => {
      await syncPass();
      const st = await getBackupState();
      if (st.enabled && can(license, 'autoBackup')) {
        await runAutoBackup({ force: true });
        showState(await getBackupState());
      }
    };
  }

  toggle.onchange = async () => {
    // Pro-gate: same entitlement as the rest of backup/restore.
    if (!can(license, 'autoBackup')) {
      toggle.checked = false;
      return setStatus(status, '✨ Automatic backup is a Pro feature — upgrade above.', 'err');
    }
    const enabled = toggle.checked;
    setStatus(status, enabled ? 'Turning on & taking a first backup…' : 'Turning off…');
    await syncPass();
    const res = await setAutoBackupEnabled(enabled);
    if (enabled && res && res.ok === false && res.reason !== 'empty') {
      toggle.checked = false;
    }
    showState(await getBackupState());
  };

  $('autobackup-now').onclick = async () => {
    if (!can(license, 'autoBackup')) {
      return setStatus(status, '✨ Automatic backup is a Pro feature — upgrade above.', 'err');
    }
    setStatus(status, 'Backing up…');
    await syncPass();
    const res = await runAutoBackup({ force: true });
    if (res.ok) {
      const parts = [`${res.count} conversation${res.count === 1 ? '' : 's'}`];
      if (res.meetingsCount) parts.push(`${res.meetingsCount} meeting${res.meetingsCount === 1 ? '' : 's'}`);
      setStatus(status, `✓ Backed up ${parts.join(' + ')} to Downloads → ChatPanel Backups.`, 'ok');
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
