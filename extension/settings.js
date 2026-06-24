// ChatPanel options page — tabs: API · Agents · Skills · License.
//
//   API     — endpoints: a connection (provider + base URL + key) with a chosen
//             model and optional system prompt/tuning. Chat with one directly.
//   Agents  — the local bridge (CLI) agents: Claude Code, Codex, Gemini CLI,
//             plus the bridge connection itself.
import { getSettings, saveSettings, uid, exportDataArchive, importAllData, resetSkillsToDefaults } from './js/store.js';
import { readZipEntry } from './js/zip.js';
import { checkBridge, updateBridge, testAgent, listModelOptions, listBridgeModels, checkAgentCommand } from './js/providers.js';
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
import { applyProviderPreset, orderedProviderPresets, providerPresetById, providerPresetForEndpoint } from './js/provider-presets.js';
import { filterComboboxOptions, normalizeComboboxOptions } from './js/combobox.js';
import { parseJsonObject, prettyJson, sanitizeExtraBody, sanitizeExtraHeaders } from './js/request-options.js';
import { clearEndpointModelState, endpointErrorAuthStatus, modelListAuthStatus } from './js/settings-endpoint.js';
import { localStorageHealth } from './js/storage-health.js';
import {
  getLicense,
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
  renderEndpoints();
  renderBridge();
  renderMcpServers();
  renderSkills();
  renderPrefs();
  renderLicense();
  wire();
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

  const toggle = document.createElement('button');
  toggle.className = 'combo-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Show options');
  toggle.textContent = '▾';
  wrap.appendChild(toggle);

  const menu = document.createElement('div');
  menu.className = 'combo-menu hidden';
  menu.setAttribute('role', 'listbox');
  wrap.appendChild(menu);
  return { wrap, menu, toggle };
}

function renderCombobox(input, state, open = true) {
  const matches = filterComboboxOptions(state.options, input.value);
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
      item.innerHTML = `<span>${escapeHtml(option.value)}</span>${option.meta ? `<small>${escapeHtml(option.meta)}</small>` : ''}`;
      item.onclick = () => {
        input.value = option.value;
        closeCombobox(state);
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
    options: normalized,
    emptyText,
  };
  input._chatpanelCombo = state;
  input.value = current ?? input.value ?? '';
  input.placeholder = placeholder;
  input.removeAttribute('list');

  if (!existing) {
    input.addEventListener('focus', () => renderCombobox(input, input._chatpanelCombo, true));
    input.addEventListener('input', () => renderCombobox(input, input._chatpanelCombo, true));
    input.addEventListener('keydown', (event) => {
      const currentState = input._chatpanelCombo;
      if (event.key === 'Escape') {
        closeCombobox(currentState);
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
      renderCombobox(input, currentState, open);
      input.focus();
    });
    document.addEventListener('click', (event) => {
      const currentState = input._chatpanelCombo;
      if (!currentState?.input?.parentElement?.contains(event.target)) closeCombobox(currentState);
    });
  }
  renderCombobox(input, state, false);
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
  const q = (sel) => node.querySelector(sel);
  const selectedPresetId = ep.providerPreset || providerPresetForEndpoint(ep)?.id || 'custom';
  const selectedPreset = providerPresetById(selectedPresetId);
  q('.ep-name').value = ep.name || '';
  populateProviderPresetSelect(q('.ep-provider'), selectedPresetId);
  q('.ep-kind').value = ep.kind || 'openai';
  q('.ep-baseurl').value = ep.baseUrl || '';
  q('.ep-authmode').value = isOAuthMode(ep.authMode) ? ep.authMode : 'apiKey';
  q('.ep-apikey').value = ep.apiKey || '';
  q('.ep-oauth-clientid').value = ep.oauth?.clientId || '';
  q('.ep-oauth-project').value = ep.oauth?.projectId || '';
  q('.ep-temp').value = ep.temperature ?? '';
  q('.ep-maxtok').value = ep.maxTokens ?? '';
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
    const selected = readProviderPresetId();
    writeProviderPresetId(selected);
    if (selected !== 'custom') {
      writeConn(applyProviderPreset({ ...rawConn(), providerPreset: selected }));
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
// Agents (local bridge: Claude Code / Codex / Gemini CLI)
// --------------------------------------------------------------------------
function renderBridge() {
  $('bridge-url').value = settings.bridgeUrl || '';
  renderBridgeAgents();
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
    status.textContent = `✕ Not reachable (${bridgeState.reason || 'no response'}). Start it with: npx @chatpanel/bridge`;
    status.className = 'status err';
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
    if (k) env[k] = v;
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
    status.innerHTML = `🔒 Free includes ${FREE_LIMITS.mcpServers} MCP servers — <a href="#" class="mcp-upsell">upgrade to Pro</a> for more`;
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
      delete server.command;
      delete server.args;
    }
    await saveSettings(settings);
  };
  q('.mcp-name').onchange = commit;
  q('.mcp-url').onchange = commit;
  q('.mcp-auth').onchange = commit;
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
      const tools = await testMcpServer(server, { bridgeUrl: settings.bridgeUrl });
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
  span.innerHTML = '✨ <b>Skills are a Pro feature.</b> Reusable prompts, the ⚡ menu, slash-commands and prompt-assist all unlock with Pro.';
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
  const q = (sel) => node.querySelector(sel);
  q('.s-icon').value = skill.icon || '';
  q('.s-name').value = skill.name || '';
  q('.s-cmd').value = skill.command || '';
  q('.s-desc').value = skill.description || '';
  q('.s-prompt').value = skill.prompt || '';
  q('.s-context').value = skill.context || 'auto';
  q('.s-history').value = skill.historyContext || 'none';
  q('.s-mcp-mode').value = skill.mcpMode || 'none';
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
  settings.skills.push({ id: uid(), name: 'New skill', command: 'mycmd', icon: '⚡', prompt: '', historyContext: 'none', mcpMode: 'none', mcpServerIds: [] });
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
// Preferences
// --------------------------------------------------------------------------
function renderPrefs() {
  $('pref-theme').value = settings.ui.theme || 'system';
  $('pref-enter').checked = settings.ui.sendOnEnter !== false;
  $('pref-stream').checked = settings.ui.streamResponses !== false;
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
  // Meetings tab — live scribe behavior.
  $('pref-live-notes').value = String(settings.ui.liveNotesIntervalMin ?? 2);
  $('pref-meeting-window').value = String(settings.ui.meetingWindowMin ?? 0);
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
  settings.ui.sendOnEnter = $('pref-enter').checked;
  settings.ui.streamResponses = $('pref-stream').checked;
  settings.ui.topicExtraction = {
    enabled: $('pref-topic-extract').checked,
    targetId: $('pref-topic-target').value,
  };
  settings.ui.autocomplete = isPro(license) && $('pref-autocomplete').checked;
  settings.ui.liveNotesIntervalMin = Number($('pref-live-notes').value);
  settings.ui.meetingWindowMin = Number($('pref-meeting-window').value);
  await saveSettings(settings);
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
  const row = (text, has) => `<li class="${has ? 'has' : 'locked'}">${has ? '✓' : '🔒'} ${esc(text)}</li>`;
  const proItems = Object.values(PRO_FEATURES).map((t) => row(t, pro)).join('');
  const teamItems = Object.values(TEAM_FEATURES).map((t) => row(t, team)).join('');
  el.innerHTML =
    `<div class="plan-group"><h3>✨ Pro</h3><ul class="feature-list">${proItems}</ul></div>` +
    `<div class="plan-group"><h3>👥 Team</h3><ul class="feature-list">${teamItems}</ul></div>`;
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
  b.textContent = '✨ Pro';
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
    star.textContent = '★ Free';
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
  $('pref-topic-extract').onchange = savePrefs;
  $('pref-topic-target').onchange = savePrefs;
  $('pref-live-notes').onchange = savePrefs;
  $('pref-meeting-window').onchange = savePrefs;
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
      const { blob, count, meetingsCount } = await exportDataArchive();
      if (!count && !meetingsCount) return setStatus(msg, 'No data to export yet.', '');
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chatpanel-data-${stamp}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const parts = [`${count} conversation${count === 1 ? '' : 's'}`];
      if (meetingsCount) parts.push(`${meetingsCount} meeting${meetingsCount === 1 ? '' : 's'}`);
      parts.push('settings'); // always included — endpoints/keys, agents, MCP, skills, prefs
      setStatus(msg, `✓ Exported ${parts.join(' + ')} (.zip — JSON backup + Markdown).`, 'ok');
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
      const data = JSON.parse(text);
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
  span.textContent = '✨ ' + text + '  ';
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
