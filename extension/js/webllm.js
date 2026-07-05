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

// Default model: Qwen2.5-0.5B (q4f16) — ~350 MB download, fast on modest GPUs, and
// coherent enough for a first-run "it works!" moment. Users can pick a bigger one.
export const DEFAULT_WEBLLM_MODEL = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

// A short curated menu surfaced in settings (id → label + approx download size).
export const WEBLLM_MODELS = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B — fastest', mb: 350 },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B — balanced', mb: 880 },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B — best quality', mb: 2200 },
  { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 2B', mb: 1600 },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi-3.5 mini', mb: 2100 },
];

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
export async function isModelCached(modelId = DEFAULT_WEBLLM_MODEL) {
  try {
    const mlc = await lib();
    return await mlc.hasModelInCache(modelId, mlc.prebuiltAppConfig);
  } catch { return false; }
}

// Get (or build/reload) the engine for `modelId`. `onProgress` receives WebLLM's
// InitProgressReport ({ progress: 0..1, timeElapsed, text }) during a download/load.
// A single engine is reused across turns; switching models reloads it in place.
export async function ensureEngine(modelId = DEFAULT_WEBLLM_MODEL, onProgress) {
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
    if (_engine) { await _engine.reload(modelId); return _engine; } // switch model in place
    _engine = await mlc.CreateMLCEngine(modelId, { initProgressCallback: cb });
    return _engine;
  })();
  try { return await _loadPromise; }
  catch (e) { _engine = null; _loadedModel = null; throw e; }
  finally { _loadPromise = null; }
}

// Stream a chat completion from the in-browser model. `messages` is the OpenAI shape
// ([{role, content}]). Yields text deltas. `onProgress` fires during a first-use
// download/load (before any token). Abort via `signal`.
export async function* streamChat(modelId, messages, { onProgress, signal } = {}) {
  const engine = await ensureEngine(modelId || DEFAULT_WEBLLM_MODEL, onProgress);
  const completion = await engine.chatCompletion({ stream: true, messages });
  try {
    for await (const chunk of completion) {
      if (signal?.aborted) break;
      const delta = chunk?.choices?.[0]?.delta?.content || '';
      if (delta) yield delta;
    }
  } finally {
    if (signal?.aborted) { try { await engine.interruptGenerate(); } catch { /* ignore */ } }
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
  const mlc = await lib();
  try { await mlc.deleteModelAllInfoInCache?.(modelId); }
  catch { /* fall through */ }
  try { await mlc.deleteModelInCache?.(modelId); } catch { /* ignore */ }
  try { await mlc.deleteModelWasmInCache?.(modelId); } catch { /* ignore */ }
}
