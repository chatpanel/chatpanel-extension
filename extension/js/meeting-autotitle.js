// Naming an ended meeting — the deterministic pass.
//
// A separate module from store-meetings.js on purpose. The naming ladder
// (js/events/titles.js) is 13 KB that NOTHING needs in order to paint the side panel,
// the settings page or the service worker, and store-meetings.js is on all three boot
// paths. Keeping it here means the weight is paid where a title is actually derived —
// which is a user action or an idle pass, never first paint.
//
// WHERE IT RUNS. Not inside markMeetingEnded(): a meeting can end while every ChatPanel
// surface is closed, and a title nobody can see has no reader to be wrong for. Instead
// every surface that DISPLAYS meetings names them first —
//   • the side panel, the moment a meeting stops being live (the usual case: the panel
//     is what was running the scribe);
//   • the meetings dashboard, on open, over the whole back catalogue;
//   • the side panel's meetings drawer, on open.
// The pass is idempotent and self-limiting — autoTitleMeeting() returns immediately when
// the stored title already came from an equal or better source — so running it from
// three places costs nothing and guarantees no list ever shows "Zoom Meeting".
//
// No model, no network: the summary the scribe already wrote, the topics already
// extracted, the participants already captured. js/meeting-title.js is the optional
// model upgrade on top of this.

import {
  getMeeting, getMeetingNotes, getMeetingTopics, getMeetingMeta, setMeetingTitle, PLATFORMS,
} from './store-meetings.js';
import { deriveMeetingTitle, shouldAutoTitle, isBetterTitleSource, TITLE_RULES_VERSION } from './events/titles.js';

/**
 * Give one meeting a title worth reading.
 *
 * Returns { title, source } when it renamed, or null when it left the title alone (the
 * user named it, it is already meaningful, or nothing better was derivable).
 * `rec` / `notes` / `topics` may be passed by a caller that already holds them — the
 * dashboard loads all three for every meeting on boot — to avoid paying for the reads
 * twice.
 */
export async function autoTitleMeeting(id, { locale, rec: given, notes: givenNotes, topics: givenTopics } = {}) {
  if (!id) return null;
  const meta = await getMeetingMeta(id);
  const stored = meta.titleSource || 'capture';
  // A title derived under OLDER rules is re-derived once even when no better source has
  // appeared — otherwise a fix to the naming reaches only meetings recorded after it, and
  // the list the user is actually looking at keeps the old mistake forever.
  const stale = (meta.titleRules || 0) !== TITLE_RULES_VERSION;
  // Otherwise: the best this pass can produce is a summary-derived title, so if the stored
  // one already came from there (or a model, or the user) there is nothing to gain — bail
  // before decrypting a transcript and a topic index to reach the same answer.
  if (!stale && !isBetterTitleSource('summary', stored)) return null;
  const rec = given || await getMeeting(id);
  if (!rec) return null;
  const platformLabel = PLATFORMS[rec.platform]?.label || rec.platform || '';
  if (!shouldAutoTitle({ title: rec.title, titleSource: meta.titleSource, platformLabel })) return null;
  const [notes, topics] = await Promise.all([
    givenNotes !== undefined ? givenNotes : getMeetingNotes(id).catch(() => ''),
    givenTopics !== undefined ? givenTopics : getMeetingTopics(id).catch(() => null),
  ]);
  const { title, source } = deriveMeetingTitle({
    title: rec.title,
    titleSource: meta.titleSource, // lets an earlier automatic title yield to a better pass
    notes,
    topics,
    participants: rec.participants || [],
    startedAt: rec.startedAt,
    platformLabel,
    locale,
  });
  if (source === 'kept') return null;
  const better = isBetterTitleSource(source, stored);
  if (!better && !stale) return null;
  if (!better && title === rec.title) {
    // Same rules-version re-run, same answer: stamp the version so this meeting stops
    // being re-derived on every open, and report no change.
    await setMeetingTitle(id, rec.title, { source: stored, rules: TITLE_RULES_VERSION });
    return null;
  }
  await setMeetingTitle(id, title, { source: better ? source : stored, rules: TITLE_RULES_VERSION });
  return { title, source: better ? source : stored };
}

/**
 * Name every ended meeting in an index that still needs it.
 *
 * Meetings captured before automatic naming existed have already ended, so they never
 * pass an ending again — without this they keep their "Zoom Meeting" titles forever.
 * Live meetings are skipped: their tab is still the authority on what they are called.
 *
 * `onRenamed(id, { title, source })` fires per rename so a list can update in place.
 * Returns the number renamed.
 */
export async function backfillMeetingTitles(entries, { onRenamed, locale, detailsById } = {}) {
  let renamed = 0;
  for (const entry of entries || []) {
    if (!entry?.id || (entry.status && entry.status !== 'ended')) continue;
    const held = detailsById?.get?.(entry.id);
    const out = await autoTitleMeeting(entry.id, {
      locale,
      ...(held?.rec ? { rec: held.rec } : {}),
      ...(held && 'notes' in held ? { notes: held.notes } : {}),
      ...(held && 'topics' in held ? { topics: held.topics } : {}),
    }).catch(() => null);
    if (!out) continue;
    renamed += 1;
    onRenamed?.(entry.id, out);
  }
  return renamed;
}
