// WHO SPOKE, AS A PICTURE — the two charts on a meeting.
//
//   • the BAND across the top of the detail view: one bar per slice of the meeting,
//     coloured by whoever held the floor in it. It answers "what was the shape of this
//     hour" before you read a word of it — who opened, who ran it, where it went quiet.
//   • the TALK-TIME donut in the Participants tab: the same meeting as minutes per person.
//
// The ARITHMETIC is not here. `js/events/meeting-shape.js` (from @chatpanel/events) works
// out who spoke when and for how long, because the desktop app and anything else reading
// the same transcripts needs the same answer. This module is the part that is genuinely
// bound to a browser: HTML, SVG and colour.
//
// COLOUR IS ASSIGNED BY RANK, NOT BY NAME HASH. Slot 0 is whoever talked most. A hash of
// the display name is stable across meetings but collides, and two people in ONE meeting
// coming out the same colour is the single failure this chart cannot survive. Five slots,
// then the tail folds into one neutral grey — past five, a categorical palette stops being
// separable for a colour-blind reader and more hues buy nothing.
//
// The palette itself lives in meetings.css as --spk-1..5, with its own steps for dark mode.
// Both sets were validated against the card surface for lightness band, chroma, all-pairs
// CVD separation (protan/deutan/tritan), normal-vision separation and contrast.
//
// EVERY SPEAKER NAME IS UNTRUSTED — participants choose their own display names. Names
// reach the DOM only through `esc`, and only ever as a label beside a mark.

import { speakerBreakdown, speakerTimeline, formatTalkTime, SPEAKER_SLOTS } from './events/meeting-shape.js';
import { isMeetingImageValue } from './meeting-people.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (share) => `${Math.round(share * 100)}%`;
const clock = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

/** The CSS variable a slot paints with. -1 is the folded tail, and grey by design. */
const slotVar = (slot) => (slot >= 0 && slot < SPEAKER_SLOTS ? `var(--spk-${slot + 1})` : 'var(--spk-other)');

/**
 * What to CALL a speaker on screen.
 *
 * Some captures (Zoom among them) put an avatar URL where the name goes, for a participant
 * whose name was never captured. The URL is a perfectly good identity — distinct people get
 * distinct URLs, so the arithmetic is right — but it is not a label, and printing it would
 * put a tracking-shaped link in a legend. They become "Participant", numbered when there is
 * more than one so two rows never read identically.
 */
function labeller(speakers) {
  const anon = speakers.filter((s) => isMeetingImageValue(s.speaker));
  const numbered = anon.length > 1;
  const index = new Map(anon.map((s, i) => [s.speaker, `Participant ${i + 1}`]));
  return (name) => (isMeetingImageValue(name) ? (numbered ? index.get(name) : 'Participant') : name);
}

/** The shared legend: a colour chip, the name, and the number the chip stands for. */
function legendHtml(rows, { basis }) {
  return `<ul class="spk-legend">${rows.map((r) => `
    <li${r.lead ? ' class="lead"' : ''}>
      <i class="spk-chip" style="background:${r.color}"></i>
      <span class="spk-name" title="${esc(r.title || r.label)}">${esc(r.label)}</span>
      <span class="spk-val">${basis === 'clock' && r.ms ? esc(formatTalkTime(r.ms)) : ''}</span>
      <span class="spk-share">${esc(pct(r.share))}</span>
    </li>`).join('')}</ul>`;
}

function legendRows(breakdown, label) {
  const rows = breakdown.shown.map((s, i) => ({
    label: label(s.speaker), title: label(s.speaker), color: slotVar(s.slot), ms: s.ms, share: s.share, lead: i === 0,
  }));
  if (breakdown.other) {
    rows.push({
      label: `${breakdown.other.speakers.length} other${breakdown.other.speakers.length === 1 ? '' : 's'}`,
      title: breakdown.other.speakers.map(label).join(', '),
      color: slotVar(-1),
      ms: breakdown.other.ms,
      share: breakdown.other.share,
    });
  }
  return rows;
}

/**
 * The band: who held the floor, across the meeting.
 *
 * Returns '' when there is nothing to draw, so the caller can drop the whole block rather
 * than leave an empty frame — a meeting with one speaker has no shape worth a chart.
 */
export function speakerBandHtml(rec, { buckets = 56 } = {}) {
  const breakdown = speakerBreakdown(rec);
  if (breakdown.speakers.length < 2) return '';
  const timeline = speakerTimeline(rec, { buckets });
  if (!timeline.buckets.length) return '';

  const label = labeller(breakdown.speakers);
  const slotOf = new Map(breakdown.speakers.map((s) => [s.speaker, s.slot]));

  const bars = timeline.buckets.map((b) => {
    if (!b.weight) {
      // A genuinely quiet slice. Drawn as a baseline stub, because an omitted bar reads as
      // a rendering gap and a full-height grey one reads as somebody talking.
      const when = b.from === null ? '' : `${clock(b.from)} · `;
      return `<i class="spk-bar quiet" title="${esc(when)}nobody speaking"></i>`;
    }
    const when = b.from === null ? '' : `${clock(b.from)} · `;
    const who = b.by.slice(0, 3).map((x) => `${label(x.speaker)} ${pct(x.share)}`).join(', ');
    return `<i class="spk-bar" style="height:${Math.max(9, Math.round(b.weight * 100))}%;background:${slotVar(slotOf.get(b.speaker) ?? -1)}" title="${esc(when + who)}"></i>`;
  }).join('');

  const span = timeline.basis === 'clock' && timeline.from !== null
    ? `<span>${esc(clock(timeline.from))}</span><span>${esc(formatTalkTime(timeline.to - timeline.from))} elapsed</span><span>${esc(clock(timeline.to))}</span>`
    : `<span>Start</span><span>by position in the transcript — this meeting has no per-line timestamps</span><span>End</span>`;

  return `
    <section class="spk-band-card" aria-label="Who spoke, across the meeting">
      <div class="spk-band" role="img" aria-label="${esc(`Who held the floor across the meeting: ${legendRows(breakdown, label).map((r) => `${r.label} ${pct(r.share)}`).join(', ')}`)}">${bars}</div>
      <div class="spk-axis">${span}</div>
      ${legendHtml(legendRows(breakdown, label), breakdown)}
    </section>`;
}

/** One donut slice, as a dashed ring segment. A 2px surface gap separates it from the next. */
function ring(color, fromShare, share, circumference, title) {
  const gap = share > 0.012 ? 2 : 0; // a sliver has no room to give 2px away
  const len = Math.max(0.6, share * circumference - gap);
  return `<circle class="spk-slice" r="${(circumference / (2 * Math.PI)).toFixed(2)}" cx="0" cy="0"
    stroke="${color}" stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}"
    stroke-dashoffset="${(-fromShare * circumference).toFixed(2)}"><title>${esc(title)}</title></circle>`;
}

/**
 * Talk time as a part-to-whole: minutes per person, biggest first.
 *
 * A donut earns its place here only because it is capped at six segments and every one is
 * labelled with its own number in the table beside it — the ring is the glance, the table
 * is the read. Without a clock the same ring shows share of what was SAID rather than
 * minutes, and says so instead of printing invented durations.
 */
export function talkTimeChartHtml(rec) {
  const breakdown = speakerBreakdown(rec);
  if (!breakdown.speakers.length) return '';

  const label = labeller(breakdown.speakers);
  const rows = legendRows(breakdown, label);
  const C = 2 * Math.PI * 54; // r = 54
  let from = 0;
  const slices = rows.map((r) => {
    const svg = ring(r.color, from, r.share, C,
      `${r.label} — ${breakdown.basis === 'clock' && r.ms ? `${formatTalkTime(r.ms)}, ` : ''}${pct(r.share)}`);
    from += r.share;
    return svg;
  }).join('');

  const lead = rows[0];
  const centre = breakdown.basis === 'clock'
    ? `<tspan class="spk-hero" x="0" dy="-2">${esc(formatTalkTime(breakdown.totalMs))}</tspan><tspan class="spk-sub" x="0" dy="17">talk time</tspan>`
    : `<tspan class="spk-hero" x="0" dy="-2">${esc(pct(lead.share))}</tspan><tspan class="spk-sub" x="0" dy="17">top speaker</tspan>`;

  const note = breakdown.basis === 'clock'
    ? `${esc(lead.label)} held the floor longest.`
    : 'Shares are of what was said — this meeting carries no per-line timestamps, so minutes cannot be derived.';

  return `
    <div class="spk-talk">
      <svg class="spk-donut" viewBox="-70 -70 140 140" role="img"
           aria-label="${esc(`Talk time: ${rows.map((r) => `${r.label} ${pct(r.share)}`).join(', ')}`)}">
        <g transform="rotate(-90)">${slices}</g>
        <text class="spk-centre" text-anchor="middle" y="0">${centre}</text>
      </svg>
      <div class="spk-talk-side">
        ${legendHtml(rows, breakdown)}
        <p class="spk-note">${note}</p>
      </div>
    </div>`;
}

/** The colour a speaker's name wears everywhere else — the transcript, chiefly. */
export function speakerColors(rec) {
  const breakdown = speakerBreakdown(rec);
  const label = labeller(breakdown.speakers);
  return {
    label,
    colorOf: (name) => slotVar(breakdown.speakers.find((s) => s.speaker === String(name ?? '').replace(/\s+/g, ' ').trim())?.slot ?? -1),
  };
}
