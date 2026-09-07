// Spoken commands, wired to the meeting transcript.
//
// The parsing lives in @chatpanel/events (js/events/voice-intents.js) so the bridge, the
// gateway and a future mobile app inherit it. What lives HERE is only what is bound to this
// client: which speaker label is the person holding the laptop, which settings switch the
// feature on, and which capability each intent actually reaches.
//
// NOTHING IN THIS FILE IMPORTS chrome.*. It is handed its settings and its actions, which is
// what lets the whole path be tested in Node — a voice command that only works when a real
// meeting is running is a voice command nobody can regression-test.
//
// WHY THE RULE ENGINE AND NOT AN `if`. Everything a spoken command needs — a switch the user
// can turn off, a rate limit, dedup on redelivery, and a recorded reason for every time it
// did NOT act — is already in rules.js, correct and tested. An `if` here would be a second,
// worse copy of all four, and the fourth is the one that matters: "I said the words and
// nothing happened" must have an answer.

import { defineRule } from './events/rules.js';
import {
  compileWake, defaultVoiceIntents, commandsFromSegments, DEFAULT_WAKE, refineSpokenCommand,
  createUtteranceGate,
} from './events/voice-intents.js';

// The bus type a transcript delta is offered under. NOT an event-schema type: the log's
// families are turn/context/capability/privacy/policy/data/automation, and transcript text
// must never enter a log whose whole safety property is that it holds metadata only. The
// engine's own automation.fired/suppressed events ARE logged, and they reference this id.
export const VOICE_EVENT = 'meeting.transcript.delta';

/** Who may speak commands to this install. */
export const COMMAND_SOURCES = Object.freeze(['off', 'me', 'anyone']);

export const DEFAULT_VOICE = Object.freeze({
  enabled: true,
  wakeWord: DEFAULT_WAKE[0],
  // 'me' by default, and it is the setting that carries the security of this feature: a
  // meeting transcript is written by everyone in the room, so 'anyone' hands every
  // participant a button on someone else's machine.
  from: 'me',
  selfNames: [],
});

/**
 * Normalize the stored config into something the rest of this module can trust.
 *
 * Takes the CONFIG OBJECT, not the settings tree: where a client keeps it is that client's
 * business (here, `settings.ui.voice`), and a shared-shaped module that reached into a
 * settings layout would have to be edited for every client that arranges one differently.
 */
export function voiceSettings(config) {
  const v = config || {};
  // Kept as the user TYPED it — including any commas. compileWake splits alternatives
  // ("ok chatpanel, hey chat panel") and strips punctuation itself, so normalizing here would
  // only be a second place for the two to disagree. An array is accepted too, for a client
  // that stores it that way.
  const raw = Array.isArray(v.wakeWord) ? v.wakeWord.join(', ') : String(v.wakeWord ?? '');
  const wakeWord = raw.trim() || DEFAULT_VOICE.wakeWord;
  const from = COMMAND_SOURCES.includes(v.from) ? v.from : DEFAULT_VOICE.from;
  const selfNames = (Array.isArray(v.selfNames) ? v.selfNames : String(v.selfNames || '').split(','))
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  return { enabled: v.enabled !== false, wakeWord, from, selfNames };
}

// Platforms label the local participant inconsistently — Meet resolves "You" to the real
// name, Teams and Zoom often leave it as "You". Both have to count, or the feature works on
// one platform and silently never fires on the others.
const SELF_LABELS = /^(you|me|myself|you \(you\)|me \(me\))$/i;

// Re-exported: callers already take the voice vocabulary from this module, and a second
// import path for one function is how two call sites end up refining differently.
export { refineSpokenCommand, createUtteranceGate };

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * @returns (speaker) => boolean, or null when the host has decided anyone may command it.
 *          Returning null rather than `() => true` keeps the difference visible: the shared
 *          scanner defaults to refusing when it gets no matcher, and "anyone" has to be an
 *          explicit choice, not the absence of one.
 */
export function makeSelfMatcher({ from, selfNames }) {
  if (from === 'anyone') return () => true;
  if (from !== 'me') return () => false;
  const names = selfNames.map(norm).filter(Boolean);
  return (speaker) => {
    const s = norm(speaker);
    if (!s) return false;
    if (SELF_LABELS.test(s)) return true;
    // A first name is enough: rosters render "Alex Rivera" and captions sometimes "Alex".
    return names.some((n) => s === n || s.startsWith(`${n} `) || n.startsWith(`${s} `));
  };
}

/**
 * Find the commands in one transcript delta. Pure: no storage, no model, no clock of its
 * own — this runs on every flush of every meeting, so it has to cost nothing when (as is
 * almost always the case) nobody said the wake word.
 */
export function scanDelta({ segments, voice, meetingId = '', sinceTs = 0, now = Date.now(), intents, gate = null } = {}) {
  const v = voiceSettings(voice);
  if (!v.enabled || v.from === 'off') return [];
  let wake;
  try { wake = compileWake(v.wakeWord); } catch { return []; } // a wake word too short to be safe
  return commandsFromSegments(segments, {
    wake,
    intents: intents || defaultVoiceIntents(),
    isSelf: makeSelfMatcher(v),
    sinceTs,
    now,
    meetingId,
    // WITH a gate, a command comes out once its words have stopped moving — see
    // createUtteranceGate. Optional here only because the gate is state and this function is
    // not: the host keeps the object, because the host is what can come back later.
    gate,
  });
}

/**
 * The rule. `when` is deliberately the authority check and nothing else: a command from
 * someone who is not the device owner is a suppression with a reason, not a silent drop.
 */
export const voiceCommandRule = defineRule({
  id: 'rule:voice-command',
  label: 'Spoken commands',
  description: 'Acts on “<wake word>, …” spoken by you during a meeting — timers, reminders, notes and monitors.',
  on: VOICE_EVENT,
  classUsed: 'R',
  // No everyMs: two commands in one breath are two commands, and a rate limit here would
  // drop the second one silently. Bursts are capped where they are produced instead
  // (MAX_COMMANDS_PER_DELTA), and redelivery is handled by the engine's dedup on event id.
  when: (event) => !!event?.payload?.command?.allowed,
  then: async (event, ctx) => ctx.run(event.payload.command),
});

/**
 * Bind intents to what this client can actually do.
 *
 * An intent with no action is NOT an error — it is a command the product understands and
 * cannot yet carry out (timers and reminders need the scheduler). Saying so is the point:
 * the user spoke to it, and silence would be indistinguishable from not being heard.
 */
export function createVoiceActions(map = {}) {
  const actions = new Map(Object.entries(map));
  // What to do with a command no intent matched. The parser marks those `needsModel` and has
  // always said the host may pay for a small model to read them — this is where that host
  // finally exists. Separate from bind() because it is not an intent: it is the absence of one.
  let onUnrecognised = null;
  return {
    bind(intentId, fn) { actions.set(intentId, fn); return () => actions.delete(intentId); },
    fallback(fn) { onUnrecognised = fn; return () => { onUnrecognised = null; }; },
    has: (intentId) => actions.has(intentId),
    async run(command) {
      const fn = actions.get(command.intent);
      if (!fn && command.needsModel && onUnrecognised) {
        try {
          const result = await onUnrecognised(command);
          // A fallback that declines (the model said "they were just talking") is NOT a
          // failure — reporting it as one would toast at the user every time they finished a
          // sentence near the wake word.
          return result ? { ok: true, result, command } : { ok: false, reason: 'not-a-request', command };
        } catch (e) {
          return { ok: false, reason: 'failed', error: e?.message || String(e), command };
        }
      }
      if (!fn) return { ok: false, reason: command.intent ? 'no-action' : 'not-understood', command };
      try {
        const result = await fn(command);
        return { ok: true, result, command };
      } catch (e) {
        return { ok: false, reason: 'failed', error: e?.message || String(e), command };
      }
    },
  };
}

/**
 * Offer a delta's commands to the engine, one event per command so each is deduped on its
 * own key. Never throws — automation is a passenger, not a driver.
 */
export async function dispatchVoiceCommands(commands, { engine, actions, onOutcome = () => {}, seen = null } = {}) {
  const out = [];
  for (const command of commands) {
    if (!command.allowed) {
      // Reported, not dropped: "someone else said it" is the single most likely reason a
      // user's command did nothing, and they cannot guess it.
      //
      // Told ONCE, though. A line keeps being re-offered while it is the newest thing said,
      // and the engine's dedup never sees these (they are refused before dispatch) — so
      // without this the refusal is a toast on every flush until someone else speaks.
      const outcome = { ok: false, reason: 'not-you', command };
      out.push(outcome);
      if (!seen?.has(command.key)) { rememberKey(seen, command.key); onOutcome(outcome); }
      continue;
    }
    let fired = [];
    try {
      fired = await engine.dispatch(
        { type: VOICE_EVENT, id: command.key, payload: { command } },
        { run: (c) => actions.run(c) },
      );
    } catch { /* the engine already swallows rule errors; this guards the engine itself */ }
    const r = fired.find((f) => f.ruleId === voiceCommandRule.id);
    const outcome = r?.fired
      ? r.result
      : { ok: false, reason: r?.reason || 'suppressed', command };
    out.push(outcome);
    onOutcome(outcome);
  }
  return out;
}

/**
 * Act on every command whose words have settled — and come back when the next one does.
 *
 * THE TIMER IS THE POINT. A gate holds a spoken request while the caption carrying it is
 * still growing, and the deliveries that would drain it are captions — which stop the moment
 * the person stops talking. The last thing said before someone goes quiet is exactly the
 * thing they are waiting to see happen, so something has to come back for it unprompted.
 *
 * Everything platform-bound is INJECTED, so this loop is the same loop wherever it runs: the
 * panel passes chrome.storage-backed freshness and a toast, a bridge would pass its own. The
 * only thing assumed is setTimeout, which every JS runtime has.
 *
 * @param isFresh (command, now) => boolean|Promise — has this already been acted on?
 * @param remember (commands, now) => void|Promise — record them BEFORE they run, so a slow
 *        action cannot be started twice by the next delivery arriving mid-flight.
 * @param isLive  (meetingId) => boolean — a drain that lands after the user moved on does
 *        nothing; acting on a call nobody is looking at is the surprise this path avoids.
 */
export function createVoiceDrain({
  engine, actions, gate, isFresh = () => true, remember = () => {}, onOutcome = () => {},
  isLive = () => true, seen = null,
}) {
  let timer = null;
  return async function drain(meetingId) {
    const now = Date.now();
    const ready = gate.due(now);
    if (ready.length) {
      const fresh = [];
      for (const c of ready) if (await isFresh(c, now)) fresh.push(c);
      if (fresh.length) {
        await remember(fresh, now);
        await dispatchVoiceCommands(fresh, { engine, actions, seen, onOutcome });
      }
    }
    if (timer) { clearTimeout(timer); timer = null; }
    // Measured AFTER the dispatch above, which may have taken a while.
    const wait = gate.nextDueIn(Date.now());
    if (wait === null) return;
    timer = setTimeout(() => {
      timer = null;
      if (isLive(meetingId)) drain(meetingId).catch(() => { /* automation is a passenger */ });
    }, Math.max(200, wait + 100));
  };
}

/** What to tell the user, in one short line. */
export function outcomeMessage(outcome) {
  const c = outcome?.command || {};
  if (outcome?.ok) return outcome.result?.message || `Done — ${c.label || c.intent}`;
  switch (outcome?.reason) {
    case 'not-you':
      return `Heard “${c.command}” from ${c.speaker || 'someone else'} — only your own commands are acted on.`;
    case 'no-action':
      return `Heard “${c.command}” — ${c.label || 'that'} isn’t wired up yet.`;
    case 'not-understood':
      return `Heard “${c.command}” — I didn’t recognise that command.`;
    case 'already-fired':
      return '';   // a redelivered flush; saying anything would be noise
    case 'disabled':
      return 'Spoken commands are switched off in Settings → Plugins.';
    case 'failed':
      return `Couldn’t do that — ${outcome.error}`;
    default:
      return '';
  }
}

// Bounded: a long meeting must not accumulate keys forever. Oldest-first, because the only
// thing this set protects against is a repeat within the next few seconds.
const SEEN_MAX = 200;
function rememberKey(seen, key) {
  if (!seen) return;
  seen.add(key);
  if (seen.size > SEEN_MAX) for (const k of seen) { seen.delete(k); if (seen.size <= SEEN_MAX) break; }
}
