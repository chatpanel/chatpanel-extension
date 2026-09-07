// How often the meeting scribe looks again — the whole of that decision, as arithmetic.
//
// THE BUG THIS EXISTS TO MAKE IMPOSSIBLE. The delay used to be picked from whether a
// bookkeeping Map had any entries in it:
//
//   setTimeout(tick, scribeState.size ? min * 60_000 : 4000)
//
// and that Map was only written on the paths that SUCCEEDED. So a live meeting that
// produced nothing — no segments yet, or a summariser throwing because the configured
// model was gone — left it empty and the panel re-ran the whole tick every four seconds,
// for as long as it stayed open. Each of those ticks re-read the meeting index, AES-GCM
// decrypted the full transcript (see store-meetings.readStoredJSON), rebuilt it as one
// string and fired a model call: fifteen times a minute, on the panel's main thread,
// forever. That is the "opening ChatPanel hangs my machine" report.
//
// A cadence that speeds up when work FAILS is backwards, and a "did anything happen"
// signal that lives in a mutable cache shared with the work itself will always drift from
// the work. So the decision is a pure function of what the tick actually observed, and the
// only fast path left is the FIRST look after the panel opens.
//
// Belongs in @chatpanel/events the day a second client grows a scribe — it is arithmetic
// over an observation, with no window, tab or permission anywhere in it. Kept here for now
// because js/events/ is generated from that package (tools/sync-events.mjs) and cannot be
// hand-edited.

/** The first look after the panel opens: soon enough to feel live, once. */
export const SCRIBE_FIRST_LOOK_MS = 4_000;

/** Never re-enter faster than this, whatever the interval setting says. The floor is the
 *  guard: a bad setting, a divide, or a future caller cannot reproduce the 4s loop. */
export const SCRIBE_MIN_DELAY_MS = 30_000;

/** A tick that hit an error waits longer each time, up to this. Long enough that a dead
 *  model costs a handful of attempts an hour instead of nine hundred. */
export const SCRIBE_MAX_BACKOFF_MS = 15 * 60_000;

/** Another tick is already running — come back shortly rather than stacking. */
export const SCRIBE_BUSY_RETRY_MS = 15_000;

/**
 * How often to look for a meeting that has STARTED, when none is live.
 *
 * The old four-second tick was doing two jobs at once, and only one of them was a mistake.
 * Discovery genuinely wants to be quick — a call that starts while the panel is open should
 * be picked up in seconds — but discovery is one index read: no per-meeting decrypt, no
 * transcript rebuild, no model call. So it keeps a short cadence of its own, and the
 * expensive per-meeting work keeps the interval the user chose.
 */
export const SCRIBE_DISCOVERY_MS = 20_000;

/**
 * How long to wait before the next scribe tick.
 *
 * @param intervalMin  the user's chosen refresh interval, in minutes (0 = scribe off)
 * @param ran          has any tick run yet this panel session?
 * @param liveCount    how many meetings this tick saw as still running
 * @param summarized   did THIS tick actually write a new summary?
 * @param failures     consecutive ticks in which every live meeting failed
 * @returns ms to wait, or null when the scribe should not run at all
 *
 * The ordering matters and is the contract:
 *   • off            → null, so the caller arms no timer at all
 *   • first look     → SCRIBE_FIRST_LOOK_MS, once per session
 *   • nothing live   → SCRIBE_DISCOVERY_MS (one cheap index read; see its note)
 *   • failing        → the interval, doubled per consecutive failure, capped
 *   • anything else  → the interval (a quiet tick is not a reason to hurry)
 * and every non-null answer for a tick that DID work is at least SCRIBE_MIN_DELAY_MS.
 */
export function nextScribeDelay({
  intervalMin = 0, ran = false, liveCount = 0, summarized = false, failures = 0,
} = {}) {
  const min = Number(intervalMin) || 0;
  if (min <= 0) return null;
  if (!ran) return SCRIBE_FIRST_LOOK_MS;
  if (!liveCount) return SCRIBE_DISCOVERY_MS;
  const base = Math.max(min * 60_000, SCRIBE_MIN_DELAY_MS);
  if (summarized || failures <= 0) return base;
  // 2^failures, so 1 failure is one interval's grace and the cap arrives quickly.
  const backoff = base * 2 ** Math.min(failures, 10);
  return Math.min(Math.max(backoff, SCRIBE_MIN_DELAY_MS), Math.max(SCRIBE_MAX_BACKOFF_MS, base));
}

/**
 * Should this meeting be skipped on this tick because it keeps failing?
 *
 * Per-meeting, not global: one meeting whose record will not decrypt must not stop the
 * scribe summarising the call the user is actually in. Failures are counted, and a meeting
 * is retried on a widening schedule rather than abandoned — the usual cause is a model that
 * is temporarily gone, and it comes back.
 */
export function shouldSkipMeeting(state, { now = Date.now() } = {}) {
  const failures = Number(state?.failures) || 0;
  if (failures <= 0) return false;
  const wait = Math.min(SCRIBE_MIN_DELAY_MS * 2 ** Math.min(failures, 10), SCRIBE_MAX_BACKOFF_MS);
  return now - (Number(state?.failedAt) || 0) < wait;
}
