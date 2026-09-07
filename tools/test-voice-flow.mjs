// The voice conversation END TO END, as a contract between the pieces.
//
// The unit tests cover each part; this covers the seams between them, which is
// where every bug in this feature has actually lived:
//   • barge-in stopped the AUDIO but the panel kept streaming, so the next
//     utterance was QUEUED instead of answered — it looked like interruption did
//     nothing at all;
//   • the microphone must stay open across turns or barge-in is impossible;
//   • echo cancellation must be requested, or the assistant interrupts itself;
//   • speech must begin before generation ends.
//
// These are asserted against the real modules with fakes for the browser, plus a
// few source-level checks for the panel wiring that has no headless equivalent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

const { createVoiceLoop } = await import('../extension/js/voice-loop.js');
const { speakStream } = await import('../extension/js/speech.js');

// ── a whole conversation: two turns, one interrupted ──────────────────────────
{
  const events = [];
  const heard = [];
  let mic = null;
  let opens = 0;
  let releaseFirst = null;

  const loop = createVoiceLoop({
    listen: (h) => { mic = h; opens++; return () => { mic = null; }; },
    send: async (text, { onDelta }) => {
      events.push(['send', text]);
      if (text.startsWith('tell me')) {
        // A slow answer, so there is something to interrupt.
        await new Promise((r) => { releaseFirst = () => r(); });
        return 'A long answer that should never be heard.';
      }
      onDelta?.('Short.');
      return 'Short.';
    },
    speakStream: () => {
      const fake = { speak: async (t) => { heard.push(t); }, stop() {} };
      return speakStream(fake);
    },
    onState: ({ state }) => events.push(['state', state]),
    onError: (m) => events.push(['error', m]),
  });

  loop.start();
  mic.onFinal('tell me a long story');
  await tick();
  assert.equal(loop.state(), 'thinking');

  // Talk over it.
  mic.onFinal('stop and answer this instead');
  await settle();
  releaseFirst();               // the abandoned answer arrives late
  await settle();

  assert.equal(opens, 1, 'the microphone must be opened once for the whole session');
  assert.ok(!heard.some((t) => t.includes('never be heard')),
    `the interrupted answer must never be spoken — heard ${JSON.stringify(heard)}`);
  assert.ok(events.some(([k, v]) => k === 'send' && v === 'stop and answer this instead'),
    'the interrupting utterance must be sent as its own turn');
  assert.equal(loop.state(), 'listening', 'and the loop returns to listening');
  loop.stop();
}

// ── speech starts before the answer is complete ───────────────────────────────
{
  const heard = [];
  let mic = null;
  const loop = createVoiceLoop({
    listen: (h) => { mic = h; return () => { mic = null; }; },
    send: async (_t, { onDelta }) => {
      // Stream one sentence, then a long pause, then another.
      onDelta('First sentence is done.');
      await tick();
      assert.ok(heard.length >= 1, 'the first COMPLETE sentence must be spoken before generation ends');
      onDelta('First sentence is done. Second one lands later.');
      await tick();
      return 'First sentence is done. Second one lands later.';
    },
    speakStream: () => speakStream({ speak: async (t) => { heard.push(t); }, stop() {} }),
    onState: () => {}, onError: () => {},
  });
  loop.start();
  mic.onFinal('say two sentences');
  await settle();
  assert.deepEqual(heard, ['First sentence is done.', 'Second one lands later.'],
    'each complete sentence is spoken in order, never a half clause');
  loop.stop();
}

// ── a half-finished sentence is NOT spoken ────────────────────────────────────
// Synthesizing a fragment gives a voice that trails off and restarts, which is
// worse than starting a moment later.
{
  const heard = [];
  const q = speakStream({ speak: async (t) => { heard.push(t); }, stop() {} });
  q.push('This is not finished yet');
  await settle();
  assert.deepEqual(heard, [], 'nothing may be spoken until a sentence completes');
  q.push('This is not finished yet. Now it is.');
  await settle();
  assert.deepEqual(heard, ['This is not finished yet. Now it is.']);
  q.end();
  await q.done;
}

// ── the panel must ABORT a running stream before a barge-in send ──────────────
// This is the seam that broke the feature in practice: the loop cancelled its own
// turn and stopped the audio, but send() sees a stream in flight and QUEUES the
// message rather than answering it, so interrupting appeared to do nothing.
{
  const panel = read('sidepanel.js');
  const sendTurn = panel.slice(panel.indexOf('sendTurn: async (text'), panel.indexOf('sendTurn: async (text') + 1400);
  assert.match(sendTurn, /isActiveStreaming\(\)/, 'sendTurn must notice a reply already in flight');
  assert.match(sendTurn, /stopStream\(\)/, 'and abort it, or the barge-in is queued instead of answered');
  // Aborting is asynchronous — the stream is removed in its finally — so sending
  // before it finishes would queue anyway.
  assert.ok(/const ended = awaitTurn\(\);[\s\S]{0,120}stopStream\(\);[\s\S]{0,60}await ended;/.test(sendTurn),
    'it must WAIT for the aborted stream to finish before sending, or the message is queued anyway');
  // And the queueing rule this defends against must still be the one in send().
  assert.match(panel, /const queued = state\.streams\.has\(conv\.id\)/,
    'if send() stops queueing on an in-flight stream, this dance can be simplified — check before deleting it');
}

// ── echo cancellation is load-bearing, not a nicety ───────────────────────────
// The mic is open while the assistant speaks; without AEC its own voice is
// transcribed and every reply interrupts itself.
{
  const dictation = read('js/dictation.js');
  assert.match(dictation, /echoCancellation: true/, 'the capture must ask for echo cancellation explicitly');
  assert.ok(!/getUserMedia\(\{ audio: true \}\)/.test(dictation),
    'bare `audio: true` leaves AEC to browser defaults, and barge-in now depends on it');
  assert.match(dictation, /analyser: \(\) => micAnalyser/, 'and expose its mic tap for the waveform');
}

// ── a one-word fragment must not interrupt ────────────────────────────────────
{
  let mic = null;
  const sent = [];
  const loop = createVoiceLoop({
    listen: (h) => { mic = h; return () => { mic = null; }; },
    send: async (t) => { sent.push(t); await new Promise(() => {}); },   // never resolves
    speakStream: () => speakStream({ speak: async () => {}, stop() {} }),
    onState: () => {}, onError: () => {},
  });
  loop.start();
  mic.onFinal('start a long answer');
  await tick();
  mic.onFinal('um');
  await settle();
  assert.deepEqual(sent, ['start a long answer'], 'a single stray word must not start a new turn');
  loop.stop();
}

console.log('✓ voice flow: mic open across turns, barge-in cancels and re-asks (panel aborts the stream first), sentences spoken as they complete, fragments never spoken, echo cancellation requested, one-word noise ignored');
