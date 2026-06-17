// Persistence layer for ChatPanel.
//
// Everything lives in chrome.storage.local. We split storage so a long history
// never has to be loaded all at once:
//   chatpanel:settings        → the single settings object (agents, skills, ui)
//   chatpanel:convIndex       → lightweight [{id,title,updatedAt,agentId,msgs}]
//   chatpanel:conv:<id>       → the full message list for one conversation
//
// All functions are async and safe to call from the side panel or options page.

const K_SETTINGS = 'chatpanel:settings';
const K_INDEX = 'chatpanel:convIndex';
const convKey = (id) => `chatpanel:conv:${id}`;

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// --------------------------------------------------------------------------
// Defaults
// --------------------------------------------------------------------------

// The two coding agents are surfaced through the local Bridge. They appear in
// the picker only when the Bridge reports them as available (see providers.js),
// so it's safe to ship them as built-ins.
export function defaultSettings() {
  return {
    version: 5,
    bridgeUrl: 'http://127.0.0.1:4319',
    activeAgentId: 'claude-code',
    // Free tier: one usable API endpoint + one usable local agent (the user's
    // pick). Everything else stays visible in the picker but locked behind Pro.
    freeEndpointId: 'local-ollama',
    freeAgentId: 'claude-code',
    // Endpoints — the one place for API models: a connection (provider + base
    // URL + key) with a chosen model and optional system prompt/tuning. Chat
    // with one directly; no separate "agent" needed.
    endpoints: [
      {
        id: 'local-ollama',
        name: 'Local · Ollama',
        kind: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: '', // chosen via "Load models" — never assume llama3.1
        models: [],
        systemPrompt: '',
        builtin: true,
      },
    ],
    // Agents — the local bridge (CLI) agents: Claude Code, Codex, Gemini CLI.
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        kind: 'bridge',
        bridgeAgent: 'claude',
        systemPrompt: '',
        workingDir: '',
        permissionMode: 'default',
        useLocalConfig: true,
        builtin: true,
      },
      {
        id: 'codex',
        name: 'Codex',
        kind: 'bridge',
        bridgeAgent: 'codex',
        systemPrompt: '',
        workingDir: '',
        permissionMode: 'default',
        useLocalConfig: true,
        builtin: true,
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        kind: 'bridge',
        bridgeAgent: 'gemini',
        systemPrompt: '',
        workingDir: '',
        permissionMode: 'default',
        useLocalConfig: true,
        builtin: true,
      },
    ],
    skills: defaultSkills(),
    ui: {
      theme: 'system',
      sendOnEnter: true,
      autoAttachActiveTab: true,
      streamResponses: true,
      // Live-meeting context window, in minutes, auto-included per message. 0 = the
      // full transcript so far; a positive value keeps only the last N minutes so
      // long meetings don't grow the prompt every question.
      meetingWindowMin: 0,
      // Live scribe: auto-refresh the running meeting notes every N minutes by
      // merging new transcript into the existing summary. 0 = off.
      liveNotesIntervalMin: 0,
      // Watch mode: re-read the current tab on an interval and re-run the agent
      // when the page changes. Remembered config (the loop is runtime-only).
      watch: { intervalMs: 10000, onlyWhenChanged: true, instruction: '' },
    },
  };
}

export function defaultSkills() {
  return [
    {
      id: 'summarize',
      name: 'Summarize',
      command: 'summarize',
      icon: '📝',
      description: 'Summarize a page, article or document',
      context: 'page',
      prompt:
        'Summarize the attached page(s) in 5 concise bullet points, then list any action items.',
      builtin: true,
    },
    {
      id: 'explain',
      name: 'Explain',
      command: 'explain',
      icon: '💡',
      description: 'Explain content or code in plain language',
      context: 'page',
      prompt:
        'Explain the attached content clearly for a smart non-expert. Define jargon inline.',
      builtin: true,
    },
    {
      id: 'extract',
      name: 'Extract data',
      command: 'extract',
      icon: '📊',
      description: 'Pull structured data from a page into a table',
      context: 'page',
      prompt:
        'Extract the key structured data from the attached content as a Markdown table.',
      builtin: true,
    },
    {
      id: 'review',
      name: 'Code review',
      command: 'review',
      icon: '🔍',
      description: 'Review code or a diff for bugs and improvements',
      context: 'page',
      prompt:
        'Review the code on this page/diff for correctness bugs and clear simplifications. Be specific and cite lines.',
      builtin: true,
    },
    meetingNotesSkill(),
  ];
}

// Structured meeting notes from the live transcript. The transcript auto-attaches
// while capture is active (context:'auto' — no extra page read), so this skill is
// just the prompt. Output structure mirrors a battle-tested meeting-insights
// format: TL;DR, Topics, tagged Key Moments, and owner/due-dated action items.
export function meetingNotesSkill() {
  return {
    id: 'meeting-notes',
    name: 'Meeting notes',
    command: 'notes',
    icon: '📝',
    description: 'Structured notes from the live meeting transcript',
    context: 'auto',
    builtin: true,
    prompt: [
      'You are taking notes from a meeting transcript. It may be PARTIAL/LIVE — write everything "as of now" and never invent a meeting end, decision, owner, or date.',
      'Ground every line strictly in the transcript. Attribute an owner or due date ONLY when it is explicitly stated; otherwise leave it off. Do not pad or speculate.',
      '',
      'Output GitHub-flavored Markdown with these sections, and OMIT any section that has no real content:',
      '',
      '## TL;DR',
      '3–6 bullets: the bottom line — what was aligned on, the key decisions, current status, and the biggest open issue.',
      '',
      '## Topics',
      'A short bullet list of the distinct topics discussed.',
      '',
      '## Key Moments',
      'Bullets, each prefixed with exactly one tag in bold: **[decision]**, **[highlight]**, **[risk]**, or **[question]**. Example:',
      '- **[decision]** The team will ship the queued-state API after end-to-end validation.',
      '- **[risk]** Metering downtime is still being billed today.',
      '- **[question]** Is the use case NTR-only or also TR-side?',
      '',
      '## Action Items',
      'A GitHub task list. Add an owner in _(parentheses)_ only if named, and a due date as — _date_ only if stated:',
      '- [ ] Task described concretely. _(Owner)_ — _due date_',
      '',
      'Be concise and specific; prefer concrete paraphrased statements over vague summaries.',
    ].join('\n'),
  };
}

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

let _settingsCache = null;

// Keep the in-memory cache honest across contexts. The side panel and the
// options page each hold their own cache; when one saves, the other must not
// keep serving a stale object. Drop the cache whenever settings change in
// storage so the next getSettings() re-reads — otherwise an edit in Settings
// (e.g. swapping the Ollama model) wouldn't take effect until a full reload.
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes[K_SETTINGS]) _settingsCache = null;
});

export async function getSettings() {
  if (_settingsCache) return _settingsCache;
  const got = await chrome.storage.local.get(K_SETTINGS);
  const stored = got[K_SETTINGS];
  // Merge over defaults so new fields appear after upgrades without wiping
  // a user's saved agents/skills.
  const base = defaultSettings();
  _settingsCache = stored ? mergeSettings(base, stored) : base;
  // Persist a one-time migration (legacy agents → endpoints) so ids are stable
  // and the side panel & options page stay in agreement.
  if (stored && (stored.version || 0) < 5) {
    await chrome.storage.local.set({ [K_SETTINGS]: _settingsCache });
  }
  return _settingsCache;
}

function mergeSettings(base, stored) {
  const out = { ...base, ...stored };
  out.ui = { ...base.ui, ...(stored.ui || {}) };
  // Keep the user's agents/skills verbatim if present; otherwise the defaults.
  out.agents = Array.isArray(stored.agents) && stored.agents.length ? stored.agents : base.agents;
  out.skills = Array.isArray(stored.skills) ? stored.skills : base.skills;
  // Inject newer built-in skills that didn't exist when the user's skills were
  // saved. Safe one-time add (a brand-new built-in can't have been user-deleted).
  if (!out.skills.some((s) => s.id === 'meeting-notes')) {
    out.skills = [...out.skills, meetingNotesSkill()];
  }
  out.endpoints = Array.isArray(stored.endpoints) ? stored.endpoints : null;

  // v2 migration: include the current page as context by default.
  if (!stored.version || stored.version < 2) {
    out.ui.autoAttachActiveTab = true;
  }
  // v4: one model concept. Every API/model config is an *endpoint* (connection +
  // model + optional system prompt/tuning); `agents` holds only the local bridge
  // (CLI) agents. Folds in both legacy http agents (v2) and the short-lived
  // "model agents" (v3).
  if (!stored.version || stored.version < 4) {
    migrateToEndpoints(out);
  }
  // v5: Free tier is now 1 endpoint + 1 agent. Seed the free slots from what the
  // user was already using so the upgrade doesn't silently switch their agent.
  if (!stored.version || stored.version < 5) {
    const ags = out.agents || [];
    const eps = out.endpoints || [];
    const active = out.activeAgentId;
    out.freeAgentId = ags.some((a) => a.id === active && a.kind === 'bridge')
      ? active
      : ags.find((a) => a.kind === 'bridge')?.id || null;
    out.freeEndpointId = eps.some((e) => e.id === active) ? active : eps[0]?.id || null;
  }
  out.version = 5;
  return out;
}

// Collapse every non-bridge "thing you can chat with" into an endpoint, merging
// ones that share a connection so a v3 endpoint and a model agent built on it
// don't double up. Bridge agents stay in `agents`. activeAgentId is repointed if
// a referenced model agent folds into an existing endpoint.
function migrateToEndpoints(out) {
  const endpoints = (Array.isArray(out.endpoints) ? out.endpoints : []).map((e) => ({
    systemPrompt: '',
    models: [],
    ...e,
  }));
  const connKey = (kind, baseUrl, apiKey) => `${kind}|${(baseUrl || '').trim()}|${apiKey || ''}`;
  const byConn = new Map(endpoints.map((e) => [connKey(e.kind, e.baseUrl, e.apiKey), e]));
  const bridge = [];
  const remap = {};
  for (const a of out.agents || []) {
    if (a.kind === 'bridge') {
      bridge.push(a);
      continue;
    }
    const ref = a.kind === 'model' ? endpoints.find((e) => e.id === a.endpointId) : null;
    const kind = ref?.kind || (a.kind === 'anthropic' ? 'anthropic' : 'openai');
    const baseUrl = ref?.baseUrl ?? a.baseUrl ?? '';
    const apiKey = ref?.apiKey ?? a.apiKey ?? '';
    const key = connKey(kind, baseUrl, apiKey);
    const existing = byConn.get(key);
    if (existing) {
      if (!existing.model && (a.model || ref?.model)) existing.model = a.model || ref.model;
      if (!existing.systemPrompt && a.systemPrompt) existing.systemPrompt = a.systemPrompt;
      remap[a.id] = existing.id;
    } else {
      const ne = {
        id: a.id,
        name: a.name || 'Endpoint',
        kind,
        baseUrl,
        apiKey,
        model: a.model || ref?.model || '',
        models: ref?.models || [],
        systemPrompt: a.systemPrompt || '',
        temperature: a.temperature,
        maxTokens: a.maxTokens,
        builtin: a.builtin,
      };
      endpoints.push(ne);
      byConn.set(key, ne);
      remap[a.id] = ne.id;
    }
  }
  out.endpoints = endpoints.length ? endpoints : defaultSettings().endpoints;
  out.agents = bridge;
  if (remap[out.activeAgentId]) out.activeAgentId = remap[out.activeAgentId];
}

export async function saveSettings(settings) {
  _settingsCache = settings;
  await chrome.storage.local.set({ [K_SETTINGS]: settings });
  return settings;
}

export async function updateSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch, ui: { ...s.ui, ...(patch.ui || {}) } };
  return saveSettings(next);
}

export function getAgent(settings, id) {
  return settings.agents.find((a) => a.id === id) || settings.agents[0];
}

// A "chat target" is anything you can talk to: an endpoint (its default model),
// a model agent (a persona over an endpoint), or a bridge agent. The side-panel
// picker offers all three; this resolves a stored id back to the object, with a
// sensible fallback so the panel always has something to talk to.
export function getTarget(settings, id) {
  const eps = settings.endpoints || [];
  const ags = settings.agents || [];
  return (
    eps.find((e) => e.id === id) ||
    ags.find((a) => a.id === id) ||
    ags.find((a) => a.kind === 'bridge') ||
    eps[0] ||
    ags[0] ||
    null
  );
}

// Flatten a target (+ settings) into the { kind, baseUrl, apiKey, model, … }
// shape providers.streamChat consumes. Endpoints already match; model agents
// merge their endpoint's connection with the agent's overrides; bridge agents
// pass through untouched.
export function resolveTarget(target, settings) {
  if (!target) return null;
  if (target.kind === 'bridge') return target;
  if (!target.endpointId) return target; // an endpoint, used directly
  const ep = (settings.endpoints || []).find((e) => e.id === target.endpointId) || {};
  return {
    name: target.name,
    kind: ep.kind || 'openai',
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: target.model || ep.model || '',
    systemPrompt: target.systemPrompt || '',
    temperature: target.temperature,
    maxTokens: target.maxTokens,
  };
}

// --------------------------------------------------------------------------
// Conversations
// --------------------------------------------------------------------------

export async function getIndex() {
  const got = await chrome.storage.local.get(K_INDEX);
  const idx = got[K_INDEX];
  return Array.isArray(idx) ? idx : [];
}

async function saveIndex(index) {
  await chrome.storage.local.set({ [K_INDEX]: index });
}

export async function getConversation(id) {
  const got = await chrome.storage.local.get(convKey(id));
  return got[convKey(id)] || null;
}

export async function createConversation({ agentId, title } = {}) {
  // A brand-new chat is kept IN MEMORY only — we don't persist it (or add it to
  // the history index) until it gets its first message (see saveConversation).
  // This stops empty "New chat · 0 msgs" entries from piling up every time the
  // side panel opens.
  return {
    id: uid(),
    title: title || 'New chat',
    agentId: agentId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

// Remove empty (0-message) conversations — both leftovers from older builds that
// persisted them eagerly, and any abandoned ones. Safe: they hold no content.
export async function pruneEmptyConversations() {
  const index = await getIndex();
  const empties = index.filter((e) => !e.msgs);
  if (!empties.length) return 0;
  await chrome.storage.local.remove(empties.map((e) => convKey(e.id)));
  await saveIndex(index.filter((e) => e.msgs));
  return empties.length;
}

function indexEntry(conv) {
  return {
    id: conv.id,
    title: conv.title,
    agentId: conv.agentId,
    updatedAt: conv.updatedAt,
    msgs: conv.messages.length,
  };
}

// Persist a conversation and refresh its index entry (auto-titling from the
// first user message if it's still the placeholder title).
export async function saveConversation(conv) {
  if (
    (!conv.title || conv.title === 'New chat') &&
    conv.messages.find((m) => m.role === 'user')
  ) {
    const first = conv.messages.find((m) => m.role === 'user');
    conv.title = titleFrom(first.content);
  }
  conv.updatedAt = Date.now();
  await chrome.storage.local.set({ [convKey(conv.id)]: conv });
  const index = await getIndex();
  const i = index.findIndex((e) => e.id === conv.id);
  const entry = indexEntry(conv);
  if (i >= 0) index[i] = entry;
  else index.unshift(entry);
  // Most-recently-updated first.
  index.sort((a, b) => b.updatedAt - a.updatedAt);
  await saveIndex(index);
  return conv;
}

export async function renameConversation(id, title) {
  const conv = await getConversation(id);
  if (!conv) return;
  conv.title = title;
  await saveConversation(conv);
}

export async function deleteConversation(id) {
  await chrome.storage.local.remove(convKey(id));
  const index = (await getIndex()).filter((e) => e.id !== id);
  await saveIndex(index);
}

export async function clearAllConversations() {
  const index = await getIndex();
  await chrome.storage.local.remove(index.map((e) => convKey(e.id)));
  await saveIndex([]);
}

function titleFrom(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? clean.slice(0, 47) + '…' : clean;
}

// Export one conversation as Markdown (used by the history "export" button).
export function conversationToMarkdown(conv) {
  const L = [`# ${conv.title}`, '', `_${new Date(conv.createdAt).toLocaleString()}_`, ''];
  for (const m of conv.messages) {
    if (m.role === 'user') L.push(`**You:** ${m.content}`, '');
    else if (m.role === 'assistant') L.push(`**${m.agentName || 'Assistant'}:** ${m.content}`, '');
    if (m.attachments?.length) {
      L.push(...m.attachments.map((a) => `> attached: ${a.title || a.url}`), '');
    }
  }
  return L.join('\n');
}
