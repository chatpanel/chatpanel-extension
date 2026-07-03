// AudioWorklet processor for dictation capture — the modern replacement for the
// deprecated ScriptProcessorNode. Runs on the audio render thread, accumulates
// the mono input into ~2048-sample batches, and posts each batch (Float32 PCM,
// already 16 kHz because the AudioContext is created at that rate) to the main
// thread, which POSTs it to the local gateway. Loaded via chrome.runtime.getURL
// (extension origin → CSP-clean, no blob URL).
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._len = 0;
    this._target = 2048; // ~128 ms at 16 kHz — small enough to feel live
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this._buf.push(new Float32Array(ch)); // the input buffer is reused each quantum — copy it
      this._len += ch.length;
      if (this._len >= this._target) {
        const out = new Float32Array(this._len);
        let o = 0;
        for (const c of this._buf) { out.set(c, o); o += c.length; }
        this._buf = []; this._len = 0;
        this.port.postMessage(out, [out.buffer]); // transfer — zero-copy handoff
      }
    }
    return true; // keep the node alive while the source feeds it
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
