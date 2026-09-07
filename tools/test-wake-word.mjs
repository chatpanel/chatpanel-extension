// A wake word you can type the way you say it — and that actually saves.
//
// Two faults, reported together:
//
// 1 · IT DID NOT SAVE. Every preference on the settings page saves on change. The four voice
//     fields were the only ones never wired, so a wake word you typed was persisted only if
//     you happened to touch some OTHER preference afterwards. From the outside: "it doesn't
//     save".
//
// 2 · ONE SPELLING ONLY. People do not say one fixed thing — "ok chatpanel", "okay, chat
//     panel", "hey chatpanel" are one intent with three spellings — and the box took a single
//     phrase. The matcher was already fuzzy about how a phrase is HEARD; it was rigid about
//     how many phrases there could be, and its scan window was fixed at three tokens, so a
//     three-word wake phrase could never be found however it was typed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { compileWake, findWakeCommand } =
  await import('../extension/js/events/voice-intents.js');

// ── the reported phrasings, all of them, from one setting ────────────────────────
{
  const wake = compileWake('ok chatpanel, okay chat panel, hey chatpanel');
  assert.deepEqual(wake.phrases, ['okchatpanel', 'okaychatpanel', 'heychatpanel']);
  for (const said of [
    'ok chat panel, set a timer for 5 minutes',
    'okay, chat panel remind me at 3',
    'OK ChatPanel, summarize this',
    'hey chatpanel take a note',
    'ok chatpanel set a timer',        // no comma
    'okay chat  panel   remind me',    // ragged spacing from the transcriber
  ]) {
    const hit = findWakeCommand(said, wake);
    assert.ok(hit, `"${said}" must trigger — it is the same wake phrase, said normally`);
    assert.ok(hit.command.length, `"${said}" must leave a command behind, got ""`);
  }
}

// ── how you TYPE it must not matter either ───────────────────────────────────────
// These are the same setting written four ways; all must compile to the same thing.
// (Note "ok, chatpanel" is NOT among them — a comma separates wake words, see below.)
for (const typed of ['ok chatpanel', 'OK ChatPanel', 'okchatpanel', ' ok  chat panel ']) {
  assert.deepEqual(
    compileWake(typed).phrases, ['okchatpanel'],
    `"${typed}" must compile to the same phrase — punctuation and spacing are not the setting`,
  );
}
// A COMMA SEPARATES THEM — "chatpanel, siri, google" is what anyone would write, and any
// other separator is a rule to learn. The apparent conflict (a comma is also how you would
// write "okay, chat panel") is not a real one: matching strips punctuation from the
// TRANSCRIPT, so a comma is never needed inside a configured phrase to hear one spoken.
assert.deepEqual(
  compileWake('chatpanel, siri, google').phrases, ['chatpanel', 'siri', 'google'],
  'the obvious way to write three wake words must be the way that works',
);
assert.deepEqual(compileWake('okay chat panel').phrases, ['okaychatpanel']);
// THE TRADE, stated: with a comma as the separator, "ok, chatpanel" is two wake words, and
// "ok" is dropped for being under three letters. That is the right call — "chatpanel, siri,
// google" is the common case and the comma is the only separator anyone reaches for — and it
// costs nothing, because a comma is never NEEDED inside a phrase (see the assertion below).
// The settings preview echoes the parsed list back so this is visible, not silent.
assert.deepEqual(compileWake('ok, chatpanel').phrases, ['chatpanel']);
assert.ok(
  findWakeCommand('okay, chat panel set a timer', compileWake('okay chat panel')),
  'and the comma the user SAYS is still heard, without being in the setting',
);
// Other separators, and duplicates collapsing rather than costing a scan.
assert.equal(compileWake('a phrase; another one\nthird one').phrases.length, 3);
assert.deepEqual(compileWake('chatpanel | chat panel | CHATPANEL').phrases, ['chatpanel']);
// The phrases AS TYPED are kept, in order — the squashed form is an implementation detail
// and echoing it back to the user read as the setting having been mangled.
assert.deepEqual(compileWake('ok chatpanel, hey chat panel').labels, ['ok chatpanel', 'hey chat panel']);
assert.equal(compileWake('  Ok ChatPanel  ').labels[0], 'Ok ChatPanel', 'original casing and spacing survive');
// An array is accepted too, for a client that stores it that way.
assert.deepEqual(compileWake(['ok chatpanel', 'hey chatpanel']).phrases, ['okchatpanel', 'heychatpanel']);

// ── THE WINDOW must fit the phrase, or a long one can never match ────────────────
{
  const one = compileWake('chatpanel');
  const three = compileWake('ok hey chat panel');
  assert.ok(three.maxTokens > one.maxTokens, 'a longer phrase must widen its own scan window');
  assert.ok(
    findWakeCommand('ok hey chat panel, set a timer', three),
    'a four-word wake phrase must be findable — the fixed three-token window made it impossible',
  );
  assert.ok(one.maxTokens >= 3, 'a one-word phrase still needs room for a split transcription');
  assert.ok(three.maxTokens <= 8, 'but the window must stay bounded — this scan runs on every utterance');
}
// A phrase longer than the ceiling must not blow the window out.
assert.ok(compileWake('one two three four five six seven eight nine ten').maxTokens <= 8);

// ── the guardrails that were there stay there ────────────────────────────────────
assert.throws(() => compileWake('ab'), /at least 3 letters/, 'too short trips ordinary speech');
assert.throws(() => compileWake(''), /at least 3 letters/);
assert.throws(() => compileWake('a, b, c'), /at least 3 letters/, 'all-too-short is still empty');
// One good phrase among rejects is enough — don't punish a stray separator.
assert.deepEqual(compileWake('chatpanel, x').phrases, ['chatpanel']);
// Nothing said, nothing fired.
assert.equal(findWakeCommand('let us talk about the roadmap', compileWake('chatpanel')), null);
assert.equal(findWakeCommand('', compileWake('chatpanel')), null);

// ── and the settings page must actually persist it ───────────────────────────────
const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
for (const id of ['pref-voice-enabled', 'pref-voice-wake', 'pref-voice-from', 'pref-voice-names']) {
  assert.match(
    js, new RegExp(`\\$\\('${id}'\\)\\.onchange = savePrefs;`),
    `${id} must save on change — it was the only group of prefs on the page that did not`,
  );
}
// And show, as it is typed, what will actually trigger — a wrong wake word is otherwise
// discovered in a meeting.
assert.match(js, /\$\('pref-voice-wake'\)\.oninput = renderWakePreview;/);
assert.match(js, /async function renderWakePreview\(\)/);
// The forgiveness has to be SHOWN, not asserted: the preview spells the user's own phrase
// the ways a transcriber might produce it, rather than claiming tolerance about a generic one.
assert.match(js, /function spokenVariants\(phrase\)/);
assert.match(js, /all work\. Add more, separated by commas\./);
assert.match(js, /however you space or punctuate it/);
const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
assert.match(html, /id="pref-voice-wake-preview"/, 'the preview needs somewhere to render');
assert.match(html, /separated by commas/, 'the label must say several are allowed, the obvious way');
// The preview echoes what was TYPED, never the squashed internal form.
assert.match(js, /const \{ labels \} = compileWake\(/, 'the preview must use the typed phrases');
// "siri" is four letters and ordinary speech trips it. Allowed — it is the user's call — but
// said out loud in the preview rather than discovered as a meeting that interrupts itself.
assert.ok(js.includes('short — ordinary speech may trip'), 'a 4-letter wake word is a hazard worth naming');
assert.match(js, /\.length < 5\)/, 'and the threshold must be explicit');

console.log('wake word: ok');

// ── the REQUEST inside a rambling utterance ──────────────────────────────────────
//
// People do not stop talking when they finish asking. Everything after the wake word became
// the job's name AND its prompt, so a job was a paragraph of thinking-aloud with the actual
// question buried in it. Both fixtures below are real captures.
{
  const { refineSpokenCommand, isFillerSentence } = await import('../extension/js/events/voice-intents.js');
  const wake = compileWake('chatpanel');
  const heard = (said) => refineSpokenCommand(findWakeCommand(said, wake).command);

  // One question → that question, and nothing around it.
  {
    const r = heard('it? Okay? All right, so. I think it is doing something. '
      + 'Okay, chat panel. How is the weather in Lakeside ?');
    assert.match(r.request, /^How is the weather in Lakeside/, 'the request, not the preamble');
    assert.doesNotMatch(r.request, /doing something/, 'thinking-aloud is not the request');
    assert.equal(r.ambiguous, false);
  }
  // An imperative with no question mark still works.
  {
    const r = heard('chatpanel, summarize the last ten minutes');
    assert.equal(r.request, 'summarize the last ten minutes');
    assert.ok(r.name.length <= 48);
  }

  // SEVERAL questions → it refuses to guess, and says so.
  //
  // The real capture had three: a standing preamble, the request, and a meta-question about
  // the tool. Last-wins picks the third; longest-wins picks the first. Every rule that fits
  // this sample is a rule fitted to this sample — which is what `needsModel` is for.
  {
    // Fed the WIDE text directly. findWakeCommand now bounds a command to its first couple of
    // sentences — that bound is what stops a timer reading its duration four sentences away —
    // so the several-questions case is exercised on what a model is actually given to read
    // (command + rest), not on the tight span the intents parse.
    const r = refineSpokenCommand('Whenever I do anything or ask any question just to do a '
      + 'research for me and get me the answer, okay? All right, so. I want to know how is the '
      + 'weather in Fairview today? All right, so we will see. It does anything. Does it get added to?');
    assert.equal(r.ambiguous, true, 'three questions is not something a regex may decide');
    assert.match(r.request, /weather in Fairview/, 'but the request must still be IN what is handed on');
    assert.doesNotMatch(r.request, /All right, so we will see/, 'while the filler is gone');
  }

  // Filler is verbal punctuation, and only whole sentences of it count.
  for (const f of ['Okay.', 'All right, so.', 'Um.', 'we will see', 'I think', 'testing']) {
    assert.equal(isFillerSentence(f), true, `"${f}" carries no request`);
  }
  for (const real of ['see if the build passed', 'right after the demo, remind me', 'so what did we decide?']) {
    assert.equal(isFillerSentence(real), false, `"${real}" is a request that merely starts like filler`);
  }

  // A name is a label in a list — one line, clipped on a word.
  {
    const r = refineSpokenCommand('remind me to '.repeat(20) + 'call Alex');
    assert.ok(r.name.length <= 48, `name is ${r.name.length} chars`);
    assert.ok(r.name.endsWith('…'));
    assert.doesNotMatch(r.name, /\s…$/, 'clipped on a word boundary, not mid-space');
  }
  // Never returns nothing for something: a command we cannot parse is still a command.
  assert.equal(refineSpokenCommand('').request, '');
  assert.equal(refineSpokenCommand(null).request, '');
  assert.equal(refineSpokenCommand('okay. um. all right.').request.length > 0, true,
    'even all-filler must fall back to what was said, not vanish');

  // Wired where the mess actually appeared, and NOT on the worker's graph.
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /vc\.refineSpokenCommand\(cmd\.args\.prompt\)/, 'spoken monitors');
  assert.match(panel, /vc\.refineSpokenCommand\(cmd\.args\.target\)/, 'spoken scheduled jobs');
  const jobsSrc = readFileSync(new URL('../extension/js/jobs.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    jobsSrc, /from '\.\/events\/voice-intents\.js'/,
    'js/jobs.js is on the service worker graph — 37 KB of voice vocabulary may not land there',
  );
}

console.log('spoken request extraction: ok');
