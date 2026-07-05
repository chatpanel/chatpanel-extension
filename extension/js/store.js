// Persistence layer for ChatPanel.
//
// Everything lives in chrome.storage.local. We split storage so a long history
// never has to be loaded all at once:
//   chatpanel:settings        → the single settings object (agents, skills, ui)
//   chatpanel:convIndex       → lightweight [{id,title,updatedAt,agentId,msgs}]
//   chatpanel:conv:<id>       → the full message list for one conversation
//
// All functions are async and safe to call from the side panel or options page.

import { exportMeetings, importMeetings, meetingToMarkdown } from './store-meetings.js';
import { exportNotes, importNotes, noteToMarkdown } from './store-notes.js';
import { exportNotesConfig, importNotesConfig } from './notes-config.js';
import { exportOAuthTokens, importOAuthTokens } from './oauth.js';
import { makeZip } from './zip.js';
import { sealJSON, openJSON } from './secret-crypto.js';

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
    version: 9,
    bridgeUrl: 'http://127.0.0.1:4319',
    // Fresh-install target is the ZERO-SETUP in-browser model — it works on the very
    // first message with no API key, no local bridge/gateway, nothing to run (a small
    // model downloads once and runs on WebGPU). This is what lets a brand-new user (or
    // a Web Store reviewer) actually chat. The bridge CLIs / API endpoints are still
    // there to switch to; they just aren't the default dead-end anymore.
    activeAgentId: 'in-browser',
    // MCP servers (Streamable HTTP) the in-extension agent loop can call as tools.
    // Each: { id, name, url, enabled, headers? }. stdio servers aren't reachable
    // from MV3 — front them with an HTTP bridge.
    mcpServers: [],
    // User-added in-browser (WebLLM) models: { id, model, model_lib } — an MLC-converted
    // HF repo URL + its model-lib WASM URL. Folded into the WebLLM catalog at load.
    webllmCustomModels: [],
    // Free tier: one usable API endpoint + one usable local agent (the user's
    // pick). Others remain visible in the picker but require Pro. The free endpoint
    // is the in-browser model, so the free experience needs zero external setup.
    freeEndpointId: 'in-browser',
    freeAgentId: 'claude-code',
    // Endpoints — the one place for API models: a connection (provider + base
    // URL + key) with a chosen model and optional system prompt/tuning. Chat
    // with one directly; no separate "agent" needed.
    endpoints: [
      {
        // The zero-setup default. kind:'webllm' routes to the in-browser WebGPU model
        // (js/webllm.js) — no baseUrl/apiKey; the model id is a WebLLM prebuilt.
        id: 'in-browser',
        name: 'WebLLM',
        kind: 'webllm',
        baseUrl: '',
        apiKey: '',
        model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        models: [],
        systemPrompt: '',
        builtin: true,
      },
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
    // Agents — the local bridge (CLI) agents: Claude Code, Codex, Antigravity.
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
        id: 'antigravity',
        name: 'Antigravity',
        kind: 'bridge',
        bridgeAgent: 'antigravity',
        systemPrompt: '',
        workingDir: '',
        permissionMode: 'default',
        useLocalConfig: true,
        builtin: true,
      },
      {
        id: 'pi',
        name: 'Pi',
        kind: 'bridge',
        bridgeAgent: 'pi',
        systemPrompt: '',
        workingDir: '',
        permissionMode: 'default',
        useLocalConfig: true,
        builtin: true,
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        kind: 'bridge',
        bridgeAgent: 'opencode',
        systemPrompt: '',
        workingDir: '',
        permissionMode: 'default',
        useLocalConfig: true,
        builtin: true,
      },
      {
        id: 'kiro',
        name: 'Kiro',
        kind: 'bridge',
        bridgeAgent: 'kiro',
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
      // Enforced response language for every model call (injected into the system
      // prompt at the single streamChat chokepoint). '' = Auto (match the user).
      language: '',
      sendOnEnter: true,
      autoAttachActiveTab: true,
      streamResponses: true,
      // Live-meeting context window, in minutes, auto-included per message. 0 = the
      // full transcript so far; a positive value keeps only the last N minutes so
      // long meetings don't grow the prompt every question.
      meetingWindowMin: 0,
      // Live scribe: auto-refresh the running meeting notes every N minutes by
      // merging new transcript into the existing summary. 0 = off. Default 2m so
      // meetings are summarized (and saved to Past Meetings) out of the box.
      liveNotesIntervalMin: 2,
      // Topic extraction: when enabled, ChatPanel extracts durable graph topics
      // after chats/meetings change. Blank targetId means the current active
      // model/agent; a specific target id pins extraction to that configured model.
      topicExtraction: { enabled: true, targetId: '' },
      // Empty-chat prompt suggestions (js/suggestions.js). The universal fallbacks
      // always show; when `enabled`, ChatPanel asks a small model for page-specific
      // ideas using ONLY lightweight metadata (URL, title, description) — never the
      // page body. Off by default so browsing triggers no model calls; turn it on
      // once to use it everywhere. `targetId` pins which configured API/agent runs it
      // (blank = the active model/agent — prefer a small/cheap one to keep it fast).
      suggestions: { enabled: false, targetId: '' },
      // Watch mode: re-read the current tab on an interval and re-run the agent
      // when the page changes. Remembered config (the loop is runtime-only).
      watch: { intervalMs: 10000, onlyWhenChanged: true, instruction: '' },
      // Right icon-rail collapsed state.
      railCollapsed: false,
      // WARM search tier (opt-in). When enabled, the extension pushes its DECRYPTED
      // history to the LOCAL gateway's index so it (and other on-device tools/agents)
      // can search the full corpus off the browser thread. Off by default — it sends
      // decrypted data to the local gateway (on-device, but an explicit choice).
      warmSearch: { enabled: false, url: 'http://127.0.0.1:4320' },
      // MCP tool exposure for chat turns:
      // auto = only skills that explicitly enable MCP get tools; off = never;
      // on = expose configured MCP servers for the next turns.
      mcpToolsMode: 'auto',
      // Local RAG context for normal chat turns. Off by default for privacy;
      // users can enable chats, meetings, or both from the composer.
      historyContextMode: 'off',
      // Expose the read-only history tools (history_search, history_list_meetings,
      // history_get_meeting, …) to the agent on every turn, so it can look up past
      // chats/meetings on demand instead of only when /history is typed. On by
      // default; the agent only calls them when a question refers to prior work,
      // and meeting access still requires Pro. Set false to never offer them.
      historyTools: true,
      // Built-in web search (context engineering). When the user types
      // `/search <query>`, ChatPanel fetches each enabled engine's results
      // (invisibly — no tab), pulls the top-N links + snippets, deep-fetches the
      // top pages, re-ranks vs the query, and attaches the bundle as context — so
      // it works for every model/agent without tool support. Engines use a
      // Chrome-style `%s` (or `{q}`) placeholder. Defaults (Startpage, Mojeek)
      // serve real results to a plain fetch; DuckDuckGo/Bing/Google return an
      // anti-bot challenge to fetch and only work via the background-tab fallback,
      // so they're off by default.
      webSearch: {
        enabled: true,
        perEngine: 5, // top-N links taken from each engine's SERP
        maxPages: 5, // how many result pages are actually deep-fetched + ranked
        // Last-resort tab render: when BOTH the reader and a direct fetch fail for
        // a SERP or a result page, open it in a background tab so its JS runs, read
        // it, and close it. OPT-IN (default off): a rendered page emits its own
        // console warnings (font preloads, CSP) that we can't silence without the
        // declarativeNetRequest permission. Off → result pages never open a tab; a
        // failed fetch just uses the SERP snippet.
        tabFallback: false,
        // Reader service: fetch result CONTENT as clean Markdown via a reader
        // instead of parsing site HTML. OPT-IN (default off): anonymous Jina is
        // blocked (401) so it needs an API key or a self-hosted reader. PRIVACY:
        // each result URL is sent to this third party. Off → reliable local parse.
        reader: { enabled: false, url: 'https://r.jina.ai/', key: '' },
        engines: [
          { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', enabled: true },
          { id: 'mojeek', name: 'Mojeek', url: 'https://www.mojeek.com/search?q=%s', enabled: true },
          { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=%s', enabled: false },
          { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', enabled: false },
          { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', enabled: false },
        ],
      },
      // Cap how many tools are advertised to the model per turn — many enabled MCP
      // servers can mean dozens of tools, which bloats the prompt and slows the model.
      // Local page/history tools are always kept; remote MCP tools beyond the cap are
      // dropped by lexical relevance to the message. 0 = no limit.
      maxToolsPerTurn: 24,
      // Reversible PII redaction (Privacy tab). Strips sensitive values out of
      // everything sent to a model and reconstructs them when rendering the reply.
      // Off by default (opt-in). mode: 'off' | 'deterministic' | 'model'
      // ('model' adds the configurable local-model detection pass — phase 2).
      // tier: 'basic' (regex) | 'full' (entity-aware; Pro). dictionary entries are
      // {value,type} (exact) or {pattern,flags,type} (regex).
      piiRedaction: {
        mode: 'off',
        tier: 'basic',
        // Redact for: 'all' chat models | 'remote' only (skip localhost models, which
        // keep data on-device, so redaction is optional there).
        applyTo: 'all',
        scope: { chat: true, context: true, history: true, toolResults: true },
        sources: { self: true, participants: true, contacts: false },
        // How tools receive redacted values. Local tools (history/meeting/page) always
        // get the real value; this controls REMOTE MCP tools: 'real' = send real values
        // (search/retrieval work, but the value reaches the MCP server) | 'redactRemote'
        // = MCP tools get placeholders (PII stays off third-party servers).
        toolData: 'real',
        dictionary: [],
        // Phase 2: configurable LOCAL entity detector (auto-redact names/orgs/IDs
        // with no dictionary). backend 'off' | 'endpoint' (spaCy/Presidio/any
        // {text}->entities service) | 'openai' (a local OpenAI-compatible LLM,
        // e.g. llama.cpp / Ollama) | 'agent' (a CONFIGURED API/agent: endpoint via its
        // connection, bridge CLI via dispatchStream). Latency-guarded (cache + timeout
        // + fail-open). `types` lets the user choose which detected categories to
        // redact, so e.g. turning off `location` keeps city names readable for geo Qs.
        detection: {
          backend: 'off', url: '', model: '', targetId: '', timeoutMs: 1500, maxChars: 8000,
          types: { person: true, org: true, location: true, number: true },
        },
      },
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
      prompt: [
        'Summarize the attached page(s) for someone who has not read them.',
        'Ground every point strictly in the content — do not add outside facts or speculate.',
        '',
        'Output GitHub-flavored Markdown:',
        '- A one-sentence **TL;DR** — what this is and its single most important takeaway.',
        '- 3–6 bullets covering the key points, most important first.',
        '- An **Action items** task list (`- [ ] …`) ONLY if the content implies concrete next steps; otherwise omit the section entirely.',
        '',
        'Scale the length to the material — a short page gets a short summary. Be specific; prefer concrete details over vague generalities.',
      ].join('\n'),
      builtin: true,
      mcpMode: 'none',
    },
    {
      id: 'explain',
      name: 'Explain',
      command: 'explain',
      icon: '💡',
      description: 'Explain content or code in plain language',
      context: 'page',
      prompt: [
        'Explain the attached content to a smart non-expert who is new to the topic.',
        'Base the explanation only on what is in the content; if something is unclear or missing, say so rather than guessing.',
        '',
        'Cover, in plain language:',
        '1. **What it is** — the core idea in one or two sentences.',
        '2. **How it works** — the key parts and how they fit together. If it is code, walk through what it does and the important logic.',
        '3. **Why it matters** — the purpose, use case, or implication.',
        '',
        'Define any jargon inline the first time it appears. Use short paragraphs or bullets; keep it concise and concrete.',
      ].join('\n'),
      builtin: true,
      mcpMode: 'none',
    },
    {
      id: 'extract',
      name: 'Extract data',
      command: 'extract',
      icon: '📊',
      description: 'Pull structured data from a page into a table',
      context: 'page',
      prompt: [
        'Extract the structured data from the attached content.',
        'First identify the repeating record type (e.g. products, people, rows, transactions): make each record one row and infer clear column headers from the fields present.',
        '',
        'Output format: default to a **Markdown table**, but if the user asked for a specific format in their message (CSV, JSON, YAML, TSV, etc.), produce exactly that format instead.',
        '',
        'Rules:',
        '- Use only values present in the content — never invent or estimate. Leave a cell empty (or null) where a value is missing.',
        '- Keep units, currency, and symbols with their values, and preserve the source ordering.',
        '- If the content holds several distinct datasets, output one labeled table/array per dataset.',
        '- If there is no tabular or structured data to extract, say so in one line instead of forcing a table.',
      ].join('\n'),
      builtin: true,
      mcpMode: 'none',
    },
    {
      id: 'review',
      name: 'Code review',
      command: 'review',
      icon: '🔍',
      description: 'Review code or a diff for bugs and improvements',
      context: 'page',
      prompt: [
        'Review the code (or diff) on the attached page as an experienced engineer.',
        'Prioritize real problems over style. Only flag issues you can actually see in the code — do not speculate about code that is not shown.',
        '',
        'Output GitHub-flavored Markdown, grouped by severity (omit any group that is empty):',
        '- **🐞 Bugs & correctness** — logic errors, unhandled edge cases, security or data-loss risks.',
        '- **⚠️ Risks & smells** — fragile patterns, missing error handling, unclear naming.',
        '- **✨ Simplifications** — clearer or more concise equivalents.',
        '',
        'For each finding: cite the location (file and/or line), explain the problem in a sentence, and give a concrete fix or short code snippet. If the code looks solid, say so plainly instead of inventing issues.',
      ].join('\n'),
      builtin: true,
      mcpMode: 'none',
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
    mcpMode: 'none',
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
      '4–8 bullets. Start each bullet with a short topic label followed by a colon, then 1–2 sentences of concrete context about what was discussed and why it mattered.',
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
// Guard `chrome` so this module is import-safe outside the extension (Node tests,
// SSR): the listener only matters in a real extension context anyway.
if (typeof chrome !== 'undefined') {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[K_SETTINGS]) _settingsCache = null;
  });
}

// Secrets are encrypted at rest (secret-crypto.js): on-disk these fields are AES-GCM
// envelopes, everything in memory / returned / backed-up stays plaintext. We seal
// only inside writeSettings() and open only inside getSettings(), so every caller —
// and the portable backup — keeps seeing real values. Sealed per-entry (not the whole
// blob) so a lost/rotated key costs only these fields, not the entire config.
const SECRET_ARRAYS = ['endpoints', 'mcpServers']; // arrays whose entries carry secrets
const SECRET_ENTRY_FIELDS = ['apiKey', 'headers'];  // API keys + MCP auth headers

async function transformSecrets(settings, fn) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const arr of SECRET_ARRAYS) {
    if (!Array.isArray(settings[arr])) continue;
    out[arr] = await Promise.all(settings[arr].map(async (item) => {
      if (!item || typeof item !== 'object') return item;
      const copy = { ...item };
      for (const f of SECRET_ENTRY_FIELDS) {
        if (f in copy && copy[f] != null && copy[f] !== '') copy[f] = await fn(copy[f]);
      }
      return copy;
    }));
  }
  return out;
}
const sealSettings = (s) => transformSecrets(s, sealJSON);
const openSettings = (s) => transformSecrets(s, openJSON);

// The ONLY path that persists settings — seals secrets first. All three set sites
// (migration re-save, saveSettings, backup import) go through here.
async function writeSettings(obj) {
  await chrome.storage.local.set({ [K_SETTINGS]: await sealSettings(obj) });
}

export async function getSettings() {
  if (_settingsCache) return _settingsCache;
  const got = await chrome.storage.local.get(K_SETTINGS);
  const stored = await openSettings(got[K_SETTINGS]); // decrypt secrets before merge
  // Merge over defaults so new fields appear after upgrades without wiping
  // a user's saved agents/skills.
  const base = defaultSettings();
  _settingsCache = stored ? mergeSettings(base, stored) : base;
  // Persist a one-time migration (legacy agents → endpoints) so ids are stable
  // and the side panel & options page stay in agreement.
  if (stored && (stored.version || 0) < base.version) {
    await writeSettings(_settingsCache);
  }
  return _settingsCache;
}

function mergeSettings(base, stored) {
  const out = { ...base, ...stored };
  out.version = base.version;
  out.ui = { ...base.ui, ...(stored.ui || {}) };
  // Keep the user's agents/skills verbatim if present; otherwise the defaults.
  out.agents = Array.isArray(stored.agents) && stored.agents.length ? stored.agents : base.agents;
  out.skills = Array.isArray(stored.skills) ? stored.skills : base.skills;
  // Inject newer built-in skills that didn't exist when the user's skills were
  // saved. Safe one-time add (a brand-new built-in can't have been user-deleted).
  if (!out.skills.some((s) => s.id === 'meeting-notes')) {
    out.skills = [...out.skills, meetingNotesSkill()];
  }
  out.skills = out.skills.map((skill) =>
    normalizeSkillMcpDefaults(skill, { legacyBuiltins: !stored.version || stored.version < 6 }),
  );
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
  // v7: web-search defaults moved to fetch-friendly engines (Startpage/Mojeek);
  // older installs persisted the now-bot-walled DuckDuckGo default, so refresh the
  // engine list while keeping the user's enabled/count preferences.
  if (!stored.version || stored.version < 7) {
    out.ui.webSearch = {
      ...base.ui.webSearch,
      ...(out.ui.webSearch || {}),
      engines: base.ui.webSearch.engines.map((e) => ({ ...e })),
    };
  }
  // v9: the web-search last-resort tab render is opt-in (its rendered pages emit
  // console warnings we can't silence). Force it OFF again — earlier installs got
  // it stuck on, so result pages kept opening tabs every search. The fallback code
  // and the Tools → Web search toggle remain for anyone who wants to opt back in.
  if ((!stored.version || stored.version < 9) && out.ui.webSearch) {
    out.ui.webSearch.tabFallback = false;
  }
  out.version = base.version;
  return out;
}

function normalizeSkillMcpDefaults(skill, { legacyBuiltins = false } = {}) {
  if (!skill || typeof skill !== 'object') return skill;
  const out = { ...skill };
  if (!out.mcpMode || (legacyBuiltins && out.builtin && out.mcpMode === 'default')) out.mcpMode = 'none';
  return normalizeSkillForSave(out);
}

export function normalizeSkillForSave(skill) {
  if (!skill || typeof skill !== 'object') return skill;
  const out = { ...skill };
  const mode = String(out.mcpMode || 'none').toLowerCase();
  out.mcpMode = mode === 'selected' || mode === 'default' ? mode : 'none';
  const ids = Array.isArray(out.mcpServerIds) ? out.mcpServerIds : [];
  out.mcpServerIds =
    out.mcpMode === 'selected'
      ? [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))]
      : [];
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
  if (Array.isArray(settings?.skills)) {
    settings.skills = settings.skills.map(normalizeSkillForSave);
  }
  if (settings && typeof settings === 'object') settings.version = defaultSettings().version;
  _settingsCache = settings;
  await writeSettings(settings);
  return settings;
}

export async function resetSkillsToDefaults() {
  const settings = await getSettings();
  settings.skills = defaultSkills().map(normalizeSkillForSave);
  return saveSettings(settings);
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
    authMode: ep.authMode,
    oauth: ep.oauth,
    providerPreset: ep.providerPreset,
    headers: ep.headers || {},
    extraBody: ep.extraBody || {},
    model: target.model || ep.model || '',
    autocompleteModel: target.autocompleteModel || ep.autocompleteModel || '',
    systemPrompt: target.systemPrompt || '',
    temperature: target.temperature,
    maxTokens: target.maxTokens,
    maxRequestsPerTurn: target.maxRequestsPerTurn ?? ep.maxRequestsPerTurn,
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

// --------------------------------------------------------------------------
// Backup & restore (Pro) — move chats between machines / survive a reinstall.
// All local: the export is a plain JSON file the user holds; nothing is uploaded.
// --------------------------------------------------------------------------
const BACKUP_TYPE = 'chatpanel-backup';

// Bundle every conversation (full message bodies) into a single serializable
// object suitable for download.
export async function exportConversations() {
  const index = await getIndex();
  const conversations = [];
  for (const e of index) {
    const c = await getConversation(e.id);
    if (c) conversations.push(c);
  }
  return { type: BACKUP_TYPE, version: 1, exportedAt: Date.now(), count: conversations.length, conversations };
}

// Restore a backup. mode 'merge' (default) keeps existing chats and adds/updates
// by id; mode 'replace' clears existing first. Original titles/timestamps are
// preserved (we don't re-stamp via saveConversation). Returns { imported, total }.
export async function importConversations(data, { mode = 'merge' } = {}) {
  if (!data || data.type !== BACKUP_TYPE || !Array.isArray(data.conversations)) {
    throw new Error('That doesn’t look like a ChatPanel backup file.');
  }
  if (mode === 'replace') await clearAllConversations();
  const index = await getIndex();
  const byId = new Map(index.map((e) => [e.id, e]));
  const writes = {};
  let imported = 0;
  for (const conv of data.conversations) {
    if (!conv || !conv.id || !Array.isArray(conv.messages)) continue;
    writes[convKey(conv.id)] = conv;
    byId.set(conv.id, indexEntry(conv));
    imported++;
  }
  if (imported) await chrome.storage.local.set(writes);
  const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  await saveIndex(merged);
  return { imported, total: data.conversations.length };
}

// "Export data" — the FULL portable backup: everything needed to recreate this
// install on another machine. version 6 adds `notesConfig` (the Notes UI +
// co-writer swarm config — role→model overrides, gear, source filter, layout —
// which lives in localStorage, so it travels too); version 5 added `notes`;
// version 4 adds `oauthTokens` (endpoint sign-ins, so a restore doesn't force a
// re-auth); version 3 added `settings` (endpoints incl. API keys, local/bridge
// agents, MCP servers incl. auth, skills, preferences); version 2 added
// `meetings`. Older files still restore (missing parts come back empty). The
// license is NOT exported — it re-activates by
// purchase email / Pro sync. The install-id, runtime UI state, and the local
// meeting-encryption key are also excluded (re-derived per install; meetings are
// decrypted on export and re-encrypted under the destination's own key on
// import). All client-side; nothing is uploaded. NOTE: this file contains
// secrets (API keys, MCP auth, OAuth tokens) — treat it like a password.
export async function exportAllData() {
  const conv = await exportConversations();
  const meetings = await exportMeetings();
  const notes = await exportNotes(); // v5 — user notes as a third first-class source
  const notesConfig = await exportNotesConfig(); // v6 — Notes UI + co-writer config (localStorage)
  const settings = await getSettings();
  const oauthTokens = await exportOAuthTokens(); // endpoint sign-ins (v4) — see SECURITY note above
  return {
    type: BACKUP_TYPE,
    version: 6,
    exportedAt: Date.now(),
    count: conv.count,
    conversations: conv.conversations,
    meetingsCount: meetings.length,
    meetings,
    notesCount: notes.length,
    notes,
    notesConfig,
    settings,
    oauthTokens,
  };
}

// Restore a full backup. Conversations and meetings honor `mode` ('merge' |
// 'replace'). Settings are configuration (not a list), so when present they are
// always applied over the defaults — that's what makes a fresh install match the
// source machine. Returns per-kind results (settings: true when restored).
export async function importAllData(data, { mode = 'merge' } = {}) {
  const conversations = await importConversations(data, { mode }); // validates the file
  const meetings = await importMeetings(data.meetings, { mode });
  const notes = await importNotes(data.notes, { mode }); // v5+; older backups have no notes
  // v6+: Notes UI + co-writer config (localStorage). Older backups have none.
  if (data.notesConfig && typeof data.notesConfig === 'object') {
    await importNotesConfig(data.notesConfig, { mode });
  }
  let settings = false;
  if (data.settings && typeof data.settings === 'object') {
    const merged = mergeSettings(defaultSettings(), data.settings); // folds in any newer fields
    await writeSettings(merged); // seals secrets at rest; onChanged clears the cache
    _settingsCache = null;
    settings = true;
  }
  // OAuth tokens (v4+) ride along so restored endpoints stay signed in. Honor the
  // same merge/replace mode as the rest of the backup.
  if (data.oauthTokens && typeof data.oauthTokens === 'object') {
    await importOAuthTokens(data.oauthTokens, { mode });
  }
  return { conversations, meetings, notes, settings };
}

// "Export all data" as a ZIP that is BOTH a restorable backup and a browsable
// archive: chatpanel-data.json (what Restore reads) + human-readable Markdown for
// every conversation and meeting. Returns { blob, count, meetingsCount }.
const ARCHIVE_README =
  'ChatPanel data export — full portable backup\n\n' +
  '• chatpanel-data.json — the complete backup. Use Settings → Restore from file\n' +
  '  to import it on this or a fresh install on another machine. It restores your\n' +
  '  settings (API endpoints & keys, agents, MCP servers, skills, preferences),\n' +
  '  all chat history, and all captured meetings. Keep this file safe.\n' +
  '• settings.json — a readable copy of your configuration (NOT used by Restore).\n' +
  '• conversations/*.md and meetings/*.md — human-readable copies for reading or\n' +
  '  sharing. These are NOT used by Restore.\n\n' +
  'SECURITY: chatpanel-data.json and settings.json contain your API keys and any\n' +
  'MCP auth tokens. Treat this file like a password. Your ChatPanel Pro license is\n' +
  'NOT included — it re-activates from your purchase email / Pro sync.\n\n' +
  'Everything here stayed on your device — nothing was uploaded.\n';

export async function exportDataArchive(precomputed) {
  const data = precomputed || (await exportAllData());
  const files = [
    { name: 'chatpanel-data.json', data: JSON.stringify(data) },
    { name: 'settings.json', data: JSON.stringify(data.settings, null, 2) },
    { name: 'README.txt', data: ARCHIVE_README },
  ];
  const used = new Set();
  const mdName = (dir, title, ts) => {
    const date = new Date(ts || Date.now()).toISOString().slice(0, 10);
    const safe = (title || 'untitled').replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
    let name = `${dir}/${date} — ${safe}.md`;
    for (let n = 2; used.has(name); n++) name = `${dir}/${date} — ${safe} (${n}).md`;
    used.add(name);
    return name;
  };
  for (const conv of data.conversations) {
    files.push({ name: mdName('conversations', conv.title, conv.createdAt), data: conversationToMarkdown(conv) });
  }
  for (const m of data.meetings) {
    const md = meetingToMarkdown(m.record) + (m.notes ? `\n\n## Summary\n\n${m.notes}\n` : '');
    files.push({ name: mdName('meetings', m.record.title, m.record.startedAt), data: md });
  }
  for (const n of data.notes || []) {
    files.push({ name: mdName('notes', n.title, n.updatedAt || n.createdAt), data: noteToMarkdown(n) });
  }
  return { blob: await makeZip(files), count: data.count, meetingsCount: data.meetingsCount };
}

function titleFrom(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? clean.slice(0, 47) + '…' : clean;
}

// Export one conversation as Markdown (used by the history "export" button AND the
// "Copy chat" header action). Includes each assistant turn's tool actions (name +
// args + a trimmed result); skips non-chat rows (live summary / monitors / watch).
export function conversationToMarkdown(conv) {
  const L = [`# ${conv.title}`, '', `_${new Date(conv.createdAt).toLocaleString()}_`, ''];
  for (const m of conv.messages || []) {
    if (m.role === 'user') {
      L.push(`**You:** ${m.content || ''}`, '');
    } else if (m.role === 'assistant') {
      for (const s of m.steps || []) {
        const args = s.input != null && Object.keys(s.input || {}).length ? ' `' + JSON.stringify(s.input) + '`' : '';
        L.push(`- 🔧 **${s.tool || 'tool'}**${args}${s.status ? ` _(${s.status})_` : ''}`);
        if (s.result) {
          const r = String(s.result).trim();
          L.push((r.length > 1500 ? `${r.slice(0, 1500)}…` : r).split('\n').map((x) => `  > ${x}`).join('\n'));
        }
      }
      L.push(`**${m.agentName || 'Assistant'}:** ${m.content || ''}`, '');
    } else {
      continue; // not part of the chat transcript
    }
    if (m.attachments?.length) {
      L.push(...m.attachments.map((a) => `> attached: ${a.title || a.url}`), '');
    }
  }
  return L.join('\n');
}
