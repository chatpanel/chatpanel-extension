// GENERATED — do not edit.
// Source of truth: chatpanel-events/schedule.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Jobs — the thing that runs when nobody asked it to.
//
// Every turn ChatPanel has ever run began with a person pressing send. A job does not, and
// that single difference is what this contract is mostly about: consent, cost, dedup and a
// findable result all have to be settled BEFORE the run, because there is nobody sitting
// there to judge the outcome.
//
// Three layers, and the split is the whole point (see docs/feature-f5-scheduler.md):
//
//   • schedule maths — "when does this next fire", "what did we miss while the laptop was
//     asleep". Pure input → output, and wrong in a subtly different way in every
//     reimplementation, so it is written once, here.
//   • the job model, admission and dedup — policy, also here.
//   • WAKING UP — `chrome.alarms`, `WorkManager`, `BGTaskScheduler`. The only platform-bound
//     part, injected by the client, never imported.
//
// A trigger says WHEN. It never says what, and it cannot widen what a job may do: a phrase
// spoken in a meeting can start a job the user already created and approved, and can do
// nothing else. That is deliberate — the transcript is written by everyone in the room.
//
// WALL CLOCK, NOT INTERVALS. "Every day at 8am" is stored as an hour and a minute, not as
// 86_400_000 milliseconds, because the second one drifts by an hour twice a year and nobody
// can explain why the brief started arriving at 7. `now` is injected for the same reason it
// is everywhere else in this package: so a Wednesday can be tested on a Tuesday.

export class ScheduleError extends Error {
  constructor(code, message) { super(message); this.name = 'ScheduleError'; this.code = code; }
}

export const SCHEDULE_KINDS = Object.freeze(['once', 'interval', 'daily', 'weekly']);
export const TRIGGER_KINDS = Object.freeze(['timer', 'meeting', 'voice', 'data']);
/** What a job does when it fires. `skill` is the headline: the instruction IS a skill. */
export const JOB_ACTIONS = Object.freeze(['skill', 'prompt', 'monitor', 'notify']);
/** What to do about occurrences that passed while nothing was running. */
export const MISSED_POLICIES = Object.freeze(['skip', 'runOnce', 'runAll']);

const MAX_CATCH_UP = 20;   // a fortnight asleep must not queue a hundred model calls

// ---------------------------------------------------------------------------
// Schedule maths
// ---------------------------------------------------------------------------

function atLocal(base, { days = 0, hour, minute = 0 }) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const isWeekend = (ts) => { const d = new Date(ts).getDay(); return d === 0 || d === 6; };

export function validateSchedule(s) {
  if (!s || typeof s !== 'object') throw new ScheduleError('BAD_SCHEDULE', 'schedule must be an object');
  if (!SCHEDULE_KINDS.includes(s.kind)) throw new ScheduleError('BAD_SCHEDULE', `unknown schedule kind '${s.kind}'`);
  if (s.kind === 'once' && !(s.at > 0)) throw new ScheduleError('BAD_SCHEDULE', 'once needs `at`');
  if (s.kind === 'interval' && !(s.everyMs >= 60_000)) {
    // A minute is the floor every platform's scheduler shares (chrome.alarms refuses less).
    // Accepting 5s here would produce a job that silently fires on somebody else's cadence.
    throw new ScheduleError('BAD_SCHEDULE', 'interval needs everyMs >= 60000');
  }
  if (s.kind === 'daily' || s.kind === 'weekly') {
    if (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23) throw new ScheduleError('BAD_SCHEDULE', 'hour must be 0-23');
    const m = s.minute ?? 0;
    if (!Number.isInteger(m) || m < 0 || m > 59) throw new ScheduleError('BAD_SCHEDULE', 'minute must be 0-59');
  }
  if (s.kind === 'weekly' && (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6)) {
    throw new ScheduleError('BAD_SCHEDULE', 'weekly needs weekday 0-6 (Sunday = 0)');
  }
  return s;
}

/**
 * The first firing STRICTLY after `from`. Null when a one-shot is already spent.
 *
 * Strictly after, so feeding a fire time back in advances instead of returning the same
 * occurrence forever — the loop that ran a job and then asked "what's next?" would otherwise
 * never stop.
 */
export function nextFireAt(schedule, from) {
  const s = validateSchedule(schedule);
  const minute = s.minute ?? 0;
  switch (s.kind) {
    case 'once':
      return s.at > from ? s.at : null;
    case 'interval': {
      // Anchored so a job restored from storage keeps its original phase instead of drifting
      // a little later every time the extension restarts.
      const anchor = s.anchor ?? from;
      if (anchor > from) return anchor;
      const steps = Math.floor((from - anchor) / s.everyMs) + 1;
      return anchor + steps * s.everyMs;
    }
    case 'daily': {
      let at = atLocal(from, { hour: s.hour, minute });
      if (at <= from) at = atLocal(from, { days: 1, hour: s.hour, minute });
      if (s.weekdaysOnly) for (let i = 0; i < 7 && isWeekend(at); i++) at = atLocal(at, { days: 1, hour: s.hour, minute });
      return at;
    }
    case 'weekly': {
      const day = new Date(from).getDay();
      let delta = (s.weekday - day + 7) % 7;
      if (delta === 0 && atLocal(from, { hour: s.hour, minute }) <= from) delta = 7;
      return atLocal(from, { days: delta, hour: s.hour, minute });
    }
    default:
      return null;
  }
}

/** Every firing in (from, to], oldest first. Capped: a long sleep is not a queue of work. */
export function occurrencesBetween(schedule, from, to, max = MAX_CATCH_UP) {
  const out = [];
  let cursor = from;
  while (out.length < max) {
    const at = nextFireAt(schedule, cursor);
    if (at === null || at > to) break;
    out.push(at);
    cursor = at;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triggers — declarations. A trigger says WHEN, never what.
// ---------------------------------------------------------------------------

/**
 * @param matches (event, params, ctx) => match | null. Pure and synchronous, like rules.js:
 *        "did this match" must be answerable without side effects or a network.
 * @param watches the event types it can possibly match, so a busy bus is cheap.
 */
export function defineTrigger({
  id, label, kind, watches = [], description = '', classUsed = 'R', matches = null, params = {},
}) {
  if (!id) throw new ScheduleError('BAD_TRIGGER', 'trigger.id required');
  if (!TRIGGER_KINDS.includes(kind)) throw new ScheduleError('BAD_TRIGGER', `trigger '${id}': unknown kind '${kind}'`);
  if (kind !== 'timer' && typeof matches !== 'function') {
    throw new ScheduleError('BAD_TRIGGER', `trigger '${id}': an event trigger needs matches()`);
  }
  return Object.freeze({ id, label: label || id, kind, watches: Object.freeze([...watches]), description, classUsed, matches, params: Object.freeze({ ...params }) });
}

export function createTriggerRegistry(triggers = []) {
  const list = [...triggers];
  return {
    add(t) { list.push(t); return () => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); }; },
    list: () => [...list],
    get: (id) => list.find((t) => t.id === id) || null,
  };
}

const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
const norm = (s) => String(s || '').trim().toLowerCase();

/** Shorter than this and ordinary speech contains it constantly. */
export const MIN_PHRASE_CHARS = 3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word containment, not `includes`.
 *
 * A substring match turns "in" into a trigger that fires on interview, thing, going and
 * finding — which is indistinguishable, from the user's chair, from a trigger that ignores
 * its phrase entirely. That is exactly how it was reported: "for every utterance I say, it
 * runs". Boundaries are only required at ends that are word characters, so "action item"
 * still matches "an action item," and ":shipped" still matches ":shipped".
 */
export function saidIn(text, phrase) {
  const p = norm(phrase);
  if (p.length < MIN_PHRASE_CHARS) return false;
  const left = /[\p{L}\p{N}]/u.test(p[0]) ? '\\b' : '';
  const right = /[\p{L}\p{N}]/u.test(p[p.length - 1]) ? '\\b' : '';
  try {
    return new RegExp(`${left}${escapeRe(p)}${right}`, 'iu').test(String(text || ''));
  } catch {
    return norm(text).includes(p); // a phrase that will not compile still gets a plain match
  }
}

// Whose speech a meeting trigger cares about. The default is 'anyone' because a phrase
// trigger is usually watching for what OTHERS say — unlike a spoken command, which is only
// ever the owner's (see voice-intents.js).
function speakerAllowed(want, speaker, ctx) {
  if (want === 'me') return !!ctx?.isSelf?.(speaker);
  if (want === 'others') return !ctx?.isSelf?.(speaker);
  return true;
}

/**
 * Words a sentence does not end on.
 *
 * Not a grammar: a short list of the tails that mean "the speaker is mid-thought". A caption
 * ending on one of these is a line that has not finished arriving.
 */
export const DANGLING_TAILS = Object.freeze(new Set([
  // conjunctions and subordinators — the reason, the contrast, the condition all come AFTER
  'and', 'or', 'but', 'so', 'because', 'cause', 'cos', 'since', 'although', 'though', 'while',
  'whereas', 'unless', 'until', 'if', 'when', 'whenever', 'that', 'which', 'who', 'whom',
  'whose', 'than', 'as', 'like',
  // prepositions and particles
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without', 'about', 'into',
  'onto', 'over', 'under', 'between', 'through', 'during', 'against', 'per',
  // determiners that must be followed by something. Only the ones that genuinely cannot end
  // a sentence — 'this', 'some' and 'both' all can ("take both"), so they are not here.
  'a', 'an', 'the', 'my', 'our', 'your', 'their', 'its',
  // auxiliaries and copulas left hanging
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has',
  'had', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
  // fillers a speaker trails off on. Pronouns are NOT here: "we should ship it" is a whole
  // thought, and treating every object pronoun as a trailing word made the common case wait.
  'um', 'uh', 'er',
]));

/**
 * Does this line read as a FINISHED thought?
 *
 * A live caption is delivered while it is still being spoken and GROWS across flushes, so a
 * trigger that matched can be holding half a sentence: "the product is just amazing because"
 * — with the reason, the only part worth acting on, still unsaid. The caller uses this to
 * decide whether to read the transcript now or wait for the rest of it.
 *
 * DEFAULT TRUE, deliberately. Speech-to-text frequently emits no punctuation at all, so
 * requiring a full stop would make every job wait every time — and the complaint this exists
 * to fix is about missing context, not about speed. Only a line that ends the way an
 * unfinished one ends is treated as unfinished.
 *
 * Pure and synchronous, like every other predicate in this file: the waiting is the caller's
 * problem, and it is the only part that needs a platform.
 */
export function utteranceLooksComplete(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Sentence-final punctuation, optionally inside a closing quote or bracket.
  if (/[.!?…]["'\u2019\u201d)\]]*$/.test(t)) return true;
  // A comma, dash or colon at the end is a speaker who is explicitly not done.
  if (/[,;:\-\u2013\u2014]$/.test(t)) return false;
  const tokens = t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const last = tokens[tokens.length - 1];
  if (!last) return true;
  return !DANGLING_TAILS.has(last);
}

// ---------------------------------------------------------------------------
// WHERE TEXT COMES FROM.
//
// A phrase worth acting on is a phrase worth acting on wherever it is written. The triggers
// below were built for live captions, but nothing in them is about a meeting: they take
// {speaker, text} arriving over time, which is equally a note being typed and a chat being
// sent. So the SOURCE became a parameter instead of three copies of the matcher.
//
// `text.delta` is the source-agnostic event. `meeting.transcript.delta` stays a first-class
// type — it is what the meeting pipeline already emits and what stored jobs were matched
// against — and is read as source 'meeting'.
//
// DEFAULT IS MEETING-ONLY, and that is a compatibility guarantee, not a preference: every
// job stored before this existed was created against a form that said "when a phrase is
// said" in a call. Widening those silently would start running models over notes their
// author never pointed them at.
// ---------------------------------------------------------------------------
export const TEXT_DELTA = 'text.delta';
export const TRIGGER_SOURCES = Object.freeze(['meeting', 'note', 'chat']);
export const TEXT_WATCHES = Object.freeze(['meeting.transcript.delta', TEXT_DELTA]);

/** Which surface an event came from. A meeting delta says so by its type alone. */
export function eventSource(event) {
  if (event?.type === 'meeting.transcript.delta') return 'meeting';
  const s = norm(event?.source);
  return TRIGGER_SOURCES.includes(s) ? s : '';
}

/** May this job act on this surface? Absent `sources` means meetings only — see above. */
export function sourceAllowed(sources, event) {
  const from = eventSource(event);
  if (!from) return false;
  const want = (Array.isArray(sources) ? sources : []).map(norm).filter((x) => TRIGGER_SOURCES.includes(x));
  return want.length ? want.includes(from) : from === 'meeting';
}

export const timerTrigger = defineTrigger({
  id: 'timer:schedule',
  label: 'On a schedule',
  kind: 'timer',
  description: 'Once, on an interval, daily, or on a weekday — "every weekday at 8am".',
});

export const meetingStartedTrigger = defineTrigger({
  id: 'meeting:started',
  label: 'When a meeting starts',
  kind: 'meeting',
  watches: ['meeting.started'],
  matches: (event, params = {}) => {
    if (params.platform && norm(event.platform) !== norm(params.platform)) return null;
    if (params.titleIncludes && !norm(event.title).includes(norm(params.titleIncludes))) return null;
    return { why: `meeting started: ${event.title || event.meetingId}` };
  },
});

export const meetingEndedTrigger = defineTrigger({
  id: 'meeting:ended',
  label: 'When a meeting ends',
  kind: 'meeting',
  watches: ['meeting.ended'],
  matches: (event) => ({ why: `meeting ended: ${event.title || event.meetingId}` }),
});

export const personJoinedTrigger = defineTrigger({
  id: 'meeting:person-joined',
  label: 'When someone joins',
  kind: 'meeting',
  watches: ['meeting.person-joined'],
  // No names means anyone — "tell me when the call fills up" is as valid as "tell me when
  // Alex joins", and an empty list that matched nothing would look like a broken job.
  matches: (event, params = {}) => {
    const want = (params.names || []).map(norm).filter(Boolean);
    const joined = (event.people || []).filter((p) => !want.length || want.some((n) => norm(p) === n || norm(p).startsWith(`${n} `)));
    return joined.length ? { why: `joined: ${joined.join(', ')}`, people: joined } : null;
  },
});

export const phraseTrigger = defineTrigger({
  id: 'meeting:phrase',
  label: 'When a phrase is said',
  kind: 'meeting',
  watches: TEXT_WATCHES,
  matches: (event, params = {}, ctx = {}) => {
    // Both guards exist because their absence looks the same to a user: a trigger that fires
    // on everything. An empty list would match every line; a one- or two-letter phrase
    // effectively does too.
    if (!sourceAllowed(params.sources, event)) return null;
    const any = (params.any || []).map(norm).filter((p) => p.length >= MIN_PHRASE_CHARS);
    if (!any.length) return null;
    for (const seg of event.segments || []) {
      if (!speakerAllowed(params.speaker, seg.speaker, ctx)) continue;
      const hit = any.find((p) => saidIn(seg.text, p));
      if (hit) return { why: `“${hit}” said by ${seg.speaker || 'someone'}`, segment: seg, phrase: hit };
    }
    return null;
  },
});

export const topicTrigger = defineTrigger({
  id: 'meeting:topic',
  label: 'When someone talks about something',
  kind: 'meeting',
  watches: TEXT_WATCHES,
  // Looser than a phrase on purpose: "says something about pricing" should not require the
  // word "pricing" in the exact shape the job author typed. Term overlap over the window is
  // deterministic, explainable, and free — a model would be all three of the opposite.
  matches: (event, params = {}, ctx = {}) => {
    if (!sourceAllowed(params.sources, event)) return null;
    const terms = (params.terms || []).map(norm).filter(Boolean);
    if (!terms.length) return null;
    const need = Math.max(1, Math.min(params.minHits || 1, terms.length));
    const window = (event.segments || []).filter((s) => speakerAllowed(params.speaker, s.speaker, ctx));
    const bag = new Set(window.flatMap((s) => words(s.text)));
    const hits = terms.filter((t) => t.split(/\s+/).every((w) => bag.has(w)));
    return hits.length >= need ? { why: `talking about ${hits.join(', ')}`, terms: hits } : null;
  },
});

// A question mark is the cheap half; the interrogative openers are what catch speech-to-text
// output, which frequently drops the punctuation entirely.
const QUESTION = /^(who|what|when|where|why|how|which|whose|can|could|would|should|shall|do|does|did|is|are|was|were|will|have|has|any(one|body)|is there|are there)\b/i;

export const questionTrigger = defineTrigger({
  id: 'meeting:question',
  label: 'When a question is asked',
  kind: 'meeting',
  watches: TEXT_WATCHES,
  matches: (event, params = {}, ctx = {}) => {
    if (!sourceAllowed(params.sources, event)) return null;
    for (const seg of event.segments || []) {
      // Other people by default: this exists for reacting to what someone ELSE asks (an
      // interview, a customer call). The job form offers the choice, so 'anyone' and 'me' are
      // one dropdown away rather than an invisible default nobody can reach.
      // ANYONE by default, including you. 'others' read well — this exists for reacting to
      // what someone ELSE asks — but it made the first thing anybody does (test it alone in a
      // call, ask a question, wait) match nothing, so the feature looked dead. "Only what
      // other people ask" is still one dropdown away in the job form.
      if (!speakerAllowed(params.speaker || 'anyone', seg.speaker, ctx)) continue;
      const text = String(seg.text || '').trim();
      if (text.length < 8) continue; // "what?" is not a question worth waking a model for
      if (text.includes('?') || QUESTION.test(text)) return { why: `question from ${seg.speaker || 'someone'}`, segment: seg };
    }
    return null;
  },
});

export const voiceCommandTrigger = defineTrigger({
  id: 'voice:command',
  label: 'When you say the wake word',
  kind: 'voice',
  watches: ['voice.command'],
  matches: (event, params = {}) => {
    const want = params.intents || [];
    if (!event.command?.allowed) return null; // authority is settled upstream; never widened here
    if (want.length && !want.includes(event.command.intent)) return null;
    return { why: `you said “${event.command.command}”`, command: event.command };
  },
});

export const BUILTIN_TRIGGERS = Object.freeze([
  timerTrigger, meetingStartedTrigger, meetingEndedTrigger, personJoinedTrigger,
  phraseTrigger, topicTrigger, questionTrigger, voiceCommandTrigger,
]);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * @param action  { kind: 'skill', skillId } — the headline case: the instruction IS a skill,
 *                so "every morning, do my daily brief" is a job whose action names the skill
 *                the user already wrote. Also 'prompt' (raw text), 'monitor', 'notify'.
 * @param limits  { maxPerDay } — a job that fails must back off, not retry in a tight loop.
 * @param onMissed what to do about occurrences that passed while nothing was awake. Stated,
 *                because silently running eleven catch-up briefs is as wrong as silently
 *                running none, and the difference is money.
 */
export function defineJob({
  id, name, trigger, schedule = null, params = {}, action,
  enabled = true, onMissed = 'runOnce', limits = {}, approval = null, createdAt = 0,
}) {
  if (!id) throw new ScheduleError('BAD_JOB', 'job.id required');
  if (!name) throw new ScheduleError('BAD_JOB', `job '${id}': name required`);
  if (!trigger) throw new ScheduleError('BAD_JOB', `job '${id}': trigger required`);
  if (!action || !JOB_ACTIONS.includes(action.kind)) {
    throw new ScheduleError('BAD_JOB', `job '${id}': action.kind must be one of ${JOB_ACTIONS}`);
  }
  if (action.kind === 'skill' && !action.skillId) throw new ScheduleError('BAD_JOB', `job '${id}': skill action needs skillId`);
  if (!MISSED_POLICIES.includes(onMissed)) throw new ScheduleError('BAD_JOB', `job '${id}': unknown onMissed '${onMissed}'`);
  if (trigger === timerTrigger.id || schedule) validateSchedule(schedule);
  return {
    id, name, trigger, schedule, params: { ...params }, action: { ...action },
    enabled: !!enabled, onMissed, limits: { ...limits }, approval, createdAt: createdAt || 0,
  };
}

/**
 * Dedup is on the SCHEDULED time, never the fired time — a wake-up at 09:04 for the 09:00
 * slot is the 09:00 run, and a second wake-up for that slot is a no-op. Alarms are
 * approximate and devices sleep; without this, "approximately 9" means "twice".
 */
export function occurrenceKey(jobId, at) { return `${jobId}@${at}`; }

/**
 * Which timer jobs are due, and which of those are catch-up rather than on-time.
 *
 * @param lastRun { [jobId]: ts } — the last OCCURRENCE run, not the last wake-up.
 */
export function dueJobs(jobs, { now, lastRun = {}, admit = null, max = MAX_CATCH_UP } = {}) {
  const out = [];
  for (const job of jobs || []) {
    if (!job.enabled) continue;
    if (job.trigger !== timerTrigger.id || !job.schedule) continue;
    if (admit && !admit(job)) continue;
    const since = lastRun[job.id] || job.createdAt || 0;
    if (!since) continue; // a job with no anchor cannot know what it missed
    const missed = occurrencesBetween(job.schedule, since, now, max);
    if (!missed.length) continue;
    const runs = job.onMissed === 'runAll' ? missed
      : job.onMissed === 'runOnce' ? [missed[missed.length - 1]]
        : [];
    for (const at of runs) out.push({ job, at, key: occurrenceKey(job.id, at), late: now - at > 60_000, missedCount: missed.length });
    // 'skip' still reports so the caller can advance its watermark without running anything.
    if (!runs.length) out.push({ job, at: missed[missed.length - 1], key: occurrenceKey(job.id, missed[missed.length - 1]), skipped: true, missedCount: missed.length });
  }
  return out;
}

/** The soonest any timer job wants to be woken, so a client arms ONE platform alarm. */
export function nextWakeAt(jobs, { now, lastRun = {} } = {}) {
  let soonest = null;
  for (const job of jobs || []) {
    if (!job.enabled || job.trigger !== timerTrigger.id || !job.schedule) continue;
    const at = nextFireAt(job.schedule, Math.max(now, lastRun[job.id] || 0));
    if (at !== null && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/**
 * Which jobs an event fires. Returns matches; running them is the host's business, because
 * only the host knows what a skill costs and whether the user approved it.
 */
/** More than this in one batch and the answer stops being an answer. */
export const DEFAULT_COALESCE_MAX = 8;

/**
 * Fold several triggers of the SAME job into ONE run.
 *
 * A cooldown exists because a topic a meeting keeps returning to is one thing happening, not
 * six — but for a job that ANSWERS something, dropping the second trigger drops a question
 * nobody ever answers. Reported exactly that way: thirteen questions asked in a burst, one
 * answered, the rest skipped with "fired moments ago (cooldown)" and never seen again.
 *
 * So the cooldown stops meaning "discard" and starts meaning "wait, and bring the rest with
 * you". This is the pure half: which of the queued triggers survive into the batch.
 *
 * Identity is the SPOKEN LINE, not the match. A live caption is re-emitted as it grows, so
 * the same sentence arrives several times at different lengths; keying on a normalized
 * prefix collapses those without the segment ids having to agree, and the LONGEST version
 * wins because it is the finished one.
 *
 * Over the cap the OLDEST go: a question the meeting has already moved past is worth less
 * than the one just asked, and an unbounded batch is a prompt nobody can afford.
 */
export function coalesceMatches(matches = [], { max = DEFAULT_COALESCE_MAX } = {}) {
  const rows = [];
  for (const m of matches) {
    const text = String(m?.segment?.text || m?.why || '').trim();
    if (!text) continue;
    const who = norm(m?.segment?.speaker);
    const t = m?.segment?.t || 0;
    const flat = text.toLowerCase().replace(/\s+/g, ' ');
    // Same utterance if it starts at the same moment, or — when the caption carries no
    // timestamp — if one text is a PREFIX of the other, which is precisely how a caption
    // grows. A fixed-length key cannot do this: "why is the sky" and "why is the sky blue"
    // differ inside any prefix long enough to tell two real questions apart.
    // When BOTH carry a start time that is identity on its own, and prefix matching must not
    // get a say: "question number 1" is a prefix of "question number 10", so an OR here
    // silently merges two different asks.
    const i = rows.findIndex((r) => r.who === who && (
      (t && r.t) ? r.t === t : (r.flat.startsWith(flat) || flat.startsWith(r.flat))
    ));
    if (i >= 0) {
      if (text.length > rows[i].text.length) rows[i] = { ...rows[i], match: m, text, flat };
      continue;
    }
    rows.push({ who, t, match: m, text, flat });
  }
  return rows.slice(-Math.max(1, max)).map((r) => r.match);
}

/** The lines a batch is asking about, in the order they were said. For a prompt, and for a log. */
export function matchTexts(matches = []) {
  return coalesceMatches(matches, { max: Number.MAX_SAFE_INTEGER })
    .map((m) => String(m?.segment?.text || m?.why || '').trim())
    .filter(Boolean);
}

export function jobsForEvent(jobs, event, { registry, ctx = {}, admit = null } = {}) {
  const out = [];
  for (const job of jobs || []) {
    if (!job.enabled) continue;
    if (admit && !admit(job)) continue;
    const trigger = registry?.get(job.trigger);
    if (!trigger || trigger.kind === 'timer') continue;
    if (trigger.watches.length && !trigger.watches.includes(event?.type)) continue;
    let match = null;
    try { match = trigger.matches(event, job.params, ctx); } catch { match = null; }
    // A condition that threw did not match. Firing on an unanswered question is how
    // automation does something nobody asked for.
    if (match) out.push({ job, trigger, match, key: occurrenceKey(job.id, event.at || event.t || 0) });
  }
  return out;
}
