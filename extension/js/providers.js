// Provider abstraction. Every agent, whatever its backend, is driven through a
// single streamChat() call. Three backends are supported:
//
//   kind: 'bridge'    → the local ChatPanel Bridge (Claude Code / Codex / Antigravity CLI)
//   kind: 'openai'    → any OpenAI-compatible /chat/completions endpoint
//                       (Ollama, LM Studio, OpenAI, OpenRouter, Together, …)
//   kind: 'anthropic' → the Anthropic Messages API (direct browser access)
//
// streamChat resolves with the full assistant text and calls onDelta(text) as
// tokens arrive. It also calls onEvent({type,...}) for non-text events (tool
// use, status) so the UI can show what a coding agent is doing.

import { getEntitlementToken } from './license.js';
import { createAdaptiveToolPolicy, resultText } from './adaptive-tool-policy.js';
import {
  redactionEnabled, redactionFromSettings, redactOutbound, redactResult, restoreDeep, makeStreamRestorer, restore,
} from './pii-pipeline.js';
import { detectEntities, normalizeEntities, EXTRACT_SYS, parseJsonLoose, withTimeout } from './pii-detect.js';
import { createVault, redactText } from './pii-redact.js';
import { combineSystemPrompt, toolStatus } from './tool-hints.js';
import { getTarget, resolveTarget } from './store.js';
import { authHeadersForEndpoint } from './oauth.js';
import { mergeExtraBody, sanitizeExtraHeaders } from './request-options.js';
// Safety cap on the agent tool-use loop: a turn may call tools at most this many
// times before we stop, so a confused model can't loop forever. Generous enough
// for real multi-step tasks (filling a table, a multi-field booking, drawing a
// shape) — each click/type/Enter is a step, so these add up fast.
const MAX_TOOL_STEPS = Number(globalThis.CHATPANEL_MAX_TOOL_STEPS) || 60;
const MAX_IDENTICAL_TOOL_CALLS = Number(globalThis.CHATPANEL_MAX_IDENTICAL_TOOL_CALLS) || 3;

// Observation/read tools are MEANT to be repeated (read → act → read again, with
// the SAME empty input) — re-reading after an action is correct, not a loop. They
// don't count toward the loop guard at all.
const OBSERVATION_TOOLS = new Set(['inspect_page', 'read_canvas', 'screenshot', 'marked_screenshot']);

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

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function stableToolCallKey(name, input) {
  return `${String(name || '')}\n${stableStringify(input ?? {})}`;
}

function blockedToolResult(name, message, extra = {}) {
  return JSON.stringify({
    ok: false,
    blocked: true,
    error: 'tool_loop_blocked',
    tool: name || 'tool',
    message,
    retry_hint: 'Answer using the already available conversation context and tool results. Do not call more tools unless the user asks you to continue.',
    ...extra,
  });
}

// Tools whose whole job is to deliver ONE discrete physical input — a keystroke,
// a click, a stroke. Pressing Enter/Tab to commit a cell and then again for the
// next one, or clicking the same spot twice, is NORMAL use, not a stuck loop: the
// input is identical by nature. So a SUCCESSFUL application counts as progress and
// clears the repeat count, leaving MAX_TOOL_STEPS as the overall backstop. A
// FAILING call (ok:false — unknown key, nothing at point, …) does NOT reset, so a
// genuinely stuck call still trips the guard.
const INPUT_PROGRESS_TOOLS = new Set([
  'press_key', 'type_text', 'click_at', 'click_mark', 'draw_path', 'click_element', 'click_by_text',
]);

// Some tools are meant to be called repeatedly. Treat such a call as progress —
// clearing its repeat count — as long as it isn't a no-op. For scroll, "more page
// below" (atBottom === false) is progress; once atBottom is true the repeat guard
// is allowed to bite again. For discrete-input tools, any successful application
// (ok === true) is progress (see INPUT_PROGRESS_TOOLS above).
function toolMadeProgress(name, result) {
  if (name === 'scroll') {
    try {
      return JSON.parse(resultText(result))?.atBottom === false;
    } catch {
      return false;
    }
  }
  if (INPUT_PROGRESS_TOOLS.has(name)) {
    try {
      return JSON.parse(resultText(result))?.ok === true;
    } catch {
      return false;
    }
  }
  return false;
}

export function createToolLoopGuard({
  maxIdenticalCalls = MAX_IDENTICAL_TOOL_CALLS,
} = {}) {
  const counts = new Map();

  return {
    // No nuclear per-turn kill switch — one looping tool must not disable the rest.
    // The MAX_TOOL_STEPS budget is the overall backstop.
    get disabled() {
      return false;
    },
    // Clear a call's repeat count when it actually made progress — lets an
    // inherently-repetitive tool (scroll-to-bottom) keep going, while a genuinely
    // stuck loop still trips the cap.
    reset(key) {
      if (key) counts.delete(key);
    },
    check(name, input) {
      // Reads are idempotent observations — re-reading after an action is correct,
      // so they never count toward the loop guard.
      if (OBSERVATION_TOOLS.has(name)) return { blocked: false };

      const key = stableToolCallKey(name, input);
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > maxIdenticalCalls) {
        // Block only THIS exact repeated call — every other tool stays available.
        return {
          blocked: true,
          count,
          key,
          result: blockedToolResult(
            name,
            `Skipped a repeated identical ${name || 'tool'} call (${count}× with the same input). Vary the input or try a different action — your other tools still work.`,
            { repeated: true, identicalCallCount: count, maxIdenticalCalls },
          ),
        };
      }

      return { blocked: false, count, key };
    },
  };
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
// A model without vision rejects image_url content (e.g. HF Router 400 "does not
// support image inputs"). Rather than fail, we strip images and continue text-only.
function isVisionUnsupportedError(text) {
  return /does not support image|image input|image_url|no.{0,3}vision|multimodal|cannot process image/i.test(String(text || ''));
}
function stripImagesFromMessages(msgs) {
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    let hadImage = false;
    m.content = m.content.filter((c) => {
      if (c?.type === 'image_url') {
        hadImage = true;
        return false;
      }
      return true;
    });
    if (hadImage && !m.content.some((c) => c?.type === 'text')) {
      m.content.push({ type: 'text', text: '(image omitted — this model has no vision)' });
    }
    if (m.content.length === 1 && m.content[0]?.type === 'text') m.content = m.content[0].text;
  }
  return msgs;
}

async function streamOpenAI(agent, messages, { signal, onDelta, onEvent, tools }) {
  const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const system = combineSystemPrompt(agent.systemPrompt, tools?.system);
  const sys = system ? [{ role: 'system', content: system }] : [];
  const headers = { ...sanitizeExtraHeaders(agent.headers), 'Content-Type': 'application/json' };
  Object.assign(headers, await authHeadersForEndpoint(agent));
  if (!headers.Authorization && agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const toolSpecs = tools?.specs?.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
  const loopGuard = createToolLoopGuard();
  const adaptivePolicy = createAdaptiveToolPolicy();

  // Native OpenAI message list — appended to across tool-use steps. Multimodal
  // so pasted/attached images ride along to vision models.
  const msgs = [...sys, ...toMultimodalMessages(messages, 'openai')];
  let full = '';
  let noVision = false; // set once the model rejects images, then we go text-only

  // One model turn = one streamed completion. Loops only when the model asks to
  // call tools; without tools it runs exactly once (unchanged single-shot path).
  for (let step = 0; step < (tools ? MAX_TOOL_STEPS : 1); step++) {
    const activeToolSpecs = loopGuard.disabled ? undefined : adaptivePolicy.filterOpenAITools(toolSpecs);
    const doFetch = () => {
      const body = mergeExtraBody({
        model: agent.model || 'gpt-4o-mini',
        messages: msgs,
        stream: true,
        ...(activeToolSpecs?.length ? { tools: activeToolSpecs } : {}),
        ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
        ...(agent.maxTokens ? { max_tokens: agent.maxTokens } : {}),
      }, agent.extraBody);
      return reachableFetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal }, agent, base);
    };
    let res = await doFetch();
    if (!res.ok) {
      const errText = await safeText(res);
      // Vision-less model: drop images and retry text-only instead of failing.
      // Providers use different status codes (OpenAI 400, OpenRouter 404, …), so
      // key off the error MESSAGE, not the status.
      if (!noVision && isVisionUnsupportedError(errText)) {
        noVision = true;
        stripImagesFromMessages(msgs);
        console.info('[chatpanel] model rejected image inputs — continuing text-only');
        res = await doFetch();
        if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));
      } else {
        throw new Error(openAiError(agent, base, res.status, errText));
      }
    }

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
    if (!tools || !activeToolSpecs?.length || finish !== 'tool_calls' || wanted.length === 0) {
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
      onEvent?.({ type: 'tool', name: c.name, phase: 'start', callId: c.id, input });
      const guard = loopGuard.check(c.name, input);
      const result = guard.blocked
        ? guard.result
        : await tools.execute(c.name, input, { callId: c.id });
      adaptivePolicy.recordResult(c.name, result);
      if (!guard.blocked && toolMadeProgress(c.name, result)) loopGuard.reset(guard.key);
      const _image = result && typeof result === 'object' ? result.image : undefined;
      onEvent?.({ type: 'tool', name: c.name, phase: 'done', callId: c.id, image: _image, status: toolStatus(result), result: stepResultText(result) });
      const text = typeof result === 'string' ? result : (result?.text ?? '');
      msgs.push({ role: 'tool', tool_call_id: c.id, content: text });
      // OpenAI tool messages can't carry images — feed any screenshot back as a
      // follow-up user message so the (vision) model can see the page. Skip once the
      // model has told us it has no vision (noVision) — send a text note instead.
      if (result && typeof result === 'object' && result.image) {
        msgs.push(
          noVision
            ? { role: 'user', content: `(Screenshot from ${c.name} omitted — this model has no vision. Rely on read_canvas / inspect_page / tool results.)` }
            : { role: 'user', content: [{ type: 'text', text: `(Screenshot from ${c.name})` }, { type: 'image_url', image_url: { url: result.image } }] },
        );
      }
    }
  }
  onEvent?.({ type: 'finish', reason: 'tool-step-limit' });
  return full + (full ? '\n\n' : '') + '_(Reached the action limit for one turn — say "continue" to keep going.)_';
}

// --------------------------------------------------------------------------
// Anthropic Messages API (direct from the browser)
// --------------------------------------------------------------------------
async function streamAnthropic(agent, messages, { signal, onDelta, onEvent, tools }) {
  const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const system = combineSystemPrompt(agent.systemPrompt, tools?.system);
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    ...sanitizeExtraHeaders(agent.headers),
  };
  Object.assign(headers, await authHeadersForEndpoint(agent));
  if (!headers.Authorization) headers['x-api-key'] = agent.apiKey || '';
  const toolSpecs = tools?.specs?.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }));
  const loopGuard = createToolLoopGuard();
  const adaptivePolicy = createAdaptiveToolPolicy();

  // Native Anthropic message list — appended to across tool-use steps. Multimodal
  // so pasted/attached images ride along as image blocks.
  const msgs = toMultimodalMessages(messages, 'anthropic');
  let full = '';

  for (let step = 0; step < (tools ? MAX_TOOL_STEPS : 1); step++) {
    const activeToolSpecs = loopGuard.disabled ? undefined : adaptivePolicy.filterAnthropicTools(toolSpecs);
    const body = mergeExtraBody({
      model: agent.model || 'claude-opus-4-8',
      max_tokens: agent.maxTokens || 4096,
      stream: true,
      ...(system ? { system } : {}),
      ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
      ...(activeToolSpecs?.length ? { tools: activeToolSpecs } : {}),
      messages: msgs,
    }, agent.extraBody);
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
    if (!tools || !activeToolSpecs?.length || stopReason !== 'tool_use' || toolUses.length === 0) {
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
      onEvent?.({ type: 'tool', name: b.name, phase: 'start', callId: b.id, input });
      const guard = loopGuard.check(b.name, input);
      const result = guard.blocked
        ? guard.result
        : await tools.execute(b.name, input, { callId: b.id });
      adaptivePolicy.recordResult(b.name, result);
      if (!guard.blocked && toolMadeProgress(b.name, result)) loopGuard.reset(guard.key);
      const _image = result && typeof result === 'object' ? result.image : undefined;
      onEvent?.({ type: 'tool', name: b.name, phase: 'done', callId: b.id, image: _image, status: toolStatus(result), result: stepResultText(result) });
      const text = typeof result === 'string' ? result : (result?.text ?? '');
      // Anthropic tool_result content may be a string OR blocks — attach the
      // screenshot as an image block so the model can see the page directly.
      let content = text;
      if (result && typeof result === 'object' && result.image) {
        const im = /^data:([^;]+);base64,(.+)$/s.exec(result.image);
        content = [];
        if (im) content.push({ type: 'image', source: { type: 'base64', media_type: im[1], data: im[2] } });
        content.push({ type: 'text', text });
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content });
    }
    msgs.push({ role: 'user', content: results });
  }
  onEvent?.({ type: 'finish', reason: 'tool-step-limit' });
  return full + (full ? '\n\n' : '') + '_(Reached the action limit for one turn — say "continue" to keep going.)_';
}

// --------------------------------------------------------------------------
// ChatPanel Bridge (Claude Code / Codex / Antigravity CLI on the user's machine)
// --------------------------------------------------------------------------
// Relay one CLI-agent tool call back to the extension's executor and POST the
// result to the bridge. Fire-and-forget so the SSE loop keeps reading; the
// bridge is blocked awaiting /tool-result, so there's nothing to read until then.
async function relayBridgeTool(base, ev, tools, onEvent, loopGuard = createToolLoopGuard()) {
  onEvent?.({ type: 'tool', name: ev.name, phase: 'start', callId: ev.id, input: ev.input });
  let result;
  try {
    const guard = loopGuard.check(ev.name, ev.input);
    result = guard.blocked
      ? guard.result
      : tools
        ? await tools.execute(ev.name, ev.input, { callId: ev.id, session: ev.session })
        : JSON.stringify({ error: 'no tools armed' });
    if (!guard.blocked && toolMadeProgress(ev.name, result)) loopGuard.reset(guard.key);
  } catch (e) {
    result = JSON.stringify({ error: String(e?.message || e) });
  }
  const image = result && typeof result === 'object' ? result.image : undefined;
  onEvent?.({ type: 'tool', name: ev.name, phase: 'done', callId: ev.id, image, status: toolStatus(result), result: stepResultText(result) });
  await fetch(`${base}/tool-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: ev.session, id: ev.id, result }),
  }).catch(() => {});
}

async function streamBridge(agent, messages, { settings, signal, onDelta, onEvent, tools }) {
  const base = (settings.bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
  const bridgeAgent = agent.bridgeAgent || 'claude';
  const options = {
    workingDir: agent.workingDir || '',
    permissionMode: agent.permissionMode || 'default',
    model: agent.model || '',
    // Default ON: use the user's local skills / MCP / config.
    useLocalConfig: agent.useLocalConfig !== false,
    // Extra CLI flags the user added (e.g. opencode `--format json
    // --dangerously-skip-permissions`). Applies to any built-in or custom agent.
    extraArgs: agent.extraArgs || '',
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
      // How this CLI takes an MCP config FILE, e.g. "--mcp-config {file}". Set →
      // the bridge writes a standard mcpServers JSON (pointing at its stdio proxy)
      // so "Act on page" tools reach this CLI. Empty = no browser tools.
      mcpArg: agent.mcpArg || '',
      // Stable MCP is for CLIs that only read persistent/global MCP config.
      requiresStableMcp: Boolean(agent.requiresStableMcp || agent.stableMcpSetupCommand),
      stableMcpSetupCommand: agent.stableMcpSetupCommand || '',
      // Some CLIs need the active tool names explicitly trusted for headless runs.
      trustToolsArg: agent.trustToolsArg || '',
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
    system: combineSystemPrompt(agent.systemPrompt, tools?.system),
    options,
    messages: toChatMessages(messages),
    ...(images.length ? { images } : {}),
    // Hand the CLI agent our turn tools. The bridge hosts an MCP server with
    // these specs and relays each call back to us (tools.execute) over the SSE.
    ...(tools?.specs?.length ? { pageTools: { specs: tools.specs } } : {}),
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
  const loopGuard = createToolLoopGuard();
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
    } else if (ev.type === 'tool_request') {
      // The CLI agent called one of our turn tools (via the bridge's MCP
      // server) — run it here and POST the result back. Don't await: the bridge
      // is blocked on /tool-result, so no further SSE arrives until we answer.
      relayBridgeTool(base, ev, tools, onEvent, loopGuard);
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
async function dispatchStream({ agent, messages, settings, signal, onDelta, onEvent, tools }) {
  const opts = { settings, signal, onDelta, onEvent, tools };
  // Bridge CLIs (Claude Code / Codex …) run their OWN agentic loop. They can now
  // ALSO use our browser tools: the bridge hosts an MCP server with the specs we
  // send and relays each call back here (see streamBridge / relayBridgeTool).
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

// A short, display-safe slice of a tool result for the Actions log — the model still
// receives the FULL result; this is only what the user sees in the UI.
function stepResultText(result) {
  const t = resultText(result);
  if (!t) return '';
  const s = String(t);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

// True when the chat model runs on THIS machine (a localhost OpenAI-compatible
// endpoint — Ollama / llama.cpp / LM Studio). Cloud APIs and bridge CLIs (which
// proxy to the cloud) count as remote. Powers the "redact for remote models only"
// option: a local model never sends your data off-device, so redaction is optional.
function isLocalAgent(agent) {
  if (!agent || agent.kind === 'bridge' || agent.kind === 'anthropic') return false;
  return /\/\/(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)(?::\d+)?(?:[/?#]|$)/i
    .test(String(agent.baseUrl || ''));
}

// Run the configured detector over `sample` → [{value,type}]. 'endpoint'/'openai'
// hit a URL directly (pii-detect.js). 'agent' reuses a CONFIGURED API/agent: an
// endpoint is detected via its OpenAI-compatible connection; a bridge CLI is driven
// through dispatchStream. All paths fail open (return []) so a slow/broken detector
// never blocks the chat.
async function detectForChat(sample, cfg, settings, signal, { strict = false } = {}) {
  const det = (cfg && cfg.detection) || {};
  if (det.backend !== 'agent') return detectEntities(sample, cfg, { signal, strict });
  // A configured API/agent: drive it through the SAME transport as chat — correct
  // base URL / auth / headers for endpoints, the CLI for bridge agents — with a
  // strict JSON-extraction prompt, then parse the entities out of its reply.
  const target = resolveTarget(getTarget(settings, det.targetId), settings);
  if (!target) { if (strict) throw new Error('No API / agent selected for the detector'); return []; }
  const capped = String(sample || '').slice(0, det.maxChars || 8000);
  if (capped.trim().length < 8) return [];
  // The instruction goes in BOTH the system prompt and the user turn: agentic CLIs
  // (Claude Code / Codex) often only *append* a custom system prompt, so the inline
  // copy makes them far likelier to emit the JSON we parse.
  const prompt = `${EXTRACT_SYS}\n\nText to analyze:\n"""\n${capped}\n"""\n\nRespond with ONLY the JSON object.`;
  const timeoutMs = det.timeoutMs || (target.kind === 'bridge' ? 20000 : 4000);
  // On OpenAI-compatible endpoints, force JSON mode (response_format) so even small
  // local models (phi4-mini, gemma) emit valid JSON instead of prose. Bridge CLIs
  // don't support it. EXTRACT_SYS mentions "JSON", satisfying servers that require it.
  const ask = (jsonMode) => withTimeout(dispatchStream({
    agent: {
      ...target, systemPrompt: EXTRACT_SYS, temperature: 0,
      maxTokens: det.maxTokens || 256, model: det.model || target.model,
      ...(jsonMode ? { extraBody: { ...(target.extraBody || {}), response_format: { type: 'json_object' } } } : {}),
    },
    messages: [{ role: 'user', content: prompt }],
    settings, signal,
  }), timeoutMs, signal);
  let text = '';
  try {
    let out;
    if (target.kind !== 'bridge') {
      // JSON mode first; if the server rejects response_format, retry without it.
      try { out = await ask(true); }
      catch (e) { if (/abort|timeout/i.test((e && e.message) || '')) throw e; out = await ask(false); }
    } else {
      out = await ask(false);
    }
    text = typeof out === 'string' ? out : (out && out.text) || '';
  } catch (e) { if (strict) throw e; return []; }
  const parsed = parseJsonLoose(text);
  if (!parsed) {
    // Distinguish "replied but not JSON" from "empty" so the Test button can say
    // something useful instead of a misleading "no entities".
    if (strict) {
      throw new Error(text.trim()
        ? 'the model replied but not as JSON. Try a model that supports JSON mode (response_format), or use a local NER service'
        : 'the model returned an empty response');
    }
    return [];
  }
  return normalizeEntities(parsed, det.types);
}

// Settings-page helper: run the detector once over a sample → its spans (or throw).
// Powers the Privacy → "Test detector" button.
export async function runDetectorTest(settings, sample) {
  const base = (settings && settings.ui && settings.ui.piiRedaction) || {};
  // strict = surface errors so the button can show them; generous timeout so a cold
  // local model / CLI isn't misreported as "no entities".
  const cfg = { ...base, detection: { ...(base.detection || {}), timeoutMs: Math.max(Number(base.detection && base.detection.timeoutMs) || 0, 30000) } };
  return detectForChat(String(sample || ''), cfg, settings, undefined, { strict: true });
}

// Settings-page helper: preview the FULL outbound redaction of a sample — the
// configured detector (names/orgs/locations) PLUS the always-on deterministic layer
// (emails, phones, cards, keys, IPs) PLUS the user dictionary — so the Test button
// shows exactly what the model would see, not just the detector's raw output. (A
// spaCy NER won't emit EMAIL/PHONE, but those are still redacted here.)
export async function previewRedaction(settings, sample) {
  const base = (settings && settings.ui && settings.ui.piiRedaction) || {};
  const text = String(sample || '');
  const tier = base.mode === 'model' ? 'full' : 'basic';
  const detector = base.mode === 'model' ? await runDetectorTest(settings, text) : []; // strict — surfaces errors
  const vault = createVault();
  const redacted = redactText(text, vault, { tier, entities: detector, dictionary: base.dictionary || [] });
  const spans = [...vault.byToken].map(([token, value]) => ({ token, value }));
  return { redacted, spans, detector };
}

// Public entry. When `redaction` ({ vault, cfg, isPro, entities }) is enabled, it
// redacts everything outbound into the vault, restores the streamed reply, and
// round-trips tool calls — restoring the model's token args before LOCAL execution
// and re-redacting the result before返回 to the model. One wrapper covers the
// API and bridge backends because they all run through dispatchStream().
export async function streamChat({ agent, messages, settings, signal, onDelta, onEvent, tools, redaction }) {
  // Default: cover EVERY model-bound call (chat, topic extraction, meeting scribe,
  // autocomplete…). A caller that omits `redaction` still gets the user's
  // configured redaction; pass an explicit object (or null) only to override.
  if (redaction === undefined) redaction = redactionFromSettings(settings);
  // "Redact for remote models only": a local model keeps data on-device, so skip
  // redaction entirely for it (the user chose not to pay the redaction cost locally).
  if (redaction && redaction.cfg && redaction.cfg.applyTo === 'remote' && isLocalAgent(agent)) redaction = null;
  if (!redaction || !redaction.vault || !redactionEnabled(redaction.cfg)) {
    return dispatchStream({ agent, messages, settings, signal, onDelta, onEvent, tools });
  }
  const { vault, cfg, isPro = false, entities = [] } = redaction;
  // Phase 2: when mode is 'model', run the configured LOCAL detector to find
  // names/orgs/IDs, merge them in, and treat this as the full (entity) tier. Fails
  // open (detector down/slow → deterministic redaction still applies).
  let activeCfg = cfg;
  let activeEntities = entities;
  let effIsPro = isPro;
  if (redaction.detect && cfg.mode === 'model') {
    try {
      const sample = (messages || []).map((m) => m.content || '').join('\n');
      const found = await detectForChat(sample, cfg, settings, signal);
      if (found.length) {
        activeEntities = [...entities, ...found];
        activeCfg = { ...cfg, tier: 'full' };
        // Model detection is itself the Pro gate (UI-locked). Once it has run and
        // found entities, redact them regardless of a possibly-stale isPro on the
        // default (auxiliary-call) path — otherwise titles/topics/etc. would leak.
        effIsPro = true;
      }
    } catch { /* fail open */ }
  }
  const ctx = { vault, cfg: activeCfg, isPro: effIsPro, entities: activeEntities };
  const red = redactOutbound({ messages, system: agent.systemPrompt, vault, cfg: activeCfg, isPro: effIsPro, entities: activeEntities });
  const safeAgent = { ...agent, systemPrompt: red.system };
  const restorer = makeStreamRestorer(vault);
  const rawOnDelta = onDelta;
  const wrappedOnDelta = rawOnDelta ? (d) => rawOnDelta(restorer.push(d)) : rawOnDelta;
  const wrappedOnEvent = onEvent
    ? (ev) => onEvent(ev && (ev.input != null || ev.result != null)
        ? { ...ev, input: restoreDeep(ev.input, vault), result: restoreDeep(ev.result, vault) }
        : ev)
    : onEvent;
  let safeTools = tools;
  if (tools && typeof tools.execute === 'function') {
    const base = tools.execute.bind(tools);
    safeTools = {
      ...tools,
      // Local tools (history/meeting/page) ALWAYS get the REAL values — they run
      // on-device and search/retrieval must work (e.g. Wikipedia for "Gandhi" needs
      // "Gandhi", not a placeholder). Remote MCP tools get real values too BY DEFAULT
      // for the same reason — unless the user chose "redact remote tools" (Privacy →
      // Tools receive), which keeps PII off third-party MCP servers at the cost of
      // remote lookups on redacted entities. The model is always blinded; results are
      // re-redacted before going back to it.
      execute: async (name, input, meta) => {
        const keepRedacted = activeCfg.toolData === 'redactRemote' && String(name || '').startsWith('mcp_');
        const toolInput = keepRedacted ? input : restoreDeep(input, vault);
        return redactResult(await base(name, toolInput, meta), ctx);
      },
    };
  }
  const full = await dispatchStream({
    agent: safeAgent, messages: red.messages, settings, signal,
    onDelta: wrappedOnDelta, onEvent: wrappedOnEvent, tools: safeTools,
  });
  const tail = restorer.flush();
  if (tail && rawOnDelta) rawOnDelta(tail);
  return restore(typeof full === 'string' ? full : full ?? '', vault);
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

function isOpenRouterEndpoint(agent, base = '') {
  try {
    return agent?.authMode === 'openrouter' || /(^|\.)openrouter\.ai$/i.test(new URL(base || 'https://example.com').hostname);
  } catch {
    return agent?.authMode === 'openrouter' || /openrouter\.ai/i.test(base);
  }
}

function priceIsZero(value) {
  if (value == null || value === '') return false;
  return Number(value) === 0;
}

function compactTokens(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function modelLabel(option) {
  const parts = [];
  if (option.free) parts.push('FREE');
  if (option.name && option.name !== option.id) parts.push(option.name);
  if (option.contextLength) parts.push(`${compactTokens(option.contextLength)} ctx`);
  if (option.maxCompletionTokens) parts.push(`${compactTokens(option.maxCompletionTokens)} max`);
  return parts.length ? parts.join(' · ') : option.id;
}

export function normalizeModelOptions(json, agent = {}, base = '') {
  const openRouter = isOpenRouterEndpoint(agent, base || agent.baseUrl);
  const list = json?.data || json?.models || [];
  return list
    .map((m) => {
      const id = m?.id || m?.name || '';
      const name = m?.name || id;
      const free = openRouter && (
        /:free$/i.test(id) ||
        /\bfree\b/i.test(name) ||
        (priceIsZero(m?.pricing?.prompt) && priceIsZero(m?.pricing?.completion))
      );
      const option = {
        id,
        name,
        free,
        contextLength: Number(m?.context_length || m?.contextLength || 0) || 0,
        maxCompletionTokens: Number(m?.top_provider?.max_completion_tokens || m?.max_completion_tokens || 0) || 0,
      };
      option.label = modelLabel(option);
      return option;
    })
    .filter((m) => m.id)
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
}

// Pick the smallest/fastest model id from a list (for autocomplete).
export function smallestModel(ids) {
  if (!ids || !ids.length) return null;
  return ids.slice().sort((a, b) => modelSizeScore(a) - modelSizeScore(b))[0];
}

export async function listModelOptions(agent) {
  if (agent.kind === 'anthropic') {
    const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const headers = {
      ...sanitizeExtraHeaders(agent.headers),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    Object.assign(headers, await authHeadersForEndpoint(agent));
    if (!headers.Authorization) headers['x-api-key'] = agent.apiKey || '';
    const res = await reachableFetch(`${base}/v1/models`, {
      headers,
    }, agent, base);
    if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));
    return normalizeModelOptions(await res.json(), agent, base);
  }
  const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const headers = { ...sanitizeExtraHeaders(agent.headers) };
  Object.assign(headers, await authHeadersForEndpoint(agent));
  if (!headers.Authorization && agent.apiKey) headers['Authorization'] = `Bearer ${agent.apiKey}`;
  const res = await reachableFetch(`${base}/models`, { headers }, agent, base);
  if (!res.ok) throw new Error(openAiError(agent, base, res.status, await safeText(res)));
  return normalizeModelOptions(await res.json(), agent, base);
}

export async function listModels(agent) {
  return (await listModelOptions(agent)).map((m) => m.id);
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
    if (isOllama) hint = ' Is Ollama running? Start it with  OLLAMA_ORIGINS="chrome-extension://*" ollama serve';
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
    return `${agent.name}: Ollama refused the browser (HTTP 403). Restart it so it accepts the extension:  OLLAMA_ORIGINS="chrome-extension://*" ollama serve`;
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
