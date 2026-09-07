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

const LABEL = { listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', idle: '' };

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
      if (text !== undefined) c.textContent = String(text || '').slice(0, 220);
      else if (st === 'listening') c.textContent = '';
    }
  };

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
    speak: (text) => speaker.speak(text),
    onState: ({ state: st, text }) => setState(st, text),
    onError: (m) => toast?.(`✕ ${m}`, 3000),
  });

  el('voice-overlay')?.classList.remove('hidden');
  el('btn-voice')?.setAttribute('aria-pressed', 'true');
  setState('listening');
  loop.start();

  const session = {
    isRunning: () => loop.isRunning(),
    // Barge-in must silence the AUDIO too. The loop's run token makes it ignore the
    // playback still in flight, but the speaker keeps talking over the user until
    // it is told to stop.
    interrupt() {
      try { speaker.stop(); } catch { /* nothing playing */ }
      loop.interrupt();
    },
    stop() {
      try { loop.stop(); } catch { /* already stopped */ }
      try { speaker.stop(); } catch { /* nothing playing */ }
      el('voice-overlay')?.classList.add('hidden');
      el('btn-voice')?.setAttribute('aria-pressed', 'false');
    },
  };
  return session;
}
