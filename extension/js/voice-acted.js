// Spoken commands that have already been acted on — the record that outlives the panel.
//
// Lifted out of sidepanel.js, which is the first-paint graph: none of this is needed to PAINT
// a chat box, and it is only ever reached from the meeting-delta path, which already loads
// js/voice-commands.js on demand. Splitting it also let the inlined copy of gistOpening go —
// it only existed to keep the shared contract off first paint, and there is no first paint
// here to protect.
//
// chrome.storage is used INSIDE the functions and never at module top, so the pure half of
// this file (voiceGist, voiceIsFresh) is importable and testable in plain Node.

import { gistOpening } from './events/voice-intents.js';

// ACTED-ON COMMANDS, ON DISK.
//
// Everything that deduped a spoken command used to live in memory: the rule engine's own
// `seen` set, the scan watermark, this page's state. The side panel is closed and reopened
// constantly, and each time it came back the engine was new and empty, the watermark was 0,
// and the delta still carried the last lines said — so every command in it fired again. A
// user who deleted the duplicate timers just made room for the next batch.
//
// Deleting a job is emphatically not a request to recreate it, so this record is what makes
// "already done" outlive the page. Keyed by command key (stable per utterance) and capped, so
// a long meeting cannot grow it without bound.
export const VOICE_ACTED_KEY = 'chatpanel:voiceActed';
export const VOICE_ACTED_MAX = 500;
// A second, SEMANTIC guard. Per-utterance identity is not enough on its own: live captions
// split one spoken sentence across segments and re-emit it as the window rolls, so the same
// request arrives again under a new id and fires again — "one per caption message", which is
// what a user sees as an unstoppable stream. Asking twice for the same thing within a couple
// of minutes is a duplicate, not a second intention; anyone who really wants two identical
// timers can add one from the Jobs panel.
/**
 * How long the EXACT same words stay done.
 *
 * Long, and that is the point. A caption entry in a monologue lives for minutes and is
 * re-scanned on every flush (deliberately — a half-heard command must get a second chance),
 * so a command spoken once kept arriving as new and kept creating timers once it cleared the
 * two-minute window. This has to outlive a caption entry comfortably.
 *
 * The cost is that saying the identical thing twice inside the window does it once. That is
 * the right trade: a duplicate timer is noise the user has to hunt down and delete, and the
 * second one can always be made from the Jobs pane.
 */
export const VOICE_SAME_MS = 20 * 60_000;
let voiceActed = null; // Map of key → when it was acted on

export async function loadVoiceActed() {
  if (voiceActed) return voiceActed;
  try {
    const got = await chrome.storage.local.get(VOICE_ACTED_KEY);
    const rows = Array.isArray(got?.[VOICE_ACTED_KEY]) ? got[VOICE_ACTED_KEY] : [];
    voiceActed = new Map(rows.filter((r) => Array.isArray(r) && r.length === 2));
  } catch {
    voiceActed = new Map(); // storage unavailable → in-memory only, still better than nothing
  }
  return voiceActed;
}

/**
 * What the request WAS, independent of which caption carried it.
 *
 * `sid` is re-minted whenever the caption engine loses the overlap between a growing line and
 * the one before it, which Google Meet does routinely inside a long monologue — so the same
 * words return under a new identity and `key` alone cannot tell it is the same request. This
 * is what actually stops the repeats.
 *
 * The unrecognised case has to carry its TEXT. Every needsModel command has intent null and
 * no duration, so all of them collapsed onto one gist per meeting — and a second, genuinely
 * different question asked inside the repeat window was swallowed as a duplicate of the
 * first. That is the "one question went, then it stopped" half of the report.
 */
export const voiceGist = (c) => (c.intent
  ? `gist:${c.meetingId}:${c.intent}:${c.ms ?? c.when ?? ''}`
  // The OPENING of the request, not all of it. A transcriber does not only append — it
  // REVISES: "How is the weather in Seattle, Washington now?" came back as "How is the
  // weather in Seattle, Washington?" on a later flush, which is different words, a different
  // key, and the same question asked twice.
  : `gist:${c.meetingId}:ask:${gistOpening(c.command)}`);

/** Should this command run? False if this exact utterance, or the same request, already did. */
export function voiceIsFresh(acted, command, now) {
  // The exact words, for as long as the caption carrying them can keep being re-delivered.
  const said = acted.get(command.key);
  if (said && now - said < VOICE_SAME_MS) return false;
  // The looser match — same intent and duration, different words — on a shorter leash.
  // The looser match — a revised transcription, or the same intent and duration through
  // different words — on the SAME long window. Two minutes was shorter than a caption entry
  // lives, so a duplicate timer arrived three minutes later and cleared it.
  const at = acted.get(voiceGist(command));
  return !(at && now - at < VOICE_SAME_MS);
}

export async function rememberVoiceActed(commands, now) {
  const acted = await loadVoiceActed();
  for (const c of commands) { acted.set(c.key, now); acted.set(voiceGist(c), now); }
  // Keep the newest; an old meeting's commands cannot recur anyway.
  const rows = [...acted.entries()].slice(-VOICE_ACTED_MAX);
  voiceActed = new Map(rows);
  try { await chrome.storage.local.set({ [VOICE_ACTED_KEY]: rows }); } catch { /* memory only */ }
}
