// Offscreen host for the in-browser (WebLLM) engine.
//
// An offscreen document has WebGPU and lives independently of the side panel, so the
// model STAYS LOADED when the panel closes/reopens (no per-open reload) and generation
// never blocks the panel UI. The panel drives this over chrome.runtime messages
// (see the offscreen client in js/webllm.js). This whole path is OPT-IN (Settings →
// "run in background"); if anything here errors, the panel falls back to its in-panel
// engine, so the default experience is unaffected.
//
// Protocol (chrome.runtime.sendMessage):
//   panel → { target:'offscreen-webllm', type:'chat'|'stop'|'delete', reqId, ... }
//   offscreen → { target:'webllm-panel', reqId, type:'progress'|'delta'|'done'|'error', ... }

import * as mlc from './vendor/web-llm.js';

let engine = null;
let loadedModel = null;

const send = (m) => { try { chrome.runtime.sendMessage(m); } catch { /* panel gone; ignore */ } };

function appConfigWith(customModels) {
  return customModels && customModels.length
    ? { ...mlc.prebuiltAppConfig, model_list: [...mlc.prebuiltAppConfig.model_list, ...customModels] }
    : undefined;
}

async function ensureEngine(model, customModels, reqId) {
  const cb = (report) => send({ target: 'webllm-panel', reqId, type: 'progress', report });
  if (engine && loadedModel === model) return engine;
  const appConfig = appConfigWith(customModels);
  if (engine) {
    try { engine.setInitProgressCallback?.(cb); await engine.reload(model); loadedModel = model; return engine; }
    catch { try { await engine.unload?.(); } catch { /* ignore */ } engine = null; }
  }
  engine = await mlc.CreateMLCEngine(model, { initProgressCallback: cb, ...(appConfig ? { appConfig } : {}) });
  loadedModel = model;
  return engine;
}

async function runChat(msg) {
  const { reqId, model, messages, params, customModels } = msg;
  const reply = (m) => send({ target: 'webllm-panel', reqId, ...m });
  try {
    const eng = await ensureEngine(model, customModels, reqId);
    const completion = await eng.chatCompletion({ stream: true, messages, ...(params || {}) });
    for await (const chunk of completion) {
      const d = chunk?.choices?.[0]?.delta?.content || '';
      if (d) reply({ type: 'delta', delta: d });
    }
    reply({ type: 'done' });
  } catch (e) {
    reply({ type: 'error', error: (e && e.message) || String(e) });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen-webllm') return;
  if (msg.type === 'chat') runChat(msg);
  else if (msg.type === 'stop') { try { engine?.interruptGenerate(); } catch { /* ignore */ } }
  else if (msg.type === 'delete') {
    (async () => {
      try { if (loadedModel === msg.model) { await engine?.unload?.(); engine = null; loadedModel = null; } } catch { /* ignore */ }
      try { await mlc.deleteModelAllInfoInCache?.(msg.model); } catch { /* ignore */ }
      try { await mlc.deleteModelInCache?.(msg.model); } catch { /* ignore */ }
    })();
  }
});
