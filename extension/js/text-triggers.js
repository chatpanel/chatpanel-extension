// Text arriving anywhere, matched against the user's jobs.
//
// A phrase worth acting on is worth acting on wherever it is written. The trigger matching
// was built for live captions, but nothing in it is about a meeting: it takes {speaker, text}
// arriving over time, which is equally a note being typed and a chat being sent. The shared
// contract made the SOURCE a parameter (@chatpanel/events `sourceAllowed`); this is the
// client half — the part that needs storage and timers, and therefore cannot live there.
//
// ONE PIPELINE, THREE SURFACES. Dedup, the daily ceiling, batching and coalescing are all
// here, so notes, chats and meetings inherit one behaviour rather than drifting into three.
// What each surface does with the answer is its own business and arrives as `runJob`.
//
// THE WATERMARK IS THE HARD PART. A note is re-read whole on every keystroke and a caption
// grows as it is spoken, so the same sentence arrives many times. Every caller passes text
// that may overlap what it passed before; `sinceKey` keeps the high-water mark per source so
// only genuinely new text is ever matched.

import { coalesceMatches } from './events/schedule.js';

/**
 * A burst is ONE answer, not one answer and twelve drops.
 *
 * Short on purpose: the window groups what was asked in one breath, it is not a guess about
 * whether more is coming. An answer that arrives a minute later has been overtaken by
 * whatever was said next. ~2 caption flushes / a sentence or two of typing.
 */
export const BATCH_MS = 6_000;

const batches = new Map();   // jobId → { matches, ctx, timer, running }
const seen = new Map();      // `${source}:${id}` → chars already matched

/** New text only. Callers hand us everything they have; this is what has not been seen. */
export function freshText(source, id, full) {
  const key = `${source}:${id}`;
  const text = String(full || '');
  const at = seen.get(key) || 0;
  // Shorter than last time means it was edited or replaced, not appended — start over rather
  // than slicing into the middle of a sentence.
  if (text.length < at) { seen.set(key, text.length); return ''; }
  seen.set(key, text.length);
  return text.slice(at);
}

/** Forget a source's watermark — a note closed, a meeting ended, a chat switched away from. */
export function forgetSource(source, id) { seen.delete(`${source}:${id}`); }

/** Drop everything queued for a job (it was paused, edited or deleted). */
export function cancelBatch(jobId) {
  const b = batches.get(jobId);
  if (b?.timer) clearTimeout(b.timer);
  batches.delete(jobId);
}

export function queueMatch(job, match, ctx) {
  let b = batches.get(job.id);
  if (!b) { b = { matches: [], ctx, timer: 0, running: false }; batches.set(job.id, b); }
  b.matches.push(match);
  b.ctx = { ...b.ctx, ...ctx };   // the newest context carries the freshest text
  if (!b.timer && !b.running) b.timer = setTimeout(() => flushBatch(job), BATCH_MS);
  return b;
}

/**
 * Answer everything gathered, once. Anything asked WHILE we answer starts the next batch
 * rather than extending this one, so a talkative source cannot hold an answer open forever.
 */
export async function flushBatch(job) {
  const b = batches.get(job.id);
  if (!b || b.running) return;
  b.timer = 0;
  const batch = coalesceMatches(b.matches);
  b.matches = [];
  if (!batch.length) return;
  b.running = true;
  try {
    await b.ctx.runJob(job, { matches: batch, ctx: b.ctx });
  } catch (e) {
    console.warn('[text-triggers] job failed', job?.id, e);
  } finally {
    b.running = false;
    if (b.matches.length && !b.timer) b.timer = setTimeout(() => flushBatch(job), BATCH_MS);
    else if (!b.matches.length) batches.delete(job.id);
  }
}

/** Testing seam — the timers are module state, and a test must not inherit the last one's. */
export function _reset() {
  for (const b of batches.values()) if (b.timer) clearTimeout(b.timer);
  batches.clear();
  seen.clear();
}
