// Voice↔voice: listen, answer, speak — with the microphone open throughout.
//
// The first version closed the mic before thinking and reopened it after speaking,
// which made barge-in impossible: there was nothing listening while the assistant
// talked, so interrupting needed a button. Keeping the mic open the whole session
// turns that into the natural behaviour — you talk, it stops.
//
// So the states are about what the ASSISTANT is doing, not whether we are
// recording:
//
//   idle ──start──> listening ──you speak──> thinking ──reply──> speaking ─┐
//                       ▲                        │                         │
//                       └────────────────────────┴─── you speak again ─────┘
//                                          (barge-in cancels whatever is running)
//
// Everything platform-shaped is injected, which is why this has tests and needs no
// microphone to run:
//   listen({ onInterim, onFinal }) -> stopFn   opened ONCE per session
//   send(text, { onDelta })        -> Promise<string>
//   speakStream()                  -> { push, end, stop, done }
//   onState({ state, text })       'idle' | 'listening' | 'thinking' | 'speaking' | 'muted'

import { createSpeakerGate } from './events/voice-speaker.js';

export const VOICE_STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted'];

// A barge-in has to be SPEECH, not a cough or the tail of our own audio leaking
// past echo cancellation. Two words is the cheapest filter that survives both.
const MIN_BARGE_IN_WORDS = 2;

/**
 * How long after muting a final transcript still counts as "what I said before I muted".
 *
 * A final only exists once the STT engine has heard a silence after the sentence — and
 * muting stops the listener, whose teardown flushes that sentence as its last final. Both
 * arrive AFTER the mute flag is set. Dropping them meant "say something, mute" lost the
 * sentence every time: the engine had it, the loop threw it away. Muting is "stop hearing
 * the room", not "forget what I just said". Longer than any end-of-sentence silence window
 * plus a decode; anything later than this really was the room.
 */
export const MUTE_GRACE_MS = 4000;

/**
 * A safety valve on held-back speech, in characters.
 *
 * The engine cuts a segment it cannot hold and says so, and this loop stitches those pieces
 * back together rather than asking half a sentence. That waits for a pause — which a person
 * always eventually takes, but a stuck audio source never does. Roughly four minutes of
 * continuous speech: far past any real sentence, and short of a buffer that never flushes,
 * because a voice UI that has silently stopped sending looks exactly like a broken mic.
 */
export const MAX_PENDING_CHARS = 4000;

export function createVoiceLoop({ listen, send, speakStream, onState, onError, onHeld, now = Date.now } = {}) {
  let state = 'idle';
  let running = false;
  let muted = false;
  let mutedAt = 0;
  // Sentence so far, across the pieces the engine had to commit for length. See onFinal.
  let pending = '';
  // WHOSE VOICE. Every final is SENT here, so the television, the colleague at the next desk
  // and the person answering their own phone all become questions. The gateway fingerprints
  // each committed segment and labels the speaker; this decides whose turn it is. It fails
  // OPEN in every uncertain case — see @chatpanel/events/voice-speaker.js.
  const speakers = createSpeakerGate({ now });
  let stopListen = null;
  let turnToken = 0;      // bumped to abandon the turn in flight
  let speaking = null;    // the live speak queue, if any

  const setState = (s, text) => {
    if (state === s && text === undefined) return;
    state = s;
    try { onState?.({ state: s, text }); } catch { /* a UI error must not break the loop */ }
  };

  const fail = (e) => {
    try { onError?.(typeof e === 'string' ? e : e?.message || 'voice failed'); } catch { /* ignore */ }
  };

  // Abandon whatever the assistant is doing, without touching the microphone.
  function cancelTurn() {
    turnToken++;
    if (speaking) { try { speaking.stop(); } catch { /* not playing */ } speaking = null; }
  }

  async function runTurn(said) {
    const mine = ++turnToken;
    setState('thinking', said);

    // Speak sentences as they are generated rather than after the whole answer.
    // On a long reply, waiting costs the entire generation in silence.
    const queue = speakStream();
    speaking = queue;
    let started = false;

    let reply = '';
    try {
      reply = await send(said, {
        onDelta: (partial) => {
          if (turnToken !== mine) return;
          if (!started && String(partial || '').trim()) { started = true; }
          setState(started ? 'speaking' : 'thinking', partial);
          queue.push(partial);
        },
      });
    } catch (e) {
      if (turnToken === mine) { fail(e); queue.stop(); speaking = null; back(); }
      return;
    }
    if (turnToken !== mine) return; // barged in while generating

    // A send that never emitted deltas still has an answer to speak.
    if (reply) queue.push(reply);
    queue.end();
    if (String(reply || '').trim()) setState('speaking', reply);
    try {
      await queue.done;
    } catch (e) { fail(e); }
    if (turnToken !== mine) return;
    speaking = null;
    back();
  }

  // Where the loop rests between turns — listening, unless the user muted it.
  function back() {
    if (!running) return;
    setState(muted ? 'muted' : 'listening');
  }

  function openMic() {
    try {
      stopListen = listen({
        onInterim: (t) => {
          if (!running || muted) return;
          // Only caption partials while we are waiting for them; during an answer
          // they are the barge-in about to happen, and showing them competes with
          // the reply on screen.
          if (state === 'listening') setState('listening', pending ? `${pending} ${t}` : t);
        },
        onFinal: (t, info) => {
          if (!running) return;
          // Spoken before the mute, finalized after it: still the user's turn. See MUTE_GRACE_MS.
          if (muted && now() - mutedAt > MUTE_GRACE_MS) return;
          const said = String(t || '').trim();
          if (!said) return;
          // Before anything else, including barge-in: a voice that is not in this
          // conversation must not interrupt the assistant either.
          const who = speakers.admit(info || {});
          if (!who.send) { onHeld?.({ speaker: who.speaker, text: said, count: speakers.heldCount() }); return; }

          if (state === 'thinking' || state === 'speaking') {
            // Barge-in. Judged on what was JUST heard, so the assistant stops the moment
            // someone is clearly talking over it — not at the end of their sentence. Require
            // real words: a single fragment is usually our own audio leaking past echo
            // cancellation, and cutting the assistant off for that is worse than ignoring it.
            if (said.split(/\s+/).filter(Boolean).length < MIN_BARGE_IN_WORDS) return;
            cancelTurn();
          }

          // NOT EVERY FINAL IS THE END OF A SENTENCE. The engine commits a segment when the
          // speaker pauses — a turn — and also when a segment has run too long to hold, which
          // is the middle of a sentence someone is still saying. Sending the second kind asked
          // half a thought and answered it, and the speaker lost the rest:
          //   "…you should just continuously listen to it and then" → sent.
          // So a piece the engine had to cut is kept and stitched to what follows. An older
          // gateway says nothing about why, and everything is a turn, exactly as before.
          pending = pending ? `${pending} ${said}` : said;
          if (info?.endOfTurn === false && pending.length < MAX_PENDING_CHARS) {
            setState('listening', pending);
            return;
          }
          const whole = pending;
          pending = '';
          runTurn(whole);
        },
      });
    } catch (e) {
      fail(e);
      stopAll();
    }
  }

  function stopAll() {
    cancelTurn();
    running = false;
    pending = '';
    muted = false; // a new session starts with the mic open, not silently deaf
    try { stopListen?.(); } catch { /* not listening */ }
    stopListen = null;
    setState('idle');
  }

  return {
    state: () => state,
    isRunning: () => running,
    isMuted: () => muted,
    /** The voice this conversation belongs to, and how many others were held out. */
    primarySpeaker: () => speakers.primary(),
    heldCount: () => speakers.heldCount(),
    /** Hear me again — for a voice the clustering merged or mislabelled. */
    resetSpeaker: () => speakers.reset(),
    start() {
      if (running) return;
      running = true;
      // A new conversation belongs to whoever speaks first in it.
      speakers.reset();
      pending = '';
      openMic();
      back();
    },
    stop: stopAll,
    /**
     * Close the microphone without ending the session — for a noisy room, or to
     * say something you would rather not have transcribed. Muting stops the
     * LISTENER, not just its output: a loop that keeps recording and discards the
     * text still ships the room to the STT engine every turn.
     */
    setMuted(on) {
      const next = !!on;
      if (next === muted) return;
      muted = next;
      if (muted) mutedAt = now();
      if (!running) return;
      if (muted) {
        try { stopListen?.(); } catch { /* not listening */ }
        stopListen = null;
        // Do not claim the assistant stopped talking; it has not.
        if (state === 'listening') setState('muted');
      } else {
        openMic();
        if (state === 'muted') setState('listening');
      }
    },
    /** Manual barge-in, for callers that still want a button. */
    interrupt() {
      if (!running) return;
      cancelTurn();
      back();
    },
  };
}
