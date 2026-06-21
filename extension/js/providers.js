// Provider abstraction. Every agent, whatever its backend, is driven through a
// single streamChat() call. Three backends are supported:
//
//   kind: 'bridge'    → the local ChatPanel Bridge (Claude Code / Codex / Gemini CLI)
//   kind: 'openai'    → any OpenAI-compatible /chat/completions endpoint
//                       (Ollama, LM Studio, OpenAI, OpenRouter, Together, …)
//   kind: 'anthropic' → the Anthropic Messages API (direct browser access)
//
// streamChat resolves with the full assistant text and calls onDelta(text) as
// tokens arrive. It also calls onEvent({type,...}) for non-text events (tool
// use, status) so the UI can show what a coding agent is doing.

import { getEntitlementToken } from './license.js';

// Safety cap on the agent tool-use loop: a turn may call tools at most this many
// times before we stop, so a confused model can't fill→inspect→fill forever.
const MAX_TOOL_STEPS = 8;

// Parse a tool-call argument string, tolerating the empty/partial case (a tool
// with no inputs streams "" or "{}").
function safeJson(s) {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// --------------------------------------------------------------------------
// Shared SSE reader: yields each `data:` payload string from a fetch Response.
// --------------------------------------------------------------------------
async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    // SSE frames are separated by a blank line; within a frame we only care
    // about `data:` fields (possibly multiple).
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

// Flatten a stored message (with attachments) into the text the model sees.
// Image attachments are excluded here — they go to the model as image blocks
// (see toMultimodalMessages), not as text.
function renderContent(m) {
  let text = m.content || '';
  const ctx = (m.attachments || []).filter((a) => a.kind !== 'image');
  if (ctx.length) {
    const blocks = ctx
      .map((a) => {
        const head = `[${a.kind || 'context'}] ${a.title || a.url || ''}`.trim();
        return `<context source="${(a.url || a.title || '').replace(/"/g, '')}">\n# ${head}\n${a.text || ''}\n</context>`;
      })
      .join('\n\n');
    text = text ? `${text}\n\n${blocks}` : blocks;
  }
  return text;
}

function toChatMessages(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: renderContent(m) }));
}

// Image attachments on a message: { dataUrl: 'data:<media>;base64,<...>' }.
function imageAttachmentsOf(m) {
  return (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
}

// Like toChatMessages, but emits multimodal content (text + image blocks) for
// user messages that carry images, in the given provider's wire format. Falls
// back to plain string content when there are no images. `provider` is
// 'openai' | 'anthropic'.
function toMultimodalMessages(messages, provider) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const text = renderContent(m);
      const imgs = m.role === 'user' ? imageAttachmentsOf(m) : [];
      if (imgs.length === 0) return { role: m.role, content: text };
      if (provider === 'anthropic') {
        const content = [];
        for (const a of imgs) {
          const match = /^data:([^;]+);base64,(.+)$/s.exec(a.dataUrl);
          if (match) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        }
        if (text) content.push({ type: 'text', text });
        return { role: 'user', content: content.length ? content : text };
      }
      // openai (and OpenAI-compatible vision endpoints)
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const a of imgs) content.push({ type: 'image_url', image_url: { url: a.dataUrl } });
      return { role: 'user', content: content.length ? content : text };
    });
}

// --------------------------------------------------------------------------
// OpenAI-compatible
// --------------------------------------------------------------------------
async function streamOpenAI(agent, messages, { signal, onDelta, onEvent, tools }) {
  const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const sys = agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : [];
  const headers = { 'Content-Type': 'application/json', ...(agent.headers || {}) };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const toolSpecs = tools?.specs?.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));

  // Native OpenAI message list — appended to across tool-use steps. Multimodal
  // so pasted/attached images ride along to vision models.
  const msgs = [...sys, ...toMultimodalMessages(messages, 'openai')];
  let full = '';

  // One model turn = one streamed completion. Loops only when the model asks to
  // call tools; without tools it runs exactly once (unchanged single-shot path).
  for (let step = 0; step < (tools ? MAX_TOOL_STEPS : 1); step++) {
    const body = {
      model: agent.model || 'gpt-4o-mini',
      messages: msgs,
      stream: true,
      ...(toolSpecs?.length ? { tools: toolSpecs } : {}),
      ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
      ...(agent.maxTokens ? { max_tokens: agent.maxTokens } : {}),
    };
    const res = await reachableFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, agent, base);
    if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));

    let stepText = '';
    const calls = {}; // index → { id, name, args } accumulated across deltas
    let finish = '';
    for await (const data of sseLines(res)) {
      if (data === '[DONE]') break;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        stepText += delta;
        full += delta;
        onDelta?.(delta);
      }
      const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
      if (reasoning) onEvent?.({ type: 'reasoning', text: reasoning });
      for (const t of choice?.delta?.tool_calls || []) {
        const slot = (calls[t.index] ||= { id: '', name: '', args: '' });
        if (t.id) slot.id = t.id;
        if (t.function?.name) slot.name = t.function.name;
        if (t.function?.arguments) slot.args += t.function.arguments;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }

    const wanted = Object.keys(calls)
      .sort((a, b) => a - b)
      .map((k) => calls[k]);
    if (!tools || finish !== 'tool_calls' || wanted.length === 0) {
      onEvent?.({ type: 'finish', reason: finish || 'stop' });
      return full;
    }
    // Execute the requested tools and feed results back for the next step.
    msgs.push({
      role: 'assistant',
      content: stepText || null,
      tool_calls: wanted.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args },
      })),
    });
    for (const c of wanted) {
      const input = safeJson(c.args);
      onEvent?.({ type: 'tool', name: c.name, phase: 'start', input });
      const result = await tools.execute(c.name, input);
      onEvent?.({ type: 'tool', name: c.name, phase: 'done' });
      msgs.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
  onEvent?.({ type: 'finish', reason: 'tool-step-limit' });
  return full;
}

// --------------------------------------------------------------------------
// Anthropic Messages API (direct from the browser)
// --------------------------------------------------------------------------
async function streamAnthropic(agent, messages, { signal, onDelta, onEvent, tools }) {
  const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': agent.apiKey || '',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const toolSpecs = tools?.specs?.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }));

  // Native Anthropic message list — appended to across tool-use steps. Multimodal
  // so pasted/attached images ride along as image blocks.
  const msgs = toMultimodalMessages(messages, 'anthropic');
  let full = '';

  for (let step = 0; step < (tools ? MAX_TOOL_STEPS : 1); step++) {
    const body = {
      model: agent.model || 'claude-opus-4-8',
      max_tokens: agent.maxTokens || 4096,
      stream: true,
      ...(agent.systemPrompt ? { system: agent.systemPrompt } : {}),
      ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
      ...(toolSpecs?.length ? { tools: toolSpecs } : {}),
      messages: msgs,
    };
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`${agent.name}: HTTP ${res.status} — ${await safeText(res)}`);

    // Reassemble the assistant's content blocks so we can both stream text and
    // collect tool_use calls. `blocks` is indexed by content_block index.
    const blocks = [];
    let stopReason = '';
    for await (const data of sseLines(res)) {
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.type === 'content_block_start') {
        const b = json.content_block;
        blocks[json.index] =
          b?.type === 'tool_use'
            ? { type: 'tool_use', id: b.id, name: b.name, json: '' }
            : { type: 'text', text: '' };
      } else if (json.type === 'content_block_delta') {
        const b = blocks[json.index];
        if (json.delta?.type === 'text_delta') {
          full += json.delta.text;
          if (b) b.text += json.delta.text;
          onDelta?.(json.delta.text);
        } else if (json.delta?.type === 'input_json_delta') {
          if (b) b.json += json.delta.partial_json || '';
        } else if (json.delta?.type === 'thinking_delta') {
          onEvent?.({ type: 'reasoning', text: json.delta.thinking || '' });
        }
      } else if (json.type === 'message_delta') {
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
      } else if (json.type === 'message_stop') {
        // handled after the loop via stopReason
      } else if (json.type === 'error') {
        throw new Error(json.error?.message || 'Anthropic stream error');
      }
    }

    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (!tools || stopReason !== 'tool_use' || toolUses.length === 0) {
      onEvent?.({ type: 'finish', reason: stopReason || 'stop' });
      return full;
    }
    // Echo the assistant's blocks back, then a user turn carrying tool_results.
    msgs.push({
      role: 'assistant',
      content: blocks
        // Drop empty text blocks — the API rejects zero-length text content.
        .filter((b) => b.type === 'tool_use' || b.text)
        .map((b) =>
          b.type === 'tool_use'
            ? { type: 'tool_use', id: b.id, name: b.name, input: safeJson(b.json) }
            : { type: 'text', text: b.text },
        ),
    });
    const results = [];
    for (const b of toolUses) {
      const input = safeJson(b.json);
      onEvent?.({ type: 'tool', name: b.name, phase: 'start', input });
      const result = await tools.execute(b.name, input);
      onEvent?.({ type: 'tool', name: b.name, phase: 'done' });
      results.push({ type: 'tool_result', tool_use_id: b.id, content: result });
    }
    msgs.push({ role: 'user', content: results });
  }
  onEvent?.({ type: 'finish', reason: 'tool-step-limit' });
  return full;
}

// --------------------------------------------------------------------------
// ChatPanel Bridge (Claude Code / Codex / Gemini CLI on the user's machine)
// --------------------------------------------------------------------------
async function streamBridge(agent, messages, { settings, signal, onDelta, onEvent }) {
  const base = (settings.bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
  const bridgeAgent = agent.bridgeAgent || 'claude';
  const options = {
    workingDir: agent.workingDir || '',
    permissionMode: agent.permissionMode || 'default',
    model: agent.model || '',
    // Default ON: use the user's local skills / MCP / config.
    useLocalConfig: agent.useLocalConfig !== false,
  };
  // "Bring your own" custom CLI (Pro) — carry the command spec plus the signed
  // entitlement token, which the bridge verifies OFFLINE before running anything.
  if (bridgeAgent === 'custom') {
    options.custom = {
      command: agent.command || '',
      args: agent.args || '',
      promptVia: agent.promptVia || 'stdin',
      format: agent.format || 'text',
      // How to inject the chosen model (options.model) into the CLI's argv, e.g.
      // "--model {model}" or opencode's "-m {model}". Empty = model not passed.
      modelArg: agent.modelArg || '',
      // How this CLI takes an attached image, e.g. "-i {path}" or pi's "@{path}".
      // Empty = the agent can't take images.
      imageArg: agent.imageArg || '',
      label: agent.name || agent.command || 'Custom',
    };
    options.entitlement = await getEntitlementToken();
  }
  // Images from the latest user turn — the bridge writes them to temp files and
  // attaches them to the agent's prompt (e.g. `codex exec -i`). CLI agents attach
  // images to the initial prompt, so only the current turn's images are sent.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const images = lastUser
    ? imageAttachmentsOf(lastUser).map((a) => ({
        name: a.title || 'image',
        mediaType: a.mediaType || 'image/png',
        dataUrl: a.dataUrl,
      }))
    : [];
  const body = {
    agent: bridgeAgent,
    system: agent.systemPrompt || '',
    options,
    messages: toChatMessages(messages),
    ...(images.length ? { images } : {}),
  };
  let res;
  try {
    res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new Error(
      `Can't reach the ChatPanel Bridge at ${base}. Start it with \`npx @chatpanel/bridge\`. (${e.message})`,
    );
  }
  if (!res.ok) throw new Error(`Bridge: HTTP ${res.status} — ${await safeText(res)}`);

  let full = '';
  for await (const data of sseLines(res)) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === 'delta' && ev.text) {
      full += ev.text;
      onDelta?.(ev.text);
    } else if (ev.type === 'error') {
      throw new Error(ev.error || 'Bridge error');
    } else if (ev.type === 'done') {
      if (!full && ev.text) {
        full = ev.text;
        onDelta?.(ev.text);
      }
      break;
    } else {
      // tool use / status / reasoning — surface for the activity strip.
      onEvent?.(ev);
    }
  }
  return full;
}

// Ask the bridge to enumerate a CLI agent's models — the unified /list-models
// interface. For a custom ("bring your own") agent this carries the command +
// the configured list-models invocation + the signed entitlement (Pro-gated
// server-side). Built-ins return their known set (claude aliases) or []. `agent`
// is a plain config object (from the Agents editor). Returns a string[].
export async function listBridgeModels(agent, settings) {
  const base = (settings.bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
  const bridgeAgent = agent.bridgeAgent || 'claude';
  const options = { workingDir: agent.workingDir || '' };
  if (bridgeAgent === 'custom') {
    options.custom = {
      command: agent.command || '',
      listModelsArgs: agent.listModelsArgs || '',
      label: agent.name || agent.command || 'Custom',
    };
    options.entitlement = await getEntitlementToken();
  }
  const res = await fetch(`${base}/list-models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: bridgeAgent, options }),
  });
  if (!res.ok) throw new Error(`Bridge: HTTP ${res.status} — ${await safeText(res)}`);
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.models) ? data.models : [];
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------
// `agent` here is a RESOLVED target (see store.resolveTarget): a flat config
// with kind 'bridge' | 'anthropic' | 'openai' and its connection fields inline.
export async function streamChat({ agent, messages, settings, signal, onDelta, onEvent, tools }) {
  const opts = { settings, signal, onDelta, onEvent, tools };
  // Bridge CLIs (Claude Code / Codex / Gemini) run their OWN agentic loop and
  // can't take our browser tools — only API agents get the tool-use loop.
  if (agent.kind === 'bridge') return streamBridge(agent, messages, opts);
  // Model targets need a model — don't silently fall back to a default the
  // endpoint may not have (the old gpt-4o-mini default hid Ollama mistakes).
  if (!agent.model || !String(agent.model).trim()) {
    throw new Error(
      `No model selected for "${agent.name || 'this endpoint'}". Open Settings → Endpoints, click “Load models”, and pick one.`,
    );
  }
  if (agent.kind === 'anthropic') return streamAnthropic(agent, messages, opts);
  return streamOpenAI(agent, messages, opts);
}

// Ask the Bridge whether a custom command resolves on this machine (PATH / a full
// path / inside WSL). Returns { ok, via } — `via` is how it resolved (native /
// script / cmd / wsl). Older bridges (no /agent-check) → { ok:false, legacy:true }.
export async function checkAgentCommand(bridgeUrl, command) {
  const base = (bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/agent-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (res.status === 404) return { ok: false, legacy: true };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Ask the Bridge which local agents are alive. Returns { ok, agents: [{id,
// label, available, reason}] } or { ok:false } if the Bridge isn't running.
export async function checkBridge(bridgeUrl) {
  const base = (bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, agents: json.agents || [], version: json.version, update: json.update || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Tell the bridge to self-update to the latest release (compiled-binary installs).
// It swaps its binary and restarts, so the connection drops briefly — callers
// should wait and re-check /health. Returns { ok, from?, to?, error? }.
export async function updateBridge(bridgeUrl) {
  const base = (bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/update`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...json } : { ok: false, error: json.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Quick connectivity probe for a BYO endpoint (used by Settings "Test").
export async function testAgent(agent, settings) {
  const messages = [{ role: 'user', content: 'Reply with exactly: pong' }];
  let out = '';
  await streamChat({
    agent,
    messages,
    settings,
    onDelta: (d) => (out += d),
  });
  return out.trim();
}

// List the models an endpoint advertises so the user can pick instead of typing.
// Works for any OpenAI-compatible server (Ollama, LM Studio, OpenAI, OpenRouter,
// Together) via GET /models, and for the Anthropic API via GET /v1/models.
// Returns a sorted array of model ids; throws an actionable error on failure.
// Rough "how small is this model" score (lower = smaller/faster), for picking an
// autocomplete model. Prefers an explicit param size (e.g. "0.5b" < "7b" < "70b"),
// then small-tier keywords (nano/mini/flash/haiku/lite…), else treats it as large.
function modelSizeScore(id) {
  const s = String(id).toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/); // 0.5b, 7b, 70b
  if (m) return parseFloat(m[1]);
  if (/nano/.test(s)) return 0.3;
  if (/(mini|micro|tiny|flash-lite|haiku|lite)/.test(s)) return 1;
  if (/(flash|small|gemma)/.test(s)) return 3;
  return 50;
}

// Pick the smallest/fastest model id from a list (for autocomplete).
export function smallestModel(ids) {
  if (!ids || !ids.length) return null;
  return ids.slice().sort((a, b) => modelSizeScore(a) - modelSizeScore(b))[0];
}

export async function listModels(agent) {
  if (agent.kind === 'anthropic') {
    const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await reachableFetch(`${base}/v1/models`, {
      headers: {
        'x-api-key': agent.apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    }, agent, base);
    if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));
    const json = await res.json();
    return (json.data || []).map((m) => m.id).filter(Boolean).sort();
  }
  const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const headers = { ...(agent.headers || {}) };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const res = await reachableFetch(`${base}/models`, { headers }, agent, base);
  if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));
  const json = await res.json();
  // OpenAI/Ollama: {data:[{id}]}. A few servers use {models:[{id|name}]}.
  const list = json.data || json.models || [];
  return list.map((m) => m.id || m.name).filter(Boolean).sort();
}

// fetch() that turns a CONNECTION failure (server not running, wrong URL, or a
// blocked origin) into a clear, actionable message instead of the opaque
// "Failed to fetch". A refused connection rejects the promise (no HTTP status),
// so we catch it here and explain what to check.
async function reachableFetch(url, opts, agent, base) {
  try {
    return await fetch(url, opts);
  } catch {
    const where = base || url;
    const isOllama = /11434|ollama/i.test(where);
    const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(where);
    let hint;
    if (isOllama) hint = ' Is Ollama running? Start it with  OLLAMA_ORIGINS="*" ollama serve';
    else if (isLocal) hint = ' Is the local server running, and is the Base URL correct?';
    else hint = ' Check the Base URL and your connection.';
    throw new Error(`${agent?.name || 'Endpoint'}: couldn't reach ${where}.${hint}`);
  }
}

// Turn the two failures local Ollama users hit most into actionable messages.
// Ollama blocks browser-extension origins (403) unless started with permissive
// CORS, and 404s on models that haven't been pulled. Anything else passes
// through verbatim.
function openAiError(agent, base, status, body) {
  const isOllama = /11434|ollama/i.test(base);
  if (isOllama && status === 403) {
    return `${agent.name}: Ollama refused the browser (HTTP 403). Restart it so it accepts the extension:  OLLAMA_ORIGINS="*" ollama serve`;
  }
  if (isOllama && status === 404 && /not found|no such model|model/i.test(body)) {
    const model = agent.model || '<model>';
    return `${agent.name}: Ollama doesn't have the model "${model}". Pull it first:  ollama pull ${model}`;
  }
  return `${agent.name}: HTTP ${status} — ${body}`;
}

async function safeText(res) {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return '(no body)';
  }
}
