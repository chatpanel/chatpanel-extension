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

export async function startVoiceMode({ gatewayUrl, settings = {}, el, toast, sendTurn, abortTurn, openMicPermission, onTurnDelta } = {}) {
  const { micPermissionState, createDictation, resolveDictationProvider } = await import('./dictation.js');
  if (await micPermissionState() !== 'granted') { openMicPermission?.(); return null; }

  const [{ createVoiceLoop }, { resolveEngine }, speechMod] = await Promise.all([
    import('./voice-loop.js'), import('./read-aloud.js'), import('./speech.js'),
  ]);
  const { createSpeech, speakStream } = speechMod;
  const { waveShape, smoothLevels, POINTS, LAYERS } = await import('./voice-wave.js');
  const { createVad, lowBandEnergy } = await import('./voice-vad.js');

  // In a conversation every final is SENT as a question, so a mid-thought pause
  // must not commit half a sentence. Dictation into a text box keeps the shorter
  // default; here we wait longer for the person to actually finish.
  const END_SILENCE_MS = 1400;
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
  // Driven by whatever is making sound: the microphone while you talk, the
  // speaker while it answers. Both are real AnalyserNodes, so the band tracks the
  // signal — one animating on a timer beside speech it is not measuring reads as
  // lag in the audio rather than in the animation. The source is re-read each
  // frame because neither analyser exists when the loop is armed.
  //
  // The SHAPE lives in js/voice-wave.js as pure maths, because the two versions
  // that drew a flat line were numeric bugs invisible from reading the code.
  let raf = 0;
  let micSource = () => null;
  let currentState = () => 'listening';
  const vad = createVad();
  // Filled in once the loop exists; the draw loop is defined before it.
  let interruptFromVoice = () => {};
  const reduceMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  function startWave() {
    const cv = el('voice-wave');
    if (!cv || typeof cv.getContext !== 'function' || raf) return;
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return;

    // The backing store must match the CSS box, or the drawing is stretched and
    // blurry — a fixed-size canvas squashed into a ~350px panel is what made the
    // first version invisible.
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
    let bins = null;
    let micBins = null;
    let t = 0;

    // Three bands stacked about the centre line, each at its own frequency and
    // phase so they interfere — that interference, plus a soft glow, is what reads
    // as liquid rather than as a single outline sliding sideways. Drawn back to
    // front: the slow swell, the body, then the shimmer on top.
    const ORDER = [2, 0, 1];
    const ALPHA = [0.22, 0.50, 0.30];
    const band = (curve, alpha, glow) => {
      const mid = h / 2;
      const x = (i) => (i / (POINTS - 1)) * w;
      const grad = ctx2d.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, `${accent}11`);
      grad.addColorStop(0.5, `${accent}dd`);
      grad.addColorStop(1, `${accent}11`);
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
      ctx2d.save();
      if (glow) { ctx2d.shadowColor = accent; ctx2d.shadowBlur = 14; }
      ctx2d.fillStyle = grad;
      ctx2d.globalAlpha = alpha;
      ctx2d.fill();
      ctx2d.restore();
    };

    const paint = (curves) => {
      ctx2d.clearRect(0, 0, w, h);
      for (const k of ORDER) band(curves[k], ALPHA[k], k === 0);
      // A hairline on the body only, so the silhouette stays crisp inside the glow.
      const mid = h / 2;
      const x = (i) => (i / (POINTS - 1)) * w;
      const c = curves[0];
      ctx2d.beginPath();
      ctx2d.moveTo(0, mid - c[0]);
      for (let i = 1; i < POINTS; i++) {
        const cx = (x(i - 1) + x(i)) / 2;
        ctx2d.quadraticCurveTo(x(i - 1), mid - c[i - 1], cx, mid - (c[i - 1] + c[i]) / 2);
      }
      ctx2d.strokeStyle = accent;
      ctx2d.globalAlpha = 0.9;
      ctx2d.lineWidth = 1.25;
      ctx2d.stroke();
      ctx2d.globalAlpha = 1;
    };

    // NOTE: reduced motion does NOT stop the loop. This used to draw one frame and
    // return, which on a machine with the OS setting on produced a beautifully
    // shaped band that never moved — indistinguishable from broken, and the exact
    // complaint it was meant to avoid. The setting suppresses the decorative idle
    // travel; the band still follows your voice, because that is information.
    const motion = !reduceMotion();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      resize();
      if (!w || !h) return;
      t += 1;
      // Pick the source by what the assistant is DOING, not by which analyser
      // happens to exist. The speaker's node lives on after its first utterance —
      // silent, but not null — so a null-check made it win forever and the mic
      // never showed again after the first reply. That was the "animation stops
      // after a follow-up question" report.
      const speakingNow = currentState() === 'speaking';
      const an = speakingNow
        ? (speaker.analyser?.() || null)
        : (micSource() || null);
      if (an) {
        if (!bins || bins.length !== an.frequencyBinCount) bins = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(bins);
        smoothLevels(level, bins);
      } else {
        smoothLevels(level, null);
      }

      // BARGE-IN BY VOICE. The microphone is read every frame regardless of what is
      // being DISPLAYED, because interruption must trigger on the fact that you
      // started talking — not on a transcript, which only arrives after you pause.
      // The VAD learns the room's floor while the assistant is quiet and fires
      // when sustained energy rises well above it during speech.
      const mic = micSource();
      if (mic) {
        if (!micBins || micBins.length !== mic.frequencyBinCount) micBins = new Uint8Array(mic.frequencyBinCount);
        mic.getByteFrequencyData(micBins);
        const fired = vad.feed(lowBandEnergy(micBins));
        if (fired && speakingNow) interruptFromVoice();
      }
      paint(LAYERS.map((_, k) => waveShape({ t, level, height: h, motion, layer: k })));
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
        endSilenceMs: END_SILENCE_MS,
        // Fingerprint each sentence so the loop can tell the person having this conversation
        // from the room. Optional and fail-open: no model, no speaker, everything is sent.
        diarize: true,
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
    // HELD, NOT DROPPED. A sentence the gate keeps out is still something the microphone
    // heard, and silently discarding input is how a voice UI becomes unexplainable. Said
    // once per conversation, not per sentence, so a talkative room does not become a
    // stream of toasts.
    onHeld: ({ count }) => { if (count === 1) toast?.('Another voice — ignoring it. Tap the mic twice to re-listen.', 3200); },
    onError: (m) => toast?.(`✕ ${m}`, 3000),
  });

  currentState = () => loop.state();
  // One interruption stops three things: the audio, the loop's turn, and the
  // panel's stream. Missing the third left the old answer streaming into the
  // conversation for a second or more after the person had talked over it.
  const interruptAll = () => {
    try { speaker.stop(); } catch { /* nothing playing */ }
    try { abortTurn?.(); } catch { /* nothing streaming */ }
    loop.interrupt();
  };
  interruptFromVoice = interruptAll;
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
    interrupt: interruptAll,
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
