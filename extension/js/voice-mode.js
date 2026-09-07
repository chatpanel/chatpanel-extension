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
  // A mirrored, smoothed band driven by whatever is making sound: the microphone
  // while you talk, the speaker while it answers. Both are real AnalyserNodes, so
  // the shape tracks the signal — a band animating on a timer beside speech it is
  // not measuring reads as lag in the audio rather than in the animation. The
  // source is re-read each frame because neither analyser exists when the loop is
  // armed.
  let raf = 0;
  let micSource = () => null;
  const reduceMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  const POINTS = 72;

  function startWave() {
    const cv = el('voice-wave');
    if (!cv || typeof cv.getContext !== 'function' || raf) return;
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return;

    // The backing store has to match the CSS box, or the drawing is stretched and
    // blurry. A fixed 560-wide canvas squashed into a ~350px panel is why the first
    // version looked like nothing was there at all.
    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      const rect = cv.getBoundingClientRect();
      const nextDpr = globalThis.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      if (cw === w && ch === h && nextDpr === dpr) return;
      w = cw; h = ch; dpr = nextDpr;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6aa9ff';
    const level = new Float32Array(POINTS);
    const curve = new Float32Array(POINTS);
    let buf = null;
    let t = 0;

    const shape = () => {
      const an = speaker.analyser?.() || micSource() || null;
      if (an) {
        if (!buf || buf.length !== an.frequencyBinCount) buf = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(buf);
      }
      const maxAmp = h * 0.44;
      for (let i = 0; i < POINTS; i++) {
        let v = 0;
        if (an && buf) {
          // Speech energy sits low, so a linear sweep spends most of the width on
          // hiss that never moves. Squaring the index weights the low end.
          const from = Math.floor((i / POINTS) ** 2 * buf.length);
          const to = Math.max(from + 1, Math.floor(((i + 1) / POINTS) ** 2 * buf.length));
          let sum = 0;
          for (let j = from; j < to; j++) sum += buf[j];
          v = (sum / (to - from)) / 255;
        }
        // Fast to rise so a syllable lands crisply, slow to fall so the band does
        // not flicker between words.
        level[i] += (v - level[i]) * (v > level[i] ? 0.5 : 0.12);
        // A travelling ripple when there is nothing to measure, so the bar reads as
        // live and waiting rather than broken.
        const idle = 0.12 * Math.abs(Math.sin(i * 0.22 - t * 0.05)) * Math.abs(Math.sin(i * 0.07 + t * 0.017));
        const taper = Math.sin((Math.PI * (i + 0.5)) / POINTS) ** 0.7;
        curve[i] = Math.max(idle, Math.max(0, level[i])) * taper * maxAmp;
      }
    };

    // One filled band mirrored about the centre line, outlined over the fill —
    // far easier to read at this height than a row of hairline bars.
    const paint = () => {
      const mid = h / 2;
      const x = (i) => (i / (POINTS - 1)) * w;
      ctx2d.clearRect(0, 0, w, h);
      const grad = ctx2d.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, `${accent}22`);
      grad.addColorStop(0.5, `${accent}cc`);
      grad.addColorStop(1, `${accent}22`);

      ctx2d.beginPath();
      ctx2d.moveTo(0, mid - curve[0]);
      // Quadratics through midpoints: smooth without real spline maths.
      for (let i = 1; i < POINTS; i++) {
        const cx = (x(i - 1) + x(i)) / 2;
        ctx2d.quadraticCurveTo(x(i - 1), mid - curve[i - 1], cx, mid - (curve[i - 1] + curve[i]) / 2);
      }
      ctx2d.lineTo(w, mid - curve[POINTS - 1]);
      ctx2d.lineTo(w, mid + curve[POINTS - 1]);
      for (let i = POINTS - 1; i > 0; i--) {
        const cx = (x(i) + x(i - 1)) / 2;
        ctx2d.quadraticCurveTo(x(i), mid + curve[i], cx, mid + (curve[i] + curve[i - 1]) / 2);
      }
      ctx2d.closePath();
      ctx2d.fillStyle = grad;
      ctx2d.globalAlpha = 0.5;
      ctx2d.fill();
      ctx2d.globalAlpha = 1;
      ctx2d.strokeStyle = accent;
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();
    };

    if (reduceMotion()) {
      // Draw one static band rather than leaving the space empty, then stop.
      resize();
      for (let i = 0; i < POINTS; i++) curve[i] = h * 0.05;
      paint();
      return;
    }

    const draw = () => {
      raf = requestAnimationFrame(draw);
      resize();
      if (!w || !h) return;
      t += 1;
      shape();
      paint();
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
