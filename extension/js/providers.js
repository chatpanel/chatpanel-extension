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
function renderContent(m) {
  let text = m.content || '';
  if (m.attachments?.length) {
    const blocks = m.attachments
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

// --------------------------------------------------------------------------
// OpenAI-compatible
// --------------------------------------------------------------------------
async function streamOpenAI(agent, messages, { signal, onDelta, onEvent }) {
  const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const sys = agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : [];
  const body = {
    model: agent.model || 'gpt-4o-mini',
    messages: [...sys, ...toChatMessages(messages)],
    stream: true,
    ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
    ...(agent.maxTokens ? { max_tokens: agent.maxTokens } : {}),
  };
  const headers = { 'Content-Type': 'application/json', ...(agent.headers || {}) };
  if (agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;

  const res = await reachableFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }, agent, base);
  if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));

  let full = '';
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
      full += delta;
      onDelta?.(delta);
    }
    // Reasoning models (DeepSeek-R1, OpenRouter, etc.) stream thinking on a
    // separate field — surface it so it can be shown as it arrives.
    const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
    if (reasoning) onEvent?.({ type: 'reasoning', text: reasoning });
    const finish = choice?.finish_reason;
    if (finish) onEvent?.({ type: 'finish', reason: finish });
  }
  return full;
}

// --------------------------------------------------------------------------
// Anthropic Messages API (direct from the browser)
// --------------------------------------------------------------------------
async function streamAnthropic(agent, messages, { signal, onDelta, onEvent }) {
  const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const body = {
    model: agent.model || 'claude-opus-4-8',
    max_tokens: agent.maxTokens || 4096,
    stream: true,
    ...(agent.systemPrompt ? { system: agent.systemPrompt } : {}),
    ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
    messages: toChatMessages(messages),
  };
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': agent.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${agent.name}: HTTP ${res.status} — ${await safeText(res)}`);

  let full = '';
  for await (const data of sseLines(res)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.type === 'content_block_delta') {
      if (json.delta?.type === 'text_delta') {
        full += json.delta.text;
        onDelta?.(json.delta.text);
      } else if (json.delta?.type === 'thinking_delta') {
        // Extended thinking — stream it as reasoning (only fires when the
        // request enables thinking; harmless otherwise).
        onEvent?.({ type: 'reasoning', text: json.delta.thinking || '' });
      }
    } else if (json.type === 'message_stop') {
      onEvent?.({ type: 'finish', reason: 'stop' });
    } else if (json.type === 'error') {
      throw new Error(json.error?.message || 'Anthropic stream error');
    }
  }
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
      label: agent.name || agent.command || 'Custom',
    };
    options.entitlement = await getEntitlementToken();
  }
  const body = {
    agent: bridgeAgent,
    system: agent.systemPrompt || '',
    options,
    messages: toChatMessages(messages),
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

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------
// `agent` here is a RESOLVED target (see store.resolveTarget): a flat config
// with kind 'bridge' | 'anthropic' | 'openai' and its connection fields inline.
export async function streamChat({ agent, messages, settings, signal, onDelta, onEvent }) {
  const opts = { settings, signal, onDelta, onEvent };
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
