// Record a short voice sample for a custom TTS voice.
//
// Deliberately its own module and dynamic-imported: it touches getUserMedia and an
// AudioContext, neither of which belongs anywhere near a settings page's first
// paint, and nobody who never records a voice should pay for it.
//
// The sample never goes anywhere except the local gateway over loopback, which
// derives an embedding and discards the audio (see the gateway's tts-voices.js).
// This module keeps it in memory and hands it over once — it is never written to
// disk here, and never uploaded anywhere else.

export const SAMPLE_RATE = 16000; // what the speaker model wants; matches the STT wire format
export const MIN_SECONDS = 3;     // under this the embedding is mostly whatever noise was in the room
export const MAX_SECONDS = 20;

/**
 * Record until stop() (or MAX_SECONDS). Resolves with 16 kHz mono Float32 PCM.
 *   const rec = await startRecording({ onLevel, onTick });
 *   ...later: const pcm = await rec.stop();
 */
export async function startRecording({ onLevel, onTick } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new AC({ sampleRate: SAMPLE_RATE });
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but is the one path that needs no separate
  // worklet FILE, which an extension page would have to ship and register. The
  // sample is a few seconds long, so its main drawback (main-thread work) is moot.
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let total = 0;
  let stopped = false;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const levels = new Uint8Array(analyser.frequencyBinCount);

  node.onaudioprocess = (e) => {
    if (stopped) return;
    const inBuf = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(inBuf));
    total += inBuf.length;
    if (onLevel) {
      analyser.getByteFrequencyData(levels);
      let sum = 0;
      for (const v of levels) sum += v;
      onLevel(Math.min(1, sum / levels.length / 128));
    }
    onTick?.(total / SAMPLE_RATE);
    if (total / SAMPLE_RATE >= MAX_SECONDS) api.stop();
  };
  src.connect(node);
  // A ScriptProcessor only fires while it is connected to a destination. Routing it
  // through a silent gain keeps the callback alive WITHOUT echoing the microphone
  // back out of the speakers, which would otherwise howl.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  let resolveStop;
  const done = new Promise((r) => { resolveStop = r; });

  const api = {
    seconds: () => total / SAMPLE_RATE,
    async stop() {
      if (stopped) return done;
      stopped = true;
      try { node.disconnect(); src.disconnect(); mute.disconnect(); } catch { /* already torn down */ }
      // Release the mic promptly — a settings page holding an open microphone is
      // exactly the thing a privacy product must not do.
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } }
      try { await ctx.close(); } catch { /* already closed */ }
      const out = new Float32Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      chunks.length = 0; // drop the copies as soon as they are merged
      resolveStop(out);
      return out;
    },
  };
  return api;
}
