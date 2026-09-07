// Voice↔voice: listen → send → speak → listen, until the user stops it.
//
// Phase 4 of docs/voice-pipeline.md is explicit that this stage is COMPOSITION, not
// new primitives — dictation.js already listens, the panel already sends, speech.js
// already speaks. What was missing is the part that is genuinely hard: the state
// machine that decides when each one runs, and that never gets stuck.
//
// So this module owns exactly that and nothing else. Every platform capability is
// INJECTED (the same rule page-capability.js and loop.js follow), which is why it
// runs under `node --test` with three fakes and no browser.
//
//   createVoiceLoop({ listen, send, speak, onState, onError })
//     listen({ onInterim, onFinal }) -> stopFn   start the mic; call onFinal(text)
//     send(text)                     -> Promise<string>   the assistant's reply
//     speak(text)                    -> Promise<void>     resolves when audio ends
//     onState({ state, text })       'idle'|'listening'|'thinking'|'speaking'
//
// The states are a cycle with one escape hatch (stop) reachable from all of them:
//
//   idle → listening → thinking → speaking ─┐
//            ▲                              │
//            └──────────────────────────────┘
//
// Two rules keep it from wedging, and both are the kind of bug you only find at 2am
// with a microphone open:
//   • Every transition is guarded by a RUN TOKEN. stop() bumps it, so a transcript,
//     a reply or an audio-end from a cancelled run is dropped instead of restarting
//     a loop the user just ended.
//   • Any failure returns to `listening` (or `idle` if stopped), never to a state
//     with no way out. A voice UI that dies silently is indistinguishable from one
//     that is still listening, and the user keeps talking to nothing.

export const VOICE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted'];

export function createVoiceLoop({ listen, send, speak, onState, onError } = {}) {
  let state = 'idle';
  let token = 0;
  let stopListen = null;
  let running = false;
  let muted = false;

  const setState = (s, text) => {
    if (state === s && text === undefined) return;
    state = s;
    try { onState?.({ state: s, text }); } catch { /* a UI error must not break the loop */ }
  };

  const fail = (e, mine) => {
    if (token !== mine) return;
    try { onError?.(typeof e === 'string' ? e : e?.message || 'voice failed'); } catch { /* ignore */ }
  };

  async function turn(mine, text) {
    if (token !== mine || !text) return;
    setState('thinking', text);
    let reply = '';
    try {
      reply = await send(text);
    } catch (e) {
      fail(e, mine);
      return cycle(mine);            // a failed send must not end the conversation
    }
    if (token !== mine) return;
    if (reply && String(reply).trim()) {
      setState('speaking', reply);
      try {
        await speak(reply);
      } catch (e) {
        fail(e, mine);               // speech failed; the answer still arrived
      }
    }
    return cycle(mine);
  }

  function cycle(mine) {
    if (token !== mine || !running) return;
    // Muted means the mic is CLOSED, not merely ignored. A loop that keeps
    // recording and discards the text still ships room noise to the STT engine
    // every turn, and on the browser provider that means shipping it to a vendor —
    // so mute has to stop the listener, not filter its output.
    if (muted) { setState('muted'); return; }
    setState('listening');
    try {
      stopListen = listen({
        onInterim: (t) => { if (token === mine) setState('listening', t); },
        onFinal: (t) => {
          if (token !== mine) return;
          const said = String(t || '').trim();
          if (!said) return;         // silence, or a discarded partial — keep listening
          try { stopListen?.(); } catch { /* already stopped */ }
          stopListen = null;
          turn(mine, said);
        },
      });
    } catch (e) {
      fail(e, mine);
      stopAll();
    }
  }

  function stopAll() {
    token++;
    running = false;
    muted = false; // a new session starts with the mic open, not silently deaf
    try { stopListen?.(); } catch { /* already stopped */ }
    stopListen = null;
    setState('idle');
  }

  return {
    state: () => state,
    isRunning: () => running,
    start() {
      if (running) return;
      running = true;
      const mine = ++token;
      cycle(mine);
    },
    stop: stopAll,
    isMuted: () => muted,
    /**
     * Close (or reopen) the microphone without ending the session — the control for
     * a noisy room, or for saying something you do not want transcribed.
     *
     * Muting mid-answer is allowed and does nothing violent: the mic is already
     * closed while thinking and speaking, so it simply means the NEXT cycle will
     * not open it. Unmuting there is equally safe — the flag clears and the turn
     * ends into a listening state as usual.
     */
    setMuted(on) {
      const next = !!on;
      if (next === muted) return;
      muted = next;
      if (!running) return;
      if (muted) {
        try { stopListen?.(); } catch { /* not listening */ }
        stopListen = null;
        // Only take over the display if the mic was what was showing; a mute
        // pressed mid-answer must not claim the assistant stopped talking.
        if (state === 'listening') setState('muted');
      } else if (state === 'muted') {
        cycle(++token);
      }
    },
    /**
     * Barge-in: drop whatever is being said or thought and listen again, without
     * ending the session. This is the button a user reaches for when the assistant
     * is three sentences into the wrong answer.
     */
    interrupt() {
      if (!running) return;
      const mine = ++token;
      try { stopListen?.(); } catch { /* not listening */ }
      stopListen = null;
      cycle(mine); // respects mute — cycle() will not open a muted mic
    },
  };
}
