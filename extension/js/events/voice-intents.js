// GENERATED — do not edit.
// Source of truth: chatpanel-events/voice-intents.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Spoken commands — "<wake word>, set a timer for ten minutes".
//
// A meeting transcript already streams into ChatPanel every few seconds, speaker-attributed.
// That makes it an INPUT DEVICE, not just a record: a person can address the product in the
// middle of a call and expect something to happen. The obvious way to build that is to ask a
// model, every tick, whether anything was said to us. That is the wrong shape — it pays a
// model call per tick to answer "no" almost every time, and the answer arrives a minute
// after the sentence ended.
//
// So the model is used ONCE, to parse a command that a free matcher already found, and
// never to watch. Everything here is class R: pure string work, microseconds, no network,
// no tokens. The parse either recognises the command or reports `needsModel`, which is the
// seam a small model fills for the phrasings a grammar will never cover.
//
// THREE THINGS THIS MODULE REFUSES TO DO, each because it would break a rule that matters:
//
//   1. It does not act. `parseCommand` returns a description of what was asked for; the
//      host decides whether that is allowed and carries it out. A parser that could start a
//      timer could also be talked into starting anything, by anyone in the room.
//   2. It does not know who is allowed to speak to it. The host passes `self`, because only
//      the host knows which speaker label is the device's owner — and gating on that is the
//      whole security story (see commandsFromSegments).
//   3. It does not read a clock. `now` is injected, exactly like loop.js and event.js, so a
//      command parses identically on replay and a test does not have to wait for Wednesday.
//
// Local time is deliberate: "9am" means 9am where the person is standing, so the resolved
// timestamps come from the host's own timezone via Date. That is the only environmental
// input, and it is the one users would be astonished to see normalised away.

export class VoiceIntentError extends Error {
  constructor(code, message) { super(message); this.name = 'VoiceIntentError'; this.code = code; }
}

/** What a wake word defaults to when the user has not chosen one. Configurable per install. */
export const DEFAULT_WAKE = Object.freeze(['chatpanel']);

// Speech-to-text mangles a brand name it has never seen: "chatpanel" comes back as "chat
// panel", "chat pal", "chad panel". A gate that only accepts the exact spelling is a gate
// that never opens on a real transcript. Tolerance scales with length because one edit in a
// four-letter word is a different word, and two edits in a nine-letter one is still clearly
// the same attempt.
function slack(len) { return len <= 4 ? 0 : len <= 6 ? 1 : 2; }

// The widest span of spoken tokens that may add up to one wake phrase ("chat" "pan" "ell").
const MAX_WAKE_TOKENS = 3;

// Bounded Levenshtein — returns early once the distance cannot come in under `max`, so a
// wake scan over a long transcript stays linear in practice.
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Lowercase and blank out punctuation WITHOUT changing length, so every offset computed
// against the normalised copy still points at the same character of the original. The
// command text handed back to the user keeps its capitals and its apostrophes; matching
// never has to care about either.
export function normalizeSpeech(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}':.\s]/gu, ' ');
}

/** Tokens with offsets into the ORIGINAL string. */
export function tokenize(text) {
  const norm = normalizeSpeech(text);
  const out = [];
  const re = /[\p{L}\p{N}'.:]+/gu;
  let m;
  while ((m = re.exec(norm))) {
    // Keep dots INSIDE a token ("a.m.", "9:30") and drop them at the edges — a trailing
    // full stop turned "ten minutes." into an unknown unit, the kind of bug that only
    // shows up on the one transcript that punctuates.
    const w = m[0].replace(/^[.:]+|[.:]+$/g, '');
    if (w) out.push({ w, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Compile the user's chosen wake word(s) into a matcher. Accepts a string or a list; each is
 * squashed to letters so "chat panel", "ChatPanel" and "chat-panel" are one phrase.
 */
export function compileWake(words = DEFAULT_WAKE) {
  const list = (Array.isArray(words) ? words : [words])
    .map((w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 3); // shorter than this and ordinary speech trips it constantly
  if (!list.length) throw new VoiceIntentError('BAD_WAKE', 'wake word must have at least 3 letters');
  return Object.freeze({ phrases: Object.freeze(list) });
}

/**
 * Find "<wake>, <command>" in one utterance.
 *
 * Returns the command with its ORIGINAL casing, plus which wake phrase matched and where —
 * the host logs the span so a user can see why something fired.
 */
export function findWakeCommand(text, wake = compileWake()) {
  const raw = String(text || '');
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  for (let i = 0; i < tokens.length; i++) {
    let squashed = '';
    for (let n = 0; n < MAX_WAKE_TOKENS && i + n < tokens.length; n++) {
      squashed += tokens[i + n].w.replace(/[^\p{L}\p{N}]/gu, '');
      for (const phrase of wake.phrases) {
        // A window far from the phrase's length cannot match; skip the distance work.
        if (Math.abs(squashed.length - phrase.length) > slack(phrase.length)) continue;
        if (editDistance(squashed, phrase, slack(phrase.length)) <= slack(phrase.length)) {
          const end = tokens[i + n].end;
          const command = stripLeadIn(raw.slice(end));
          return { command, wake: phrase, heard: raw.slice(tokens[i].start, end), at: tokens[i].start };
        }
      }
    }
  }
  return null;
}

// "chatpanel, could you please set a timer" — politeness is not part of the command, and
// leaving it in makes every intent pattern carry an optional-courtesy prefix.
function stripLeadIn(text) {
  return String(text)
    .replace(/^[\s,.:;!?-]+/, '')
    .replace(/^(?:(?:hey|hi|ok|okay|yo)\b[\s,]*)+/i, '')
    .replace(/^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Numbers, durations and clock times as people actually say them
// ---------------------------------------------------------------------------

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const FRACTION = { half: 0.5, quarter: 0.25 };

/** "twenty five" → 25, "a" → 1, "half" → 0.5. Returns null when the words are not a number. */
export function parseNumberWords(words) {
  if (!words.length) return null;
  let total = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'and' || w === 'of') continue; // "two AND a half", "a quarter OF an hour"
    // "an hour" is one hour. "A quarter of an hour" is a quarter, and "two and A half" is
    // 2.5 — in both of those the article belongs to the fraction, not to the count.
    if (w === 'a' || w === 'an') {
      if (total === null && !(words[i + 1] in FRACTION)) total = 1;
      continue;
    }
    if (w in FRACTION) { total = (total ?? 0) + FRACTION[w]; continue; }
    if (w in SMALL) { total = (total ?? 0) + SMALL[w]; continue; }
    if (w in TENS) { total = (total ?? 0) + TENS[w]; continue; }
    if (/^\d+(?:\.\d+)?$/.test(w)) { total = (total ?? 0) + Number(w); continue; }
    return null;
  }
  return total;
}

const UNIT_MS = {
  second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000, m: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000, h: 3_600_000,
  day: 86_400_000, days: 86_400_000,
};

// "10", "10m", "90s" — a number welded to its unit, which is how people type and how STT
// sometimes renders speech.
const GLUED = /^(\d+(?:\.\d+)?)(s|m|h|secs?|mins?|hrs?|seconds?|minutes?|hours?|days?)$/;

/**
 * Total duration named anywhere in `text`: "10 minutes", "an hour and a half",
 * "1 hour 30 minutes", "90s", "half an hour", "two and a half hours".
 *
 * Summing every (quantity, unit) pair rather than taking the first is what makes
 * "1 hour 30 minutes" 90 minutes instead of an hour.
 */
export function parseDuration(text) {
  const tokens = tokenize(text);
  let ms = 0;
  let start = -1;
  let end = -1;
  let matched = false;
  let qty = [];        // words that could still add up to a quantity
  let qtyStart = -1;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const take = (n, unit, from, to) => {
      ms += n * unit;
      if (start < 0) start = from;
      end = to;
      matched = true;
    };
    const glued = GLUED.exec(t.w);
    const unit = glued ? UNIT_MS[glued[2]] : UNIT_MS[t.w];
    if (!unit) {
      // Not a unit: extend the pending quantity while it still parses as a number, else
      // start over from this word. An unrelated clause before the number cannot poison it.
      const next = [...qty, t.w];
      if (parseNumberWords(next) !== null) { if (qtyStart < 0) qtyStart = t.start; qty = next; }
      else if (parseNumberWords([t.w]) !== null) { qty = [t.w]; qtyStart = t.start; }
      else { qty = []; qtyStart = -1; }
      continue;
    }
    if (glued) take(Number(glued[1]), unit, t.start, t.end);
    else {
      const n = qty.length ? parseNumberWords(qty) : null;
      if (n !== null) take(n, unit, qtyStart >= 0 ? qtyStart : t.start, t.end);
    }
    qty = []; qtyStart = -1;
    // "an hour and a half" — the fraction trails its unit, so here is the only place it
    // can be attributed to the right one.
    const j = consumeTrailingFraction(tokens, i);
    if (j > i) { ms += FRACTION[tokens[j].w] * unit; end = tokens[j].end; i = j; }
  }
  if (!matched || ms <= 0) return null;
  return { ms: Math.round(ms), start, end };
}

// Index of the last token of a trailing "…and a half" / "…and a quarter", or `i` when what
// follows is something else.
function consumeTrailingFraction(tokens, i) {
  let j = i + 1;
  if (tokens[j]?.w !== 'and') return i;
  j++;
  if (tokens[j]?.w === 'a' || tokens[j]?.w === 'an') j++;
  return FRACTION[tokens[j]?.w] === undefined ? i : j;
}

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

// When someone names a part of the day instead of a time. Chosen to be unsurprising rather
// than clever: a reminder that fires at a time nobody expected is worse than one that fires
// at a boring one.
export const DAYPART_HOUR = Object.freeze({ morning: 9, afternoon: 14, evening: 19, night: 20, tonight: 19, noon: 12, midnight: 0 });

function atLocal(base, { days = 0, hour, minute = 0 }) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/**
 * When a command says to do something: "in 20 minutes", "at 9am", "tomorrow at 3",
 * "on Wednesday at 9am", "every weekday morning".
 *
 * Returns `{ at, recurrence }`. `recurrence` is null for one-shots and otherwise the shape
 * the scheduler consumes — daily/weekly plus a local wall-clock time, NOT an interval in
 * milliseconds, because "every day at 8am" survives a daylight-saving change and
 * "every 86400000ms" does not.
 */
export function parseWhen(text, { now = Date.now() } = {}) {
  const raw = String(text || '');
  const norm = normalizeSpeech(raw);

  // WHERE the time was said matters as much as what it was: a reminder's body is the
  // command minus the time phrase, and a phrase at the START of the sentence ("remind me
  // every weekday morning to check the queue") used to take the whole reminder with it.
  let from = Infinity;
  let to = -1;
  const span = (a, b) => { if (a < from) from = a; if (b > to) to = b; };

  // "in 20 minutes" — relative, and unambiguous enough to answer before anything else.
  const rel = /\bin\s+(.+)$/i.exec(norm);
  if (rel) {
    const d = parseDuration(rel[1]);
    if (d) {
      const base = rel.index + rel[0].length - rel[1].length;
      return { at: now + d.ms, recurrence: null, kind: 'relative', ...widen(norm, rel.index, base + d.end) };
    }
  }

  const every = /\bevery\s+(day|morning|afternoon|evening|night|week|weekday|[a-z]+day|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b/i.exec(norm)
    || /\b(daily|nightly|weekly)\b/i.exec(norm);
  const clock = parseClock(norm);
  const dayWord = /\b(today|tonight|tomorrow)\b/i.exec(norm);
  const weekdayMatch = /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i.exec(norm);
  const daypart = /\b(morning|afternoon|evening|tonight|night|noon|midnight)\b/i.exec(norm);

  if (every) span(every.index, every.index + every[0].length);
  if (clock) span(clock.start, clock.end);
  if (dayWord) span(dayWord.index, dayWord.index + dayWord[0].length);
  if (weekdayMatch) span(weekdayMatch.index, weekdayMatch.index + weekdayMatch[0].length);
  if (daypart) span(daypart.index, daypart.index + daypart[0].length);

  let hour = clock ? clock.hour : daypart ? DAYPART_HOUR[daypart[1]] : null;
  const minute = clock ? clock.minute : 0;
  // "tonight at 8" is 8 in the EVENING. A bare hour with no meridiem, said alongside a part
  // of the day that is plainly not the morning, means the afternoon reading.
  if (clock && !clock.meridiem && hour < 12 && daypart && DAYPART_HOUR[daypart[1]] >= 12) hour += 12;

  if (every) {
    const word = (every[1] || '').toLowerCase();
    const h = hour ?? DAYPART_HOUR[word] ?? DAYPART_HOUR[word.replace(/ly$/, '')] ?? 9; // "nightly" is night
    const at = word in WEEKDAYS
      ? nextWeekday(now, WEEKDAYS[word], h, minute)
      : word === 'week' || word === 'weekly'
        ? atLocal(now, { days: 7, hour: h, minute })
        : nextDailyAt(now, h, minute, word === 'weekday');
    const recurrence = word in WEEKDAYS
      ? { kind: 'weekly', weekday: WEEKDAYS[word], hour: h, minute }
      : word === 'week' || word === 'weekly'
        ? { kind: 'weekly', weekday: new Date(now).getDay(), hour: h, minute }
        : { kind: 'daily', hour: h, minute, weekdaysOnly: word === 'weekday' };
    return { at, recurrence, kind: 'recurring', ...widen(norm, from, to) };
  }

  if (hour === null && !dayWord && !weekdayMatch) return null;

  if (weekdayMatch) {
    const wd = WEEKDAYS[weekdayMatch[2]];
    const h = hour ?? 9;
    // "next Wednesday" is never today, even when today is Wednesday and the hour is ahead.
    const at = nextWeekday(now, wd, h, minute, !!weekdayMatch[1]);
    return { at, recurrence: null, kind: 'weekday', ...widen(norm, from, to) };
  }

  const h = hour ?? DAYPART_HOUR[daypart?.[1] || 'morning'];
  if (dayWord) {
    const w = dayWord[1].toLowerCase();
    return { at: atLocal(now, { days: w === 'tomorrow' ? 1 : 0, hour: h, minute }), recurrence: null, kind: w, ...widen(norm, from, to) };
  }
  // A bare clock time: today if it is still ahead, otherwise the same time tomorrow. Firing
  // immediately for a time that has already passed is never what was meant.
  let at = atLocal(now, { hour: h, minute });
  if (at <= now) at = atLocal(now, { days: 1, hour: h, minute });
  return { at, recurrence: null, kind: 'clock', ...widen(norm, from, to) };
}

// Grow a time span backwards over the preposition that introduced it, so cutting it out of
// "take the kids to school AT 9am" does not leave a dangling "at".
function widen(norm, from, to) {
  if (!(from >= 0) || !(to > from)) return { start: -1, end: -1 };
  const lead = /\b(?:at|on|by|in|this|starting|from)\s+$/i.exec(norm.slice(0, from));
  return { start: lead ? from - lead[0].length : from, end: to };
}

function nextDailyAt(now, hour, minute, weekdaysOnly = false) {
  let at = atLocal(now, { hour, minute });
  if (at <= now) at = atLocal(now, { days: 1, hour, minute });
  if (weekdaysOnly) {
    for (let i = 0; i < 7; i++) {
      const day = new Date(at).getDay();
      if (day !== 0 && day !== 6) break;
      at = atLocal(at, { days: 1, hour, minute });
    }
  }
  return at;
}

function nextWeekday(now, weekday, hour, minute, skipToday = false) {
  const d = new Date(now);
  let delta = (weekday - d.getDay() + 7) % 7;
  if (delta === 0 && (skipToday || atLocal(now, { hour, minute }) <= now)) delta = 7;
  return atLocal(now, { days: delta, hour, minute });
}

/** "9am", "9:30 pm", "at nine", "21:15", "9 o'clock". Returns 24h {hour, minute}. */
export function parseClock(text) {
  const norm = normalizeSpeech(text);
  // A NUMBER IS ONLY A TIME WHEN SOMETHING SAYS SO. "set a timer for 10 minutes" contains
  // the digits of a perfectly good clock time, and reading it as 10 o'clock is how a timer
  // becomes tomorrow morning. The cue must be attached to THIS number — a meridiem, a
  // minutes part, "o'clock", or an immediately preceding "at" — not merely present
  // somewhere in the sentence.
  const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?/gi;
  let m;
  while ((m = re.exec(norm))) {
    const attachedAt = /\bat\s+$/.test(norm.slice(0, m.index));
    if (!m[2] && !m[3] && !attachedAt) continue;
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour > 23 || minute > 59) continue;
    const mer = (m[3] || '').replace(/[.\s]/g, '').toLowerCase();
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    return { hour, minute, meridiem: mer === 'am' || mer === 'pm', start: m.index, end: m.index + m[0].length };
  }
  // Spelled out: "at nine am". "at half past" is deliberately unsupported — rare in STT
  // output and ambiguous enough to deserve a model rather than a guess.
  const words = /\bat\s+([a-z]+)(?:\s+(a\.?m\.?|p\.?m\.?))?/i.exec(norm);
  if (words) {
    const n = parseNumberWords([words[1]]);
    if (n !== null && Number.isInteger(n) && n >= 0 && n <= 23) {
      let hour = n;
      const mer = (words[2] || '').replace(/[.\s]/g, '').toLowerCase();
      if (mer === 'pm' && hour < 12) hour += 12;
      if (mer === 'am' && hour === 12) hour = 0;
      return { hour, minute: 0, meridiem: mer === 'am' || mer === 'pm', start: words.index, end: words.index + words[0].length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intents — declarations, so a client adds one without touching the parser
// ---------------------------------------------------------------------------

/**
 * @param match (command, ctx) => args | null. Pure and synchronous, for the same reason
 *        rules.js insists on it: "did this match" must be answerable without side effects.
 * @param classUsed what carrying it out costs — R for a local timer, C when it will start a
 *        model turn. Declared, never inferred, so the honest answer to "did that spend
 *        anything" is readable in the declaration.
 * @param effects  'idempotent' | 'non-replayable' — the host uses it to decide whether a
 *        redelivered command may be re-run.
 */
export function defineVoiceIntent({
  id, label, description = '', examples = [], classUsed = 'R',
  effects = 'idempotent', requiresApproval = false, match,
}) {
  if (!id) throw new VoiceIntentError('BAD_INTENT', 'intent.id required');
  if (typeof match !== 'function') throw new VoiceIntentError('BAD_INTENT', `intent '${id}': match required`);
  return Object.freeze({ id, label: label || id, description, examples: Object.freeze([...examples]), classUsed, effects, requiresApproval, match });
}

export function createVoiceIntentRegistry(intents = []) {
  const list = [...intents];
  return {
    add(intent) {
      list.push(intent);
      return () => { const i = list.indexOf(intent); if (i >= 0) list.splice(i, 1); };
    },
    list: () => [...list],
    get: (id) => list.find((i) => i.id === id) || null,

    /**
     * First intent whose pattern matches wins; declaration order is precedence. A command
     * nothing recognises comes back with `needsModel`, which is a different answer from "not
     * a command" — the host may pay for a small model to read it, and MUST NOT guess.
     */
    parse(command, ctx = {}) {
      const text = String(command || '').trim();
      if (!text) return null;
      for (const intent of list) {
        let args = null;
        try { args = intent.match(text, ctx); } catch { args = null; }
        if (args) return { intent: intent.id, label: intent.label, classUsed: intent.classUsed, effects: intent.effects, requiresApproval: intent.requiresApproval, args, command: text, needsModel: false };
      }
      return { intent: null, args: null, command: text, needsModel: true };
    },
  };
}

// ── the built-ins ──────────────────────────────────────────────────────────
// Deliberately the four that are local, revertible and need no new permission. Anything
// that sends, spends or clicks is not a good first thing to trigger by talking near a
// laptop, and belongs behind the per-action confirm gate the host already has.

export const timerIntent = defineVoiceIntent({
  id: 'voice:timer',
  label: 'Set a timer',
  description: 'Starts a countdown and alerts when it finishes.',
  examples: ['set a timer for 10 minutes', 'start a 90 second timer', 'timer for an hour and a half'],
  match: (command, { now = Date.now() } = {}) => {
    if (!/\btimers?\b/i.test(command)) return null;
    const d = parseDuration(command);
    if (!d) return null;
    // "timer for the standup" — whatever is left once the duration and the plumbing words
    // are removed is what the timer is FOR, and a labelled timer is the difference between
    // three anonymous countdowns and three useful ones.
    const label = (command.slice(0, d.start) + ' ' + command.slice(d.end))
      .replace(/\b(set|start|make|create|a|an|the|for|please|timer|timers|to|of|and|half|quarter)\b/gi, ' ');
    return { ms: d.ms, at: now + d.ms, label: tidy(label) };
  },
});

export const reminderIntent = defineVoiceIntent({
  id: 'voice:reminder',
  label: 'Set a reminder',
  description: 'Remembers something and raises it at the time you said.',
  examples: ['remind me to send the deck at 4pm', 'remember to take the kids to school at 9am on Wednesday', 'remind me every weekday morning to check the queue'],
  match: (command, { now = Date.now() } = {}) => {
    const m = /\b(?:remind\s+(?:me|us)|reminder|remember)\b/i.exec(command);
    if (!m) return null;
    const when = parseWhen(command, { now });
    // Cut out exactly the span parseWhen matched — a notification that already says when it
    // is should not also read "…at 9am on wednesday" in its title, and the phrase can sit at
    // either end of the sentence ("remind me every weekday morning to check the queue").
    let text = when && when.end > when.start
      ? command.slice(0, when.start) + ' ' + command.slice(when.end)
      : command;
    text = text.slice(text.toLowerCase().indexOf(m[0].toLowerCase()) + m[0].length);
    text = tidy(text.replace(/^(?:\s*(?:to|that|about|i\s+need\s+to|we\s+need\s+to))\b/i, ''));
    if (!text) return null; // "remind me" with nothing to remember is not a reminder
    return { text, at: when?.at ?? null, recurrence: when?.recurrence ?? null, when: when?.kind ?? null };
  },
});

export const noteIntent = defineVoiceIntent({
  id: 'voice:note',
  label: 'Take a note',
  description: 'Appends a line to the meeting notes.',
  examples: ['note that we agreed to ship on Friday', 'take a note: budget is approved'],
  match: (command) => {
    const m = /^(?:take\s+a\s+note|make\s+a\s+note|note)\b[\s:,-]*(?:that\s+)?(.+)$/i.exec(command.trim());
    const text = m && tidy(m[1]);
    return text ? { text } : null;
  },
});

export const monitorIntent = defineVoiceIntent({
  id: 'voice:monitor',
  label: 'Watch for something',
  description: 'Starts a live monitor that answers as the meeting continues.',
  examples: ['watch for whether we agree a date', 'keep an eye on the pricing question', 'track who owns the migration'],
  classUsed: 'C', // it starts model turns for the rest of the meeting — say so
  match: (command) => {
    const m = /^(?:watch\s+(?:out\s+)?for|watch|keep\s+an\s+eye\s+on|track|monitor)\b[\s:,-]*(?:whether\s+|if\s+|for\s+)?(.+)$/i.exec(command.trim());
    const prompt = m && tidy(m[1]);
    return prompt && prompt.length > 2 ? { prompt } : null;
  },
});

// "Every weekday at 8am run my daily brief." The recurrence parser already existed for
// reminders; what makes this different is that the thing being scheduled is WORK — a skill
// the user already wrote — so the job says only when, and the skill stays the single
// definition of what. Declared class C because it will start a model turn every time.
export const scheduleIntent = defineVoiceIntent({
  id: 'voice:schedule',
  label: 'Schedule something',
  description: 'Runs one of your skills (or a plain instruction) on a schedule.',
  examples: ['every weekday at 8am run my daily brief', 'run the standup summary every morning', 'tomorrow at 9 do the release checklist'],
  classUsed: 'C',
  match: (command, { now = Date.now() } = {}) => {
    const verb = /\b(run|do|start|kick\s+off|execute)\b/i.exec(command);
    if (!verb) return null;
    const when = parseWhen(command, { now });
    // No time is not a schedule — it is a request to do something now, which is a chat
    // message, not a job. Refusing here is what keeps "run the checklist" out of the
    // scheduler.
    if (!when) return null;
    let target = when.end > when.start
      ? command.slice(0, when.start) + ' ' + command.slice(when.end)
      : command;
    const v = /\b(run|do|start|kick\s+off|execute)\b/i.exec(target);
    target = tidy((v ? target.slice(v.index + v[0].length) : target)
      .replace(/^\s*(?:my|the|our)\b/i, '')
      .replace(/\b(skill|job|task)\b\s*$/i, ''));
    if (!target) return null;
    return { target, at: when.at, recurrence: when.recurrence, when: when.kind };
  },
});

export const BUILTIN_VOICE_INTENTS = Object.freeze([timerIntent, reminderIntent, scheduleIntent, noteIntent, monitorIntent]);

function tidy(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
}

/** A registry preloaded with the built-ins — the common case, one call. */
export function defaultVoiceIntents() {
  return createVoiceIntentRegistry(BUILTIN_VOICE_INTENTS);
}

/**
 * Parse one utterance end to end: wake word, then intent.
 *
 * Returns null when the utterance was not addressed to us — which is almost every utterance
 * in a meeting, and must therefore be the cheapest path through this module.
 */
export function parseCommand(text, { wake = compileWake(), intents = defaultVoiceIntents(), now = Date.now() } = {}) {
  const found = findWakeCommand(text, wake);
  if (!found) return null;
  const parsed = intents.parse(found.command, { now });
  if (!parsed) return null;
  return { ...parsed, wake: found.wake, heard: found.heard, at: found.at };
}

// ---------------------------------------------------------------------------
// Transcript → commands
// ---------------------------------------------------------------------------

/** How many commands one transcript delta may produce. */
export const MAX_COMMANDS_PER_DELTA = 3;

/**
 * Scan new transcript segments for commands addressed to us.
 *
 * WHO IS ALLOWED TO SPEAK TO IT is the whole security question here. A meeting transcript
 * carries everyone in the room, so an ungated version of this lets any participant put
 * reminders on someone else's device by saying the wake word — and lets a compromised page
 * do it by writing captions. `self` is therefore matched by the HOST, which is the only
 * layer that knows which label is the device owner; segments from anyone else come back
 * with `allowed: false` rather than being dropped silently, so "why didn't it fire" has an
 * answer.
 *
 * @param segments [{ t, speaker, text }] — the delta, not the whole meeting.
 * @param isSelf   (speaker) => boolean. Omit ONLY when the host has decided anyone may
 *                 command this install; the default refuses, because failing closed on a
 *                 question about authority is the only safe default.
 */
export function commandsFromSegments(segments, {
  wake = compileWake(), intents = defaultVoiceIntents(), isSelf = null,
  sinceTs = 0, now = Date.now(), meetingId = '', max = MAX_COMMANDS_PER_DELTA,
} = {}) {
  const out = [];
  for (const seg of segments || []) {
    if (!seg || !seg.text) continue;
    if (seg.t && seg.t <= sinceTs) continue;
    const parsed = parseCommand(seg.text, { wake, intents, now });
    if (!parsed) continue;
    // NO INTENT, NO ACTION. parseCommand returns a shape for anything that carries the wake
    // word and a time-ish phrase, intent included or not — so "we should talk about the chat
    // panel roadmap next week" came back as a command with intent:null and the caller acted
    // on it anyway. In a live meeting that means ordinary conversation quietly sets timers,
    // which is what happened: a caption grows, keeps matching, and fires again.
    //
    // An automation that runs when it did not understand the request is worse than one that
    // does nothing, so an unrecognised utterance stops here.
    if (!parsed.intent) continue;
    const allowed = isSelf ? !!isSelf(seg.speaker) : false;
    out.push({
      ...parsed,
      allowed,
      speaker: seg.speaker || '',
      t: seg.t || now,
      meetingId,
      // Stable across redeliveries of the same segment, so the dedupe actually dedupes.
      //
      // `parsed.at` used to be in this key, and it is an ABSOLUTE time computed as now + the
      // spoken duration — so it changed on every scan. A live caption is rescanned as the
      // sentence grows (deliberately: a half-heard command must get a second chance), which
      // meant one "set a timer for 10 seconds" produced a brand-new key, and a brand-new
      // timer, on every caption update — indefinitely, and faster than the user could delete
      // them. The key now carries only what the same utterance keeps: where it was said, and
      // what it asked for.
      key: `voice:${meetingId}:${seg.t || 0}:${parsed.intent || 'unknown'}:${parsed.ms ?? parsed.when ?? ''}`,
    });
    if (out.length >= max) break; // a pathological transcript cannot fire fifty actions
  }
  return out;
}
