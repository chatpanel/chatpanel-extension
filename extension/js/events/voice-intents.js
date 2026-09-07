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

import {
  defineSchema, describeSchema, responseFormat, coerce, createStructuredStream,
} from './structured.js';
// The same list meeting triggers read. "Has this person finished the thought?" must have ONE
// answer in this package — a second copy here would drift, and two features would disagree
// about the same caption on the same screen.
import { DANGLING_TAILS } from './schedule.js';

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

// The widest span of spoken tokens that may add up to a ONE-WORD wake phrase ("chat" "pan"
// "ell"). A longer phrase widens its own window — see compileWake.
const MAX_WAKE_TOKENS = 3;
// …but never without limit: the scan is O(tokens x window x phrases) over every utterance,
// and a wake phrase longer than this is a sentence, not a wake phrase.
const WAKE_TOKEN_CEILING = 8;

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
  // SEVERAL PHRASES, however they arrive. People do not say one fixed thing: "ok chatpanel",
  // "okay chat panel" and "hey chatpanel" are one intent with three spellings, and asking
  // someone to pick exactly one is asking them to remember which one they picked.
  //
  // A COMMA SEPARATES THEM — "chatpanel, siri, google" is what anyone would write, and any
  // other separator is a rule to learn. The apparent conflict ("okay, chat panel" is also how
  // you would write ONE phrase) is not a real one: matching strips punctuation from the
  // TRANSCRIPT, so a comma is never needed inside a configured phrase to hear one spoken.
  // Type "okay chat panel" and "okay, chat panel" is heard. `|`, `;` and newlines work too.
  const raw = (Array.isArray(words) ? words : String(words ?? '').split(/[,|;\n]/))
    .map((w) => String(w ?? '').trim())
    .filter(Boolean);
  const list = [];
  // The phrases AS TYPED, kept alongside the squashed forms and in the same order. The
  // squashed form is an implementation detail — "okchatpanel" is neither what the user wrote
  // nor what they would say — so any UI that echoes the setting back must have the original
  // to show. Deduped on the squashed form, keeping the first spelling of each.
  const labels = [];
  let widest = 1;
  for (const phrase of raw) {
    // Punctuation and spacing are stripped, so "ok chat panel", "ok, chat panel" and
    // "okchatpanel" compile to one and the same thing — which is what makes the setting
    // forgiving of how it was typed AND of how the transcriber spaced it.
    const squashed = phrase.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (squashed.length < 3) continue; // shorter than this and ordinary speech trips it constantly
    if (list.includes(squashed)) continue;
    list.push(squashed);
    labels.push(phrase);
    // The scan joins adjacent spoken tokens looking for the phrase, so its window has to be
    // at least as wide as the longest phrase is in WORDS — otherwise a three-word wake phrase
    // could never be found, however it was typed. +1 for a transcriber that splits one of
    // them ("chat" "pan" "ell").
    widest = Math.max(widest, phrase.split(/\s+/).filter(Boolean).length + 1);
  }
  if (!list.length) throw new VoiceIntentError('BAD_WAKE', 'wake word must have at least 3 letters');
  return Object.freeze({
    phrases: Object.freeze(list),
    labels: Object.freeze(labels),
    maxTokens: Math.min(Math.max(widest, MAX_WAKE_TOKENS), WAKE_TOKEN_CEILING),
  });
}

/**
 * How much of what follows the wake word is the command.
 *
 * THE 720-HOUR TIMER. One caption held six wake words and 420 characters, and the command was
 * "everything after the first one to the end of the line". So "Okay, chat panel. Set a timer
 * for 1 minute" swallowed four later sentences including "…research on the weather for the
 * next 30 days" — and the duration parser, scanning the whole span, found 30 days. The user
 * got a 720-hour timer from a request for one minute.
 *
 * A spoken command is a sentence, occasionally two ("Set a timer for 30 seconds. Make it
 * two."). Never a paragraph. Bounded here, and bounded again by the next wake word: a second
 * address is by definition the end of the first command.
 */
export const MAX_COMMAND_SENTENCES = 2;

/** Where every wake phrase sits in this text, in order. Shared by the singular and plural. */
function wakeHits(raw, tokens, wake) {
  const hits = [];
  const window = wake.maxTokens || MAX_WAKE_TOKENS; // an older compiled wake has no maxTokens
  for (let i = 0; i < tokens.length; i++) {
    let squashed = '';
    let matched = false;
    for (let n = 0; n < window && i + n < tokens.length && !matched; n++) {
      squashed += tokens[i + n].w.replace(/[^\p{L}\p{N}]/gu, '');
      for (const phrase of wake.phrases) {
        // A window far from the phrase's length cannot match; skip the distance work.
        if (Math.abs(squashed.length - phrase.length) > slack(phrase.length)) continue;
        if (editDistance(squashed, phrase, slack(phrase.length)) <= slack(phrase.length)) {
          hits.push({
            phrase,
            start: tokens[i].start,
            end: tokens[i + n].end,
            addressed: isAddressed(raw, tokens, i, n),
          });
          // Skip past the phrase so "chat panel" is one hit, not two overlapping ones.
          i += n;
          matched = true;
          break;
        }
      }
    }
  }
  return hits;
}

/**
 * The first `max` sentences of `text`, or all of it when it has fewer.
 *
 * A boundary is terminal punctuation followed by WHITESPACE or the end — not any full stop.
 * "Go to google.com and search" is one sentence; splitting on the dot in a domain cut a
 * command down to "Go to google." and sent that. Decimals ("2.5 minutes") and initials break
 * the same way.
 */
function firstSentences(text, max) {
  const t = String(text || '');
  if (!t) return t;
  const re = /[.!?…]+["'\u2019\u201d)\]]*(?=\s|$)/g;
  let taken = 0;
  let m;
  while (taken < max && (m = re.exec(t))) {
    taken += 1;
    if (taken === max) return t.slice(0, m.index + m[0].length);
  }
  // Fewer sentences than asked for — all of it. A trailing fragment with no terminal
  // punctuation is still what they said, and must not be silently emptied.
  return t;
}

/**
 * EVERY "<wake>, <command>" in one utterance, in order.
 *
 * A live caption often carries a whole minute of speech, and a person addressing an assistant
 * addresses it more than once in a minute. Returning only the first match meant the other
 * five requests in the same caption were invisible — and made the first command swallow them.
 */
export function findWakeCommands(text, wake = compileWake(), { maxSentences = MAX_COMMAND_SENTENCES } = {}) {
  const raw = String(text || '');
  const tokens = tokenize(raw);
  if (!tokens.length) return [];
  const hits = wakeHits(raw, tokens, wake);
  return hits.map((hit, idx) => {
    // Bounded by the NEXT address, then by sentence count. A second wake word is the end of
    // the first command however the sentences fall.
    const stop = idx + 1 < hits.length ? hits[idx + 1].start : raw.length;
    const span = raw.slice(hit.end, stop);
    const command = trimTrailingLeadIn(stripLeadIn(firstSentences(span, maxSentences)).trim());
    return {
      command,
      wake: hit.phrase,
      heard: raw.slice(hit.start, hit.end),
      at: hit.start,
      addressed: hit.addressed,
      // What was said after the command's own sentences, up to the next address. Not part of
      // the command — kept so a caller refining with a model has the surrounding words.
      rest: raw.slice(hit.end + span.indexOf(command) + command.length, stop).trim(),
    };
  });
}

/**
 * Find "<wake>, <command>" in one utterance — the first one.
 *
 * Returns the command with its ORIGINAL casing, plus which wake phrase matched and where —
 * the host logs the span so a user can see why something fired.
 */
export function findWakeCommand(text, wake = compileWake(), opts = {}) {
  return findWakeCommands(text, wake, opts)[0] || null;
}

/**
 * The REQUEST inside a spoken utterance — not everything that followed the wake word.
 *
 * People do not stop talking when they finish asking. A real capture:
 *
 *   "Okay, chat panel. Whenever I do anything or ask any question just to do a research for
 *    me and get me the answer, okay? All right, so. I want to know how is the weather in
 *    Fairview today? All right, so we will see. It does anything. Does it get added to?"
 *
 * Everything after the wake word became the job's name AND its prompt, so the job was a
 * paragraph of thinking-aloud with a weather question buried in the middle — which is what
 * "it didn't separate" means, and why the answer was useless even on the runs that happened.
 *
 * What this does, and deliberately no more: split into sentences, drop the ones that are pure
 * filler, and prefer a QUESTION when one was asked (the LAST one — people circle back, and
 * the restatement is the version they meant). Everything here is free, deterministic and
 * reversible. Turning rambling into a good PROMPT is a model's job, and the parser already
 * says so by returning `needsModel`; this is the FLOOR under that, for when no model is
 * configured and for the instant before one answers. It is a heuristic over speech and it
 * will sometimes pick the wrong sentence — that is precisely why the contract asks the host
 * to pay for a model rather than pretending this is the answer.
 */

// Sentences carrying no request — verbal punctuation, thinking aloud, or narrating the very
// experiment being run. Matched WHOLE, so "so we will see" goes and "see if the build passed"
// stays.
const FILLER_SENTENCE = new RegExp('^(?:'
  + "ok(?:ay)?|all ?right|right|so|well|um+|uh+|hmm+|yeah|yep|hey|and|but|then|now"
  + "|let(?:'s| us) see|we(?:'ll| will) see|so we(?:'ll| will) see"
  + "|i think it is doing something|it does anything|does it (?:do )?anything"
  + "|hold on(?: a second)?|one second|let me see|i think|i guess|here we go|there we go"
  + "|test(?:ing)?"
  + ')[\\s,.!?]*$', 'i');

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/**
 * True when a sentence is only filler — verbal punctuation rather than a request.
 *
 * Checked CLAUSE BY CLAUSE, because people string filler together with commas: "All right,
 * so we will see." is two fillers in one sentence and matches neither whole. Every clause
 * must be filler for the sentence to be, so "right after the demo, remind me" survives on the
 * strength of its first clause even though the second would pass alone.
 */
export function isFillerSentence(text) {
  const t = String(text || '').trim().replace(/^[\s,.:;!?-]+/, '');
  if (!t) return true;
  if (FILLER_SENTENCE.test(t)) return true;
  const clauses = t.split(',').map((c) => c.trim()).filter(Boolean);
  return clauses.length > 1 && clauses.every((c) => FILLER_SENTENCE.test(c));
}

/**
 * @returns { request, name, ambiguous } — the text to act on, a short label for it, and
 *          whether more than one question was asked (in which case `request` is everything
 *          meaningful and a model should be asked to pick). Both strings fall back to the
 *          cleaned original rather than to nothing: a command we could not parse is still a
 *          command the user gave, and dropping it silently is the worse failure.
 */
export function refineSpokenCommand(text, { maxName = 48 } = {}) {
  const raw = stripLeadIn(String(text || '')).trim();
  if (!raw) return { request: '', name: '' };
  const sentences = raw.split(SENTENCE_SPLIT).map((t) => t.trim()).filter(Boolean);
  const meaningful = sentences.filter((t) => !isFillerSentence(t));
  // ONE question is the request. SEVERAL is a guess, and this function refuses to make it.
  //
  // A real capture contained three: a standing preamble ("whenever I ask anything, research
  // it for me, okay?"), the actual request ("how is the weather in Fairview today?") and a
  // meta-question about the tool ("does it get added to?"). Last-wins picks the third,
  // longest-wins picks the first, and every other rule that fits this sample is a rule fitted
  // to this sample. Choosing between them needs to understand them — which is a model's job,
  // and exactly what `needsModel` exists to ask for. So: an unambiguous question is used, and
  // an ambiguous one is handed on WHOLE with `ambiguous` set, for the caller to refine.
  const questions = meaningful.filter((t) => /\?\s*$/.test(t));
  const ambiguous = questions.length > 1;
  const picked = questions.length === 1
    ? questions[0]
    : (meaningful.length ? meaningful.join(' ') : raw);
  const request = stripLeadIn(picked).trim() || raw;
  // The name is a label in a list, not the instruction. One line, clipped on a word boundary.
  const flat = request.replace(/\s+/g, ' ').trim();
  const name = flat.length > maxName
    ? `${flat.slice(0, maxName - 1).replace(/\s+\S*$/, '')}…`
    : flat;
  return { request, name: name || flat, ambiguous };
}

/**
 * Ask a model what was actually being asked — the other half of `needsModel`.
 *
 * The parser has always returned `needsModel: true` for a command it did not recognise, with
 * a comment saying the host "may pay for a small model to read it, and MUST NOT guess". No
 * host ever did, so an unrecognised spoken request became a job whose name and prompt were
 * both the entire utterance. refineSpokenCommand() is the free floor under this; when several
 * questions were asked it declines to choose, and THIS is what chooses.
 *
 * Deliberately a tiny, single-shot classification with a strict output shape: it runs on a
 * fast model while a meeting is happening, so it must cost about as much as one sentence.
 */
/**
 * The shape of the answer, declared ONCE.
 *
 * It used to be typed twice — as prose inside the prompt string and again as a list of enum
 * values thirty lines below in the parser — with nothing making the two agree. Adding a kind
 * to one and not the other is a silent, permanent bug: the model answers correctly and the
 * parser maps it to "question" forever. Now the prompt is rendered from this and the parser
 * coerces onto it, so there is only one place a field exists.
 */
export const REFINEMENT_SCHEMA = defineSchema({
  name: 'voice_refinement',
  fields: {
    request: {
      type: 'string', required: true, max: 400,
      describe: 'the one thing they actually want done, in their own words, one sentence',
    },
    name: { type: 'string', max: 48, describe: 'a label of at most 6 words' },
    kind: {
      type: 'enum',
      // 'action' is here because it was MISSING, and the gap was silent. A browser command
      // ("go to google.com and search for chat panel") is not something they want to KNOW, so
      // it does not read as a question — and the only other bucket that fitted a rambling,
      // narrated demo was "none", which is dropped without a word. Spoken four different ways
      // in one meeting, it did nothing every time while the timer beside it worked.
      values: ['question', 'action', 'monitor', 'note', 'skill', 'timer', 'none'],
      // An unknown kind becomes a QUESTION — the least surprising thing to do with something
      // someone asked for, and the only kind that is undone by ignoring the answer. Guessing
      // "monitor" instead would leave a card watching the meeting that nobody asked for.
      default: 'question',
      describe: 'the SMALLEST kind that does what they asked',
    },
    skill: { type: 'string', max: 80, describe: 'the skill name, only when kind is skill' },
  },
  // "none" is a real answer and the most important one to honour: it is how the model says
  // "they were just talking", which is the case that produced junk jobs. It arrives two ways —
  // as the whole reply, and as the value of `request` — and both are this.
  nothing: { request: '', name: '', kind: 'none', skill: '' },
});

export function refinementPrompt(utterance) {
  return [
    'A person spoke to their assistant during a meeting. Below is everything they said after',
    'the wake word, transcribed live — so it contains false starts, thinking aloud, and',
    'sometimes several questions where only one is the request.',
    '',
    describeSchema(REFINEMENT_SCHEMA),
    '',
    'Pick the SMALLEST kind that does what they asked:',
    '  question — answer it once, now. The DEFAULT for anything they want to know.',
    '  action   — DO something in the browser or an app ("go to google.com and search for X").',
    '  monitor  — only if they asked to be told as the meeting CONTINUES ("let me know if",',
    '             "keep an eye on"). A one-off question is NOT a monitor.',
    '  note     — they asked for notes written down ("take notes on", "write that up").',
    '  skill    — they named a saved skill ("use the summarize skill"); put its name in `skill`.',
    '  timer    — alerted after an AMOUNT OF TIME ("set a one minute"); keep it in `request`.',
    '  none     — not asking for anything: thinking aloud, or talking ABOUT the assistant.',
    'Never invent a request that is not there — return "none". Keep `request` close to their',
    'words; do not answer it.',
    '',
    'WHAT THEY SAID:',
    String(utterance || ''),
  ].join('\n');
}

/**
 * The body fragment that makes a capable endpoint enforce the shape server-side.
 * Null for an agent CLI, which has no such control — the prompt and the repair pass carry it.
 */
export function refinementFormat(mode = 'schema') { return responseFormat(REFINEMENT_SCHEMA, { mode }); }

/**
 * Read the model's answer back, defensively.
 *
 * Everything generic — code fences, a prose preamble, single quotes, a trailing comma, the
 * word "none" in place of an object, a key spelled `Request` — is handled by the shared
 * coercer, which means every OTHER structured call in the product gets those repairs too.
 * What stays here is only what is true of THIS answer and no other.
 *
 * Returns null for anything unusable, so the caller falls back to the deterministic pass
 * rather than acting on a hallucinated request.
 */
export function parseRefinement(text) {
  const got = coerce(text, REFINEMENT_SCHEMA);
  if (!got) return null;
  return settleRefinement(got.value);
}

/**
 * The two rules that are about voice commands rather than about JSON.
 *
 * Shared with the streaming reader below, because a rule applied on the final answer and not
 * on the partial one is a rule the user watches the UI break. Exported because a caller that
 * fetches the answer through the generic structured-call capability gets the raw coerced
 * object and still needs these — the rules must not live only inside one of two paths.
 */
export function settleRefinement(v) {
  if (!v) return null;
  const request = String(v.request || '').trim();
  if (v.kind === 'none' || !request) return { request: '', name: '', kind: 'none', skill: '' };
  // A "skill" with no name is a question — there is nothing to run.
  let kind = v.kind === 'skill' && !v.skill ? 'question' : v.kind;
  const name = String(v.name || '').trim() || request;
  // A TIMER IS RESOLVED HERE, not by whatever runs the request.
  //
  // A spoken timer the grammar missed used to arrive as a plain question, so it went to the
  // chat — where an agent answered it by running `sleep 60` in its own sandbox and saying it
  // would notify. It cannot: nothing connects that process back to the user. Reading the
  // duration here turns it back into a job the product itself owns and can fire.
  //
  // No duration means the model called it a timer without one, and a timer with no duration
  // is a question about time. Downgraded rather than dropped.
  if (kind === 'timer') {
    const d = parseDuration(request);
    if (!d) return { request, name, kind: 'question', skill: '' };
    return { request, name, kind: 'timer', skill: '', ms: d.ms };
  }
  return { request, name, kind, skill: v.skill || '' };
}

/**
 * Did the user's own spoken words name this host?
 *
 * The authority test for a hands-free browser command. A URL a MODEL picked is
 * attacker-influenced by construction — it has been reading page text and meeting captions —
 * so it gets a confirmation dialog. A URL whose host the USER said out loud has already been
 * reviewed by the only person that dialog would have asked, and a modal in a side panel is
 * exactly what nobody in a meeting is looking at: "go to google.com and search for chat
 * panel" was spoken four ways in one call and did nothing every time.
 *
 * Deliberately strict. The full hostname always counts ("google.com"). The bare first label
 * counts ONLY for a two-label host, so saying "docs" can never authorise `docs.evil.test` —
 * anything deeper has to be said in full.
 *
 * Shared rather than written in the panel because it is a pure decision with no platform in
 * it: the bridge relays the same page tools, and a second copy of an authority rule is a
 * second answer to "may this happen".
 */
export function spokenNamesHost(url, spoken) {
  const said = String(spoken || '').toLowerCase();
  if (!said) return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  if (!host) return false;
  if (said.includes(host)) return true;
  const labels = host.split('.');
  if (labels.length !== 2) return false;
  return new RegExp(`\\b${labels[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(said);
}

/**
 * The same answer, AS IT ARRIVES.
 *
 * A refinement is asked for mid-meeting while someone is waiting to see whether they were
 * heard, and the standing rule is that every model output streams with visible progress. The
 * `settled` set is what makes that safe: `request` can be shown growing, and `kind` — which
 * decides whether a monitor gets created — is only acted on once the model has closed it.
 *
 *     const s = refinementStream({ onChange: (v, settled) => paint(v, settled) });
 *     await stream({ …, onDelta: (d) => s.push(d) });
 *     const final = s.end().value;   // already settled, or null
 */
export function refinementStream({ onChange = null } = {}) {
  const inner = createStructuredStream(REFINEMENT_SCHEMA, {
    onChange: onChange ? (v, settled) => onChange(settleRefinement(v), settled) : null,
  });
  const wrap = (snap) => ({ ...snap, value: settleRefinement(snap.value) });
  return {
    push: (chunk) => wrap(inner.push(chunk)),
    end: () => wrap(inner.end()),
    snapshot: () => wrap(inner.snapshot()),
    reset: () => inner.reset(),
    get text() { return inner.text; },
  };
}

/**
 * Was the assistant SPOKEN TO, or merely spoken about?
 *
 * "we should talk about the chat panel roadmap next week" contains the wake word and is not a
 * command — acting on it is how ordinary conversation quietly set timers. But "Okay, chat
 * panel. Anytime I ask a question…" is unmistakably addressed, and dropping it is why a
 * clearly-spoken request did nothing at all.
 *
 * The signal that separates them is grammatical and cheap: a wake word used as a NOUN is
 * introduced by a determiner or preposition ("the chat panel", "about ChatPanel", "our chat
 * panel"). A wake word used as a VOCATIVE is at the start of what is being said, or follows
 * an address word ("okay", "hey", "hi"), or follows the end of the previous sentence.
 *
 * Wrong sometimes, in both directions — which is exactly why it decides whether to ASK
 * (needsModel, a visible and reversible monitor) rather than whether to act.
 */
const NOUN_MARKERS = /^(?:the|a|an|our|your|their|my|this|that|these|those|about|on|in|of|with|via|using|called|named|to)$/i;

// Adverbs that sit between a subject and its verb — "chat panel ACTUALLY helps us".
const SUBJECT_ADVERBS = /^(?:actually|really|also|always|never|just|only|still|often|usually|basically|literally|probably|certainly|definitely|now|then|even|apparently|obviously)$/i;
// Verb forms that make whatever comes before them the SUBJECT of a claim rather than the
// person being spoken to. A closed list on purpose: the general rule ("any third-person verb")
// cannot be told from an imperative without a parser, and guessing wrong here costs a command.
const SUBJECT_VERBS = /^(?:is|isn't|was|wasn't|are|aren't|were|weren't|has|hasn't|have|had|does|doesn't|did|didn't|can|can't|cannot|could|couldn't|will|won't|would|wouldn't|should|shouldn't|shall|may|might|must|seems|helps|lets|gives|allows|works|looks|means|needs|wants|keeps|makes|shows|tells|comes|goes|takes|runs|becomes|provides|supports)$/i;
// …unless a pronoun follows, which turns the same auxiliary into a question aimed at us:
// "chatpanel, can YOU set a timer" against "chat panel can help us".
const QUESTION_PRONOUNS = /^(?:you|we|i|they|it|there|he|she)$/i;

const bare = (t) => String(t?.w || '').replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Is the wake phrase the SUBJECT of the sentence rather than the person being addressed?
 *
 * "…what chat panel actually helps us to monitor" is a sentence ABOUT the product, and it
 * fired a request. Nothing in the words before the name says so — the giveaway is what comes
 * after it: a vocative is followed by a comma, an imperative or a question word, while a
 * subject is followed by its verb.
 */
function readsAsSubject(raw, tokens, endIdx) {
  const next = tokens[endIdx + 1];
  if (!next) return false; // nothing after the name at all — not a claim about it
  // Punctuation between the name and what follows is the vocative comma (or a sentence
  // break). Either way the name stands alone, which subjects do not do.
  if (/[.!?,;:–—-]/.test(raw.slice(tokens[endIdx].end, next.start))) return false;
  let j = endIdx + 1;
  if (SUBJECT_ADVERBS.test(bare(tokens[j])) && tokens[j + 1]) j += 1;
  if (!SUBJECT_VERBS.test(bare(tokens[j]))) return false;
  return !QUESTION_PRONOUNS.test(bare(tokens[j + 1]));
}

function isAddressed(raw, tokens, i, n = 0) {
  // The fuzzy match is generous enough to SWALLOW a leading article: "a chat panel" squashes
  // to "achatpanel", one edit from "chatpanel", so the determiner ends up inside the matched
  // span instead of before it. Check the first matched token too, or "a chat panel would be
  // useful here" reads as an address purely because the "a" was absorbed.
  if (n > 0 && NOUN_MARKERS.test(String(tokens[i].w || '').replace(/[^\p{L}\p{N}]/gu, ''))) return false;
  // Whatever came before it, a name followed by its own verb is being TALKED ABOUT.
  if (readsAsSubject(raw, tokens, i + n)) return false;
  if (i === 0) return true; // nothing before it — it opens the utterance
  const prev = tokens[i - 1];
  const word = String(prev.w || '').replace(/[^\p{L}\p{N}]/gu, '');
  if (NOUN_MARKERS.test(word)) return false; // "the chat panel" — a thing, not a listener
  // "hey chatpanel", "ok chatpanel" — an address word is how people open one.
  if (/^(?:ok|okay|hey|hi|yo|hello|so|um|uh)$/i.test(word)) return true;
  // Punctuation before it is the vocative comma or a sentence break — "…here. Okay, chat
  // panel", "so I was thinking. ChatPanel, what did we decide?" — and both mean a fresh
  // address rather than a continuing noun phrase. Measured from the previous token's START,
  // because the tokenizer keeps trailing punctuation ON the token ("thinking."), so the gap
  // between tokens is only the space and the full stop would be missed.
  const gap = raw.slice(prev.start, tokens[i].start);
  if (!/[.!?,;:]["'’”)\]]*\s*$/.test(gap)) return false;
  // …but ONLY a break the speaker actually made. The transcriber invents full stops, and it
  // invents them mid-clause: "…another round of testing to see what. Chat panel actually
  // helps us to monitor" is one sentence about the product, cut in half by a machine, and the
  // half-stop made the second half read as a fresh address. A break is only a break when the
  // words before it are a finished thought — the same test that decides when a command has
  // stopped growing, for exactly the same reason.
  return !/[.!?…]/.test(gap) || commandLooksFinished(raw.slice(0, prev.end));
}

/**
 * Drop the NEXT address's run-up from the end of this command.
 *
 * A command is bounded by where the next wake phrase starts — but people open an address with
 * a word or two before the name ("…Okay, chat panel."), and those land on the end of the
 * previous command. Harmless to read, ruinous to identity: as the caption grows, "start
 * monitoring the pricing question." becomes "…pricing question. Okay", which is different
 * words, a different key, and therefore the same request acted on twice.
 *
 * Only the address words are trimmed, and only from the end — the same short list that marks
 * an opening in isAddressed().
 */
function trimTrailingLeadIn(text) {
  return String(text)
    .replace(/(?:[\s,.:;!?-]*\b(?:ok|okay|hey|hi|yo|hello|so|um+|uh+|and|then|now)\b)+[\s,.:;!?-]*$/i, '')
    .trim();
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
  // THE TWO-MINUTE ONE-MINUTE TIMER. The article used to set the count to 1 outright, and
  // everything after it ADDS — so "set a one minute timer", which is how most people say it,
  // came out as 1 + 1 = two minutes. Reported as "I asked for a 1-minute timer, it didn't
  // work": it worked, twice as long, which looks exactly like not working.
  //
  // The article is now only a count when nothing else supplies one. "A minute" is still a
  // minute; "a one minute" is one minute, not two.
  let article = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'and' || w === 'of') continue; // "two AND a half", "a quarter OF an hour"
    // "an hour" is one hour. "A quarter of an hour" is a quarter, and "two and A half" is
    // 2.5 — in both of those the article belongs to the fraction, not to the count.
    if (w === 'a' || w === 'an') {
      if (total === null && !(words[i + 1] in FRACTION)) article = true;
      continue;
    }
    if (w in FRACTION) { total = (total ?? 0) + FRACTION[w]; continue; }
    if (w in SMALL) { total = (total ?? 0) + SMALL[w]; continue; }
    if (w in TENS) { total = (total ?? 0) + TENS[w]; continue; }
    if (/^\d+(?:\.\d+)?$/.test(w)) { total = (total ?? 0) + Number(w); continue; }
    return null;
  }
  return total ?? (article ? 1 : null);
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
    const d = parseDuration(command);
    if (!d) return null;
    // THE MISSING HEAD NOUN. "Okay ChatPanel, set a 1-minute timer" reached the scanner as
    // "set a one minute." — the word this pattern was keyed on was still being said. With no
    // intent it went to the model, which answered a spoken timer by running `sleep 60` in a
    // sandbox and promising a notification it had no way to deliver.
    //
    // So a SET verb whose only content is a duration is a timer: nothing else is ever said
    // that way. Anything left over after the duration and the plumbing words means it is
    // something else — "set a 5 minute meeting" is a meeting — and still needs the noun.
    if (!/\btimers?\b/i.test(command)) {
      if (!/^(?:set|start|make|create|put)\b/i.test(command.trim())) return null;
      const rest = (command.slice(0, d.start) + ' ' + command.slice(d.end))
        .replace(/\b(set|start|make|create|put|a|an|the|for|please|to|of|and|half|quarter|this|that|time|up|on|me)\b/gi, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, '');
      if (rest) return null;
    }
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
    // "Take THE NOTES of whatever we spoke so far" — the plural, the definite article and
    // "of" instead of "that" were all misses, so the request went to the model, which spent
    // four tool calls hunting for a transcript before writing anything.
    const m = /^(?:(?:take|make|write|jot|add)\s+(?:down\s+)?(?:a\s+|the\s+|some\s+)?notes?|(?:write|jot)\s+down|notes?)\b[\s:,-]*(?:down\s+)?(?:that\s+|of\s+|on\s+|about\s+|from\s+)?(.+)$/i.exec(command.trim());
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
    // "Start a live monitor about…" is how it was asked for in the very demo of the feature,
    // and it matched nothing: every pattern here began at the verb, so the noun form —
    // start/set up a monitor — fell through to the model and no card was ever created.
    const m = /^(?:(?:start|set\s+up|create|begin|add|open|run)\s+(?:a\s+|the\s+|an\s+)?(?:live\s+|new\s+)?(?:monitor|monitoring|watch|tracker)|watch\s+(?:out\s+)?for|watch|keep\s+an\s+eye\s+on|track|monitor|monitoring)\b[\s:,-]*(?:whether\s+|if\s+|for\s+|on\s+|about\s+|that\s+)?(.+)$/i.exec(command.trim());
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
  return { ...parsed, wake: found.wake, heard: found.heard, at: found.at, addressed: found.addressed !== false };
}

// ---------------------------------------------------------------------------
// Transcript → commands
// ---------------------------------------------------------------------------

/**
 * Has the speaker finished the thought? — and PUNCTUATION IS NOT THE EVIDENCE.
 *
 * This used to be `endsSentence`: a full stop at the end of the caption meant the speaker had
 * stopped. Live caption engines punctuate as they go, and they punctuate FRAGMENTS. One
 * capture of this feature in use produced, in order: "Take.", "Take the question and ask
 * the.", "set a timer for.", "let's summar." — four full stops nobody uttered, and four
 * half-sentences sent to a model as requests while the speaker was still saying the rest.
 *
 * So the full stop is thrown away and the LAST WORD is read instead. A command ending on a
 * preposition, an article, a conjunction or an auxiliary ("…ask the", "…a timer for") is
 * someone mid-thought, however the transcriber punctuated it.
 *
 * A HINT, NOT A VERDICT. "Tell me what that is" is a real request that ends on 'is', so a
 * dangling tail must never DISCARD a command — it only makes the gate below wait longer for
 * the rest to arrive. A command that is never acted on is the worse failure of the two.
 */
// Words that can end a sentence grammatically but in speech mean the qualifier is still being
// chosen — "summarize the last 30 seconds, like, maybe…".
const TRAILING_HEDGES = new Set(['maybe', 'perhaps', 'probably', 'basically', 'roughly', 'kinda', 'sorta']);

export function commandLooksFinished(text) {
  const t = String(text || '').trim().replace(/[\s.,;:!?…'"’”)\]-]+$/u, '');
  if (!t) return false;
  const tokens = t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const last = tokens[tokens.length - 1];
  if (!last) return false;
  return !DANGLING_TAILS.has(last) && !TRAILING_HEDGES.has(last);
}

// Terminal punctuation. Worth almost nothing on its own — see above — but it is the only
// signal a caller with no gate has, so the ungated path keeps asking for it ON TOP of the
// tail test rather than getting looser than it was.
const endsSentence = (text) => /[.!?…]["'’”)\]]*\s*$/.test(String(text || '').trim());

/**
 * The SHORTEST span that parses wins.
 *
 * "Set a timer for 30 seconds. And then that should actually set a timer for 30 seconds."
 * is one request said twice, and the duration parser sums what it finds across the span —
 * so a two-sentence window turned 30 seconds into 60 and produced a one-minute timer nobody
 * asked for. Worse, it moved: as the caption grew, the same words re-parsed to a different
 * duration, which is a different dedupe key, which is another timer. That is the "why is it
 * creating timers again and again" report.
 *
 * So the first sentence is tried alone, and the wider span only when it yields nothing. A
 * request that genuinely needs two ("Set a timer. Make it five minutes.") still gets them.
 */
function parseShortest(command, intents, now) {
  const first = firstSentences(command, 1).trim();
  if (first && first !== command) {
    const narrow = intents.parse(first, { now });
    if (narrow?.intent) return narrow;
  }
  return intents.parse(command, { now });
}

/**
 * A command's words, reduced to what survives re-transcription.
 *
 * Case and spacing vary between flushes of the same sentence, and punctuation appears and
 * disappears as the engine revises — so none of them may be part of an identity that is
 * supposed to say "you have already done this".
 */
export const gistText = (text) => String(text || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);

/**
 * The OPENING of a request — a looser identity than its full words.
 *
 * A transcriber does not only append; it REVISES. "How is the weather in Seattle, Washington
 * now?" became "How is the weather in Seattle, Washington?" on a later flush — different
 * words, a different key, and the same question asked twice. The first few words are what a
 * revision leaves alone.
 *
 * Six is chosen against the failure it exists to stop: long enough that two genuinely
 * different requests rarely share an opening, short enough to survive the tail being rewritten.
 */
export const OPENING_WORDS = 6;
export const gistOpening = (text) => gistText(text).split(' ').slice(0, OPENING_WORDS).join(' ');

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
  sinceTs = 0, now = Date.now(), meetingId = '', max = MAX_COMMANDS_PER_DELTA, gate = null,
} = {}) {
  const out = [];
  for (const seg of segments || []) {
    if (!seg || !seg.text) continue;
    if (seg.t && seg.t <= sinceTs) continue;
    // EVERY address in this caption, not just the first. A live caption carries a minute of
    // speech, and a person addressing an assistant addresses it more than once in a minute —
    // "…set a timer for 1 minute. Okay chat panel, go and search…" is two commands. Taking
    // only the first also made that first command swallow the rest, which is how a one-minute
    // timer became 720 hours: the duration parser found "30 days" four sentences later.
    for (const found of findWakeCommands(seg.text, wake)) {
    if (!found.command) continue; // a bare mention with nothing after it
    const intent = parseShortest(found.command, intents, now);
    // `rest` rides along: the deterministic intents parse only the tight span (that is what
    // stops a duration being found four sentences away), but a MODEL asked to read an
    // unrecognised request should see the words around it — the question often follows a
    // sentence of preamble. Parse narrow, refine wide.
    const parsed = intent && {
      ...intent, wake: found.wake, heard: found.heard, at: found.at,
      addressed: found.addressed, rest: found.rest,
    };
    if (!parsed) continue;
    // MENTIONED vs ADDRESSED — and this guard used to conflate them.
    //
    // parseCommand returns a shape for anything carrying the wake word, intent or not, so
    // "we should talk about the chat panel roadmap next week" came back as a command and the
    // caller acted on it: ordinary conversation quietly setting timers. Dropping every
    // intentless utterance fixed that, and broke the opposite case just as badly — "Okay,
    // chat panel. How is the weather in Lakeside?" is unmistakably a request, matches no
    // built-in intent (there is no weather intent, and there should not be), and was
    // discarded here. Nothing downstream ever saw it, which is why `needsModel` had no
    // handler: it could not reach one.
    //
    // So the test is whether the assistant was SPOKEN TO. A passing mention still stops here.
    // An address with no matching intent goes on with needsModel set, for a model to read —
    // which is what the parser has always said should happen.
    //
    if (!parsed.intent && !parsed.addressed) continue;
    // Does this read as a whole thought? Computed once, where the command's own words are:
    // the guard below and the gate must never be able to answer that differently.
    const finished = commandLooksFinished(found.command);
    // WHETHER THE SENTENCE HAS ENDED IS NOT DECIDED HERE — when there is a gate.
    //
    // It used to be decided here, on the caption's terminal punctuation, and that is exactly
    // what sent "Take the question and ask the." to a model as a request. This function sees
    // ONE delivery of a caption; only something watching the same utterance across
    // deliveries can tell a finished sentence from a punctuated fragment, and that is the
    // gate below (`finished` is the hint it reads).
    //
    // A caller with no gate has no such thing, so it keeps the old conservative rule and
    // gains the tail test on top of it: both, or the request waits for the next delivery.
    // Getting LOOSER than the code being fixed would be a strange way to fix it.
    if (!parsed.intent && !gate && !(finished && endsSentence(seg.text))) continue;
    const allowed = isSelf ? !!isSelf(seg.speaker) : false;
    out.push({
      ...parsed,
      allowed,
      // Carried, so the gate reads the same answer this scan did.
      finished,
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
      // IDENTITY, NOT FRESHNESS. `seg.t` is bumped every time a live caption's text grows —
      // that is what keeps the line flowing through the delta filter — so keying on it made
      // one spoken request look like a new request on every update, and a single "set a timer
      // for 30 seconds" became a screenful of timers. `sid` is assigned once per utterance and
      // never moves, so the same sentence keeps one key however many times it is rescanned.
      // WHAT WAS ASKED, not which delivery of it carried the words.
      //
      // This used to key on the caption's identity (`sid`) and the wake word's offset. Both
      // move: `sid` is re-minted whenever the caption engine loses the overlap between a
      // growing line and the one before it, and a monologue keeps ONE entry alive for
      // minutes — re-scanned on every flush, by design, so a half-heard command gets a
      // second chance. So one spoken "set a timer for 30 seconds" kept arriving as a
      // brand-new command and kept creating timers.
      //
      // The words are what does not move. Two different commands in one breath still differ;
      // the same command through fifty flushes is one request.
      // The OPENING, not the whole sentence: a live caption keeps growing ("…10 seconds",
      // then "…10 seconds and then", then "…and then we moved on"), and gistText over the
      // full text moves with every one of those — which is the very bug this key exists to
      // stop, just later in the sentence. The intent and its resolved duration are already
      // in the key, so two genuinely different commands still differ.
      key: `voice:${meetingId}:${parsed.intent || 'ask'}:${parsed.ms ?? parsed.when ?? ''}:${gistOpening(found.command)}`,
    });
    }
  }
  // THE NEWEST, not the first.
  //
  // The cap exists so a pathological transcript cannot fire fifty actions, and it used to
  // stop scanning once it had `max` — counting from the START of the caption. A caption entry
  // in a monologue lives for minutes and is re-scanned on every flush, accumulating every
  // address spoken into it, so the first three (long since acted on) consumed the whole
  // budget and everything said AFTER them was never returned at all. The request you just
  // made was the one thrown away.
  //
  // The newest are both the most likely to be fresh and the ones a person is waiting on, so
  // the cap keeps those. The already-acted ones are dropped downstream by the dedupe anyway.
  const found = out.length > max ? out.slice(-max) : out;
  // WITH A GATE, nothing is returned until the words stop moving — see createUtteranceGate.
  // Without one the old behaviour stands, so a host that has not adopted it (or a test asking
  // what the grammar sees) is unchanged.
  return gate ? gate.offer(found, now).due(now) : found;
}

// ---------------------------------------------------------------------------
// One utterance, one action
// ---------------------------------------------------------------------------

/**
 * How long a command's words must stop changing before it is acted on.
 *
 * LONGER THAN THE CAPTURE'S FLUSH INTERVAL, and that is the whole calculation. Captions reach
 * a client in batches — the extension debounces its flush by 4s — so "these words have not
 * changed for 1s" says nothing except that no batch arrived in the last second. Only a wait
 * that outlasts a flush can distinguish "they stopped talking" from "we have not been told
 * what they said next".
 */
export const UTTERANCE_SETTLE_MS = 5_000;

/**
 * How long a command that ends MID-THOUGHT waits instead.
 *
 * "Set a timer for" is not a request yet; the duration is in the breath after it. Waiting the
 * ordinary window and acting on it is exactly the bug this file exists to stop. But the tail
 * test is a word list, not grammar, and "tell me what that is" ends on 'is' — so a dangling
 * command is DELAYED, never dropped. If the speaker really did stop there, it still runs.
 */
export const UTTERANCE_DANGLING_MS = 12_000;

// How long an utterance is remembered after it was last heard. A caption entry in a monologue
// is re-delivered for minutes, and every one of those redeliveries has to find the record
// saying "this one is done" — that record IS the one-utterance-one-action guarantee.
const UTTERANCE_FORGET_MS = 3 * 60_000;
// A cap, because a long meeting must not grow this without bound. Small: only utterances
// still in flight or recently acted on matter, and the caller has its own longer-lived record
// of what has been done.
const UTTERANCE_TRACKED_MAX = 24;

/**
 * Is this the same spoken request as that one, a moment later?
 *
 * Two relations, because a transcriber does both. It APPENDS — "let's summar" becomes "let's
 * summarize the notes" — which is a prefix. And it REVISES — "…in Seattle, Washington now?"
 * came back as "…in Seattle, Washington?" — which is not, but keeps the opening.
 */
export function sameUtterance(a, b) {
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  const oa = a.split(' ').slice(0, OPENING_WORDS);
  const ob = b.split(' ').slice(0, OPENING_WORDS);
  // A short opening is not enough evidence: "set a timer" opens half the commands ever
  // spoken, and collapsing two of them into one utterance loses the second silently.
  return oa.length >= OPENING_WORDS && oa.join(' ') === ob.join(' ');
}

/**
 * The thing that makes a growing caption ONE request.
 *
 * THE BUG THIS IS. A live caption is re-delivered as it grows, and every delivery was acted
 * on the moment it parsed. So a single spoken "Okay ChatPanel, set a timer for 30 seconds"
 * arrived first as "set a timer for." — no duration, no intent, addressed, punctuated by the
 * transcriber — and went to the model as a QUESTION; then, seconds later, arrived whole and
 * became a TIMER. One thing said, two things done, and the user reasonably reported it as
 * "it set the timer but it also sent a message". Nothing downstream could relate the two:
 * they had different words, different intents, and therefore different dedupe keys.
 *
 * They can only be related by watching them, so this is the one stateful thing in the file —
 * and it is still clock-free (`now` is passed in, like everywhere else) and platform-free.
 * The host owns exactly two things: keeping the object, and calling back when the wait is up.
 *
 *     const gate = createUtteranceGate();
 *     const ready = commandsFromSegments(segments, { …, gate });   // offers and drains
 *     const later = gate.nextDueIn();      // ms until something becomes actionable, or null
 *     …setTimeout(() => act(gate.due()), later)                     // silence needs a nudge
 *
 * Note what does NOT come out of `due()`: an utterance that already fired. It stays in the
 * gate, matching its own redeliveries, so the completed version of a request that was already
 * acted on cannot act again as something else.
 */
export function createUtteranceGate({
  settleMs = UTTERANCE_SETTLE_MS,
  danglingMs = UTTERANCE_DANGLING_MS,
  forgetMs = UTTERANCE_FORGET_MS,
  max = UTTERANCE_TRACKED_MAX,
} = {}) {
  let live = [];
  const waitFor = (e) => (e.command.finished === false ? danglingMs : settleMs);
  const find = (command, gist) => live.find(
    (e) => e.meetingId === (command.meetingId || '') && sameUtterance(e.gist, gist),
  );
  return {
    /** Offer this delta's commands. Chainable, so a scan reads as one expression. */
    offer(commands, now = Date.now()) {
      for (const command of commands || []) {
        const gist = gistText(command.command);
        if (!gist) continue;
        const entry = find(command, gist);
        if (!entry) {
          live.push({ meetingId: command.meetingId || '', gist, command, changedAt: now, seenAt: now, done: false });
          continue;
        }
        entry.seenAt = now;
        if (entry.done) continue; // said once, done once — however many more words arrive
        if (gist === entry.gist) continue; // unchanged: the clock keeps running, untouched
        // Still growing (or being revised). The newest wording is the one to act on, and the
        // wait starts again from here — which is what makes a pause, not a full stop, the
        // signal that someone has finished.
        entry.gist = gist;
        entry.command = command;
        entry.changedAt = now;
      }
      live = live.filter((e) => now - e.seenAt <= forgetMs);
      if (live.length > max) live = live.slice(-max);
      return this;
    },
    /** The commands whose words have stopped moving. Each is returned exactly once. */
    due(now = Date.now()) {
      const out = [];
      for (const e of live) {
        if (e.done || now - e.changedAt < waitFor(e)) continue;
        e.done = true;
        out.push(e.command);
      }
      return out;
    },
    /**
     * ms until the earliest waiting command becomes actionable, or null when none is waiting.
     * The host needs this because silence produces no deltas to re-scan on: the last thing
     * said before someone stops talking is exactly the thing they are waiting to see happen.
     */
    nextDueIn(now = Date.now()) {
      let soonest = null;
      for (const e of live) {
        if (e.done) continue;
        const left = Math.max(0, waitFor(e) - (now - e.changedAt));
        if (soonest === null || left < soonest) soonest = left;
      }
      return soonest;
    },
    /** How many utterances are still waiting — for tests and for a diagnostics line. */
    get waiting() { return live.filter((e) => !e.done).length; },
  };
}
