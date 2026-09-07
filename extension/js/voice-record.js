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
export const TARGET_SECONDS = 10; // where it stops on its own — see below
export const MAX_SECONDS = 20;    // hard ceiling if a caller asks for longer

// A speaker embedding stops improving well before people stop talking. Ten seconds
// of connected speech covers the vowel space and most consonant classes; past that
// the vector barely moves, so recording longer is effort spent for nothing. The
// recorder therefore STOPS ITSELF at the target rather than leaving someone
// talking into an open microphone wondering when they have said enough.
//
// The prompt is built for coverage rather than meaning: all five long vowels, the
// voiced/unvoiced pairs (p/b, t/d, k/g, f/v, s/z), both th sounds, the sibilants
// sh and zh, the affricates ch and j, the nasals, and the r/l distinction — in
// connected sentences, because phonemes read from a list are pronounced
// differently from phonemes in speech.
export const PROMPT_TEXT =
  'The quick brown fox jumps over a lazy dog while five wizards vex him. '
  + 'Each child watched the choir approach the church on a chilly evening. '
  + 'She measured the rough edge, then judged both azure shapes against the light. '
  + 'Please call Stella and ask her to bring these things: a thin blue thread, '
  + 'seven small toys, and the yellow jug from the shed.';

/**
 * Record until stop() (or MAX_SECONDS). Resolves with 16 kHz mono Float32 PCM.
 *   const rec = await startRecording({ onLevel, onTick });
 *   ...later: const pcm = await rec.stop();
 */
export async function startRecording({ onLevel, onTick, onAutoStop, targetSeconds = TARGET_SECONDS } = {}) {
  const target = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(targetSeconds) || TARGET_SECONDS));
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
    const secs = total / SAMPLE_RATE;
    onTick?.(secs, target);
    // Stop at the target, not the ceiling: the whole point of a target is that the
    // person does not have to decide when they have said enough.
    if (secs >= target) { onAutoStop?.(secs); api.stop(); }
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
    target: () => target,
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
