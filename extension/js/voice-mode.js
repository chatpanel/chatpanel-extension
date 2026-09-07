// Voice conversation — the session, assembled.
//
// voice-loop.js owns the state machine, dictation.js the ear, speech.js the mouth.
// This module is the wiring between them and the overlay, and it lives OUTSIDE
// sidepanel.js for two reasons: the panel is already 9k lines, and every byte here
// is action-only — nobody who never starts a voice conversation should pay for it
// at first paint (tools/test-first-paint-budget.mjs enforces exactly that).
//
// Everything the panel owns is INJECTED rather than imported, so this module never
// reaches back into the panel's globals:
//   startVoiceMode({ gatewayUrl, settings, el, toast, sendTurn }) -> session | null
//     el(id)          -> element lookup ($ in the panel)
//     sendTurn(text)  -> Promise<string>   send it and resolve with the reply
//   session: { stop(), interrupt(), isRunning() }

const LABEL = { listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', muted: 'Muted — tap Unmute to talk', idle: '' };

export async function startVoiceMode({ gatewayUrl, settings = {}, el, toast, sendTurn, openMicPermission, onTurnDelta } = {}) {
  const { micPermissionState, createDictation, resolveDictationProvider } = await import('./dictation.js');
  if (await micPermissionState() !== 'granted') {
    openMicPermission?.();
    return null;
  }

  const [{ createVoiceLoop }, { resolveEngine }, { createSpeech }] = await Promise.all([
    import('./voice-loop.js'), import('./read-aloud.js'), import('./speech.js'),
  ]);
  const [ear, mouth] = await Promise.all([
    resolveDictationProvider({ gatewayUrl }),
    resolveEngine({ gatewayUrl }),
  ]);
  if (!ear.provider) { toast?.('✕ Voice input isn’t supported in this browser', 2600); return null; }

  const setState = (st, text) => {
    const ov = el('voice-overlay');
    if (!ov) return;
    ov.dataset.state = st;
    const s = el('voice-state'); if (s) s.textContent = LABEL[st] || '';
    // The caption shows what it HEARD while listening and what it is SAYING while
    // speaking — the two moments a user needs to see that it got them right.
    const c = el('voice-caption');
    if (c) {
      if (text !== undefined) {
        const next = String(text || '').slice(0, 240);
        if (next !== c.textContent) {
          c.textContent = next;
          // Re-trigger the entry animation so each new chunk reads as a new line
          // rather than text silently mutating under the reader.
          c.classList.remove('enter');
          void c.offsetWidth;
          c.classList.add('enter');
        }
      } else if (st === 'listening' || st === 'muted') c.textContent = '';
    }
  };

  // ── waveform ────────────────────────────────────────────────────────────────
  // Driven by whatever is making sound RIGHT NOW: the microphone while listening,
  // the speaker while speaking. Both are real AnalyserNodes, so the shape tracks
  // the actual signal — a bar chart animating on a timer next to speech it is not
  // measuring is worse than no bar chart, because it looks like lag in the audio.
  //
  // The getter is re-read every frame rather than captured once: the mic analyser
  // does not exist until capture starts, and the speech one not until audio plays.
  let raf = 0;
  let getAnalyser = () => null;
  const reduceMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  function stopWave() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el('voice-wave')?.classList.add('hidden');
  }

  function startWave(source) {
    getAnalyser = source || (() => null);
    const cv = el('voice-wave');
    if (!cv || typeof cv.getContext !== 'function' || reduceMotion()) return;
    if (raf) return; // already running; the source just changed
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return;
    cv.classList.remove('hidden');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa9ff';
    const bars = 56;
    // Smoothed per-bar heights, so the shape eases between frames instead of
    // strobing on every FFT update.
    const level = new Float32Array(bars);
    let buf = null;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const an = getAnalyser();
      const { width: w, height: h } = cv;
      ctx2d.clearRect(0, 0, w, h);
      if (an) {
        if (!buf || buf.length !== an.frequencyBinCount) buf = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(buf);
      }
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        let v = 0;
        if (an && buf) {
          // Speech energy sits low, so a linear sweep spends most of the width on
          // hiss that never moves. Square the index to weight the low end.
          const from = Math.floor((i / bars) ** 2 * buf.length);
          const to = Math.max(from + 1, Math.floor(((i + 1) / bars) ** 2 * buf.length));
          let sum = 0;
          for (let j = from; j < to; j++) sum += buf[j];
          v = (sum / (to - from)) / 255;
        }
        // Ease toward the target: fast to rise (so a syllable lands crisply), slow
        // to fall (so the shape does not flicker between words).
        level[i] += (v - level[i]) * (v > level[i] ? 0.55 : 0.12);
        // A resting ripple when there is no signal, so the panel never looks frozen.
        const idle = 0.04 + 0.03 * Math.sin(Date.now() / 320 + i / 3.5);
        const amp = Math.max(idle, level[i]);
        // Taper the ends so it reads as a voice rather than a bar chart.
        const taper = Math.sin((Math.PI * (i + 0.5)) / bars) ** 0.6;
        const bh = Math.max(2, amp * taper * h);
        ctx2d.globalAlpha = 0.3 + Math.min(0.7, amp * 1.2);
        ctx2d.fillStyle = accent;
        const x = i * bw + bw * 0.22;
        const bwd = bw * 0.56;
        const r = Math.min(bwd / 2, 2);
        const y = (h - bh) / 2;
        // Rounded caps — cheap, and it stops the bars looking like a spreadsheet.
        ctx2d.beginPath();
        if (ctx2d.roundRect) ctx2d.roundRect(x, y, bwd, bh, r);
        else ctx2d.rect(x, y, bwd, bh);
        ctx2d.fill();
      }
      ctx2d.globalAlpha = 1;
    };
    draw();
  }

  // Say plainly where the audio and the voice are handled. Both-local is the point
  // of running the gateway; anything else the user should know BEFORE they start
  // talking, not discover afterwards.
  const bothLocal = ear.private && mouth?.private && mouth.provider === 'gateway';
  const priv = el('voice-privacy');
  if (priv) {
    priv.textContent = bothLocal
      ? 'Speech and voice both run locally on this machine.'
      : `Hearing: ${ear.label} · Voice: ${mouth?.label || 'unavailable'}`;
  }

  const speaker = createSpeech({
    provider: mouth?.provider === 'gateway' ? 'gateway' : 'browser',
    gatewayUrl,
    voice: settings?.ui?.speech?.voice || undefined,
    analyse: true,
    // The caption follows the CHUNK being spoken, so the words on screen are the
    // words in the air rather than the whole answer sitting there from the start.
    onChunk: (i, n, chunkText) => setState('speaking', chunkText),
  });

  const loop = createVoiceLoop({
    listen: ({ onInterim, onFinal }) => {
      const d = createDictation({
        provider: ear.provider,
        gatewayUrl,
        lang: settings?.ui?.dictation?.lang || undefined,
        onInterim,
        onFinal,
        onError: ({ message }) => toast?.(`✕ ${message || 'Voice input failed'}`, 2800),
      });
      d.start();
      // The mic analyser appears once capture is up, so hand the getter over now
      // and let the draw loop pick it up when it exists.
      startWave(() => d.analyser?.() || null);
      return () => {
        try { d.stop(); } catch { /* already stopped */ }
        stopWave();
      };
    },
    send: sendTurn,
    speak: async (text) => {
      startWave(() => speaker.analyser());
      try { await speaker.speak(text); } finally { stopWave(); }
    },
    onState: ({ state: st, text }) => setState(st, text),
    onError: (m) => toast?.(`✕ ${m}`, 3000),
  });

  // Show the answer forming. Without this the overlay reads "Thinking…" for the
  // whole generation and then jumps to speech, which feels like a hang on anything
  // longer than a sentence.
  const stopDelta = onTurnDelta?.((partial) => {
    if (loop.state() !== 'thinking') return;
    const clean = String(partial || '').replace(/\s+/g, ' ').trim();
    if (clean) setState('thinking', clean.length > 240 ? `…${clean.slice(-240)}` : clean);
  });

  el('voice-overlay')?.classList.remove('hidden');
  el('btn-voice')?.setAttribute('aria-pressed', 'true');
  setState('listening');
  loop.start();

  const session = {
    isRunning: () => loop.isRunning(),
    isMuted: () => loop.isMuted(),
    toggleMute() {
      const next = !loop.isMuted();
      loop.setMuted(next);
      const b = el('voice-mute');
      if (b) { b.textContent = next ? 'Unmute' : 'Mute'; b.setAttribute('aria-pressed', String(next)); }
      return next;
    },
    // Barge-in must silence the AUDIO too. The loop's run token makes it ignore the
    // playback still in flight, but the speaker keeps talking over the user until
    // it is told to stop.
    interrupt() {
      try { speaker.stop(); } catch { /* nothing playing */ }
      stopWave();
      loop.interrupt();
    },
    stop() {
      try { stopDelta?.(); } catch { /* not subscribed */ }
      try { loop.stop(); } catch { /* already stopped */ }
      try { speaker.stop(); } catch { /* nothing playing */ }
      stopWave();
      const b = el('voice-mute');
      if (b) { b.textContent = 'Mute'; b.setAttribute('aria-pressed', 'false'); }
      el('voice-overlay')?.classList.add('hidden');
      el('btn-voice')?.setAttribute('aria-pressed', 'false');
    },
  };
  return session;
}
