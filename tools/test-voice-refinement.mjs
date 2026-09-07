// `needsModel` was returned by the parser and handled NOWHERE.
//
// The intent parser has always answered an unrecognised command with `needsModel: true`, and
// its own comment says the host "may pay for a small model to read it, and MUST NOT guess".
// No host ever did — the dispatcher turned it into reason:'not-understood' — so an
// unrecognised spoken request became a job whose name AND prompt were the entire utterance,
// preamble and thinking-aloud included.
//
// Two halves now exist: the free deterministic pass (refineSpokenCommand, which declines when
// several questions were asked), and this — a model reading the ambiguous case, on the
// MONITOR's model, because it runs mid-meeting and must cost about as much as one sentence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { refinementPrompt, parseRefinement } = await import('../extension/js/events/voice-intents.js');

// ── the prompt asks for one thing, in a shape that can be parsed ─────────────────
{
  const p = refinementPrompt('okay so, how is the weather in Fairview? does it get added?');
  assert.match(p, /Return ONLY a JSON object/, 'strict output or the parse is a guess');
  assert.match(p, /"request"/);
  assert.match(p, /"kind"/);
  assert.match(p, /weather in Fairview/, 'the utterance must actually be in the prompt');
  assert.match(p, /do not answer it/, 'this is extraction, not the turn');
  assert.match(p, /Never invent a request that is not there/, 'the failure mode is a confident hallucination');
  // Five kinds to describe rather than three, so it grew — but it must stay a classification,
  // not a briefing. This runs on the fast model while people are still talking.
  assert.ok(p.length < 1600, `the prompt is ${p.length} chars — this runs mid-meeting`);
  for (const kind of ['question', 'monitor', 'note', 'skill', 'none']) {
    assert.ok(p.includes(kind), `the model must be told about "${kind}"`);
  }
  assert.match(p, /A one-off question is NOT a monitor/,
    'everything became a monitor — that is the sentence that stops it');
}

// ── the parse is defensive, because a model's JSON often is not ──────────────────
{
  const good = parseRefinement('{"request":"how is the weather in Fairview","name":"Fairview weather","kind":"question"}');
  assert.equal(good.request, 'how is the weather in Fairview');
  assert.equal(good.name, 'Fairview weather');
  assert.equal(good.kind, 'question');
  // Code fences are common enough to handle rather than punish.
  assert.equal(parseRefinement('```json\n{"request":"x","kind":"question"}\n```').request, 'x');
  // Prose around the object.
  assert.equal(parseRefinement('Sure! {"request":"x","kind":"monitor"} hope that helps').kind, 'monitor');
  // A name is a label; a model that returns a paragraph gets clipped.
  assert.ok(parseRefinement(`{"request":"x","name":"${'y'.repeat(200)}","kind":"question"}`).name.length <= 48);
  // Missing name falls back to the request rather than to nothing.
  assert.equal(parseRefinement('{"request":"call Alex","kind":"question"}').name, 'call Alex');
  // An unknown kind is treated as a question, not dropped.
  assert.equal(parseRefinement('{"request":"x","kind":"banana"}').kind, 'question');
}
// "none" is a real answer and the most important one to honour: it is how the model says
// "they were just talking", which is the case that produced junk jobs.
{
  const none = parseRefinement('{"request":"","kind":"none"}');
  assert.equal(none.kind, 'none');
  assert.equal(none.request, '');
  assert.equal(parseRefinement('{"request":"something","kind":"none"}').kind, 'none', 'kind none wins over a request');
}
// Anything unusable → null, so the caller falls back to the deterministic reading rather
// than acting on a hallucination.
for (const bad of ['', 'no json here', '{', '{"nope":1}', null, undefined, '[]', '{"request":"   "}']) {
  const r = parseRefinement(bad);
  assert.ok(r === null || r.kind === 'none', `${JSON.stringify(bad)} must not become a request`);
}

// ── the dispatcher finally has somewhere to send it ──────────────────────────────
const vc = readFileSync(new URL('../extension/js/voice-commands.js', import.meta.url), 'utf8');
assert.match(vc, /fallback\(fn\) \{ onUnrecognised = fn;/, 'an unrecognised command needs a destination');
assert.match(
  vc, /if \(!fn && command\.needsModel && onUnrecognised\)/,
  'the fallback fires on needsModel specifically — not on every unbound intent',
);
assert.match(
  vc, /reason: 'not-a-request'/,
  'a fallback that DECLINES is not a failure — reporting it as one would toast at the user '
  + 'every time they finished a sentence near the wake word',
);

// ── and the panel binds it, on the fast model, falling back rather than losing it ─
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
assert.match(panel, /actions\.fallback\(async \(cmd\) => \{/, 'the panel must bind the fallback');
// The model is ALWAYS asked when one is configured. The free pass can extract a request but
// has no idea what KIND it is — it always says "question" — so "use the skill summarize" and
// "take notes on what we discussed" both became questions and neither ever happened.
// Choosing between ask / watch / write / run is the whole job of the classification.
assert.match(panel, /let refined = await refineSpokenWithModel\(/,
  'the classification must run for every unrecognised request, not only ambiguous ones');
assert.match(panel, /spoken\.ambiguous \? spoken\.request : wide/,
  'and it reads the trimmed request when several questions were asked, the wide text otherwise');
assert.match(panel, /if \(refined\.kind === 'none'\) return null;/, 'the model may say "they were just talking"');
assert.match(panel, /if \(!refined\) refined = \{ request: spoken\.request/,
  'no model, a refusal or a failure must fall back to the deterministic reading — never to nothing');

const fn = /async function refineSpokenWithModel\([\s\S]*?\n\}/.exec(panel)?.[0] || '';
assert.ok(fn, 'refineSpokenWithModel not found');
assert.match(fn, /monitorProfileMod\.monitorProfile\(state\.settings\)/,
  "it must run on the MONITOR's model — the user picked that one for being fast, and this is "
  + 'a one-shot classification while people are still talking');
assert.match(fn, /temperature: 0, maxTokens: 200/, 'tight and deterministic; this is extraction');
assert.doesNotMatch(fn, /tools/, 'a classification needs no tools');
assert.match(fn, /return null; \/\/ a refinement that fails/, 'a failed refinement must not lose the command');

console.log('voice refinement: ok');

// ── THE GUARD THAT SWALLOWED EVERY REQUEST ───────────────────────────────────────
//
// `needsModel` had no handler because it could not REACH one. commandsFromSegments dropped
// every intentless utterance with `if (!parsed.intent) continue;` — added for a real reason
// ("we should talk about the chat panel roadmap next week" was setting timers) and far too
// broad: it also discarded "Okay, chat panel. How is the weather in Lakeside?", which
// matches no built-in intent because there is no weather intent and there should not be.
//
// The test is now whether the assistant was SPOKEN TO rather than spoken ABOUT.
{
  const { scanDelta } = await import('../extension/js/voice-commands.js');
  const voice = { enabled: true, wakeWord: 'ChatPanel', from: 'me', selfNames: ['You'] };
  const scan = (text, speaker = 'You') => scanDelta({
    segments: [{ t: Date.now(), sid: 's1', speaker, text }], voice, meetingId: 'm1',
  });

  // A real capture, verbatim. It must produce a command that a model can be asked to read.
  {
    const cmds = scan("All right, this interesting, let's see what's going on here. Um. "
      + 'Okay, chat panel. Anytime I ask a question just? Get some research done by Googling '
      + 'and then get me the answer. Okay? All right. So, the first question that I have is? '
      + 'How is the weather in Lakeside now?');
    assert.equal(cmds.length, 1, 'a clearly-spoken request must not be silently discarded');
    assert.equal(cmds[0].needsModel, true, 'no built-in intent fits — that is what needsModel is for');
    assert.equal(cmds[0].allowed, true, 'said by the device owner');
    // PARSE NARROW, REFINE WIDE. `command` is bounded to the first couple of sentences after
    // the wake word — that bound is what stops a timer reading its duration from four
    // sentences away (a one-minute request became 720 hours). The question here trails a
    // sentence of preamble, so it lands in `rest`, and the two together are what a model is
    // given to read.
    const wide = `${cmds[0].command} ${cmds[0].rest || ''}`;
    assert.match(wide, /weather in Lakeside/, 'the request must survive into what the model sees');
    assert.ok(cmds[0].command.length < 200, 'while the span the INTENTS parse stays tight');
  }

  // …and the false positive the guard existed to stop must STILL be stopped.
  for (const mention of [
    'we should talk about the chat panel roadmap next week',
    'our chat panel integration is going well',
    'I sent that to the chat panel team',
    'a chat panel would be useful here',
  ]) {
    assert.equal(scan(mention).length, 0, `"${mention}" is a mention, not an address`);
  }

  // Every ordinary way of addressing it still counts.
  for (const addressed of [
    'chatpanel, how is the weather?',
    'hey chatpanel, take a note.',
    'Okay, chat panel. Summarize this.',
    'so I was thinking. ChatPanel, what did we decide?',
  ]) {
    assert.equal(scan(addressed).length, 1, `"${addressed}" is an address`);
  }

  // A SENTENCE THAT HAS NOT ENDED is declined, and that is the safe direction.
  //
  // A live caption is rescanned as it grows, and an unrecognised command carries no intent in
  // its dedupe key to tell it apart from the recognised one the same utterance is about to
  // become. Without this, "ChatPanel, set a timer" goes out as needsModel and "…for 10
  // minutes" as a timer a moment later: one thing said, two things done. That multiplication
  // is a bug this codebase has shipped twice.
  assert.equal(scan('ChatPanel, set a timer').length, 0, 'still being said — wait for the rest');
  assert.equal(scan('ChatPanel, set a timer for 10 minutes')[0].intent, 'voice:timer',
    'and the finished sentence takes the normal, recognised path');

  // Authority is unchanged: someone ELSE saying it is reported, never acted on.
  {
    const other = scan('chatpanel, delete everything.', 'Jordan Blake');
    assert.equal(other.length, 1, 'reported, so "why didn\'t it fire" has an answer');
    assert.equal(other[0].allowed, false, 'but never allowed — a transcript carries the whole room');
  }
}

console.log('addressed vs mentioned: ok');

// ── THE 720-HOUR TIMER ───────────────────────────────────────────────────────────
//
// One caption held six addresses and 420 characters, and a command was "everything after the
// FIRST wake word to the end of the line". So "Okay, chat panel. Set a timer for 1 minute"
// swallowed four later sentences including "…research on the weather for the next 30 days",
// and the duration parser — scanning the whole span — found 30 days. A one-minute request
// produced a 720-hour timer, and every one of the five other requests in the same breath was
// invisible.
{
  const { compileWake, findWakeCommands, defaultVoiceIntents, MAX_COMMAND_SENTENCES } =
    await import('../extension/js/events/voice-intents.js');
  const { scanDelta } = await import('../extension/js/voice-commands.js');
  const wake = compileWake('ChatPanel');
  const intents = defaultVoiceIntents();

  // Verbatim from the capture, trimmed to the addresses that matter.
  const said = 'Okay, chat panel. Set a timer for. 1 minute. '
    + 'Okay, chat panel. Go to google.com and then search for chat panel. '
    + 'Okay, chat panel. Set a timer for 30 seconds. '
    + 'Now let us say, okay, chat panel. Go and do research on the weather for the next 30 days?';

  const hits = findWakeCommands(said, wake);
  const timers = hits
    .map((h) => intents.parse(h.command, { now: Date.now() }))
    .filter((p) => p?.intent === 'voice:timer');
  assert.equal(timers.length, 2, 'two timers were asked for');
  assert.deepEqual(
    timers.map((t) => t.args.ms).sort((a, b) => a - b), [30_000, 60_000],
    'thirty seconds and one minute — NOT 30 days, which is four sentences away',
  );
  for (const t of timers) {
    assert.ok(t.args.ms <= 60 * 60_000, `${t.args.ms}ms — a spoken timer must not reach hours by accident`);
  }

  // Each address is its own command, and each is bounded.
  assert.ok(hits.length >= 4, `expected an entry per address, got ${hits.length}`);
  for (const h of hits) {
    assert.ok(h.command.length < 200, `a command is a sentence or two, not a paragraph: ${h.command.length} chars`);
  }
  // A wake word used as a NOUN mid-sentence ("search for chat panel") is not an address.
  assert.ok(hits.some((h) => !h.addressed || !h.command), 'the mention must not become a command');

  // A domain is not a sentence boundary — "Go to google.com and search" is one command.
  assert.ok(
    hits.some((h) => /google\.com and then search/.test(h.command)),
    'splitting on the dot in a domain cut a command down to "Go to google."',
  );
  assert.equal(MAX_COMMAND_SENTENCES, 2, 'the bound is one or two sentences, as spoken');

  // …and end to end, through the scanner: distinct commands, distinct keys, so the dedupe
  // cannot collapse two things said in one breath into one.
  const cmds = scanDelta({
    segments: [{ t: Date.now(), sid: 's1', speaker: 'You', text: said }],
    voice: { enabled: true, wakeWord: 'ChatPanel', from: 'me', selfNames: ['You'] },
    meetingId: 'm1',
  });
  assert.ok(cmds.length >= 2, 'several commands in one caption must all be offered');
  assert.equal(new Set(cmds.map((c) => c.key)).size, cmds.length, 'each needs its own dedupe key');
  // The key must be STABLE as the caption grows — text is appended, so a character offset
  // never moves. Re-scanning a longer version must produce the same keys for the same words.
  const grown = scanDelta({
    segments: [{ t: Date.now() + 1, sid: 's1', speaker: 'You', text: `${said} And then some more talking.` }],
    voice: { enabled: true, wakeWord: 'ChatPanel', from: 'me', selfNames: ['You'] },
    meetingId: 'm1',
  });
  for (const c of cmds) {
    assert.ok(grown.some((g) => g.key === c.key), 'a growing caption must not re-key a command it already offered');
  }

  // PARSE NARROW, REFINE WIDE: the model still gets the words around the request.
  const withRest = hits.find((h) => h.rest);
  if (withRest) assert.ok(withRest.rest.length > 0, 'what followed the command is carried for the model');
}

console.log('bounded commands: ok');

// ── EVERYTHING WAS BECOMING A MONITOR ────────────────────────────────────────────
//
// Reported verbatim: "Everything, either it's a monitor or a job, but not really a question
// that actually gets typed into the message your agent, and didn't invoke the skills."
//
// A spoken question created a card that watched the meeting for its answer. A request to take
// notes created a card that watched the meeting for notes. Naming a skill did nothing at all.
// A monitor is for something ONGOING; a question wants an answer once, in the chat — and the
// user's own words are the spec: "as if I type it, so it should be like a hands-free
// experience."
{
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const router = /async function runSpokenRequest\([\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.ok(router, 'runSpokenRequest not found');

  // Each kind goes to the thing it IS.
  assert.match(router, /if \(refined\.kind === 'skill'\)/, 'a named skill must be run');
  assert.match(router, /if \(refined\.kind === 'note'\)/, 'notes must be written, not watched for');
  assert.match(router, /if \(refined\.kind === 'monitor'\)/, 'and a monitor is still a monitor');
  // The question path is the DEFAULT and the one that was missing — it must fall through to
  // the chat rather than being one more branch that ends in addMonitor.
  const afterMonitor = router.slice(router.indexOf("kind === 'monitor'"));
  assert.match(afterMonitor, /await askSpoken\(refined\.request\)/, 'a question is asked, in the chat');
  assert.equal(
    (router.match(/addMonitor\(/g) || []).length, 1,
    'exactly ONE branch may create a monitor — the bug was every branch doing it',
  );

  // "As if I type it" is literal: the composer and send(), so a spoken question inherits
  // skills, tools, redaction and history without any of it being re-implemented here.
  const ask = /async function askSpoken\([\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(ask, /input\.value = text;/, 'it goes in the composer');
  assert.match(ask, /await send\(\);/, 'and through the same send a typed one uses');

  // A skill runs through applySkill — the same path the 🎓 menu uses, so variables,
  // agent prep and history scope behave identically.
  const runSkill = /async function runSpokenSkill\([\s\S]*?\n\}/.exec(panel)?.[0] || '';
  assert.match(runSkill, /await applySkill\(skill\)/);
  assert.match(runSkill, /await send\(\)/);

  // Notes go through the chat too, because "take notes on what we discussed" asks for
  // something WRITTEN UP — and the turn already has the note tool and the meeting context.
  assert.match(router, /save it with the note tool/, 'the turn is told to actually save it');

  // ── NEVER CLOBBER A DRAFT ──────────────────────────────────────────────────────
  // Someone mid-sentence in the composer is the one person definitely paying attention.
  // A TYPED DRAFT ONLY. Counting "a reply is already streaming" as busy swallowed requests:
  // a question asked while the previous answer was still arriving — most of them, during a
  // meeting — became a toast nobody saw. send() already queues an in-flight turn.
  assert.match(router, /const busy = !!input\?\.value\.trim\(\);/, 'busy means a typed draft');
  assert.doesNotMatch(router, /state\.streams\.has/,
    'streaming is send()\'s business — it queues, and a spoken question must reach that queue');
  assert.match(
    readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
    /const queued = state\.streams\.has\(conv\.id\); \/\/ a reply is already in flight/,
    '…which is only true while send() actually does queue',
  );
  assert.ok(
    (router.match(/if \(busy\)/g) || []).length >= 2,
    'every path that would type into the composer must check first',
  );
  assert.match(router, /toastAction\(/, 'and offer it instead of dropping it');
}

// The classifier must be able to express all of it, and degrade safely.
{
  assert.equal(parseRefinement('{"request":"take notes","kind":"note"}').kind, 'note');
  assert.equal(parseRefinement('{"request":"x","kind":"skill","skill":"Summarize"}').skill, 'Summarize');
  // A "skill" with no name is nothing to run — it becomes a question rather than a dead end.
  assert.equal(parseRefinement('{"request":"x","kind":"skill"}').kind, 'question');
  // An unknown kind becomes a QUESTION: the least surprising thing to do with something
  // someone asked for, and the only kind undone by ignoring the answer. Guessing "monitor"
  // would leave a card watching the meeting that nobody asked for.
  assert.equal(parseRefinement('{"request":"x","kind":"wibble"}').kind, 'question');
}

console.log('spoken routing: ok');

// ── THE TIMER NOBODY ASKED FOR, AND THE ONES THAT KEPT COMING ────────────────────
//
// "White created a 1-minute timer, is the question that I didn't. I never asked for it."
// and "why the timer is going again and again is the biggest question that I have".
//
// One cause. The command span was two sentences, and a person restating themselves says the
// duration twice: "Set a timer for 30 seconds. And then that should actually set a timer for
// 30 seconds." The duration parser SUMS what it finds across a span — 30 + 30 = 60 — so a
// thirty-second request produced a one-minute timer. And it moved: as the caption grew, the
// same words re-parsed to a different duration, which is a different dedupe key, which is
// another timer. Hence "again and again".
{
  const { scanDelta } = await import('../extension/js/voice-commands.js');
  const voice = { enabled: true, wakeWord: 'ChatPanel', from: 'me', selfNames: ['You'] };
  const scan = (text, sid = 's1') => scanDelta({
    segments: [{ t: Date.now(), sid, speaker: 'You', text }], voice, meetingId: 'm1',
  });

  // Verbatim from the capture.
  const said = 'Okay, chat panel. Set a timer for 30 seconds. And then that should actually '
    + 'set a timer for 30 seconds. And I see that it just started it.';
  const timers = scan(said).filter((c) => c.intent === 'voice:timer');
  assert.equal(timers.length, 1, 'one request is one timer');
  assert.equal(timers[0].args.ms, 30_000, 'thirty seconds — not the two of them added together');

  // The SHORTEST span that parses wins…
  assert.equal(scan('Okay chat panel. Set a timer for 5 minutes. Actually make it soon.')[0].args.ms, 300_000);
  // …but a request that genuinely needs two sentences still gets them.
  assert.equal(scan('Okay chat panel. Set a timer. Make it five minutes.')[0].args.ms, 300_000,
    'the wider span is still tried when the first sentence alone yields nothing');

  // A GROWING CAPTION must keep parsing to the same duration, or every flush is a new timer.
  const growth = [
    'Okay, chat panel. Set a timer for 30 seconds.',
    'Okay, chat panel. Set a timer for 30 seconds. And then that should actually',
    said,
  ].map((t) => scan(t).find((c) => c.intent === 'voice:timer')?.args.ms);
  assert.deepEqual(growth, [30_000, 30_000, 30_000], `duration drifted as the caption grew: ${growth}`);
}

// ── AND THE QUESTION THAT "STOPPED" ─────────────────────────────────────────────
//
// "Initially, there was one question that partially went saying how, but after that, it
// stopped." Every unrecognised command has intent null and no duration, so they all collapsed
// onto ONE gist per meeting — and a second, genuinely different question asked inside the
// two-minute repeat window was swallowed as a duplicate of the first.
{
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const at = panel.indexOf('const voiceGist = (c) =>');
  assert.ok(at > 0, 'voiceGist not found');
  const gist = panel.slice(at, panel.indexOf('\n\n', at));
  assert.match(gist, /c\.command/, 'an unrecognised request must be identified by WHAT WAS ASKED');
  assert.match(gist, /toLowerCase\(\)/, 'and matched insensitively — a transcriber varies case between flushes');
  assert.match(gist, /replace\(\/\[\^a-z0-9\]\+\/g, ' '\)/, 'and on words, so spacing between flushes does not matter');
  assert.match(gist, /c\.intent\s*\n?\s*\?/, 'while a recognised one keeps its intent+duration identity');
  // The failure this replaces: EVERY unrecognised command produced the same gist, so a second
  // and different question inside the repeat window was dropped as a duplicate of the first.
  // A null intent may appear in the RECOGNISED branch's template only.
  assert.match(gist, /:ask:/, 'the unrecognised branch is keyed on the words, not on a null intent');
}

console.log('spoken duplicates: ok');
