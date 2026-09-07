// Voice conversation — the session, assembled.
//
// voice-loop.js owns the ordering and cancellation, dictation.js the ear,
// speech.js the mouth. This wires them to the composer's voice bar, and it lives
// outside sidepanel.js because every byte of it is action-only: nobody who never
// starts a voice conversation should pay for it at first paint
// (tools/test-first-paint-budget.mjs enforces exactly that).
//
// There is deliberately no separate voice SCREEN. The conversation already renders
// each turn with proper sides and formatted markdown, and an overlay could only
// show one centred line of it — so voice takes the composer's place and leaves the
// chat exactly where it was.
//
// Everything the panel owns is injected:
//   startVoiceMode({ gatewayUrl, settings, el, toast, sendTurn, onTurnDelta }) -> session
//     el(id)                    -> element lookup ($ in the panel)
//     sendTurn(text, {onDelta}) -> Promise<string>   send it, stream the reply
//   session: { stop(), interrupt(), isRunning(), toggleMute() }

const LABEL = {
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking… (just talk to interrupt)',
  muted: 'Muted — tap Unmute to talk',
  idle: '',
};

export async function startVoiceMode({ gatewayUrl, settings = {}, el, toast, sendTurn, openMicPermission, onTurnDelta } = {}) {
  const { micPermissionState, createDictation, resolveDictationProvider } = await import('./dictation.js');
  if (await micPermissionState() !== 'granted') { openMicPermission?.(); return null; }

  const [{ createVoiceLoop }, { resolveEngine }, speechMod] = await Promise.all([
    import('./voice-loop.js'), import('./read-aloud.js'), import('./speech.js'),
  ]);
  const { createSpeech, speakStream } = speechMod;
  const [ear, mouth] = await Promise.all([
    resolveDictationProvider({ gatewayUrl }),
    resolveEngine({ gatewayUrl }),
  ]);
  if (!ear.provider) { toast?.('✕ Voice input isn’t supported in this browser', 2600); return null; }

  const bar = () => el('voice-bar');
  const setState = (st) => {
    const b = bar();
    if (!b) return;
    b.dataset.state = st;
    const s = el('voice-state');
    if (s) s.textContent = LABEL[st] || '';
  };

  // ── waveform ────────────────────────────────────────────────────────────────
  // Driven by whatever is making sound right now: the microphone while you talk,
  // the speaker while it answers. Both are real AnalyserNodes, so the shape tracks
  // the signal — bars animating on a timer beside speech they are not measuring
  // read as lag in the audio rather than in the animation. The source is re-read
  // every frame because neither analyser exists when the loop is armed.
  let raf = 0;
  let micSource = () => null;
  const reduceMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  function startWave() {
    const cv = el('voice-wave');
    if (!cv || typeof cv.getContext !== 'function' || reduceMotion() || raf) return;
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa9ff';
    const bars = 64;
    const level = new Float32Array(bars);
    let buf = null;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      // Prefer whichever is actually producing sound; the speaker wins while it
      // plays, because that is what the user is hearing.
      const an = speaker.analyser?.() || micSource() || null;
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
          // hiss that never moves. Squaring the index weights the low end.
          const from = Math.floor((i / bars) ** 2 * buf.length);
          const to = Math.max(from + 1, Math.floor(((i + 1) / bars) ** 2 * buf.length));
          let sum = 0;
          for (let j = from; j < to; j++) sum += buf[j];
          v = (sum / (to - from)) / 255;
        }
        // Fast to rise so a syllable lands crisply, slow to fall so the shape does
        // not flicker between words.
        level[i] += (v - level[i]) * (v > level[i] ? 0.55 : 0.12);
        const idle = 0.05 + 0.04 * Math.sin(Date.now() / 300 + i / 3.2);
        const amp = Math.max(idle, level[i]);
        const taper = Math.sin((Math.PI * (i + 0.5)) / bars) ** 0.6;
        const bh = Math.max(2, amp * taper * h);
        ctx2d.globalAlpha = 0.3 + Math.min(0.7, amp * 1.2);
        ctx2d.fillStyle = accent;
        const x = i * bw + bw * 0.22;
        const bwd = Math.max(1, bw * 0.56);
        const y = (h - bh) / 2;
        ctx2d.beginPath();
        if (ctx2d.roundRect) ctx2d.roundRect(x, y, bwd, bh, Math.min(bwd / 2, 2));
        else ctx2d.rect(x, y, bwd, bh);
        ctx2d.fill();
      }
      ctx2d.globalAlpha = 1;
    };
    draw();
  }

  function stopWave() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Say where the audio and the voice are handled, before the user starts talking
  // rather than after.
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
      micSource = () => d.analyser?.() || null;
      return () => {
        try { d.stop(); } catch { /* already stopped */ }
        micSource = () => null;
      };
    },
    send: sendTurn,
    // Sentences are spoken as they are generated, so a long answer starts sounding
    // almost immediately instead of after the whole thing exists.
    speakStream: () => speakStream(speaker),
    onState: ({ state: st }) => setState(st),
    onError: (m) => toast?.(`✕ ${m}`, 3000),
  });

  bar()?.classList.remove('hidden');
  el('btn-voice')?.setAttribute('aria-pressed', 'true');
  document.body?.classList.add('voice-active');
  setState('listening');
  startWave();
  loop.start();

  return {
    isRunning: () => loop.isRunning(),
    isMuted: () => loop.isMuted(),
    toggleMute() {
      const next = !loop.isMuted();
      loop.setMuted(next);
      const b = el('voice-mute');
      if (b) { b.textContent = next ? 'Unmute' : 'Mute'; b.setAttribute('aria-pressed', String(next)); }
      return next;
    },
    interrupt() {
      try { speaker.stop(); } catch { /* nothing playing */ }
      loop.interrupt();
    },
    stop() {
      try { loop.stop(); } catch { /* already stopped */ }
      try { speaker.stop(); } catch { /* nothing playing */ }
      stopWave();
      bar()?.classList.add('hidden');
      document.body?.classList.remove('voice-active');
      el('btn-voice')?.setAttribute('aria-pressed', 'false');
      const b = el('voice-mute');
      if (b) { b.textContent = 'Mute'; b.setAttribute('aria-pressed', 'false'); }
    },
  };
}
