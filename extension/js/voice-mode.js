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

export async function startVoiceMode({ gatewayUrl, settings = {}, el, toast, sendTurn, openMicPermission } = {}) {
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
  // Driven by the AnalyserNode on the audio that is actually playing. There is no
  // node while listening or thinking, and none at all on the browser voice, so the
  // canvas hides itself rather than animating something it is not measuring.
  let raf = 0;
  function stopWave() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el('voice-wave')?.classList.add('hidden');
  }
  function startWave(getAnalyser) {
    const cv = el('voice-wave');
    const an = getAnalyser?.();
    if (!cv || !an || typeof cv.getContext !== 'function') return;
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduce) return; // the orb already carries the state without motion
    cv.classList.remove('hidden');
    const buf = new Uint8Array(an.frequencyBinCount);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa9ff';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      an.getByteFrequencyData(buf);
      const { width: w, height: h } = cv;
      ctx2d.clearRect(0, 0, w, h);
      // Log-ish spacing: speech energy lives low, so a linear sweep wastes most of
      // the width on hiss that never moves.
      const bars = 48;
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const from = Math.floor((i / bars) ** 2 * buf.length);
        const to = Math.max(from + 1, Math.floor(((i + 1) / bars) ** 2 * buf.length));
        let sum = 0;
        for (let j = from; j < to; j++) sum += buf[j];
        const v = (sum / (to - from)) / 255;
        const bh = Math.max(2, v * h);
        ctx2d.globalAlpha = 0.25 + v * 0.75;
        ctx2d.fillStyle = accent;
        // Mirrored around the centre line — it reads as a voice, not a bar chart.
        ctx2d.fillRect(i * bw + bw * 0.2, (h - bh) / 2, bw * 0.6, bh);
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
      return () => { try { d.stop(); } catch { /* already stopped */ } };
    },
    send: sendTurn,
    speak: async (text) => {
      startWave(() => speaker.analyser());
      try { await speaker.speak(text); } finally { stopWave(); }
    },
    onState: ({ state: st, text }) => setState(st, text),
    onError: (m) => toast?.(`✕ ${m}`, 3000),
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
