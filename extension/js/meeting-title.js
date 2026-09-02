// Naming a meeting — the capability, not the button.
//
// Two passes, deliberately separated:
//   • The DETERMINISTIC one lives in store-meetings.js autoTitleMeeting() and runs on
//     every ending, model or no model, panel open or closed. Nobody is ever left with
//     a list of "Zoom Meeting" rows.
//   • This one is the UPGRADE: when a model is configured, it reads the summary (or
//     the transcript, when the scribe never ran) and names the call the way a person
//     would. It can only improve on a weaker source — isBetterTitleSource is what
//     stops a model overwriting a title someone typed, and what stops a second pass
//     churning the title of a meeting that is already well named.
//
// The model is injected, never imported: `complete({ prompt, maxTokens, signal })` →
// text. The side panel passes its streamChat, the meetings page passes the same, and a
// hosted/gateway version can pass its own — the contract here doesn't change. That is
// the same shape js/suggestions.js uses, and the reason this can move to the gateway
// later without rewriting either caller.

import {
  getMeeting, getMeetingNotes, getMeetingMeta, setMeetingTitle, meetingToText, PLATFORMS,
} from './store-meetings.js';
import {
  meetingTitlePrompt, parseTitleResponse, shouldAutoTitle, isBetterTitleSource, cleanTitle,
} from './events/titles.js';

// The transcript tail the model sees when there is no summary to read. Enough to know
// what a call was about; small enough that titling every meeting stays negligible.
const TRANSCRIPT_CHARS = 6000;
// A title is a handful of words. Anything longer is a model ignoring the instruction,
// and parseTitleResponse will refuse it anyway — so don't pay for the tokens.
const MAX_TOKENS = 40;

/**
 * Ask a model to name one meeting. Returns a clean title, or '' when the model
 * declined, rambled, or there wasn't enough content to name.
 *
 * `rec` may be a stored record or anything with the same shape, so this is testable
 * and reusable without touching storage.
 */
export async function suggestMeetingTitle({ rec, notes = '', complete, signal } = {}) {
  if (typeof complete !== 'function' || !rec) return '';
  // The summary is a better source than the raw transcript when one exists: it is
  // already the meeting distilled, and it costs a tenth of the tokens.
  const summary = String(notes || '').trim();
  const transcript = summary ? '' : meetingToText(rec).slice(-TRANSCRIPT_CHARS);
  if (!summary && !transcript.trim()) return '';
  const prompt = meetingTitlePrompt({
    notes: summary,
    transcript,
    participants: rec.participants || [],
  });
  try {
    const raw = await complete({ prompt, maxTokens: MAX_TOKENS, signal });
    return parseTitleResponse(raw);
  } catch {
    // A titling pass is a nicety running unattended — a model that is down, rate-limited
    // or mid-rotation must never surface as an error on a meeting that captured fine.
    return '';
  }
}

/**
 * Upgrade one stored meeting's title with a model, and persist it.
 *
 * Returns { title, source:'model' } when it renamed, or null when it left things alone
 * (no model, a title the user typed, a title already better than this pass can produce,
 * or a model that gave nothing usable). `force:true` is the user pressing "Rename with
 * AI" — it still refuses to overwrite a title the user typed themselves, because that
 * is a rename, not a suggestion, and the rename UI is right there.
 */
export async function retitleMeetingWithModel(id, { complete, force = false, signal } = {}) {
  if (!id || typeof complete !== 'function') return null;
  const [rec, meta] = await Promise.all([getMeeting(id), getMeetingMeta(id)]);
  if (!rec) return null;
  const source = meta.titleSource || 'capture';
  if (source === 'user') return null;
  const platformLabel = PLATFORMS[rec.platform]?.label || rec.platform || '';
  if (!force) {
    // Same gate the deterministic pass uses, plus the ranking: a summary-derived title
    // is already model-written, so re-asking spends tokens to churn the same answer.
    if (!shouldAutoTitle({ title: rec.title, titleSource: source, platformLabel })) return null;
    if (!isBetterTitleSource('model', source)) return null;
  }
  const notes = await getMeetingNotes(id).catch(() => '');
  const title = await suggestMeetingTitle({ rec, notes, complete, signal });
  if (!title || cleanTitle(title) === cleanTitle(rec.title)) return null;
  await setMeetingTitle(id, title, { source: 'model' });
  return { title, source: 'model' };
}
