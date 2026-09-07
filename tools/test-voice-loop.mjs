// The voice loop's failure modes are all "it got stuck with the mic open" — which
// looks exactly like "it is listening", so the user keeps talking to nothing. Every
// test here is about a transition that must still happen when something went wrong.
import assert from 'node:assert/strict';
import { createVoiceLoop, VOICE_STATES } from '../extension/js/voice-loop.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// A rig with three fakes: a mic we can feed transcripts to, a model, and a mouth.
function rig({ send, speak } = {}) {
  const states = [];
  let mic = null;
  let stopped = 0;
  const loop = createVoiceLoop({
    listen: (h) => { mic = h; return () => { mic = null; stopped++; }; },
    send: send || (async (t) => `reply to ${t}`),
    speak: speak || (async () => {}),
    onState: ({ state, text }) => states.push(text === undefined ? state : `${state}:${text}`),
    onError: (m) => states.push(`error:${m}`),
  });
  return { loop, states, say: (t) => mic?.onFinal(t), partial: (t) => mic?.onInterim(t), listening: () => !!mic, stops: () => stopped };
}

// ── the happy cycle ────────────────────────────────────────────────────────────
{
  const r = rig();
  r.loop.start();
  assert.equal(r.loop.state(), 'listening');
  r.say('what is the weather');
  await tick(); await tick(); await tick();
  assert.deepEqual(r.states.filter((s) => VOICE_STATES.includes(s.split(':')[0]) && !s.includes(':')),
    ['listening', 'listening'], 'it must return to listening for the next turn');
  assert.ok(r.states.some((s) => s.startsWith('thinking:what is the weather')));
  assert.ok(r.states.some((s) => s.startsWith('speaking:reply to')));
  assert.equal(r.loop.state(), 'listening');
  assert.ok(r.listening(), 'the mic must be open again');
  r.loop.stop();
  assert.equal(r.loop.state(), 'idle');
}

// ── silence must not start a turn ──────────────────────────────────────────────
{
  let sent = 0;
  const r = rig({ send: async (t) => { sent++; return 'x'; } });
  r.loop.start();
  r.say('   '); r.say(''); r.say(null);
  await tick();
  assert.equal(sent, 0, 'blank transcripts must never reach the model');
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

// ── interim text updates the UI without ending the turn ───────────────────────
{
  const r = rig();
  r.loop.start();
  r.partial('what is the');
  assert.ok(r.states.includes('listening:what is the'), 'interim text should surface for the caption');
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

// ── a failing model keeps the conversation alive ──────────────────────────────
{
  const r = rig({ send: async () => { throw new Error('model offline'); } });
  r.loop.start();
  r.say('hello');
  await tick(); await tick();
  assert.ok(r.states.includes('error:model offline'), 'the user must be told');
  assert.equal(r.loop.state(), 'listening', 'a failed send must NOT end the session');
  r.loop.stop();
}

// ── a failing voice still continues: the answer arrived, only the audio failed ─
{
  const r = rig({ speak: async () => { throw new Error('no audio device'); } });
  r.loop.start();
  r.say('hello');
  await tick(); await tick(); await tick();
  assert.ok(r.states.includes('error:no audio device'));
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

// ── stop() during "thinking": a late reply must not restart the mic ───────────
{
  let release;
  const r = rig({ send: () => new Promise((res) => { release = () => res('late answer'); }) });
  r.loop.start();
  r.say('question');
  await tick();
  assert.equal(r.loop.state(), 'thinking');
  r.loop.stop();
  release();                       // the model answers after the user quit
  await tick(); await tick();
  assert.equal(r.loop.state(), 'idle', 'a cancelled run must stay idle');
  assert.equal(r.listening(), false, 'the mic must NOT reopen after stop()');
  assert.ok(!r.states.some((s) => s.startsWith('speaking')), 'and it must not speak the late answer');
}

// ── stop() during "speaking": audio ending must not restart the loop ──────────
{
  let endAudio;
  const r = rig({ speak: () => new Promise((res) => { endAudio = res; }) });
  r.loop.start();
  r.say('question');
  await tick(); await tick();
  assert.equal(r.loop.state(), 'speaking');
  r.loop.stop();
  endAudio();
  await tick(); await tick();
  assert.equal(r.loop.state(), 'idle');
  assert.equal(r.listening(), false);
}

// ── interrupt(): barge in mid-answer, keep the session ───────────────────────
{
  let endAudio;
  const r = rig({ speak: () => new Promise((res) => { endAudio = res; }) });
  r.loop.start();
  r.say('long question');
  await tick(); await tick();
  assert.equal(r.loop.state(), 'speaking');
  r.loop.interrupt();
  assert.equal(r.loop.state(), 'listening', 'interrupt returns to listening');
  assert.ok(r.loop.isRunning(), 'and does NOT end the session');
  endAudio();                       // the abandoned audio finishes late
  await tick(); await tick();
  assert.equal(r.loop.state(), 'listening', 'the stale audio-end must not double-advance');
  r.loop.stop();
}

// ── start() twice is a no-op, not two microphones ────────────────────────────
{
  const r = rig();
  r.loop.start();
  r.loop.start();
  r.loop.start();
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
  assert.equal(r.stops(), 1, 'only one listener should ever have been opened');
}

// ── a mic that refuses to start ends cleanly instead of hanging ──────────────
{
  const loop = createVoiceLoop({
    listen: () => { throw new Error('mic blocked'); },
    send: async () => 'x', speak: async () => {},
    onState: () => {}, onError: () => {},
  });
  loop.start();
  assert.equal(loop.state(), 'idle', 'a mic failure must land in idle, not a dead "listening"');
  assert.equal(loop.isRunning(), false);
}

// ── mute ───────────────────────────────────────────────────────────────────────
// Mute must CLOSE the mic, not filter its output. A loop that keeps recording and
// throws the text away still ships room noise to the STT engine every turn — and on
// the browser provider that means shipping it to a vendor.
{
  const r = rig();
  r.loop.start();
  assert.ok(r.listening(), 'starts listening');
  r.loop.setMuted(true);
  assert.equal(r.listening(), false, 'muting must stop the listener, not just ignore it');
  assert.equal(r.loop.state(), 'muted');
  assert.ok(r.loop.isRunning(), 'and must NOT end the session');
  r.loop.setMuted(false);
  assert.ok(r.listening(), 'unmuting reopens the mic');
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

// Muting mid-answer is allowed, and must not claim the assistant stopped talking.
{
  let endAudio;
  const r = rig({ speak: () => new Promise((res) => { endAudio = res; }) });
  r.loop.start();
  r.say('question');
  await tick(); await tick();
  assert.equal(r.loop.state(), 'speaking');
  r.loop.setMuted(true);
  assert.equal(r.loop.state(), 'speaking', 'a mute pressed mid-answer must not hijack the display');
  endAudio();
  await tick(); await tick();
  assert.equal(r.loop.state(), 'muted', 'but the turn must end into muted, not reopen the mic');
  assert.equal(r.listening(), false);
  r.loop.stop();
}

// Unmuting while the assistant is still talking just clears the flag; the turn
// ends into listening as usual.
{
  let endAudio;
  const r = rig({ speak: () => new Promise((res) => { endAudio = res; }) });
  r.loop.start();
  r.loop.setMuted(true);
  r.loop.setMuted(false);
  r.say('question');
  await tick(); await tick();
  r.loop.setMuted(true);
  r.loop.setMuted(false);
  endAudio();
  await tick(); await tick();
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

// Interrupt while muted must not sneak the mic back open.
{
  const r = rig();
  r.loop.start();
  r.loop.setMuted(true);
  r.loop.interrupt();
  assert.equal(r.listening(), false, 'barge-in must respect mute');
  assert.equal(r.loop.state(), 'muted');
  r.loop.stop();
}

// Redundant calls are no-ops, and a new session never starts silently deaf.
{
  const r = rig();
  r.loop.start();
  r.loop.setMuted(true);
  r.loop.setMuted(true);
  assert.equal(r.stops(), 1, 'muting twice must not stop a listener twice');
  r.loop.stop();
  assert.equal(r.loop.isMuted(), false, 'stop() clears mute — the next session opens with the mic on');
  r.loop.start();
  assert.equal(r.loop.state(), 'listening');
  r.loop.stop();
}

console.log('✓ voice-loop: full cycle, silence ignored, interim captions, send/speak failures survive, stop beats late reply + late audio, barge-in keeps session, double-start safe, mic failure lands idle, mute closes the mic and survives mid-answer');
