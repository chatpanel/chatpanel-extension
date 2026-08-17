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
  redactOpts, gatedScope,
} from './pii-pipeline.js';
import { makeToolHarness, placeholderToolNote } from './tool-harness.js';
import { canUseFullRedaction, recordFullRedaction } from './pii-usage.js';
import { sanitizeUnicode } from './sanitize.js';
// Pure, tiny and needed on every turn that carries an attachment — the retrieval contract
// itself, shared so the gateway and bridge answer 'what did the model read' the same way.
import { makeSourceStore, manifestText, readSource, approxTokens } from './events/sources-retrieval.js';
import { extractUrls } from './events/sources.js';
import { detectEntities, normalizeEntities, EXTRACT_SYS, parseJsonLoose, withTimeout } from './pii-detect.js';
import { createVault, redactText, restoreText } from './pii-redact.js';
import { combineSystemPrompt, toolStatus } from './tool-hints.js';
import { getTarget, resolveTarget } from './store.js';
import { authHeadersForEndpoint } from './oauth.js';
import { mergeExtraBody, sanitizeExtraHeaders } from './request-options.js';
// Safety cap on the agent tool-use loop: a turn may call tools at most this many
// times before we stop, so a confused model can't loop forever. Generous enough
// for real multi-step tasks (filling a table, a multi-field booking, drawing a
// shape) — each click/type/Enter is a step, so these add up fast.
const MAX_TOOL_STEPS = Number(globalThis.CHATPANEL_MAX_TOOL_STEPS) || 60;

// Per-endpoint cap on model calls within ONE tool-using turn — a throttle for
// rate-limited providers (e.g. a 429). 0/unset → unlimited (the MAX_TOOL_STEPS
// backstop). On the final allowed call we withhold tools so the model must answer
// with the information it has already gathered ("work with available information")
// instead of emitting another tool call that can't run.
function toolStepCap(agent, tools) {
  if (!tools) return 1;
  const n = Number(agent?.maxRequestsPerTurn) || 0;
  return n > 0 ? Math.min(MAX_TOOL_STEPS, n) : MAX_TOOL_STEPS;
}
const MAX_IDENTICAL_TOOL_CALLS = Number(globalThis.CHATPANEL_MAX_IDENTICAL_TOOL_CALLS) || 3;
// GLOBAL stall breaker: the per-tool guard above blocks a SINGLE repeated call, but
// a weak model can keep cycling blocked calls across several tools (history_search,
// discover_tools, …) with the same garbage input, never making progress. After this
// many consecutive rounds where EVERY tool call was blocked, we stop offering tools
// so the model is forced to answer with what it has, instead of looping to the step
// limit. Strong models rarely hit this; weak ones are capped early.
const MAX_STALLED_ROUNDS = Number(globalThis.CHATPANEL_MAX_STALLED_ROUNDS) || 2;

// Observation/read tools are MEANT to be repeated (read → act → read again, with
// the SAME empty input) — re-reading after an action is correct, not a loop. They
// don't count toward the loop guard at all.
const OBSERVATION_TOOLS = new Set(['inspect_page', 'read_canvas', 'screenshot', 'marked_screenshot']);

// Pure reads whose repeated answer is the SAME answer, so a repeat can be served from what
// the first call returned rather than refused. Deliberately not page ACTIONS: replaying a
// click would be a lie about something that changes the world.
const REPLAYABLE_TOOLS = new Set([
  'web_search', 'read_page', 'history_search', 'history_get_source', 'history_related',
  'history_list_meetings', 'history_get_meeting',
]);

// A DISPATCHER tool carries the real action in its arguments — `page` with
// {action:'screenshot'} rather than a tool literally named `screenshot`. Every
// name-based policy below has to see through that, or the exemptions silently stop
// applying: a screenshot takes {} every time, so four in a row look like a stuck loop and
// get blocked, and the agent is left flailing for an argument it can vary. That is
// exactly what happened once page tools moved behind one registered tool.
function effectiveToolName(name, input) {
  const action = input && typeof input === 'object' ? input.action : null;
  return typeof action === 'string' && action ? action : name;
}

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
  'press_key', 'type_text', 'click_at', 'move_mouse', 'click_mark', 'draw_path', 'input_sequence',
  'click_element', 'click_by_text',
]);

// A tool whose repetition signals a LOOP (search/query/fetch tools), vs one that's
// meant to repeat (observations, scrolling, typing). Only loopable tools form the
// round signature, so a legit re-read/scroll never looks like a stalled loop.
function isLoopableTool(name) {
  return !OBSERVATION_TOOLS.has(name) && !INPUT_PROGRESS_TOOLS.has(name) && name !== 'scroll';
}

// Same question, asked of a call rather than a bare name — use this wherever the
// arguments are in hand, so a dispatched action is judged on what it actually is.
export function isMutatingCall(name, input) {
  return isMutatingTool(effectiveToolName(name, input));
}

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
  maxStalledRounds = MAX_STALLED_ROUNDS,
} = {}) {
  const counts = new Map();
  const lastResult = new Map();   // key -> what that identical call returned the first time
  let stalledRounds = 0;
  let lastSignature = null;

  return {
    // No nuclear per-turn kill switch — one looping tool must not disable the rest.
    // The MAX_TOOL_STEPS budget is the overall backstop.
    get disabled() {
      return false;
    },
    // After each tool round, note progress. A round makes NO progress when either
    // every call was blocked OR the round's call-set is byte-identical to the
    // previous round's (the model re-firing the exact same tools+args — a loop, even
    // before the per-tool block threshold trips). Enough no-progress rounds in a row
    // → `stalled`, and the caller stops offering tools so the model must answer.
    noteRound(blockedCount, total, signature = '') {
      const allBlocked = total > 0 && blockedCount >= total;
      const repeatRound = !!signature && signature === lastSignature;
      lastSignature = signature;
      // An EXACT-repeat round (same loopable tools+args as last round) is a
      // definitive loop — bail fast (2 strikes at once → stalls on the 2nd identical
      // round). All-blocked-but-varying is softer (needs maxStalledRounds rounds).
      if (repeatRound) stalledRounds += 2;
      else if (allBlocked) stalledRounds += 1;
      else stalledRounds = 0;
    },
    get stalled() {
      return stalledRounds >= maxStalledRounds;
    },
    // Clear a call's repeat count when it actually made progress — lets an
    // inherently-repetitive tool (scroll-to-bottom) keep going, while a genuinely
    // stuck loop still trips the cap.
    reset(key) {
      if (key) counts.delete(key);
    },
    /**
     * Remember what an identical call returned, so a repeat can be ANSWERED instead of
     * refused. A pure read asked twice has one true answer; replying "you already asked
     * that" is both unhelpful and, for a small model, the start of a worse loop — it varies
     * the query, gets a different and emptier result, and concludes the tool is broken.
     * That is exactly what a user saw: a repeated `web_search` refused, the retry reworded
     * into a query with no results, and the model announcing it had no access to weather.
     */
    remember(key, name, input, result) {
      if (!key || !result) return;
      if (!REPLAYABLE_TOOLS.has(effectiveToolName(name, input))) return;
      lastResult.set(key, result);
    },

    check(name, input) {
      // Reads are idempotent observations — re-reading after an action is correct,
      // so they never count toward the loop guard.
      if (OBSERVATION_TOOLS.has(effectiveToolName(name, input))) return { blocked: false };

      const key = stableToolCallKey(name, input);
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > maxIdenticalCalls && lastResult.has(key)) {
        // Serve the answer it already earned. Still counted, so a genuinely stuck loop is
        // still visible in the log — but the model gets the truth rather than a scolding.
        return { blocked: false, replayed: true, count, key, result: lastResult.get(key) };
      }
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

// Very cheap token estimate (~4 chars/token) — ONLY used when a provider didn't
// report usage. Deliberately no tokenizer import: real usage is both accurate
// and free (the model already told us), and a per-model tokenizer on the boot
// path would violate the load-time budget. Flagged `estimated` so the UI shows "≈".
function estimateTokens(text) {
  return Math.max(0, Math.round(String(text || '').length / 4));
}

// Normalize + emit ONE usage event for a completed turn. When the provider
// reported real usage we forward it; otherwise we estimate from the sent
// messages + produced text and mark it estimated.
function emitUsage(onEvent, provider, model, acc, sentMessages, fullText) {
  if (!onEvent) return;
  let { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reported } = acc;
  let estimated = false;
  if (!reported || (!inputTokens && !outputTokens)) {
    estimated = true;
    const inText = (sentMessages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
    inputTokens = estimateTokens(inText);
    outputTokens = estimateTokens(fullText);
    cacheReadTokens = 0;
    cacheWriteTokens = 0;
  }
  onEvent({ type: 'usage', provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimated });
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
  // Token accounting — accumulate across tool-use steps (each step is its own
  // completion with its own usage) and emit ONE total when the turn returns.
  const usageAcc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false };
  const finishUsage = () => emitUsage(onEvent, 'openai', agent.model || 'gpt-4o-mini', usageAcc, msgs, full);

  // One model turn = one streamed completion. Loops only when the model asks to
  // call tools; without tools it runs exactly once (unchanged single-shot path).
  const stepCap = toolStepCap(agent, tools);
  for (let step = 0; step < stepCap; step++) {
    const lastCall = step === stepCap - 1; // withhold tools → force a final answer
    const activeToolSpecs = (loopGuard.disabled || loopGuard.stalled || lastCall) ? undefined : adaptivePolicy.filterOpenAITools(toolSpecs);
    const doFetch = () => {
      const body = mergeExtraBody({
        model: agent.model || 'gpt-4o-mini',
        messages: msgs,
        stream: true,
        // Ask for token usage in the final SSE chunk. Ignored by servers that
        // don't support it (we then fall back to an estimate at finishUsage).
        stream_options: { include_usage: true },
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
      // Usage rides in a trailing chunk (choices often empty) when
      // stream_options.include_usage is honored. Accumulate across steps.
      if (json.usage) {
        usageAcc.reported = true;
        usageAcc.inputTokens += Number(json.usage.prompt_tokens || 0);
        usageAcc.outputTokens += Number(json.usage.completion_tokens || 0);
        usageAcc.cacheReadTokens += Number(json.usage.prompt_tokens_details?.cached_tokens || 0);
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
      finishUsage();
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
    let blockedThisRound = 0;
    for (const c of wanted) {
      const input = safeJson(c.args);
      // WHICH MODEL MADE THIS CALL. A turn can change model mid-flight — a failover after a
      // provider declines — and attributing every action to whichever model finished the
      // turn misreports the work. The one that drew the circle is not always the one that
      // answered.
      onEvent?.({ type: 'tool', name: c.name, phase: 'start', callId: c.id, input, model: modelLabelOf(agent) });
      const guard = loopGuard.check(c.name, input);
      if (guard.blocked) blockedThisRound += 1;
      const result = guard.blocked || guard.replayed
        ? guard.result
        : await tools.execute(c.name, input, { callId: c.id });
      adaptivePolicy.recordResult(c.name, result);
      if (!guard.blocked && toolMadeProgress(c.name, result)) loopGuard.reset(guard.key);
      loopGuard.remember(guard.key, c.name, input, result);
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
    const sig = wanted.filter((c) => isLoopableTool(c.name)).map((c) => stableToolCallKey(c.name, safeJson(c.args))).sort().join('|');
    loopGuard.noteRound(blockedThisRound, wanted.length, sig);
  }
  onEvent?.({ type: 'finish', reason: 'tool-step-limit' });
  finishUsage();
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
  // Token accounting — Anthropic splits input across message_start (input +
  // cache_creation + cache_read) and output across message_delta. Accumulate
  // across tool-use steps; emit one total per turn.
  const usageAcc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false };
  const finishUsage = () => emitUsage(onEvent, 'anthropic', agent.model || 'claude-opus-4-8', usageAcc, msgs, full);

  const stepCap = toolStepCap(agent, tools);
  for (let step = 0; step < stepCap; step++) {
    const lastCall = step === stepCap - 1; // withhold tools → force a final answer
    const activeToolSpecs = (loopGuard.disabled || loopGuard.stalled || lastCall) ? undefined : adaptivePolicy.filterAnthropicTools(toolSpecs);
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
      } else if (json.type === 'message_start') {
        const u = json.message?.usage;
        if (u) {
          usageAcc.reported = true;
          usageAcc.inputTokens += Number(u.input_tokens || 0);
          usageAcc.cacheWriteTokens += Number(u.cache_creation_input_tokens || 0);
          usageAcc.cacheReadTokens += Number(u.cache_read_input_tokens || 0);
        }
      } else if (json.type === 'message_delta') {
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
        if (json.usage?.output_tokens != null) {
          usageAcc.reported = true;
          usageAcc.outputTokens += Number(json.usage.output_tokens || 0);
        }
      } else if (json.type === 'message_stop') {
        // handled after the loop via stopReason
      } else if (json.type === 'error') {
        throw new Error(json.error?.message || 'Anthropic stream error');
      }
    }

    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (!tools || !activeToolSpecs?.length || stopReason !== 'tool_use' || toolUses.length === 0) {
      onEvent?.({ type: 'finish', reason: stopReason || 'stop' });
      finishUsage();
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
    let blockedThisRound = 0;
    for (const b of toolUses) {
      const input = safeJson(b.json);
      onEvent?.({ type: 'tool', name: b.name, phase: 'start', callId: b.id, input, model: modelLabelOf(agent) });
      const guard = loopGuard.check(b.name, input);
      if (guard.blocked) blockedThisRound += 1;
      const result = guard.blocked || guard.replayed
        ? guard.result
        : await tools.execute(b.name, input, { callId: b.id });
      adaptivePolicy.recordResult(b.name, result);
      if (!guard.blocked && toolMadeProgress(b.name, result)) loopGuard.reset(guard.key);
      loopGuard.remember(guard.key, b.name, input, result);
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
    const sig = toolUses.filter((b) => isLoopableTool(b.name)).map((b) => stableToolCallKey(b.name, safeJson(b.json))).sort().join('|');
    loopGuard.noteRound(blockedThisRound, toolUses.length, sig);
    msgs.push({ role: 'user', content: results });
  }
  onEvent?.({ type: 'finish', reason: 'tool-step-limit' });
  finishUsage();
  return full + (full ? '\n\n' : '') + '_(Reached the action limit for one turn — say "continue" to keep going.)_';
}

// --------------------------------------------------------------------------
// ChatPanel Bridge (Claude Code / Codex / Antigravity CLI on the user's machine)
// --------------------------------------------------------------------------
// Relay one CLI-agent tool call back to the extension's executor and POST the
// result to the bridge. Fire-and-forget so the SSE loop keeps reading; the
// bridge is blocked awaiting /tool-result, so there's nothing to read until then.
export async function relayBridgeTool(base, ev, tools, onEvent, loopGuard = createToolLoopGuard(), label = '') {
  // The bridge is BLOCKED on /tool-result until we answer, so every exit from
  // this function must POST one — including a crash in our own bookkeeping.
  // Without that guarantee a throw here strands the CLI agent forever (the tool
  // shows `running` for minutes after the work is actually done).
  let result;
  try {
    onEvent?.({ type: 'tool', name: ev.name, phase: 'start', callId: ev.id, input: ev.input, model: label });
    const guard = loopGuard.check(ev.name, ev.input);
    result = guard.blocked
      ? guard.result
      : tools
        ? await tools.execute(ev.name, ev.input, { callId: ev.id, session: ev.session })
        : JSON.stringify({ error: 'no tools armed' });
    if (!guard.blocked && toolMadeProgress(ev.name, result)) loopGuard.reset(guard.key);
    loopGuard.remember(guard.key, ev.name, ev.input, result);
  } catch (e) {
    result = JSON.stringify({ error: String(e?.message || e) });
  } finally {
    const image = result && typeof result === 'object' ? result.image : undefined;
    try {
      onEvent?.({ type: 'tool', name: ev.name, phase: 'done', callId: ev.id, image, status: toolStatus(result), result: stepResultText(result) });
    } catch { /* a reporting failure must not strand the agent */ }
    await fetch(`${base}/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: ev.session, id: ev.id, result: result ?? JSON.stringify({ error: 'tool relay failed' }) }),
    }).catch(() => {});
  }
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
  // Antigravity (headless `agy -p`) can't reliably use our per-turn tools.
  // It has no per-run MCP flag; it only connects to MCP servers through its
  // long-lived background service, which does NOT synchronously pick up a config
  // we write for a single headless run (verified: cold runs never connect before
  // timing out). If we still advertised the tools — specs + the "callable tools:
  // …" system inventory — the model would emit a call to a tool agy never
  // registered → "invalid tool call (unknown_tool)". So withhold tools from agy:
  // it answers from the attached page/context instead of calling into the void.
  // (Tool-using / "Act on page" tasks work with Claude Code or Codex, whose CLIs
  // accept an MCP config arg and connect synchronously within the run.)
  const turnTools = bridgeAgent === 'antigravity' ? null : tools;
  const body = {
    agent: bridgeAgent,
    system: combineSystemPrompt(agent.systemPrompt, turnTools?.system),
    options,
    messages: toChatMessages(messages),
    ...(images.length ? { images } : {}),
    // Hand the CLI agent our turn tools. The bridge hosts an MCP server with
    // these specs and relays each call back to us (tools.execute) over the SSE.
    ...(turnTools?.specs?.length ? { pageTools: { specs: turnTools.specs } } : {}),
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

  // STOP IS AN INSTRUCTION, NOT A DROPPED SOCKET.
  //
  // Aborting the fetch left the bridge to infer cancellation from a socket close, which
  // arrives late and, on a request whose body was already consumed, may not arrive at all —
  // a codex shell step ran on for minutes after Stop. The bridge now names each run, and we
  // tell it to stop that run by name. The socket path stays as the backstop for a panel
  // that crashes.
  let runId = null;
  const cancelRun = () => {
    if (!runId) return;
    const id = runId;
    runId = null;
    fetch(`${base}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      // NOT the turn's signal: this request exists BECAUSE that signal fired, and passing it
      // would abort the cancellation itself.
    }).catch(() => {});
  };
  signal?.addEventListener?.('abort', cancelRun, { once: true });

  let full = '';
  // Token accounting for CLI agents. Newer bridges emit a {type:'usage'} SSE
  // event (real counts from Claude Code / Codex stream-json); older ones don't,
  // so we estimate from the produced text at the end. `costUsd` (when the CLI
  // reports it) is authoritative and bypasses our rate table.
  let usage = null;
  const loopGuard = createToolLoopGuard();
  for await (const data of sseLines(res)) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === 'run') {
      runId = ev.id;
      // Stop may have been pressed before the id arrived — honour it the moment it does.
      if (signal?.aborted) cancelRun();
      continue;
    }
    if (ev.type === 'delta' && ev.text) {
      full += ev.text;
      onDelta?.(ev.text);
    } else if (ev.type === 'usage') {
      usage = {
        type: 'usage', provider: 'bridge', model: ev.model || agent.model || bridgeAgent,
        inputTokens: Number(ev.inputTokens || 0), outputTokens: Number(ev.outputTokens || 0),
        cacheReadTokens: Number(ev.cacheReadTokens || 0), cacheWriteTokens: Number(ev.cacheWriteTokens || 0),
        costUsd: ev.costUsd != null ? Number(ev.costUsd) : null, estimated: false,
      };
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
      relayBridgeTool(base, ev, tools, onEvent, loopGuard, modelLabelOf(agent));
    } else {
      // tool use / status / reasoning — surface for the activity strip.
      onEvent?.(ev);
    }
  }
  if (usage) onEvent?.(usage);
  else emitUsage(onEvent, 'bridge', agent.model || bridgeAgent, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false }, toChatMessages(messages), full);
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
// In-browser model (WebLLM / WebGPU) — the zero-setup path: no key, no bridge, no
// gateway. The ~6 MB runtime + the model weights load on first use; we surface that as
// a `model-load` event so the UI shows download progress in the pending bubble.
// Text-only (small on-device models don't take images/tools). 100% on-device.
// Trim a chat list to ~budget chars, NEWEST-first. The current (last) turn is kept and
// its tail truncated — renderContent puts the user's question FIRST and the attached
// page context AFTER, so this preserves the question and as much leading context as
// fits; older turns are dropped once the budget runs out.
function fitWebllmMessages(chat, budget) {
  const kept = [];
  let left = Math.max(400, budget);
  for (let i = chat.length - 1; i >= 0; i--) {
    let c = chat[i].content;
    if (c.length > left) {
      if (i === chat.length - 1) c = c.slice(0, left) + '\n\n…[context truncated to fit this model]';
      else break; // no room for older turns
    }
    kept.unshift({ ...chat[i], content: c });
    left -= c.length;
    if (left <= 0) break;
  }
  return kept;
}

async function streamWebLLM(agent, messages, { signal, onDelta, onEvent, settings }) {
  const { streamChat: streamWebLLMChat, DEFAULT_WEBLLM_MODEL, webllmPromptBudget } = await import('./webllm.js');
  const model = (agent.model && String(agent.model).trim()) || DEFAULT_WEBLLM_MODEL;
  const isQwen3 = /qwen3/i.test(model);
  // User-added MLC models (Settings) → WebLLM appConfig shape, so a custom id loads too.
  const customModels = (settings?.webllmCustomModels || [])
    .filter((c) => c && c.id && c.model && c.model_lib)
    .map((c) => ({ model_id: c.id, model: c.model, model_lib: c.model_lib }));

  // Fold attachments (page/selection/URL context) into the text using the SAME helper
  // the API providers use — WITHOUT this the in-browser model never saw the page context.
  const chat = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: renderContent(m) }))
    .filter((m) => m.content != null && m.content !== '');

  // A small on-device model has a tiny context window, and a full page overflows it —
  // compact to the model's budget (its question survives; context is trimmed to fit).
  const sysText = String(agent.systemPrompt || '').trim();
  const fitted = fitWebllmMessages(chat, webllmPromptBudget(model) - sysText.length);
  const msgs = sysText ? [{ role: 'system', content: sysText }, ...fitted] : fitted;

  let lastText = '';
  const onProgress = (r) => {
    const text = r?.text || `Preparing on-device model… ${Math.round((r?.progress || 0) * 100)}%`;
    if (text !== lastText) { lastText = text; onEvent?.({ type: 'model-load', text: `⏬ ${text}`, progress: r?.progress || 0 }); }
  };

  // Generation controls for a tiny model: cap length + penalize repetition so it can't
  // fall into a loop (the citation/link degeneration we saw), and turn Qwen3's <think>
  // OFF at the source (enable_thinking:false is reliable; the /no_think text switch isn't).
  const params = {
    max_tokens: 512,        // bound runaway length (a slow on-device model can't ramble forever)
    temperature: 0.7,
    frequency_penalty: 0.7, // discourage the tiny-model repetition loop harder
    presence_penalty: 0.5,
    ...(isQwen3 ? { extra_body: { enable_thinking: false } } : {}),
  };

  // Show the answer directly. Strip any residual <think>…</think> (and stray tags) so a
  // build that still reasons doesn't hide the reply — but DON'T route it to a collapsible
  // (a model that never closes </think> would look "stuck" with an empty answer).
  const clean = (s) => s.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').replace(/<\/?think>/gi, '');
  const background = !!settings?.ui?.webllmBackground; // opt-in "stay warm" offscreen engine
  let raw = ''; let shown = 0;
  for await (const delta of streamWebLLMChat(model, msgs, { onProgress, signal, params, customModels, background })) {
    raw += delta;
    const vis = clean(raw);
    if (vis.length > shown) { onDelta?.(vis.slice(shown)); shown = vis.length; }
  }
  return clean(raw);
}

async function dispatchStream({ agent, messages, settings, signal, onDelta, onEvent, tools }) {
  const opts = { settings, signal, onDelta, onEvent, tools };
  // Bridge CLIs (Claude Code / Codex …) run their OWN agentic loop. They can now
  // ALSO use our browser tools: the bridge hosts an MCP server with the specs we
  // send and relays each call back here (see streamBridge / relayBridgeTool).
  if (agent.kind === 'bridge') return streamBridge(agent, messages, opts);
  // In-browser model: the model defaults internally, so this must run BEFORE the
  // "no model selected" check below.
  if (agent.kind === 'webllm') return streamWebLLM(agent, messages, opts);
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
  // Meter the detector too — it's a real (Pro) model call. Tagged 'redaction' so
  // its token spend is visible alongside chat/notes/meetings.
  const detModel = det.model || target.model;
  const onDetectEvent = (ev) => {
    if (ev && ev.type === 'usage') import('./usage-meter.js').then((m) => m.recordUsageEvent(ev, { surface: 'redaction', agentId: target.agentId || target.name || null })).catch(() => {});
  };
  const ask = (jsonMode) => withTimeout(dispatchStream({
    agent: {
      ...target, systemPrompt: EXTRACT_SYS, temperature: 0,
      maxTokens: det.maxTokens || 256, model: detModel,
      ...(jsonMode ? { extraBody: { ...(target.extraBody || {}), response_format: { type: 'json_object' } } } : {}),
    },
    messages: [{ role: 'user', content: prompt }],
    settings, signal, onEvent: onDetectEvent,
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
  // Report the WHOLE pipeline: reversible redactions (value → [[TOKEN]]) AND
  // pseudonyms (value → alias). Pseudonyms aren't tokenized, so they live in
  // vault.aliases (alias → original) — without these the preview misses them.
  const spans = [
    ...[...vault.byToken].map(([token, value]) => ({ token, value, kind: 'redact' })),
    ...[...vault.aliases].map(([alias, value]) => ({ token: alias, value, kind: 'alias' })),
  ];
  return { redacted, spans, detector };
}

// Minimum wall-clock the LOCAL entity detector (NER / model) gets before we fall
// open. A fast detector returns in well under a second, so this is just a CEILING
// — it never adds latency in the common case. But a slow/cold detector that needs
// several seconds (e.g. first call while a model loads) MUST be allowed to finish:
// if it times out, the turn silently falls back to dictionary/deterministic-only
// redaction, which produces PERMANENT pseudonyms the reply-restorer can't undo.
// The Settings "Test a prompt" harness AND the real chat turn use this same value,
// so they detect+tokenize+restore identically.
const DETECT_TIMEOUT_MS = 30000;

// Settings-page helper: run a prompt END-TO-END through the privacy pipeline against
// a chosen chat model, capturing every stage for the flow visual — what's detected,
// what the model SEES (redacted), its raw reply, and what YOU see (restored). Tools
// (local + MCP) would receive the real `spans` values; the flow shows that statically.
export async function traceFlow(settings, targetId, prompt, { tools, signal } = {}) {
  const cfg = (settings && settings.ui && settings.ui.piiRedaction) || {};
  const tier = cfg.mode === 'model' ? 'full' : 'basic';
  const text = String(prompt || '');
  const target = resolveTarget(getTarget(settings, targetId), settings);
  // Honor "Redact for: Remote only" — a LOCAL model keeps data on-device, so skip
  // detection + redaction entirely (faster; the model sees the real text), exactly
  // like a real turn does. Also skip when redaction is off.
  const redactionOn = cfg.mode === 'deterministic' || cfg.mode === 'model';
  const skipped = !redactionOn || (cfg.applyTo === 'remote' && isLocalAgent(target));
  const vault = createVault();
  let detected = [];
  let modelSees = text;
  let spans = [];
  if (!skipped) {
    detected = cfg.mode === 'model'
      ? await detectForChat(text, { ...cfg, detection: { ...(cfg.detection || {}), timeoutMs: Math.max(Number(cfg.detection && cfg.detection.timeoutMs) || 0, DETECT_TIMEOUT_MS) } }, settings, signal, { strict: true })
      : [];
    modelSees = redactText(text, vault, { tier, entities: detected, dictionary: cfg.dictionary || [] });
    spans = [
      ...[...vault.byToken].map(([token, value]) => ({ token, value, kind: 'redact' })),
      ...[...vault.aliases].map(([alias, value]) => ({ token: alias, value, kind: 'alias' })),
    ];
  }
  // Wrap the toolset so each call is TRACED and redaction is applied exactly like a
  // real turn: restore the model's token args before the tool runs, then re-redact
  // the result before it goes back to the model.
  const toolTrace = [];
  let tracedTools;
  if (tools && typeof tools.execute === 'function') {
    const base = tools.execute.bind(tools);
    // THE shared tool harness — identical to the real chat turn (and the gateway),
    // so the preview shows EXACTLY what production does. `skipped` (local model /
    // redaction off) → no vault → pass-through, but tools still ran.
    const tcfg = { ...cfg, tier };
    const harness = makeToolHarness({
      vault: skipped ? null : vault,
      toolData: cfg.toolData,
      redactOpts: redactOpts(tcfg, true, detected),
      redactResults: gatedScope(tcfg, true).toolResults,
      remoteTools: tools.remoteTools, // explicit remote set (L3), not the name heuristic
    });
    tracedTools = {
      ...tools,
      execute: async (name, input, meta) => {
        const realArgs = harness.toTool(name, input);
        const redactedToTool = harness.enabled && cfg.toolData === 'redactRemote' && harness.isRemoteTool(name);
        const row = { name, modelArgs: input, realArgs, redactedToTool, result: '', modelResult: '', error: null };
        let out;
        try {
          const raw = await base(name, realArgs, meta);
          out = harness.toModelResult(name, raw);
          row.result = stepResultText(raw);
          row.modelResult = stepResultText(out);
        } catch (e) {
          row.error = (e && e.message) || 'tool error';
          out = `Tool error: ${row.error}`;
        }
        toolTrace.push(row);
        return out;
      },
    };
  }
  let modelRaw = '';
  let error = null;
  if (!target) {
    error = 'Pick a model to run the full flow.';
  } else {
    try {
      const toolNote = (tracedTools && !skipped) ? placeholderToolNote({ toolData: cfg.toolData }) : '';
      const out = await dispatchStream({
        agent: { ...target, systemPrompt: combineSystemPrompt(target.systemPrompt, tracedTools && tracedTools.system, toolNote) },
        messages: [{ role: 'user', content: modelSees }],
        settings, signal, tools: tracedTools,
      });
      modelRaw = typeof out === 'string' ? out : (out && out.text) || '';
    } catch (e) { error = (e && e.message) || 'model call failed'; }
  }
  const youSee = restoreText(modelRaw, vault);
  return { input: text, detected, modelSees, spans, toolTrace, modelRaw, youSee, error, skipped };
}

// Public entry. When `redaction` ({ vault, cfg, isPro, entities }) is enabled, it
// redacts everything outbound into the vault, restores the streamed reply, and
// round-trips tool calls — restoring the model's token args before LOCAL execution
// and re-redacting the result before返回 to the model. One wrapper covers the
// API and bridge backends because they all run through dispatchStream().
// Runtime context injected into EVERY model call (the single chokepoint below), so
// current and future agents inherit it: today's date (models often assume an older
// year) and the enforced response language from settings.
function runtimeContextSystem(settings) {
  const lines = [];
  try {
    const date = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    lines.push(
      `Today's date is ${date}. Treat this as the current date — your training data may be ` +
      `older, so do not assume an earlier year when reasoning about "now", recent events, or ` +
      `time-sensitive facts.`,
    );
  } catch { /* Date unavailable — skip */ }
  const lang = String(settings?.ui?.language || '').trim();
  if (lang && !/^(auto|default)$/i.test(lang)) {
    lines.push(
      `Always respond in ${lang}, regardless of the language the user writes in, unless they ` +
      `explicitly ask for a different language.`,
    );
  }
  return lines.join('\n');
}

/**
 * The one entry point every model-bound call passes through — chat, notes, meetings,
 * watch, assist. Turn lifetime is NOT held here any more: the shared runner opens the
 * turn before this body runs and closes it in `finally`, so the early-return path that
 * once left every finished note reporting itself as still running cannot recur. See
 * `js/turn-runner.js` and `events/loop.js`.
 */
export async function streamChat(opts = {}) {
  const { loop, request } = turnSpecFor(opts);
  const { runAsTurn } = await import('./turn-runner.js');
  // `signal` is deliberately not part of turnSpecFor — it is live state, not a
  // description of the turn — but the runner needs it to tell "you stopped it" from
  // "it broke".
  return runAsTurn(
    loop,
    // `startedAt` is when the USER acted. Everything before this call — assembling tools,
    // connecting to MCP servers — is time they waited, and a duration measured from here
    // reported 2.6s for a message that took 48.
    { ...request, signal: opts.signal, startedAt: opts.usage?.startedAt },
    (turn) => {
      // Time to first token, reported once. Total duration cannot distinguish "took ages
      // to start" from "wrote a long answer", and only the first is a problem worth
      // chasing — it is what "it felt slow" actually means.
      const t0 = Date.now();
      const inner = opts.onDelta;
      // Shared holder rather than a closure variable the body cannot see: the body needs the
      // measured value to stamp it on the first request record, and a local that is only
      // ever read as null is worse than no field at all.
      const timing = { ttftMs: null };
      const onDelta = inner
        ? (d) => {
          if (timing.ttftMs == null) { timing.ttftMs = Date.now() - t0; turn.report({ ttftMs: timing.ttftMs }); }
          return inner(d);
        }
        : inner;
      return streamChatTurn({ ...opts, onDelta, timing }, turn);
    },
  );
}

/**
 * What kind of turn this call is — pure, so it is assertable.
 *
 * Extracted deliberately. Three separate bugs in this codebase came from behaviour that
 * only existed inside a call nothing could reach (the dispatcher blinding the loop guard,
 * the swallowed Enter key, every activity row reading `page`). Each was fixed by pulling
 * the decision into a function a test could call.
 */
export function turnSpecFor({ usage, tools, onDelta, agent } = {}) {
  const kind = usage?.surface || 'other';
  // A turn that streams nothing to a human and calls no tool is infrastructure — a title,
  // a topic pass, a grammar fix. Recorded either way (the privacy record must cover every
  // model call) but folded out of the default view, or one note buries its own run under
  // a dozen one-token rows. This reads a signal the call already carries rather than
  // guessing from maxTokens.
  const background = !(tools?.specs || []).length && !onDelta;
  return {
    loop: { id: `loop:${kind}`, kind, background },
    request: {
      turnId: usage?.turnId,
      kind,
      agentId: agent?.agentId || agent?.id || agent?.name || usage?.agentId || null,
      surface: usage?.surface || null,
      sourceId: usage?.sourceId || null,
      background,
    },
  };
}

/**
 * Watch tool results for numbered sources, and rewrite the answer's bare `[1]` citations
 * into links using them.
 *
 * The model is asked to write markdown links; large models mostly do and small ones write
 * bare numbers, leaving a reader with figures that reference nothing while the URLs sit in
 * a tool result they never see. The mapping is already known exactly — the tool numbered
 * them — so this is a substitution, not a judgement, and a rule cannot fail to follow it
 * the way an instruction can.
 */
/**
 * Watch tool results for sources — for the answer AND for the record.
 *
 * A turn's INPUT is not just what the person typed. It is also everything fetched to support
 * it: notes, past chats, meeting transcripts, search results, an attached page read on
 * demand. None of that was recorded, so a trajectory showed a tool ran and an answer
 * appeared, with the material that connected them nowhere. And the citations already being
 * extracted here were applied to the text and then thrown away, so the OUTPUT could not say
 * what it was based on either.
 *
 * Both come from the same place, so both are captured here.
 */
function citationCollector(tools, turn = null) {
  const sources = new Map();
  const collect = (name, text) => {
    const body = typeof text === 'string' ? text : (text?.text || '');
    if (!body) return;
    import('./events/citations.js')
      .then((m) => {
        const found = m.sourcesFromToolText(body);
        for (const s of found) if (!sources.has(s.rank)) sources.set(s.rank, s);
        // RETRIEVAL IS INPUT. Recorded per call, so the turn shows what it was given and by
        // which tool — a tool that ran is not the same fact as a tool that returned material.
        if (found.length && turn) {
          turn.emit('context.retrieved', {
            tool: name,
            count: found.length,
            chars: body.length,
            sources: found.slice(0, 20).map((x) => ({ rank: x.rank, title: x.title || '', url: x.url || '' })),
          });
        } else if (turn && RETRIEVAL_TOOLS.has(String(name || '').replace(/^mcp[_-]/, '').split('__')[0])) {
          // A retrieval tool that returned no LINKS still returned material — notes and past
          // chats have no urls. Silence here would under-report exactly the private sources
          // this is meant to make visible.
          turn.emit('context.retrieved', { tool: name, count: 0, chars: body.length, sources: [] });
        }
      })
      .catch(() => {});
  };
  const wrapped = tools && tools.execute
    ? {
      ...tools,
      execute: async (name, input, meta) => {
        const out = await tools.execute(name, input, meta);
        collect(name, out);
        return out;
      },
    }
    : tools;
  return {
    tools: wrapped,
    list: () => [...sources.values()],
    async apply(answer) {
      if (!sources.size || !answer) return answer;
      try {
        const { linkifyCitations } = await import('./events/citations.js');
        return linkifyCitations(answer, [...sources.values()]);
      } catch {
        return answer;   // a citation pass must never cost the user their answer
      }
    },
  };
}

/** Tools whose job is to RETURN material rather than to act on something. */
const RETRIEVAL_TOOLS = new Set(['find', 'source', 'history_search', 'web_search', 'search', 'fetch', 'read_page']);

async function streamChatTurn({ agent, messages, settings, signal, onDelta, onEvent, tools, redaction, usage: usageCtx, timing, sources }, turn) {
  // Per-round-trip records for this turn. Accumulated rather than overwritten — see the
  // usage handler below.
  const requests = [];
  // Token accounting at THE chokepoint: every provider adapter emits one
  // {type:'usage'} event per turn; record it here (best-effort, off the hot
  // path) tagging it with the caller's surface/sourceId, then forward the event
  // unchanged. `usageCtx` = { surface:'note'|'chat'|'meeting'|…, sourceId }.
  {
    const rawOnEvent = onEvent;
    const agentId = agent?.agentId || agent?.id || agent?.name || usageCtx?.agentId || null;
    const ctx = { surface: usageCtx?.surface || 'other', sourceId: usageCtx?.sourceId, agentId };
    onEvent = (ev) => {
      if (ev && ev.type === 'usage') {
        import('./usage-meter.js').then((m) => m.recordUsageEvent(ev, ctx)).catch(() => {});
        // ONE RECORD PER ROUND-TRIP, not one per turn. A tool loop asks the model, gets a
        // call, feeds the result back and asks again; each of those is a separate usage
        // event, and overwriting them left a four-request turn looking like one. "The
        // second request is where it went wrong" is a sentence a user can act on.
        requests.push({
          index: requests.length + 1,
          tokensIn: ev.inputTokens ?? null,
          tokensOut: ev.outputTokens ?? null,
          cacheReadTokens: ev.cacheReadTokens ?? null,
          model: ev.model || null,
          estimated: !!ev.estimated,
          // Only the first round-trip has a measured time-to-first-token; the rest would be
          // guesses, and a guess in this table is indistinguishable from a measurement.
          ttftMs: requests.length === 0 ? (timing?.ttftMs ?? null) : null,
          at: Date.now(),
        });
        turn.report({ requests });
        // Put the REAL cost on the turn record. Activity previously showed the resident
        // tool-schema cost under a "tok" label, which is a fact about the prompt we built,
        // not about what the turn spent — so a turn that answered from a 4k-token context
        // and one that burned 40k both read the same.
        turn.report({
          tokensIn: ev.inputTokens ?? null,
          tokensOut: ev.outputTokens ?? null,
          cacheReadTokens: ev.cacheReadTokens ?? null,
          model: ev.model || null,
          provider: ev.provider || null,
          estimated: !!ev.estimated,
        });
      }
      return rawOnEvent?.(ev);
    };

    // ACTIVITY IS RECORDED HERE, NOT PER SURFACE.
    //
    // Notes, meetings and assist all reach a model through this function — which is also
    // where redaction and the tool harness already live, so privacy has always applied
    // everywhere. The activity log did not: it was emitted from the side panel's own send
    // path, so notes and meetings were simply missing from it.
    //
    // Different starting points is how a guarantee ends up true in one surface and
    // untested in the others. One chokepoint, one record.
    //
    // turn.started/turn.ended belong to the runner. What is left here is the one fact
    // only this function knows — what the model was actually shown.
    const toolSpecs = tools?.specs || [];
    turn.emit('context.assembled', {
      budget: 0,
      used: approxTok(toolSpecs) + approxTok(tools?.system),
      parts: {
        toolSchemas: approxTok(toolSpecs),
        system: approxTok(tools?.system),
        messages: approxTok(messages),
      },
      // The preamble broken down by which tool group asked for it, so an expensive turn can
      // be traced to the blurb responsible instead of to 'system'.
      systemParts: tools?.systemParts || null,
      resident: [],
      reachableCount: toolSpecs.length,
      tools: toolSpecs.map((t) => t.name || t.function?.name).filter(Boolean),
      surface: ctx.surface,
      redaction: !!redaction?.vault,
      // Setup time, so "it was slow" can be attributed instead of guessed: prepMs is
      // everything before the model saw anything, mcpMs the part spent connecting to the
      // user's servers.
      prepMs: tools?.prepMs ?? null,
      mcpMs: tools?.mcpMs ?? null,
    });

    // WHAT THE ROUTER WOULD HAVE CHOSEN — recorded, not obeyed.
    //
    // Observe mode: the decision is computed and logged while the existing target selection
    // still runs. A router that took over every message on its first day would be
    // indistinguishable, when something felt wrong, from any other change made that day.
    // Once the recorded decisions look right, switching it on is one setting.
    //
    // Free to compute (class R, no model call) and fire-and-forget, so an observation can
    // never cost or break the turn it is observing.
    // Only when routing did NOT apply. When Auto answered, the applied decision is already
    // recorded, and adding an observation computed separately is how the log came to say
    // "would route to Gemma4" about a turn OpenCode answered.
    if (agent?.kind !== 'router' && agent?.id !== 'router:auto') recordRouteDecision(turn, agent, settings, tools, messages);
    // Also on the turn record, so a reader does not have to join two events to answer
    // "where did the time go".
    turn.report({ prepMs: tools?.prepMs ?? null, mcpMs: tools?.mcpMs ?? null });
  }
  // ROUTING, when the user has switched it on.
  //
  // Applied here rather than at each call site so every surface inherits it — and applied
  // BEFORE the system prompt is composed, so the routed model gets the same treatment any
  // other would. Returns null in every uncertain case, and null means "leave the choice
  // alone": routing must never be the reason a message fails to send.
  {
    const routed = await pickRoutedAgent(agent, settings, tools, turn, messages, sources);
    if (routed) {
      agent = routed;
      // Tell the panel, so the reply can name the model that answered. Emitted as an event
      // rather than returned, because the answer streams — by the time a return value
      // arrives the user has been reading text from a model they cannot identify.
      if (routed.routedVia) onEvent?.({ type: 'routed', ...routed.routedVia });
    }
  }

  // PULL, NOT PUSH. Swap attached content for a manifest plus a `source` tool before the
  // prompt is built, so every surface — chat, notes, meetings — inherits it from the one
  // place they all pass through.
  {
    const deferred = deferAttachedSources(messages, tools);
    if (deferred) {
      messages = deferred.messages;
      tools = withSourceTool(tools, deferred.store);
      onEvent?.({ type: 'sources', deferred: deferred.store.entries.length, tokens: deferred.store.tokens });
    }
  }

  // ── the source ceiling ────────────────────────────────────────────────────
  //
  // ROUTING IS NOT ENOUGH. `pickRoutedAgent` returns null in every uncertain case and null
  // means "leave the choice alone" — which is right for a preference and catastrophic for a
  // privacy rule: an internal page with no local model available would have gone to the
  // third party the user had selected. And routing only runs under Auto, so a manually
  // chosen cloud model bypassed it entirely.
  //
  // So this is a GATE, not a ranking. It runs on every turn, after routing has had its
  // chance to pick something local, and it REFUSES rather than substituting: silently
  // answering from a different model is the substitution this codebase keeps removing, and
  // silently sending anyway is the leak it exists to stop.
  {
    const gate = await sourceGate(agent, settings, messages, sources);
    if (gate?.blocked) {
      onEvent?.({ type: 'blocked', reason: 'internal-source', detail: gate.why, model: modelLabelOf(agent) });
      throw new Error(gate.message);
    }
  }

  // ONE place every model-bound call passes through — augment the agent's system
  // prompt with runtime context (date + enforced language) so all agents, present
  // and future, inherit it without per-provider wiring.
  agent = { ...agent, systemPrompt: combineSystemPrompt(agent?.systemPrompt, runtimeContextSystem(settings)) };
  // Default: cover EVERY model-bound call (chat, topic extraction, meeting scribe,
  // autocomplete…). A caller that omits `redaction` still gets the user's
  // configured redaction; pass an explicit object (or null) only to override.
  if (redaction === undefined) redaction = redactionFromSettings(settings);
  // "Redact for remote models only": a local model keeps data on-device, so skip
  // redaction entirely for it (the user chose not to pay the redaction cost locally).
  if (redaction && redaction.cfg && redaction.cfg.applyTo === 'remote' && isLocalAgent(agent)) redaction = null;
  if (!redaction || !redaction.vault || !redactionEnabled(redaction.cfg)) {
    // This path returns early — which is exactly how the turn once escaped without
    // closing, and how it would now escape without a transcript. Both belong on every
    // exit, not on the one that happened to be edited last.
    recordPrompt(turn, agent, messages, tools);
    const cites = citationCollector(tools, turn);
    const full = await withFailover(
      agent, settings, tools, turn, onEvent, signal,
      (a) => dispatchStream({ agent: a, messages, settings, signal, onDelta, onEvent, tools: cites.tools }),
    );
    if (typeof full === 'string' ? full.trim() : full) turn.produced();
    const cited = typeof full === 'string' ? await cites.apply(full) : full;
    recordAnswer(turn, cited, cites.list());
    return cited;
  }
  const { vault, cfg, isPro = false, entities = [] } = redaction;
  // Phase 2: when mode is 'model', run the configured LOCAL detector to find
  // names/orgs/IDs, merge them in, and treat this as the full (entity) tier. Fails
  // open (detector down/slow → deterministic redaction still applies).
  let activeCfg = cfg;
  let activeEntities = entities;
  let effIsPro = isPro;
  // AI (full-tier) detection is Pro; Free gets a lifetime allowance counted by the
  // shared quota (chat + privacy screen). Check BEFORE running the detector so an
  // out-of-quota Free user stays on deterministic redaction (no model call). Pro
  // always passes.
  if (redaction.detect && cfg.mode === 'model' && await canUseFullRedaction(isPro)) {
    try {
      // Sanitize before detection too: a zero-width-split name must be rejoined here
      // or the NER pass misses it (redactOutbound also scrubs the delivered copy).
      const sample = sanitizeUnicode((messages || []).map((m) => m.content || '').join('\n')).clean;
      // Same detection budget as the Settings "Test a prompt" harness, so the real
      // chat detects+tokenizes (reversible [[TYPE_n]] → restored) instead of timing
      // out and falling back to dictionary pseudonyms (permanent, unrestored).
      const detectCfg = { ...cfg, detection: { ...(cfg.detection || {}), timeoutMs: Math.max(Number(cfg.detection && cfg.detection.timeoutMs) || 0, DETECT_TIMEOUT_MS) } };
      const found = await detectForChat(sample, detectCfg, settings, signal);
      if (found.length) {
        activeEntities = [...entities, ...found];
        activeCfg = { ...cfg, tier: 'full' };
        // Model detection is itself the Pro gate. Once it has run and found
        // entities, redact them regardless of a possibly-stale isPro on the default
        // (auxiliary-call) path — otherwise titles/topics/etc. would leak.
        effIsPro = true;
        // Burn one of the Free lifetime allowance (no-op for Pro). Only on a real
        // hit, so an empty detection doesn't cost the user a redaction.
        await recordFullRedaction(isPro);
      }
    } catch { /* fail open */ }
  }
  const ctx = { vault, cfg: activeCfg, isPro: effIsPro, entities: activeEntities };
  // THE shared tool harness — same one the gateway uses. Owns ② tool args and
  // ③ result re-redaction so this path can't drift from the others.
  const harness = makeToolHarness({
    vault, toolData: activeCfg.toolData,
    redactOpts: redactOpts(activeCfg, effIsPro, activeEntities),
    redactResults: gatedScope(activeCfg, effIsPro).toolResults,
    remoteTools: tools?.remoteTools, // explicit remote set (L3), not the name heuristic
  });
  const red = redactOutbound({ messages, system: agent.systemPrompt, vault, cfg: activeCfg, isPro: effIsPro, entities: activeEntities });
  // When tools are armed, tell the model placeholders are auto-restored for tools —
  // so privacy-aware models (Codex/Claude) USE them instead of refusing the lookup.
  // Appended AFTER redaction so it isn't itself redacted.
  const systemPrompt = tools ? combineSystemPrompt(red.system, placeholderToolNote({ toolData: activeCfg.toolData })) : red.system;
  const safeAgent = { ...agent, systemPrompt };
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
      // ② tool gets real values (or the redacted token for remote MCP under
      // "redact remote"); ③ the result is re-redacted before the model sees it.
      execute: async (name, input, meta) =>
        harness.toModelResult(name, await base(name, harness.toTool(name, input), meta)),
    };
  }
  // What the model is ABOUT to be shown — recorded before the call, so a turn that dies
  // mid-stream still says what was asked. Deliberately the REDACTED copy: it is what the
  // model actually saw, which makes it both the honest record and the safer one.
  recordPrompt(turn, safeAgent, red.messages, safeTools);

  // No try/catch. The one that used to be here existed solely to close the turn on the
  // error path; the runner does that in its own `finally`, so an exception simply
  // propagates and the turn is still recorded as failed.
  const cites = citationCollector(safeTools, turn);
  const full = await dispatchStream({
    agent: safeAgent, messages: red.messages, settings, signal,
    onDelta: wrappedOnDelta, onEvent: wrappedOnEvent, tools: cites.tools,
  });
  const tail = restorer.flush();
  if (tail && rawOnDelta) rawOnDelta(tail);
  if (typeof full === 'string' ? full.trim() : full) turn.produced();
  // Restore FIRST, then linkify: rewriting against redacted text would match placeholders
  // instead of the words the user will actually read.
  const answer = await cites.apply(restore(typeof full === 'string' ? full : full ?? '', vault));
  recordAnswer(turn, answer, cites.list());
  return answer;
}

/**
 * How a model should be named in an event.
 *
 * What the router chose, else the raw model. A turn can change model mid-flight, so this is
 * read at each call rather than captured once — capturing it would attribute every action to
 * whichever model happened to start the turn.
 */
function modelLabelOf(agent) {
  return agent?.routedVia?.model || agent?.model || null;
}

/**
 * Run the call, and try the next model when this one cannot answer.
 *
 * A provider that returns "you have depleted your monthly credits" has not failed the
 * request — it has declined it, and there is very likely another model that would say yes.
 * Showing that error to the user when an alternative was available is the router not doing
 * the one job it exists for.
 *
 * ONLY WHEN THE ROUTER CHOSE. If the user picked a specific model, silently answering from a
 * different one would be worse than the error: they asked for that model for a reason.
 */
async function withFailover(agent, settings, tools, turn, onEvent, signal, call) {
  const chose = agent?.routedVia || agent?.kind === 'router';
  // KEEP TRYING, not once. The first replacement can decline too — a retired model is often
  // retired at every provider, so one retry lands on the same wall and the turn dies anyway.
  // Bounded, because a user waiting on an answer should not sit through eight failures.
  // Enough to work through a realistic set of models rather than sampling it. A user with
  // eight endpoints who watches five decline has been told nothing useful by stopping at
  // four — but this is still bounded, because sitting through every failure is its own kind
  // of broken.
  const MAX_ATTEMPTS = 6;
  const tried = [];
  let current = agent;
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const out = await call(current);
      if (current?.id) (await import('./model-health.js')).markHealthy(current.id);
      return out;
    } catch (err) {
      lastErr = err;
      if (!chose || signal?.aborted) throw err;
      const health = await import('./model-health.js');
      // The model name goes with the report, so "this model fails everywhere" is learnable
      // rather than rediscovered at each provider in turn.
      const marked = health.markUnhealthy(current.id, err, current.model);
      // A 400 or a bad key is OUR request being wrong, and every other model would refuse it
      // too. Retrying would turn one clear error into four slow ones.
      if (!marked) throw err;
      tried.push(current.id);

      // Do not ANNOUNCE a model we are not going to call. The loop used to pick and announce
      // the next one and only then discover it was out of attempts, so the chain named a
      // model that never ran and the error shown came from the hop before it — the two
      // disagreed, and the one the user could see was the wrong one.
      if (attempt === MAX_ATTEMPTS - 1) {
        const e = new Error(
          `${tried.length} models tried, none could answer. Last error — ${err.message}`,
        );
        e.cause = err;
        throw e;
      }

      const [router, store] = await Promise.all([import('./model-router.js'), import('./store.js').catch(() => null)]);
      const next = await router.routeForTurn(settings, store?.resolveTarget, {
        capabilities: (tools?.specs || []).length ? ['tools'] : [],
        force: true,
        exclude: tried,
        // Replace like with like — and pass WHY it failed, because "same model elsewhere" is
        // the best replacement for a provider saying no and the worst one for a model that
        // no longer exists.
        like: {
          model: current.model,
          capabilities: current.routedVia?.capabilities || [],
          quality: current.routedVia?.quality,
          reason: marked.reason,
          // How this model is REACHED, so a request is not handed from an API model to a CLI
          // agent that will go and do something else entirely.
          classUsed: current.routedVia?.classUsed || (current.kind === 'bridge' ? 'A' : 'C'),
        },
      });
      if (!next?.target) {
        // Genuinely out of options. Say that, rather than showing the last provider's error
        // as though it were the whole story — "Groq says no" and "every model you have said
        // no" are different problems with different fixes.
        const e = new Error(
          `${tried.length} model${tried.length === 1 ? '' : 's'} tried, none could answer. `
          + `Last error — ${err.message}`,
        );
        e.cause = err;
        throw e;
      }

      const to = next.decision.model.label || next.decision.model.id;
      turn.emit('automation.fired', {
        ruleId: 'router:failover', classUsed: 'R',
        from: current.routedVia?.model || current.name || current.id,
        to, reason: marked.reason,
      });
      // Tell the panel, because an answer arriving from a different model than the byline
      // promised is exactly the kind of silent substitution this codebase keeps removing.
      onEvent?.({ type: 'routed', model: to, reasons: [`${current.name || current.id} declined (${marked.reason})`, ...next.decision.reasons] });
      current = {
        ...agent,
        ...next.target,
        routedVia: {
          model: to,
          reasons: next.decision.reasons,
          // Carried so a SECOND failover still knows what it is replacing. Without these the
          // chain forgets after one hop and starts substituting across classes again.
          classUsed: next.decision.model.classUsed,
          capabilities: next.decision.model.capabilities,
          quality: next.decision.model.quality,
        },
      };
    }
  }
  throw lastErr;
}

/**
 * Would this turn send internal material to a model that is too far away?
 *
 * Sources come from two places: every context attachment the conversation carries (a page,
 * a selection, a fetched URL — each keeps the `url` it came from), plus anything the caller
 * states outright. The WHOLE conversation is scanned, not just the newest message, because
 * an internal page attached three turns ago is still in the text being sent now.
 *
 * Returns `{ blocked, why, message }` or null. Dynamic-import so the model-router graph
 * stays off the first-paint path.
 */
/**
 * Hand the model a MANIFEST of what is attached, and a tool to read it.
 *
 * Attachments used to be flattened into the first message — every attached tab, in full,
 * before the model had said anything. "hi" on a long page paid for the whole page, and five
 * attached tabs put five documents in the prompt to answer a question about one paragraph of
 * one of them.
 *
 * Two conditions, both necessary:
 *   - THE TURN MUST CARRY TOOLS. Deferring content a model cannot then fetch does not save
 *     tokens, it deletes the context — the worst possible outcome, and silently.
 *   - IT MUST BE WORTH A ROUND TRIP. Below the threshold the extra call costs more than the
 *     text it avoids, so small attachments still travel inline.
 *
 * Returns the rewritten messages plus a store, or null when nothing was deferred.
 */
export function deferAttachedSources(messages, tools, { minTokens = 700 } = {}) {
  if (!tools?.specs?.length) return null;
  const carried = [];
  for (const m of messages || []) {
    for (const a of m?.attachments || []) {
      if (a?.kind === 'image' || !a?.text) continue;
      carried.push(a);
    }
  }
  if (!carried.length) return null;
  const store = makeSourceStore(carried.map((a) => ({
    kind: a.kind || 'context', title: a.title, url: a.url, text: a.text,
  })));
  if (store.tokens < minTokens) return null;
  // Same index, same id: the manifest and the store must agree or the model asks for
  // something real and is told it does not exist.
  const idFor = new Map(carried.map((a, i) => [a, store.entries[i]?.id]));
  const out = (messages || []).map((m) => {
    if (!m?.attachments?.some((a) => idFor.get(a))) return m;
    return {
      ...m,
      attachments: m.attachments.map((a) => {
        const id = idFor.get(a);
        // The stub keeps the title and url — knowing WHAT is attached is what lets the model
        // decide whether to read it, and that part is cheap.
        return id ? { ...a, text: `(not included — read with \`source\`: id ${id}, ~${approxTokens(a.text)} tokens)` } : a;
      }),
    };
  });
  return { messages: out, store };
}

const SOURCE_TOOL_SPEC = {
  name: 'source',
  description: 'Read an attached source (a page, tab, selection or file the user attached). Their content is NOT in the conversation — read what you need from here.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The source id from the manifest, e.g. page-1.' },
      query: { type: 'string', description: 'What you are looking for. A large source returns the matching sections rather than its first page.' },
    },
    required: ['id'],
  },
};

/** Add `source` to an existing toolset without disturbing what is already there. */
export function withSourceTool(tools, store) {
  const spec = { ...SOURCE_TOOL_SPEC };
  const system = [
    tools?.system,
    `${manifestText(store)}\n\nTheir content is NOT in this conversation. Call \`source\` with an id — and a query when the source is large — to read what you need.`,
  ].filter(Boolean).join('\n\n');
  return {
    ...tools,
    specs: [...(tools?.specs || []), spec],
    system,
    systemParts: { ...(tools?.systemParts || {}), source: approxTokens(manifestText(store)) },
    execute: async (name, input, meta) => (name === 'source'
      ? JSON.stringify(readSource(store, typeof input === 'string' ? JSON.parse(input || '{}') : (input || {})))
      : tools.execute(name, input, meta)),
  };
}

function sourceUrlsOf(messages, extraSources = []) {
  const urls = [];
  for (const m of messages || []) {
    for (const a of m?.attachments || []) if (a?.url) urls.push(a.url);
    // THE BODY IS EVIDENCE TOO. An internal link pasted into a message — or arriving in a
    // tool result that got written back into the conversation — is internal material just as
    // much as an attachment is. The address is what proves it, wherever it appears.
    for (const u of extractUrls(m?.content)) urls.push(u);
  }
  for (const s of extraSources || []) if (s) urls.push(typeof s === 'string' ? s : (s.url || s.href || ''));
  return urls.filter(Boolean);
}

export async function sourceGate(agent, settings, messages, extraSources = []) {
  try {
    const { sourceGuardFor, reachOf } = await import('./model-router.js');
    const guard = sourceGuardFor(settings, sourceUrlsOf(messages, extraSources));
    if (!guard) return null;
    const REACH = ['device', 'trusted', 'any'];
    const allowed = REACH.indexOf(guard.reach);
    const actual = REACH.indexOf(reachOf(agent || {}));
    if (actual <= allowed) return null;
    const where = guard.reach === 'device' ? 'stay on this device' : 'stay inside your workspace';
    return {
      blocked: true,
      why: guard.why,
      // Name the source, the model and the way out. A refusal a person cannot act on gets
      // switched off wholesale, which would leave them worse protected than before.
      message: `Not sent: ${guard.why}. "${modelLabelOf(agent) || 'this model'}" is outside that, and content from an internal source must ${where}. `
        + 'Pick a local model (or run one), or remove this site under Settings → Privacy → Internal sites.',
    };
  } catch {
    // A BROKEN GUARD MUST NOT BECOME AN OPEN GATE — but it must not block every turn either.
    // The compromise: fail open ONLY when the guard itself could not run, and say so, so a
    // bug here is visible rather than silently permissive.
    console.warn('[chatpanel] source guard did not run; turn allowed');
    return null;
  }
}

/**
 * The routed model, or null to keep the caller's choice.
 *
 * Every failure path returns null. A router that can break a turn is worse than no router,
 * and "the model I picked was ignored because routing threw" is the least explicable failure
 * this could produce.
 */
async function pickRoutedAgent(agent, settings, tools, turn, messages, sources = []) {
  try {
    const [router, store] = await Promise.all([import('./model-router.js'), import('./store.js').catch(() => null)]);
    // AUTO IS THE ONLY SWITCH.
    //
    // A settings dial that applied routing to an explicitly chosen model overrode the user's
    // own selection — they picked that model for a reason, and answering from another is
    // exactly the substitution this codebase keeps removing. Picking Auto is how routing is
    // turned on; picking a model is how it is turned off. There is no third state, and the
    // dial that created one was mine.
    const chose = agent?.kind === 'router' || agent?.id === 'router:auto';
    if (!chose) return null;
    // A page or canvas action is inherently hard: exact coordinates, a structured payload,
    // and a result that is visibly wrong when the model guesses. Cost is the right
    // tie-breaker between models that can all do the job, and the wrong one when they cannot.
    const toolNames = (tools?.specs || []).map((t) => t.name || t.function?.name || '');
    const structured = toolNames.some((n) => /^(structured_insert|sheet_write)$/.test(n));
    // The page dispatcher means this turn can drive the browser — and driving it means
    // screenshots, so the model has to be able to read one.
    const pageTools = toolNames.includes('page');
    const need = {
      capabilities: (tools?.specs || []).length ? ['tools'] : [],
      force: chose,
      // NOT `structured || pageTools`. Page tools being armed is equipment; 'structured'
      // means the turn must emit an exact payload. Conflating them made every turn on a page
      // read as structured work, which is how a greeting reached an escalation strategy.
      // requirementsFor already handles pageTools on its own terms.
      structured,
      pageTools,
      // The request itself, so complexity, modality and volume can be read for free rather
      // than guessed at or asked of a model.
      request: { messages },
      // Where the material came from. Given to the router so Auto can pick something local
      // BEFORE the gate has to refuse — a turn answered on-device is a better outcome than a
      // turn correctly blocked.
      sources: sourceUrlsOf(messages, sources),
    };
    const routed = await router.routeForTurn(settings, store?.resolveTarget, need);
    if (!routed?.target) {
      // Auto with nothing routable is a dead end the caller cannot recover from, unlike a
      // specific model that simply answers. Say so rather than failing obscurely.
      if (chose) throw new Error('No model fits the current routing constraints — pick a model, or relax the limits in Settings → Plugins → Model routing.');
      return null;
    }
    // READABLE NAMES IN THE LOG. mqnnje2c9z70th is a generated id and means nothing to
    // anyone reading a routing decision six turns later — the same fix the settings preview
    // needed, in the place people actually look.
    const from = chose ? 'Auto' : (agent?.name || agent?.model || agent?.id || null);
    const to = routed.decision.model.label || routed.decision.model.id;
    if (!chose && from === to) return null;   // nothing changed; no need to say anything
    // A model swapped under the user is exactly the kind of thing that must be visible.
    turn.emit('policy.changed', {
      dial: 'route.applied',
      actor: { kind: 'rule', id: 'model-router' },
      from, to,
      strategy: routed.decision.strategy,
      reasons: routed.decision.reasons,
    });
    // The caller's system prompt and per-turn overrides survive; only the target changes.
    // `routedVia` travels with the agent so the reply can say which model answered and why —
    // with Auto selected, that is the one thing the user cannot otherwise know.
    return {
      ...agent,
      ...routed.target,
      routedVia: {
        model: routed.decision.model.label || to,
        reasons: routed.decision.reasons,
        strategy: routed.decision.strategy,
        classUsed: routed.decision.model.classUsed,
        capabilities: routed.decision.model.capabilities,
        quality: routed.decision.model.quality,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Record what the router would choose for this turn, and why.
 *
 * Deliberately compares against the target actually used, because the interesting number is
 * not "what did it pick" but "how often would it have picked something else" — that is the
 * question that says whether turning it on is safe.
 *
 * Fire-and-forget and free to compute (class R, no model call), so an observation can never
 * cost or break the turn it observes.
 */
function recordRouteDecision(turn, agent, settings, tools, messages) {
  Promise.all([import('./model-router.js'), import('./store.js').catch(() => null)])
    .then(async ([router, store]) => {
      // THE SAME inputs the applier uses. Constructing this separately is what made the
      // observation disagree with the decision it was supposed to be observing.
      const need = router.needForTurn(settings, {
        capabilities: (tools?.specs || []).length ? ['tools'] : [],
        request: { messages },
        structured: (tools?.specs || []).some((t) => /^(structured_insert|sheet_write)$/.test(t.name || t.function?.name || '')),
        pageTools: (tools?.specs || []).some((t) => (t.name || t.function?.name) === 'page'),
        sources: sourceUrlsOf(messages),
      });
      const preview = await router.previewRoute(settings, store?.resolveTarget, need);
      const used = agent?.id || agent?.name || agent?.model || null;
      turn.emit('policy.changed', {
        dial: 'route.observed',
        actor: { kind: 'rule', id: 'model-router' },
        from: used,
        to: preview.chosen,
        agrees: !!preview.chosen && preview.chosen === used,
        strategy: preview.strategy,
        reasons: preview.reasons,
        eligible: preview.eligible,
        rejected: preview.rejected,
      });
    })
    .catch(() => {});
}

/**
 * Store the model-visible input and reference it from the log.
 *
 * Fire-and-forget by design: a transcript that could fail a chat turn would be worse than
 * no transcript. The event carries only a hash — see I7 in @chatpanel/events for why
 * content never travels inside an event.
 */
function recordPrompt(turn, agent, messages, tools) {
  // FOUR DIFFERENT THINGS, RECORDED AS FOUR. They were flattened into one blob, so the
  // trajectory could not tell the user's own words from the page that was attached to them
  // or from the instructions we added — and "why did it answer that" is usually a question
  // about which of those three said something.
  //
  //   system   — what WE told the model (ours, and the tool preamble, kept apart)
  //   user     — what the person actually typed
  //   context  — what was attached to it, named rather than inlined
  //   tools    — what it was allowed to call
  const context = [];
  for (const m of messages || []) {
    for (const a of m?.attachments || []) {
      context.push({
        kind: a.kind || 'context',
        title: a.title || a.url || '',
        url: a.url || '',
        chars: String(a.text || '').length,
        // Whether the model was HANDED this or had to ask for it. Two very different turns
        // that otherwise look identical in the log.
        deferred: /^\(not included/.test(String(a.text || '')),
      });
    }
  }
  const text = JSON.stringify({
    system: agent?.systemPrompt || '',
    toolSystem: tools?.system || '',
    messages: (messages || []).map((m) => ({ role: m.role, content: m.content })),
    context,
    tools: (tools?.specs || []).map((t) => t.name || t.function?.name).filter(Boolean),
  }, null, 2);
  import('./event-log.js')
    .then(async (m) => {
      const ref = await m.putBlob(text, 'chat');
      if (ref) turn.emit('assistant.prompted', { ref, chars: text.length, contextCount: context.length });
    })
    .catch(() => {});
}

/** Store the answer. Same rules: a ref in the log, the text in the blob store. */
function recordAnswer(turn, answer, citations = []) {
  const text = typeof answer === 'string' ? answer : '';
  if (!text.trim()) return;
  import('./event-log.js')
    .then(async (m) => {
      const ref = await m.putBlob(text, 'chat');
      // WHAT IT WAS BASED ON, with the answer. The citations were computed, linkified into
      // the text and then discarded, so the log could show an answer and never what stood
      // behind it — which is the first thing anyone checks when an answer looks wrong.
      if (ref) {
        turn.emit('assistant.message', {
          ref, chars: text.length,
          citations: (citations || []).slice(0, 20).map((c) => ({ rank: c.rank, title: c.title || '', url: c.url || '' })),
        });
      }
    })
    .catch(() => {});
}

// Rough token estimate — the same 4-chars-per-token rule the dispatcher budget uses.
const approxTok = (v) => (v == null ? 0 : Math.round(JSON.stringify(v).length / 4));

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
  if (agent.kind === 'webllm') {
    // In-browser models have no /models endpoint — list from the static catalog (+ any
    // stored/custom ids). Dynamic import keeps the catalog off the first-paint graph.
    const { WEBLLM_ALL_MODELS } = await import('./webllm-models.js');
    const stored = Array.isArray(agent.models) ? agent.models : [];
    const ids = [...new Set([...stored, ...WEBLLM_ALL_MODELS.map((m) => m.id)])].filter(Boolean);
    return ids.map((id) => ({ id }));
  }
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
