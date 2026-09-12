// GENERATED — do not edit.
// Source of truth: chatpanel-events/meeting-shape.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// THE SHAPE OF A MEETING — who spoke, when, and for how long.
//
// A transcript you did not attend is a wall. The shape of it — one band showing who held
// the floor across the hour, and a breakdown of the minutes — is the fastest way in, and
// it is derivable from the captions alone. So it lives HERE, not in a client: the
// extension, the desktop app and anything that reads the warm index all want the same
// answer, and three implementations of "who talked most" drift into three numbers.
//
// TWO BASES, and the module says which one it used.
//
//   'clock' — the segments carry real timestamps (the extension's capture stamps every
//             caption with `t`, epoch ms). Buckets are equal slices of WALL TIME, so a
//             five-minute silence is visibly five minutes of nothing, and talk time is
//             real minutes.
//   'text'  — the segments carry no usable clock (a meeting read back out of its flat
//             text form, where the timestamps are display strings like "6:28:00 PM" that
//             cannot be turned into durations without guessing at a date and a timezone).
//             Buckets are equal slices of POSITION and shares are shares of characters.
//
// A caller that draws minutes on a 'text' meeting would be inventing them, which is why
// `basis` is part of the return rather than something to infer from a null.
//
// THE TRANSCRIPT IS UNTRUSTED CONTENT — participant-chosen display names, live captions,
// meeting chat. Everything here treats a speaker as an opaque label and returns it as its
// own field; nothing is concatenated into a sentence a prompt could read as an instruction.

/** Ordinary speech, in characters per second — ~150 words per minute. */
const CPS = 15;
/** No caption is shorter than this. Below it, rounding noise becomes "talk time". */
const MIN_TURN_MS = 800;
/** Past this, the speaker has stopped and the meeting is simply quiet. A gap longer than
 *  half a minute is silence, a screen share or a break — not somebody still holding forth. */
const MAX_TURN_MS = 30_000;

/** How many speakers get their own colour before the rest fold into one bucket. Five is
 *  where a categorical palette stops being separable for colour-blind readers; past it,
 *  more hues buy nothing and cost legibility. */
export const SPEAKER_SLOTS = 5;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Epoch ms from whatever the segment carries, or `null` when it carries nothing usable. */
function clockOf(seg) {
  const t = seg?.t ?? seg?.ts ?? null;
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t;
  // An ISO string round-trips through JSON as a string; a display clock ("6:28:00 PM")
  // does not parse and must not be coerced into today's date.
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** The segments as this module needs them: a label, some text, and a clock or `null`. */
function segmentsOf(meeting) {
  const raw = Array.isArray(meeting) ? meeting : (meeting?.segments || []);
  return raw
    .map((s) => ({ speaker: clean(s?.speaker) || 'Speaker', text: String(s?.text ?? ''), t: clockOf(s) }))
    .filter((s) => s.text.trim() || s.speaker);
}

/** How long a caption plausibly took to say, from its own length. */
const spoken = (text) => Math.min(MAX_TURN_MS, Math.max(MIN_TURN_MS, (text.length / CPS) * 1000));

/**
 * Each segment with a start and a duration, sorted, when the meeting has a usable clock.
 * Returns `null` otherwise — the caller falls back to counting characters.
 *
 * A segment runs until the NEXT one starts, capped at `MAX_TURN_MS` so a break does not
 * get billed to whoever spoke last, and floored by its own text so back-to-back interim
 * captions (which can share a millisecond) still register.
 */
function timedSegments(meeting) {
  const segs = segmentsOf(meeting).filter((s) => s.t !== null);
  if (segs.length < 2) return null;
  segs.sort((a, b) => a.t - b.t);
  if (segs.at(-1).t - segs[0].t <= 0) return null; // every caption on one millisecond
  return segs.map((s, i) => {
    const next = segs[i + 1];
    const gap = next ? next.t - s.t : 0;
    const ms = gap > 0 ? Math.min(gap, MAX_TURN_MS) : spoken(s.text);
    return { ...s, ms: Math.max(MIN_TURN_MS, ms) };
  });
}

/**
 * Who spoke, for how long, in one shape — the input to both the talk-time chart and the
 * colouring of everything else.
 *
 * Speakers are ranked by talk time and given a SLOT in that order, and the slot is what a
 * client turns into a colour. Ranking rather than hashing the name is deliberate: a hash
 * is stable across meetings but collides, so two people in the same meeting can come out
 * the same colour, which is the one thing this chart must never do. The ranking is stable
 * for a given meeting because the speaker set is fixed — no filter removes a series here.
 *
 * Past `slots` speakers, the tail folds into `other` rather than taking a generated hue.
 */
export function speakerBreakdown(meeting, { slots = SPEAKER_SLOTS } = {}) {
  const timed = timedSegments(meeting);
  const segs = timed || segmentsOf(meeting);
  const basis = timed ? 'clock' : 'text';

  const by = new Map();
  for (const s of segs) {
    const prev = by.get(s.speaker) || { speaker: s.speaker, lines: 0, chars: 0, ms: 0 };
    prev.lines += 1;
    prev.chars += s.text.length;
    prev.ms += s.ms || 0;
    by.set(s.speaker, prev);
  }

  const weightOf = (s) => (basis === 'clock' ? s.ms : s.chars);
  const total = [...by.values()].reduce((n, s) => n + weightOf(s), 0);
  const ranked = [...by.values()].sort((a, b) => weightOf(b) - weightOf(a) || a.speaker.localeCompare(b.speaker));

  const speakers = ranked.map((s, i) => ({
    speaker: s.speaker,
    slot: i < slots ? i : -1,
    lines: s.lines,
    chars: s.chars,
    ms: basis === 'clock' ? Math.round(s.ms) : null,
    seconds: basis === 'clock' ? Math.round(s.ms / 1000) : null,
    share: total ? weightOf(s) / total : 0,
  }));

  const tail = speakers.filter((s) => s.slot === -1);
  return {
    basis,
    totalMs: basis === 'clock' ? Math.round(total) : null,
    lines: segs.length,
    speakers,
    shown: speakers.filter((s) => s.slot >= 0),
    other: tail.length
      ? {
        speakers: tail.map((s) => s.speaker),
        lines: tail.reduce((n, s) => n + s.lines, 0),
        ms: basis === 'clock' ? tail.reduce((n, s) => n + s.ms, 0) : null,
        seconds: basis === 'clock' ? Math.round(tail.reduce((n, s) => n + s.ms, 0) / 1000) : null,
        share: tail.reduce((n, s) => n + s.share, 0),
      }
      : null,
  };
}

/**
 * The meeting as a row of buckets — who held the floor, across the meeting.
 *
 * On a clock basis the buckets are equal slices of WALL TIME between the first and last
 * caption, so silence reads as silence and a bucket can be genuinely empty. Position
 * buckets (the fallback) cannot show that: they space the captions evenly whatever the
 * pace, which makes a quiet hour look like a busy one.
 *
 * Each bucket names its DOMINANT speaker and the full split, so a client can paint one
 * bar per bucket and still say in a tooltip who else was in it.
 */
export function speakerTimeline(meeting, { buckets = 48 } = {}) {
  const timed = timedSegments(meeting);
  const segs = timed || segmentsOf(meeting);
  if (!segs.length) return { basis: timed ? 'clock' : 'text', from: null, to: null, buckets: [] };

  const n = Math.max(1, Math.floor(buckets));
  const bins = Array.from({ length: n }, () => new Map());
  const add = (bin, speaker, weight) => bin.set(speaker, (bin.get(speaker) || 0) + weight);

  let from = null;
  let to = null;

  if (timed) {
    from = timed[0].t;
    to = Math.max(timed.at(-1).t + timed.at(-1).ms, from + 1);
    const span = to - from;
    for (const s of timed) {
      // A long turn spans buckets; bill each one for the part of the turn inside it, or a
      // ten-minute monologue counts once and the band under-reports a whole stretch.
      const start = s.t;
      const end = Math.min(to, s.t + s.ms);
      const first = Math.min(n - 1, Math.floor(((start - from) / span) * n));
      const last = Math.min(n - 1, Math.floor(((end - from) / span) * n));
      for (let b = first; b <= last; b += 1) {
        const bFrom = from + (span * b) / n;
        const bTo = from + (span * (b + 1)) / n;
        const overlap = Math.min(end, bTo) - Math.max(start, bFrom);
        if (overlap > 0) add(bins[b], s.speaker, overlap);
      }
    }
  } else {
    const per = segs.length / n;
    segs.forEach((s, i) => add(bins[Math.min(n - 1, Math.floor(i / per))], s.speaker, Math.max(1, s.text.length)));
  }

  const rows = bins.map((bin, i) => {
    const by = [...bin.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const weight = by.reduce((sum, [, w]) => sum + w, 0);
    const span = to === null ? null : (to - from) / n;
    return {
      speaker: by[0]?.[0] || '',
      weight,
      by: by.map(([speaker, w]) => ({ speaker, weight: w, share: weight ? w / weight : 0 })),
      from: span === null ? null : Math.round(from + span * i),
      to: span === null ? null : Math.round(from + span * (i + 1)),
    };
  });

  const max = Math.max(...rows.map((r) => r.weight), 1);
  return { basis: timed ? 'clock' : 'text', from, to, buckets: rows.map((r) => ({ ...r, weight: r.weight / max })) };
}

/**
 * Who spoke, and how much — the character-share form kept for callers that only ever had
 * text. `speakerBreakdown` is the fuller answer; this stays because the desktop's meeting
 * pane and `meeting-text.js` are built on it.
 */
export function speakerStats(meeting) {
  const by = new Map();
  for (const s of meeting?.segments || []) {
    const prev = by.get(s.speaker) || { speaker: s.speaker, lines: 0, chars: 0 };
    prev.lines += 1;
    prev.chars += s.text.length;
    by.set(s.speaker, prev);
  }
  const total = [...by.values()].reduce((n, s) => n + s.chars, 0) || 1;
  return [...by.values()]
    .map((s) => ({ ...s, share: s.chars / total }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * The meeting as one ribbon of who-spoke-when, bucketed by POSITION.
 *
 * Kept as-is for the desktop pane, which reads meetings back out of their flat text form
 * and so has no clock to bucket by. New callers want `speakerTimeline`, which uses the
 * clock when there is one and falls back to exactly this when there is not.
 */
export function densityRibbon(meeting, buckets = 40) {
  const segs = meeting?.segments || [];
  if (!segs.length) return [];
  const out = [];
  const per = segs.length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    const slice = segs.slice(from, to);
    if (!slice.length) { out.push({ speaker: '', weight: 0 }); continue; }
    const by = new Map();
    for (const s of slice) by.set(s.speaker, (by.get(s.speaker) || 0) + s.text.length);
    const [speaker, chars] = [...by.entries()].sort((a, b2) => b2[1] - a[1])[0];
    out.push({ speaker, weight: chars });
  }
  const max = Math.max(...out.map((o) => o.weight), 1);
  return out.map((o) => ({ ...o, weight: o.weight / max }));
}

/** `41 min`, `1h 12m`, `48s` — a duration a person reads without converting it. */
export function formatTalkTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.round(total / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
