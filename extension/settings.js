// ChatPanel options page — tabs: API · Agents · Skills · License.
//
//   API     — endpoints: a connection (provider + base URL + key) with a chosen
//             model and optional system prompt/tuning. Chat with one directly.
//   Agents  — the local bridge (CLI) agents: Claude Code, Codex, Gemini CLI,
//             plus the bridge connection itself.
import { getSettings, saveSettings, uid, exportDataArchive, importAllData } from './js/store.js';
import { readZipEntry } from './js/zip.js';
import { checkBridge, updateBridge, testAgent, listModels, listBridgeModels, checkAgentCommand } from './js/providers.js';
import { testMcpServer } from './js/mcp-manager.js';
import { MCP_CATALOG } from './js/mcp-catalog.js';
import { assistPrompt } from './js/assist.js';
import { checkForUpdate, currentVersion, DOWNLOAD_URL } from './js/update.js';
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

  wireTabs();
  renderEndpoints();
  renderBridge();
  renderMcpServers();
  renderSkills();
  renderPrefs();
  renderLicense();
  wire();
  refreshBridgeState();
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
// Model picker (a real <select> populated from the endpoint, + a Custom… entry)
// --------------------------------------------------------------------------
function populateModelSelect(sel, customEl, models, current) {
  models = models || [];
  sel.innerHTML = '';
  const opt = (v, label, selected) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (selected) o.selected = true;
    sel.appendChild(o);
  };
  opt('', '— Select a model —', !current);
  if (current && !models.includes(current)) opt(current, current, true);
  for (const m of models) opt(m, m, m === current);
  opt('__custom__', '✏️ Custom…', false);
  customEl.classList.add('hidden');
  customEl.value = '';
}
function wireModelSelect(sel, customEl, models, current) {
  populateModelSelect(sel, customEl, models, current);
  sel.onchange = () => {
    const custom = sel.value === '__custom__';
    customEl.classList.toggle('hidden', !custom);
    if (custom) customEl.focus();
  };
}
function readModel(sel, customEl) {
  return sel.value === '__custom__' ? customEl.value.trim() : sel.value;
}

// --------------------------------------------------------------------------
// API endpoints
// --------------------------------------------------------------------------
function customEndpointCount() {
  return (settings.endpoints || []).filter((e) => !e.builtin).length;
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
  q('.ep-name').value = ep.name || '';
  q('.ep-kind').value = ep.kind || 'openai';
  q('.ep-baseurl').value = ep.baseUrl || '';
  q('.ep-apikey').value = ep.apiKey || '';
  q('.ep-temp').value = ep.temperature ?? '';
  q('.ep-maxtok').value = ep.maxTokens ?? '';
  q('.ep-system').value = ep.systemPrompt || '';
  q('.ep-acmodel').value = ep.autocompleteModel || '';
  gateField('advancedAgent', q('.ep-system')); // per-agent system prompt is Pro
  applyFreeSlot(node, ep, 'endpoint'); // Free uses one endpoint — the user's pick
  wireModelSelect(q('.ep-model'), q('.ep-model-custom'), ep.models, ep.model);
  // Offer this endpoint's known models as autocomplete-model suggestions (free text
  // still accepted — e.g. a small/fast model your local server also hosts).
  if ((ep.models || []).length) {
    const dl = document.createElement('datalist');
    dl.id = `ep-acmodels-${uid()}`;
    dl.replaceChildren(...ep.models.map((m) => { const o = document.createElement('option'); o.value = m; return o; }));
    node.appendChild(dl);
    q('.ep-acmodel').setAttribute('list', dl.id);
  }

  const conn = () => ({
    name: q('.ep-name').value.trim() || 'Endpoint',
    kind: q('.ep-kind').value,
    baseUrl: q('.ep-baseurl').value.trim(),
    apiKey: q('.ep-apikey').value,
  });

  q('.ep-load').onclick = async () => {
    const st = q('.ep-status');
    setStatus(st, 'Loading models…');
    try {
      const ids = await listModels(conn());
      if (!ids.length) return setStatus(st, 'Endpoint returned no models', 'err');
      ep.models = ids;
      wireModelSelect(q('.ep-model'), q('.ep-model-custom'), ids, readModel(q('.ep-model'), q('.ep-model-custom')) || ep.model);
      await saveSettings(settings);
      setStatus(st, `✓ ${ids.length} models — pick one below`, 'ok');
    } catch (e) {
      setStatus(st, '✕ ' + e.message, 'err');
    }
  };

  q('.ep-test').onclick = async () => {
    const st = q('.ep-status');
    const model = readModel(q('.ep-model'), q('.ep-model-custom'));
    if (!model) return setStatus(st, '✕ Pick a model first', 'err');
    setStatus(st, 'Testing…');
    try {
      const reply = await testAgent({ ...conn(), model, systemPrompt: '', maxTokens: 64 }, settings);
      setStatus(st, `✓ Replied: "${reply.slice(0, 40)}"`, 'ok');
    } catch (e) {
      setStatus(st, '✕ ' + e.message, 'err');
    }
  };

  q('.ep-save').onclick = async () => {
    Object.assign(ep, {
      name: q('.ep-name').value.trim() || 'Endpoint',
      kind: q('.ep-kind').value,
      baseUrl: q('.ep-baseurl').value.trim(),
      apiKey: q('.ep-apikey').value,
      model: readModel(q('.ep-model'), q('.ep-model-custom')),
      autocompleteModel: q('.ep-acmodel').value.trim(),
      temperature: q('.ep-temp').value === '' ? undefined : Number(q('.ep-temp').value),
      maxTokens: q('.ep-maxtok').value === '' ? undefined : Number(q('.ep-maxtok').value),
      systemPrompt: q('.ep-system').value,
    });
    await saveSettings(settings);
    setStatus(q('.ep-status'), '✓ Saved', 'ok');
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
  // Adding endpoints is free — only *using* more than one is Pro (enforced in
  // the agent picker). Extra endpoints stay visible there, locked, as upsell.
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
  // Common model ids per engine, offered as a typeahead dropdown (datalist) while
  // still accepting any custom string — CLIs have no queryable model list. The
  // newer CLIs expose a "Load models" command, so their lists fill on demand.
  const MODEL_LIST = {
    claude: ['opus', 'sonnet', 'haiku'],
    antigravity: [],
    codex: [],
    pi: [],
    opencode: [],
    kiro: [],
  };
  const dl = document.createElement('datalist');
  dl.id = `ba-models-${uid()}`;
  node.appendChild(dl);
  q('.ba-model').setAttribute('list', dl.id);
  q('.ba-acmodel').setAttribute('list', dl.id);

  // Show/hide the custom block and refresh the availability line for the kind.
  const syncKind = () => {
    const kind = q('.ba-kind').value;
    const isCustom = kind === 'custom';
    q('.ba-custom').classList.toggle('hidden', !isCustom);
    // local skills/MCP & per-agent system prompt only apply to the built-in CLIs.
    q('.ba-local').closest('.check').classList.toggle('hidden', isCustom);
    // Model fields show for every kind — a custom CLI passes the chosen model via
    // its configured "Pass model via" arg. Seed the datalist with known ids for
    // built-ins; custom starts empty until "Load models" populates it.
    q('.ba-model').placeholder = MODEL_HINT[kind] || "blank = default  ·  use Load models →";
    dl.replaceChildren(...(MODEL_LIST[kind] || []).map((m) => { const o = document.createElement('option'); o.value = m; return o; }));
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
      dl.replaceChildren(...models.map((m) => { const o = document.createElement('option'); o.value = m; return o; }));
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
}

function mcpServerCard(server, index = 0) {
  const node = $('mcp-server-tpl').content.firstElementChild.cloneNode(true);
  const q = (sel) => node.querySelector(sel);
  q('.mcp-name').value = server.name || '';
  q('.mcp-url').value = server.url || '';
  q('.mcp-auth').value = server.headers?.Authorization || '';
  q('.mcp-enabled').checked = server.enabled !== false;
  const status = q('.mcp-status');

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
    server.url = q('.mcp-url').value.trim();
    server.enabled = q('.mcp-enabled').checked;
    const auth = q('.mcp-auth').value.trim();
    server.headers = auth ? { Authorization: auth } : {};
    await saveSettings(settings);
  };
  q('.mcp-name').onchange = commit;
  q('.mcp-url').onchange = commit;
  q('.mcp-auth').onchange = commit;
  q('.mcp-enabled').onchange = commit;

  q('.mcp-test').onclick = async () => {
    await commit();
    if (!server.url) { status.textContent = 'Enter a URL first'; return; }
    status.textContent = 'Connecting…';
    try {
      const tools = await testMcpServer(server);
      status.textContent = tools.length
        ? `✓ ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map((t) => t.name).slice(0, 6).join(', ')}${tools.length > 6 ? '…' : ''}`
        : '✓ connected (0 tools)';
    } catch (e) {
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
  settings.mcpServers = settings.mcpServers || [];
  settings.mcpServers.push({ id: uid(), name: 'New MCP server', url: '', enabled: true, headers: {} });
  saveSettings(settings);
  renderMcpServers();
  $('mcp-list').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

// Discover: one-click add of known public remote MCP servers.
function renderMcpCatalog() {
  const root = $('mcp-catalog');
  if (!root) return;
  root.innerHTML = '';
  const have = (url) => (settings.mcpServers || []).some((s) => s.url === url);
  for (const item of MCP_CATALOG) {
    const el = document.createElement('div');
    el.className = 'mcp-cat-item';
    const added = have(item.url);
    el.innerHTML =
      `<div class="mcp-cat-main">` +
      `<div class="mcp-cat-name">${item.name}${item.auth ? ' <span class="mcp-cat-auth">auth</span>' : ' <span class="mcp-cat-free">no auth</span>'}</div>` +
      `<div class="mcp-cat-desc">${item.desc}</div>` +
      `<div class="mcp-cat-url">${item.url}</div>` +
      `</div>` +
      `<button class="btn mcp-cat-add"${added ? ' disabled' : ''}>${added ? '✓ Added' : '+ Add'}</button>`;
    el.querySelector('.mcp-cat-add').onclick = async () => {
      settings.mcpServers = settings.mcpServers || [];
      settings.mcpServers.push({ id: uid(), name: item.name, url: item.url, enabled: true, headers: {} });
      await saveSettings(settings);
      renderMcpServers();
      renderMcpCatalog();
    };
    root.appendChild(el);
  }
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

function skillCard(skill) {
  const node = $('skill-tpl').content.firstElementChild.cloneNode(true);
  const q = (sel) => node.querySelector(sel);
  q('.s-icon').value = skill.icon || '';
  q('.s-name').value = skill.name || '';
  q('.s-cmd').value = skill.command || '';
  q('.s-desc').value = skill.description || '';
  q('.s-prompt').value = skill.prompt || '';
  q('.s-context').value = skill.context || 'auto';
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
    Object.assign(skill, {
      icon: q('.s-icon').value.trim(),
      name: q('.s-name').value.trim() || 'Skill',
      command: q('.s-cmd').value.trim().replace(/^\//, ''),
      description: q('.s-desc').value.trim(),
      prompt: q('.s-prompt').value,
      context: q('.s-context').value,
      agentId: q('.s-agent').value,
    });
    await saveSettings(settings);
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
  settings.skills.push({ id: uid(), name: 'New skill', command: 'mycmd', icon: '⚡', prompt: '' });
  saveSettings(settings);
  renderSkills();
  $('skills').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

// --------------------------------------------------------------------------
// Preferences
// --------------------------------------------------------------------------
function renderPrefs() {
  $('pref-theme').value = settings.ui.theme || 'system';
  $('pref-enter').checked = settings.ui.sendOnEnter !== false;
  $('pref-stream').checked = settings.ui.streamResponses !== false;
  // Autocomplete is a Pro feature — gate the toggle for Free users.
  const ac = $('pref-autocomplete');
  const pro = isPro(license);
  ac.checked = pro && !!settings.ui.autocomplete;
  ac.disabled = !pro;
  $('pref-autocomplete-row').classList.toggle('locked', !pro);
  $('pref-pageact-cdp').checked = !!settings.ui.pageActionsCdp;
}
async function savePrefs() {
  settings.ui.theme = $('pref-theme').value;
  settings.ui.sendOnEnter = $('pref-enter').checked;
  settings.ui.streamResponses = $('pref-stream').checked;
  settings.ui.autocomplete = isPro(license) && $('pref-autocomplete').checked;
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
function renderGateBadges() {
  badgeButton($('add-skill'), !can(license, 'customSkills'));
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
  $('add-skill').onclick = addSkill;

  $('bridge-test').onclick = testBridge;
  $('bridge-url').onchange = async () => {
    settings.bridgeUrl = $('bridge-url').value.trim();
    await saveSettings(settings);
  };

  $('pref-theme').onchange = savePrefs;
  $('pref-enter').onchange = savePrefs;
  $('pref-stream').onchange = savePrefs;
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
      const { conversations, meetings } = await importAllData(data, { mode });
      const parts = [`${conversations.imported} conversation${conversations.imported === 1 ? '' : 's'}`];
      if (meetings.imported) parts.push(`${meetings.imported} meeting${meetings.imported === 1 ? '' : 's'}`);
      const skipped = (conversations.total - conversations.imported) + (meetings.total - meetings.imported);
      setStatus(msg, `✓ Restored ${parts.join(' + ')}${skipped ? ` (${skipped} skipped)` : ''}. Reopen ChatPanel to see them.`, 'ok');
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
