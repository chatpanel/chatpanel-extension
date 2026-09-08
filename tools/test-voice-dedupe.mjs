// One spoken request must produce ONE job — across caption growth, across the same sentence
// arriving under a new segment id, and across the side panel being closed and reopened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/js/voice-acted.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const voice = readFileSync(new URL('../extension/js/voice-commands.js', import.meta.url), 'utf8');
// The real guards, not a copy of them: a test that re-implements the thing it is testing
// passes just as happily when the shipped version is wrong.
const { voiceIsFresh, voiceGist, VOICE_SAME_MS } = await import('../extension/js/voice-acted.js');

// DURABLE. Everything that deduped a command used to be in memory — the rule engine's set,
// the watermark, this page — so a reopened panel refired the last lines said, and deleting
// the duplicates just made room for more.
assert.match(src, /chrome\.storage\.local\.get\(VOICE_ACTED_KEY\)/, 'the acted-on record is read from disk');
assert.match(src, /chrome\.storage\.local\.set\(\{ \[VOICE_ACTED_KEY\]/, 'and written back');
assert.match(src, /VOICE_ACTED_MAX/, 'and capped, so a long meeting cannot grow it forever');

// SEMANTIC. Per-utterance identity is not enough: captions split one sentence across segments
// and re-emit it, so the same request returns under a new id.
assert.match(src, /const voiceGist = /, 'a request has an identity beyond its caption');
// One window, and a long one. Two minutes was SHORTER than a caption entry lives — a
// monologue keeps one entry alive and re-scanned for minutes, so a duplicate timer arrived
// three minutes later, cleared the window, and fired. The same words, and the same opening
// through a revised transcription, now stay done for twenty.
assert.match(src, /VOICE_SAME_MS/, 'and repeats within a window are suppressed');
assert.match(src, /const VOICE_SAME_MS = 20 \* 60_000;/, 'longer than a caption entry lives');
assert.doesNotMatch(src, /VOICE_REPEAT_MS/, 'the short window it replaced must be gone, not merely unused');
// The looser identity is the OPENING of the request: a transcriber revises its tail
// ("…Seattle, Washington now?" -> "…Seattle, Washington?"), which used to be a new request.
// Taken from the shared contract, not copied: there used to be an inlined duplicate here to
// keep 6 KB off the panel's first paint, and this file is no longer on it.
assert.match(src, /import \{ gistOpening \} from '\.\/events\/voice-intents\.js'/,
  'the opening comes from the one place that defines it');
assert.match(src, /gistOpening\(c\.command\)/, 'a revised tail must not make a new request');
assert.doesNotMatch(src, /vcGistOpening/, 'and the copy of it is gone, not merely unused');
{
  const revised = (text) => voiceGist({ meetingId: 'm', intent: null, command: text });
  assert.equal(revised('How is the weather in Seattle, Washington now?'),
    revised('How is the weather in Seattle, Washington?'),
    'the same question, re-transcribed, is the same question');
  assert.notEqual(revised('How is the weather in Seattle?'), revised('What did we decide about pricing?'));
}

// The guard is actually applied before dispatch, not merely defined. `at` rather than `now`
// because the drain's clock is injected now — a decision about whether something is old enough
// to act on, made against a clock no test can move, is a decision no test can reach.
assert.match(voice, /if \(await isFresh\(c, at\)\) fresh\.push\(c\)/, 'filtered before dispatch');
assert.match(voice, /await remember\(fresh, at\);\n\s*await dispatchVoiceCommands/, 'recorded BEFORE dispatch, so a slow action cannot double-fire');
// …and it must see BOTH routes. The scan drains the gate itself, so commands that came due as
// a caption landed arrive as `already` and would otherwise skip the freshness check entirely.
assert.match(voice, /const ready = \[\.\.\.already, \.\.\.gate\.due\(at\)\]/,
  'what the scan took and what the gate still holds are one list, filtered once');

// SETTLED. The identity guards above cannot relate "set a timer for." to the timer the same
// breath is about to become — different words, different intent, different key — so the
// fragment went to the model as a question and the finished sentence set a timer. The gate is
// what makes one utterance one action, and something must come back to it: once the speaker
// stops, the captions stop, and nothing else would ever drain it.
assert.match(panel, /gate = vc\.createUtteranceGate\(\)/, 'the panel keeps one gate for the meeting');
assert.match(panel, /const ready = vc\.scanDelta\(\{[^}]*gate \}\)/, 'and every scan is offered to it');
// …and WHAT THE SCAN GIVES BACK is handed on. A gated scan ends in `.due(now)`, so it removes
// anything that settled in the same breath; discarding its return value dropped those commands
// on the floor, and left nothing waiting for the timer below to come back for.
assert.match(panel, /await drain\(meetingId, ready\)/, 'what the scan took out must still be delivered');
assert.match(voice, /gate\.nextDueIn\(now\(\)\)/, 'and the next one is scheduled for');
assert.match(voice, /if \(isLive\(meetingId\)\) drain\(meetingId\)/, 'a drain that lands after the meeting moved on does nothing');
assert.match(panel, /isLive: \(meetingId\) => state\.liveMeeting\?\.id === meetingId/, 'and the panel is what knows that');

// Behaviour of the guard itself, exercised directly.
const isFresh = (a, c, now) => voiceIsFresh(a, c, now);
const acted = new Map();
const cmd = (key) => ({ key, meetingId: 'm', intent: 'voice:timer', ms: 30000 });

const first = cmd('voice:m:s:1:voice:timer:30000');
assert.equal(isFresh(acted, first, 1000), true, 'the first request runs');
acted.set(first.key, 1000); acted.set(voiceGist(first), 1000);

// The same sentence again under a NEW segment id — what "one per caption message" looked like.
assert.equal(isFresh(acted, cmd('voice:m:s:2:voice:timer:30000'), 5000), false, 'a repeat under a new id does not');
assert.equal(isFresh(acted, first, 9000), false, 'and neither does the identical utterance');
// Long enough later, the user meant it.
assert.equal(isFresh(acted, cmd('voice:m:s:9:voice:timer:30000'), 1000 + VOICE_SAME_MS + 1), true, 'a genuinely new request later does run');
// A different request is never blocked by an unrelated one.
assert.equal(isFresh(acted, { key: 'k', meetingId: 'm', intent: 'voice:timer', ms: 60000 }, 5000), true);

console.log('ok — one spoken request is one job, across captions, ids, and panel reloads');
