// The offscreen document's router.
//
// WHY THIS EXISTS RATHER THAN LOADING THE ENGINE DIRECTLY. offscreen.html used to load
// js/offscreen-webllm.js, which statically imports the 6.3 MB WebLLM runtime — so the moment
// ANYTHING created the offscreen document, 6.3 MB was fetched, parsed and instantiated. That
// was tolerable while the only reason to create it was to run the model. It stopped being
// tolerable the moment a timer needed the document to make a sound: a two-note chime cannot
// cost six megabytes.
//
// So the page loads this instead. Audio is handled here (~3 KB); the model runtime is
// `await import()`ed on the first message that actually needs it, and never before.

const send = (m) => { try { chrome.runtime.sendMessage(m); } catch { /* nobody listening */ } };

let _webllm = null;
// Loaded once, on the first chat/stop/delete. Module resolution is cached, so a session that
// uses the model pays this once and a session that never does pays nothing.
const webllm = () => (_webllm ||= import('./offscreen-webllm.js'));

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;

  // A timer went off and there is no window open to hear it — see js/alert-sound.js.
  if (msg.target === 'offscreen-audio' && msg.type === 'alert') {
    import('./alert-sound.js')
      .then((m) => m.playAlert({ gain: msg.gain, repeat: msg.repeat }))
      .catch(() => { /* no audio device / refused — the notification still went out */ });
    return;
  }

  if (msg.target !== 'offscreen-webllm') return;
  // Awaited here rather than at module top: this is what keeps the 6.3 MB runtime off the
  // path a timer takes. The message is handed on AFTER the module is ready, so nothing is
  // dropped by loading late.
  webllm()
    .then((m) => m.handleWebllmMessage(msg))
    .catch((e) => send({
      target: 'webllm-panel', reqId: msg.reqId, type: 'error',
      error: `in-browser model failed to load: ${e?.message || e}`,
    }));
});
