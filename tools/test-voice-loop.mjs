// The voice loop's failures are all about TIMING and CANCELLATION, and they all
// look the same from the outside: a mic that is open but going nowhere. Every test
// here is a transition that must still happen when something went wrong.
import assert from 'node:assert/strict';
import { createVoiceLoop, VOICE_STATES } from '../extension/js/voice-loop.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

// A rig with three fakes: a mic we feed transcripts to, a model, and a mouth.
// `send` may stream via onDelta; `hold` lets a test freeze a turn mid-flight.
function rig({ reply = (t) => `reply to ${t}`, stream = false, hold = false } = {}) {
  const states = [];
  const spoken = [];
  let mic = null;
  let opens = 0, closes = 0;
  let release = null;

  const loop = createVoiceLoop({
    listen: (h) => { mic = h; opens++; return () => { mic = null; closes++; }; },
    send: async (text, { onDelta } = {}) => {
      if (hold) await new Promise((r) => { release = () => r(); });
      const out = reply(text);
      if (stream) {
        let acc = '';
        for (const part of String(out).split(' ')) { acc += (acc ? ' ' : '') + part; onDelta?.(acc); await tick(); }
      }
      return out;
    },
    speakStream: () => {
      let ended = false;
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      return {
        push: (t) => { if (!ended) spoken.push(['push', t]); },
        end: () => { ended = true; spoken.push(['end']); resolveDone(); },
        stop: () => { ended = true; spoken.push(['stop']); resolveDone(); },
        done,
      };
    },
    onState: ({ state, text }) => states.push(text === undefined ? state : `${state}:${text}`),
    onError: (m) => states.push(`error:${m}`),
  });
  return {
    loop, states, spoken,
    say: (t) => mic?.onFinal(t),
    partial: (t) => mic?.onInterim(t),
    listening: () => !!mic,
    opens: () => opens,
    closes: () => closes,
    release: () => release?.(),
  };
}

// ── the mic stays open ─────────────────────────────────────────────────────────
// This is the whole point of the redesign: without it, barge-in needs a button.
{
  const r = rig();
  r.loop.start();
  assert.ok(r.listening(), 'starts listening');
  r.say('hello there');
  await settle();
  assert.ok(r.listening(), 'the mic must stay open through thinking and speaking');
  assert.equal(r.opens(), 1, 'and must not be reopened per turn');
  assert.equal(r.loop.state(), 'listening', 'and the loop returns to listening');
  r.loop.stop();
  assert.equal(r.closes(), 1, 'stop closes it exactly once');
}

// ── barge-in ───────────────────────────────────────────────────────────────────
{
  const r = rig({ hold: true });
  r.loop.start();
  r.say('first question');
  await tick();
  assert.equal(r.loop.state(), 'thinking');
  r.say('actually never mind tell me something else');
  await settle();
  r.release();                       // the first answer lands late
  await settle();
  assert.ok(r.spoken.some(([k]) => k === 'stop'), 'the abandoned turn must be stopped');
  // Identify the cancelled turn by its TEXT: pushes after the stop belong to the
  // NEW turn and are expected, but the first question's answer must never be said.
  const saidTexts = r.spoken.filter(([k]) => k === 'push').map(([, t]) => String(t));
  assert.ok(!saidTexts.some((t) => t.includes('first question')),
    `a cancelled turn must not speak its late answer — heard ${JSON.stringify(saidTexts)}`);
  r.loop.stop();
}

// A single stray word is usually our own audio leaking past echo cancellation.
// Cutting the assistant off for that is worse than ignoring it.
{
  const r = rig({ hold: true });
  r.loop.start();
  r.say('tell me a story');
  await tick();
  assert.equal(r.loop.state(), 'thinking');
  r.say('the');                      // one word — not a barge-in
  await tick();
  assert.equal(r.loop.state(), 'thinking', 'a one-word fragment must not interrupt');
  r.say('stop please');              // two words — a real interruption
  await settle();
  assert.ok(r.spoken.some(([k]) => k === 'stop'), 'real speech must interrupt');
  r.loop.stop();
}

// ── speaking starts DURING generation ──────────────────────────────────────────
{
  const r = rig({ stream: true, reply: () => 'One two three four five' });
  r.loop.start();
  r.say('say something');
  await settle();
  const pushes = r.spoken.filter(([k]) => k === 'push').map(([, t]) => t);
  assert.ok(pushes.length > 1, 'partial text must reach the speaker as it streams, not once at the end');
  assert.ok(r.states.some((s) => s.startsWith('speaking:')), 'and the UI must say it is speaking');
  assert.ok(r.spoken.some(([k]) => k === 'end'), 'the queue must be closed when generation finishes');
  r.loop.stop();
}

// A send that never streams still has to be spoken.
{
  const r = rig({ stream: false, reply: () => 'A complete answer.' });
  r.loop.start();
  r.say('question');
  await settle();
  assert.ok(r.spoken.some(([k, t]) => k === 'push' && t === 'A complete answer.'),
    'a non-streaming send must still be spoken');
  r.loop.stop();
}

// ── silence and noise ──────────────────────────────────────────────────────────
{
  const r = rig();
  r.loop.start();
  r.say('   '); r.say(''); r.say(null);
  await settle();
  assert.equal(r.spoken.length, 0, 'blank transcripts must never start a turn');
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

// ── failures keep the conversation alive ───────────────────────────────────────
{
  const r = rig({ reply: () => { throw new Error('model offline'); } });
  r.loop.start();
  r.say('hello');
  await settle();
  assert.ok(r.states.includes('error:model offline'), 'the user must be told');
  assert.equal(r.loop.state(), 'listening', 'a failed send must NOT end the session');
  assert.ok(r.listening(), 'and must not close the mic');
  r.loop.stop();
}

// ── mute closes the mic; it does not merely discard ────────────────────────────
{
  const r = rig();
  r.loop.start();
  r.loop.setMuted(true);
  assert.equal(r.listening(), false, 'muting must stop the listener, not filter it');
  assert.equal(r.loop.state(), 'muted');
  assert.ok(r.loop.isRunning(), 'and must not end the session');
  r.loop.setMuted(false);
  assert.ok(r.listening(), 'unmuting reopens it');
  assert.equal(r.loop.state(), 'listening');
  r.loop.setMuted(true); r.loop.setMuted(true);
  assert.equal(r.closes(), 2, 'muting twice must not close a listener twice');
  r.loop.stop();
  assert.equal(r.loop.isMuted(), false, 'stop clears mute — the next session is not silently deaf');
}

// Muting mid-answer must not claim the assistant stopped talking.
{
  const r = rig({ hold: true });
  r.loop.start();
  r.say('a question');
  await tick();
  r.loop.setMuted(true);
  assert.equal(r.loop.state(), 'thinking', 'a mute mid-answer must not hijack the display');
  r.release();
  await settle();
  assert.equal(r.loop.state(), 'muted', 'but the turn ends into muted');
  r.loop.stop();
}

// ── stop beats everything in flight ────────────────────────────────────────────
{
  const r = rig({ hold: true });
  r.loop.start();
  r.say('question');
  await tick();
  r.loop.stop();
  r.release();
  await settle();
  assert.equal(r.loop.state(), 'idle', 'a cancelled run must stay idle');
  assert.equal(r.listening(), false, 'the mic must not reopen after stop');
}

// ── interrupt() still works for callers that want a button ────────────────────
{
  const r = rig({ hold: true });
  r.loop.start();
  r.say('question');
  await tick();
  r.loop.interrupt();
  assert.equal(r.loop.state(), 'listening', 'interrupt returns to listening');
  assert.ok(r.loop.isRunning(), 'without ending the session');
  r.loop.stop();
}

// ── double start is a no-op, and a broken mic lands in idle ───────────────────
{
  const r = rig();
  r.loop.start(); r.loop.start(); r.loop.start();
  assert.equal(r.opens(), 1, 'only one listener may ever be opened');
  r.loop.stop();

  const loop = createVoiceLoop({
    listen: () => { throw new Error('mic blocked'); },
    send: async () => 'x',
    speakStream: () => ({ push() {}, end() {}, stop() {}, done: Promise.resolve() }),
    onState: () => {}, onError: () => {},
  });
  loop.start();
  assert.equal(loop.state(), 'idle', 'a mic failure must land in idle, not a dead "listening"');
  assert.equal(loop.isRunning(), false);
}

assert.deepEqual(VOICE_STATES, ['idle', 'listening', 'thinking', 'speaking', 'muted']);
console.log('✓ voice-loop: mic stays open, barge-in cancels (and ignores one-word echo), speaks while generating, silence ignored, failures survive, mute closes the mic, stop beats late replies');

// ── "say something, mute" must still send the something ────────────────────────
// A final only exists after the engine hears a silence, and muting flushes the listener's
// tail as its last final — both land AFTER the mute flag. They are the sentence spoken
// before the mute, and they used to be thrown away.
{
  let clock = 1_000_000;
  let handlers = null;
  const sent = [];
  const loop = createVoiceLoop({
    now: () => clock,
    listen: (h) => { handlers = h; return () => {}; },
    send: async (text) => { sent.push(text); return 'ok'; },
    // The loop pushes deltas into a speech QUEUE, not a promise — same shape as rig()'s.
    speakStream: () => { let r; const done = new Promise((res) => { r = res; }); return { push: () => {}, end: () => r(), stop: () => r(), done }; },
    onState: () => {},
  });
  loop.start();
  const h = handlers;
  loop.setMuted(true);
  clock += 1500;                      // the end-of-sentence silence, then the flush
  h.onFinal('send the release notes');
  await settle();
  assert.deepEqual(sent, ['send the release notes'], 'a final that lands just after muting is the sentence spoken before it, and is sent');
  assert.equal(loop.state(), 'muted', 'and the loop rests muted afterwards, as asked');

  clock += 10_000;                    // long after — this is the room, not the user
  h.onFinal('the television in the background');
  await settle();
  assert.deepEqual(sent, ['send the release notes'], 'a final that arrives well after muting is ignored');
  loop.stop();
}

// ── the room does not get a turn ───────────────────────────────────────────────
// Every final is SENT in a conversation, so a television or a colleague at the next desk
// becomes a question. The gateway fingerprints each sentence; the loop keeps the
// conversation to whoever started it — and a voice that is not in it may not barge in either.
{
  let clock = 2_000_000;
  let handlers = null;
  const sent = [];
  const held = [];
  const loop = createVoiceLoop({
    now: () => clock,
    listen: (h) => { handlers = h; return () => {}; },
    send: async (text) => { sent.push(text); return `reply to ${text}`; },
    speakStream: () => { let r; const done = new Promise((res) => { r = res; }); return { push: () => {}, end: () => r(), stop: () => r(), done }; },
    onState: () => {},
    onHeld: (h) => held.push(h),
  });
  loop.start();
  const h = handlers;

  h.onFinal('what is on my calendar', { speaker: { label: 'Speaker 1' } });
  await settle();
  assert.deepEqual(sent, ['what is on my calendar'], 'the first voice owns the conversation');
  assert.equal(loop.primarySpeaker(), 'Speaker 1');

  clock += 2000;
  h.onFinal('and then the weather turned', { speaker: { label: 'Speaker 2' } });
  await settle();
  assert.deepEqual(sent, ['what is on my calendar'], 'the room is not a turn');
  assert.equal(held.length, 1, 'and the caller is told, so it can say so rather than dropping it silently');
  assert.equal(held[0].count, 1);

  clock += 1000;
  h.onFinal('add a reminder', { speaker: { label: 'Speaker 1' } });
  await settle();
  assert.deepEqual(sent, ['what is on my calendar', 'add a reminder'], 'and the person having it is still heard');

  // No speaker at all — diarization off, or the model is missing. Everything is sent.
  clock += 1000;
  h.onFinal('no fingerprint on this one');
  await settle();
  assert.equal(sent.length, 3, 'a final with no speaker is always sent — the gate never silences you');
  loop.stop();
}

// A voice that is not in the conversation must not barge in on the assistant either.
{
  let clock = 3_000_000;
  let handlers = null;
  let released = null;
  const sent = [];
  const loop = createVoiceLoop({
    now: () => clock,
    listen: (h) => { handlers = h; return () => {}; },
    send: async (text) => { sent.push(text); await new Promise((r) => { released = r; }); return 'ok'; },
    speakStream: () => { let r; const done = new Promise((res) => { r = res; }); return { push: () => {}, end: () => r(), stop: () => r(), done }; },
    onState: () => {},
  });
  loop.start();
  const h = handlers;
  h.onFinal('summarise my week', { speaker: { label: 'Speaker 1' } });
  await tick();
  assert.equal(loop.state(), 'thinking');
  clock += 1000;
  h.onFinal('the television says something with several words in it', { speaker: { label: 'Speaker 2' } });
  await settle();
  assert.equal(loop.state(), 'thinking', 'the room does not cancel the answer you asked for');
  assert.deepEqual(sent, ['summarise my week']);
  released();
  await settle();
  loop.stop();
}

// ── a long sentence is not four questions ──────────────────────────────────────
// The engine commits a segment when the speaker pauses AND when one has run too long to
// hold. Only the first is the end of a turn. Sending the second asked half a thought and
// answered it: "…you should just continuously listen to it and then" went to the model.
{
  let clock = 4_000_000;
  let handlers = null;
  const sent = [];
  const captions = [];
  const loop = createVoiceLoop({
    now: () => clock,
    listen: (h) => { handlers = h; return () => {}; },
    send: async (text) => { sent.push(text); return 'ok'; },
    speakStream: () => { let r; const done = new Promise((res) => { r = res; }); return { push: () => {}, end: () => r(), stop: () => r(), done }; },
    onState: ({ state, text }) => { if (state === 'listening' && text) captions.push(text); },
  });
  loop.start();
  const h = handlers;

  h.onFinal('okay so listen whenever you see that I am actually speaking', { endOfTurn: false, reason: 'length' });
  await settle();
  assert.deepEqual(sent, [], 'a segment the engine had to cut is not a question');
  assert.equal(captions.at(-1), 'okay so listen whenever you see that I am actually speaking', 'but it is shown, so the speaker sees their sentence building');

  h.onFinal('then you should just continuously listen', { endOfTurn: false, reason: 'length' });
  await settle();
  assert.deepEqual(sent, [], 'nor is the next one');

  h.onFinal('and wait for me to finish', { endOfTurn: true, reason: 'silence' });
  await settle();
  assert.deepEqual(sent, ['okay so listen whenever you see that I am actually speaking then you should just continuously listen and wait for me to finish'],
    'the pause ends the turn, and the whole sentence is asked once');

  // The next sentence starts clean.
  h.onFinal('thanks', { endOfTurn: true, reason: 'silence' });
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], 'thanks');
  loop.stop();
}

// An older gateway says nothing about why it committed — everything is a turn, as before.
{
  let handlers = null;
  const sent = [];
  const loop = createVoiceLoop({
    listen: (h) => { handlers = h; return () => {}; },
    send: async (text) => { sent.push(text); return 'ok'; },
    speakStream: () => { let r; const done = new Promise((res) => { r = res; }); return { push: () => {}, end: () => r(), stop: () => r(), done }; },
    onState: () => {},
  });
  loop.start();
  handlers.onFinal('what is the weather', { speaker: { label: 'Speaker 1' } });
  await settle();
  assert.deepEqual(sent, ['what is the weather'], 'no endOfTurn field: sent, exactly as it always was');
  loop.stop();
}

// Stopping mid-sentence must not leave the fragment to be asked at the start of the next one.
{
  let handlers = null;
  const sent = [];
  const mk = () => createVoiceLoop({
    listen: (h) => { handlers = h; return () => {}; },
    send: async (text) => { sent.push(text); return 'ok'; },
    speakStream: () => { let r; const done = new Promise((res) => { r = res; }); return { push: () => {}, end: () => r(), stop: () => r(), done }; },
    onState: () => {},
  });
  const loop = mk();
  loop.start();
  handlers.onFinal('half a thought that never', { endOfTurn: false, reason: 'length' });
  await settle();
  loop.stop();
  loop.start();
  handlers.onFinal('a new question', { endOfTurn: true, reason: 'silence' });
  await settle();
  assert.deepEqual(sent, ['a new question'], 'the abandoned fragment does not lead the next turn');
  loop.stop();
}
