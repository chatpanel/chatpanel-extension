// In-browser LLM — the zero-setup chat that works the moment the extension is
// installed (no API key, no local bridge/gateway, nothing to run). It downloads a
// small quantized model ONCE and runs it locally on WebGPU via WebLLM (MLC). This is
// what lets a brand-new user (or a Web Store reviewer) send a first message and get a
// reply with a single click.
//
// LOAD-TIME CONTRACT: the WebLLM runtime is ~6 MB and is heavy to parse, so it is
// NEVER imported at module top — every entry point below `await import()`s the
// vendored bundle at its call site, so it stays completely off the side panel's
// first-paint graph. It's pulled in only when the user actually sends to the
// in-browser model. Model WEIGHTS are not bundled — they stream from the MLC CDN on
// first use and are cached in the browser (Cache API), so subsequent loads are offline.
//
// PRIVACY: inference is 100% on-device — the conversation never leaves the machine.

// The FULL WebLLM catalog (~159 models) lives in the generated webllm-models.js so
// settings can browse it without loading the 6 MB runtime.
export { WEBLLM_ALL_MODELS } from './webllm-models.js';
import { WEBLLM_ALL_MODELS } from './webllm-models.js';

// Default model: Llama-3.2-1B (q4f16) — the best zero-setup balance. It needs the least
// VRAM of the small models (~879 MB, so it runs on more GPUs), follows instructions
// well, and emits NO <think> reasoning (unlike the tiny Qwen3 models), so first-run
// answers are clean and steady. Users can pick a bigger/smarter model in Settings.
export const DEFAULT_WEBLLM_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

// A short RECOMMENDED subset surfaced first in the picker (ids from the full catalog).
export const WEBLLM_RECOMMENDED = [
  'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Qwen3-1.7B-q4f16_1-MLC', 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  'Qwen3-4B-q4f16_1-MLC', 'gemma-2-2b-it-q4f16_1-MLC', 'Phi-3.5-mini-instruct-q4f16_1-MLC',
];

// Prompt CHARACTER budget for a model's context window — derived from the model's real
// context_window_size (≈3.5 chars/token) with ~1000 tokens reserved for the system
// prompt + reply, so attached page context is compacted to fit whatever model is chosen.
export function webllmPromptBudget(modelId) {
  const ctxTokens = WEBLLM_ALL_MODELS.find((m) => m.id === modelId)?.ctx || 4096;
  return Math.max(1500, Math.round((ctxTokens - 1000) * 3.5));
}

// WebGPU is required. A headless / older / locked-down Chrome may lack it — callers
// use this to fall back to a "configure an API key" path with a clear message.
export function webgpuAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

let _lib = null;                 // memoized vendored module
let _engine = null;              // the live MLCEngine
let _loadedModel = null;         // id currently loaded into _engine
let _loadPromise = null;         // in-flight (re)load, so concurrent sends share it

async function lib() {
  if (!_lib) _lib = await import('./vendor/web-llm.js');
  return _lib;
}

// Has this model already been downloaded + cached (so "send" won't trigger a big
// download)? Used by the UI to decide whether to show a first-run download notice.
export async function isModelCached(modelId = DEFAULT_WEBLLM_MODEL, customModels = []) {
  try {
    const mlc = await lib();
    return await mlc.hasModelInCache(modelId, appConfigWith(mlc, customModels) || mlc.prebuiltAppConfig);
  } catch { return false; }
}

// Get (or build/reload) the engine for `modelId`. `onProgress` receives WebLLM's
// InitProgressReport ({ progress: 0..1, timeElapsed, text }) during a download/load.
// A single engine is reused across turns; switching models reloads it in place.
// `customModels` are user-added MLC models ({ model_id, model, model_lib }); they're
// folded into WebLLM's appConfig so a custom id loads like any prebuilt one.
function appConfigWith(mlc, customModels) {
  return customModels && customModels.length
    ? { ...mlc.prebuiltAppConfig, model_list: [...mlc.prebuiltAppConfig.model_list, ...customModels] }
    : undefined; // undefined → WebLLM uses the built-in prebuilt catalog
}

export async function ensureEngine(modelId = DEFAULT_WEBLLM_MODEL, onProgress, customModels = []) {
  if (!webgpuAvailable()) {
    const e = new Error('This browser has no WebGPU, so the in-browser model can’t run. Add an API endpoint (a free provider key or local Ollama) in Settings, or try a Chromium browser with GPU enabled.');
    e.code = 'WEBGPU_UNAVAILABLE';
    throw e;
  }
  if (_engine && _loadedModel === modelId) return _engine;
  if (_loadPromise && _loadedModel === modelId) return _loadPromise;
  _loadedModel = modelId;
  _loadPromise = (async () => {
    const mlc = await lib();
    const cb = typeof onProgress === 'function' ? onProgress : undefined;
    const appConfig = appConfigWith(mlc, customModels);
    if (_engine) {
      // Switch model in place; if the target isn't in this engine's appConfig (e.g. a
      // custom model added after the engine was built), rebuild with the full config.
      // reload() doesn't take a progress callback and reuses the engine's stored one —
      // so re-point it at THIS turn's callback first, or switching to a not-yet-
      // downloaded model shows no download progress (just a silent "Working…").
      try { _engine.setInitProgressCallback?.(cb); await _engine.reload(modelId); return _engine; }
      catch { try { await _engine.unload?.(); } catch { /* ignore */ } _engine = null; }
    }
    _engine = await mlc.CreateMLCEngine(modelId, { initProgressCallback: cb, ...(appConfig ? { appConfig } : {}) });
    return _engine;
  })();
  try { return await _loadPromise; }
  catch (e) { _engine = null; _loadedModel = null; throw e; }
  finally { _loadPromise = null; }
}

// ── Offscreen (background) engine — opt-in "stay warm" path ──────────────────
// Runs the engine in an offscreen document so the model stays loaded across panel
// open/close. The panel is a CLIENT that streams over chrome.runtime messages. Guarded
// so a failure to set up the offscreen doc falls back to the in-panel engine.
let _offscreenReady = null;
export async function ensureOffscreenDoc() {
  if (typeof chrome === 'undefined' || !chrome.offscreen) throw new Error('offscreen API unavailable');
  if (_offscreenReady) return _offscreenReady;
  _offscreenReady = (async () => {
    if (!(await chrome.offscreen.hasDocument?.())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run the on-device AI model off the UI thread so it stays loaded when the side panel closes.',
      });
    }
  })();
  try { return await _offscreenReady; } catch (e) { _offscreenReady = null; throw e; }
}

let _reqSeq = 0;
async function* streamChatBackground(model, messages, { onProgress, signal, params = {}, customModels = [] }) {
  await ensureOffscreenDoc();
  const reqId = `wl${++_reqSeq}`;
  const queue = []; let finished = false; let error = null; let wake = null;
  const listener = (msg) => {
    if (!msg || msg.target !== 'webllm-panel' || msg.reqId !== reqId) return;
    if (msg.type === 'progress') onProgress?.(msg.report);
    else if (msg.type === 'delta') { queue.push(msg.delta); wake?.(); }
    else if (msg.type === 'done') { finished = true; wake?.(); }
    else if (msg.type === 'error') { error = new Error(msg.error); finished = true; wake?.(); }
  };
  chrome.runtime.onMessage.addListener(listener);
  const onAbort = () => { try { chrome.runtime.sendMessage({ target: 'offscreen-webllm', type: 'stop', reqId }); } catch { /* ignore */ } };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  chrome.runtime.sendMessage({ target: 'offscreen-webllm', type: 'chat', reqId, model, messages, params, customModels });
  try {
    while (!finished || queue.length) {
      if (signal?.aborted) break;
      while (queue.length) yield queue.shift();
      if (!finished && !queue.length) await new Promise((r) => { wake = r; });
    }
    if (error) throw error;
  } finally {
    chrome.runtime.onMessage.removeListener(listener);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Stream a chat completion from the in-browser model. `messages` is the OpenAI shape
// ([{role, content}]). Yields text deltas. `onProgress` fires during a first-use
// download/load (before any token). Abort via `signal`. `background:true` routes to the
// offscreen engine (stays warm), with automatic fallback to the in-panel engine if the
// offscreen path can't start.
export async function* streamChat(modelId, messages, { onProgress, signal, params = {}, customModels = [], background = false } = {}) {
  const model = modelId || DEFAULT_WEBLLM_MODEL;
  if (background) {
    let started = false;
    try { await ensureOffscreenDoc(); started = true; } catch { started = false; } // no offscreen → in-panel
    if (started) {
      let yielded = false;
      try {
        for await (const d of streamChatBackground(model, messages, { onProgress, signal, params, customModels })) { yielded = true; yield d; }
        return;
      } catch (e) {
        if (yielded) throw e;         // mid-stream failure — don't re-run on the main thread
        // else fall through to the in-panel engine (offscreen couldn't produce output)
      }
    }
  }
  const engine = await ensureEngine(model, onProgress, customModels);
  // `params` carries OpenAI-style generation controls (max_tokens, penalties) plus
  // extra_body (e.g. { enable_thinking:false } for Qwen3) — the caller sets sane caps
  // so a tiny model can't ramble into a repetition loop.
  const completion = await engine.chatCompletion({ stream: true, messages, ...params });
  // STOP responsiveness: interrupt the GPU generation the MOMENT the caller aborts —
  // not just at the next chunk boundary (a stuck/looping model may not yield for a
  // while, so waiting for the loop check left Stop feeling dead).
  const onAbort = () => { try { engine.interruptGenerate(); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for await (const chunk of completion) {
      if (signal?.aborted) break;
      const delta = chunk?.choices?.[0]?.delta?.content || '';
      if (delta) yield delta;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await engine.interruptGenerate(); } catch { /* ignore */ }
  }
}

// Free the GPU/session (e.g. on settings change). Best-effort.
export async function unload() {
  try { await _engine?.unload?.(); } catch { /* ignore */ }
  _engine = null; _loadedModel = null; _loadPromise = null;
}

// Delete a downloaded model's cached weights to reclaim disk (Settings → in-browser
// endpoint → "Remove downloaded model"). Best-effort across WebLLM cache-util names.
export async function deleteModel(modelId = DEFAULT_WEBLLM_MODEL) {
  if (_loadedModel === modelId) await unload();
  // If the offscreen engine is holding this model, ask it to unload + purge too, so the
  // background "stay warm" path doesn't keep stale weights loaded after a Remove.
  try {
    if (typeof chrome !== 'undefined' && chrome.offscreen && (await chrome.offscreen.hasDocument?.())) {
      chrome.runtime.sendMessage({ target: 'offscreen-webllm', type: 'delete', model: modelId });
    }
  } catch { /* ignore */ }
  const mlc = await lib();
  try { await mlc.deleteModelAllInfoInCache?.(modelId); }
  catch { /* fall through */ }
  try { await mlc.deleteModelInCache?.(modelId); } catch { /* ignore */ }
  try { await mlc.deleteModelWasmInCache?.(modelId); } catch { /* ignore */ }
}
