// GENERATED — do not edit.
// Source of truth: chatpanel-events/voice-speaker.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// WHOSE VOICE IS THIS — the gate that keeps a conversation to the person having it.
//
// In a voice conversation every finalized sentence is SENT, so anything the microphone hears
// becomes a question: a television, a colleague at the next desk, someone answering their own
// phone behind you. The engine transcribes them all perfectly and correctly, and the
// assistant answers the room.
//
// The gateway already computes a 512-d speaker fingerprint per committed segment and clusters
// it into a stable label for the session (`diarize-engine.js`). All that is missing is the
// DECISION, which is this file: the first voice in a conversation is the person who started
// it, and later sentences from a different voice are not their turn.
//
// THE FAILURE DIRECTION MATTERS MORE THAN THE FEATURE. An assistant that occasionally answers
// the television is annoying; one that ignores YOU is broken, and from the outside the two
// look identical — a mic that is open and going nowhere. So every uncertain case sends:
//
//   · no speaker on the final (diarization off, model missing, embedding failed) → send;
//   · no primary enrolled yet → this is the first voice, enroll it and send;
//   · the primary has not been heard for a long time → adopt whoever is talking now and
//     send, because the phone may have been handed over, or the first voice may have been
//     the television while the user was drawing breath.
//
// Only one case holds: a DIFFERENT voice, while the person having the conversation is still
// in it. That is the case the user asked for and the only one we can be confident about.
//
// The engine's own honesty note applies here too: embeddings separate different speakers
// well, but similar voices can merge — so this gate can let a very similar voice through. It
// never claims to be security, only to keep the room out of the conversation.

/** How long the primary must be silent before another voice may take over the conversation. */
export const RE_ENROLL_MS = 45_000;

/** A label the gateway pins to the microphone channel; never a guess, so always the primary. */
export const PINNED_SELF = 'You';

const labelOf = (speaker) => {
  if (!speaker) return '';
  if (typeof speaker === 'string') return speaker;
  return String(speaker.label || speaker.id || '');
};

/**
 * A per-conversation speaker gate.
 *
 * @param {object} [opts]
 * @param {number} [opts.reEnrollMs]  silence after which another voice may take over
 * @param {() => number} [opts.now]   injected clock, so the rules are testable without waiting
 */
export function createSpeakerGate({ reEnrollMs = RE_ENROLL_MS, now = Date.now } = {}) {
  let primary = '';        // the label of the person having this conversation
  let lastHeard = 0;       // when the primary last said something
  let held = 0;            // sentences kept out, for the UI to report honestly

  return {
    /** The enrolled voice, or '' before anyone has spoken. */
    primary: () => primary,
    /** How many sentences this gate has held back. */
    heldCount: () => held,

    /**
     * Should this finalized sentence become a turn?
     *
     * @param {{ speaker?: any }} [final]
     * @returns {{ send: boolean, reason: 'no-speaker'|'enrolled'|'primary'|'adopted'|'other', speaker: string }}
     */
    admit(final = {}) {
      const label = labelOf(final.speaker);
      // Diarization is optional and fails open — a sentence with no speaker is always sent.
      if (!label) return { send: true, reason: 'no-speaker', speaker: '' };

      const t = now();
      if (!primary) {
        primary = label;
        lastHeard = t;
        return { send: true, reason: 'enrolled', speaker: label };
      }
      if (label === primary) {
        lastHeard = t;
        return { send: true, reason: 'primary', speaker: label };
      }
      // A different voice. Only take over when the conversation has clearly moved on.
      if (t - lastHeard >= reEnrollMs) {
        primary = label;
        lastHeard = t;
        return { send: true, reason: 'adopted', speaker: label };
      }
      held += 1;
      return { send: false, reason: 'other', speaker: label };
    },

    /**
     * Forget who was talking. Called when a conversation starts, and by a user who wants the
     * gate to hear them again — a voice it merged or mislabelled must be recoverable without
     * ending the session.
     */
    reset() { primary = ''; lastHeard = 0; held = 0; },
  };
}
