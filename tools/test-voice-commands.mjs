// Spoken commands: who is allowed to give one, what happens when they do, and every reason
// one might not fire. The parsing itself is tested in @chatpanel/events; this is the half
// that is bound to this client — authority, dedup and the action seam.
import assert from 'node:assert/strict';

const { createRuleEngine } = await import('../extension/js/events/rules.js');
const {
  voiceSettings, makeSelfMatcher, scanDelta, voiceCommandRule, createVoiceActions,
  dispatchVoiceCommands, outcomeMessage, DEFAULT_VOICE,
} = await import('../extension/js/voice-commands.js');

const ON = { enabled: true, wakeWord: 'ChatPanel', from: 'me', selfNames: ['Alex Rivera'] };
const segs = (text, speaker = 'Alex Rivera', t = 1000) => [{ t, speaker, text }];

// ── settings ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(voiceSettings(undefined), { ...DEFAULT_VOICE, selfNames: [] });
  assert.equal(voiceSettings({ from: 'everyone' }).from, 'me', 'an unknown source falls back to the safe one');
  assert.deepEqual(voiceSettings({ selfNames: 'Alex Rivera, Alex' }).selfNames, ['Alex Rivera', 'Alex'],
    'a comma-separated field from a settings input is accepted');
  assert.equal(voiceSettings({ wakeWord: '   ' }).wakeWord, DEFAULT_VOICE.wakeWord, 'a blank wake word cannot disarm the gate');
}

// ── who counts as "me" ─────────────────────────────────────────────────────
{
  const me = makeSelfMatcher({ from: 'me', selfNames: ['Alex Rivera'] });
  assert.equal(me('You'), true, 'Teams and Zoom label the local speaker "You"');
  assert.equal(me('Alex Rivera'), true, 'Meet resolves "You" to the real name');
  assert.equal(me('Alex'), true, 'captions sometimes carry only a first name');
  assert.equal(me('Jordan Blake'), false);
  assert.equal(me(''), false);
  assert.equal(makeSelfMatcher({ from: 'anyone', selfNames: [] })('Jordan Blake'), true);
  assert.equal(makeSelfMatcher({ from: 'off', selfNames: [] })('You'), false);
}

// ── scanning a delta ───────────────────────────────────────────────────────
{
  const found = scanDelta({ segments: segs('ChatPanel, set a timer for 10 minutes'), voice: ON, meetingId: 'm1' });
  assert.equal(found.length, 1);
  assert.equal(found[0].intent, 'voice:timer');
  assert.equal(found[0].allowed, true);
  assert.equal(found[0].args.ms, 600_000);

  assert.deepEqual(scanDelta({ segments: segs('so anyway the migration lands friday'), voice: ON }), [],
    'ordinary meeting speech costs nothing and produces nothing');
  assert.deepEqual(scanDelta({ segments: segs('ChatPanel, set a timer for 10 minutes'), voice: { ...ON, enabled: false } }), [],
    'the switch has to reach the scan, not just the UI');
  assert.deepEqual(scanDelta({ segments: segs('ChatPanel, set a timer for 10 minutes'), voice: { ...ON, from: 'off' } }), []);
  assert.deepEqual(scanDelta({ segments: segs('ChatPanel, set a timer'), voice: { ...ON, wakeWord: 'ok' } }), [],
    'a wake word too short to be safe disables the feature rather than firing on everything');

  const custom = scanDelta({ segments: segs('Jarvis, note that the budget is approved'), voice: { ...ON, wakeWord: 'Jarvis' } });
  assert.equal(custom[0].intent, 'voice:note', 'the wake word is configurable');
}

// ── dispatch: authority, action, dedup ─────────────────────────────────────
const mkEngine = (admit = () => true) => {
  const engine = createRuleEngine({ now: () => Date.now(), admit });
  engine.add(voiceCommandRule);
  return engine;
};

{
  const started = [];
  const actions = createVoiceActions();
  actions.bind('voice:monitor', async (cmd) => { started.push(cmd.args.prompt); return { message: 'ok' }; });

  const cmds = scanDelta({ segments: segs('ChatPanel, keep an eye on the pricing question'), voice: ON, meetingId: 'm1' });
  const out = await dispatchVoiceCommands(cmds, { engine: mkEngine(), actions });
  assert.equal(out[0].ok, true);
  assert.deepEqual(started, ['the pricing question']);
}

{
  // The security property: a participant saying the wake word gets a report, not an action.
  const actions = createVoiceActions();
  let ran = 0;
  actions.bind('voice:monitor', async () => { ran++; return {}; });
  const cmds = scanDelta({
    segments: segs('ChatPanel, watch for whether we agree a date', 'Jordan Blake'), voice: ON, meetingId: 'm1',
  });
  const said = [];
  const seen = new Set();
  const out = await dispatchVoiceCommands(cmds, { engine: mkEngine(), actions, seen, onOutcome: (o) => said.push(o) });
  assert.equal(ran, 0, "someone else's command must never reach an action");
  assert.equal(out[0].reason, 'not-you');
  assert.match(outcomeMessage(out[0]), /Jordan Blake/, 'and the user must be told why nothing happened');
  // …once. The line is re-offered while it is the newest thing said, and these never reach
  // the engine's dedup, so without a guard the refusal toasts on every flush.
  await dispatchVoiceCommands(cmds, { engine: mkEngine(), actions, seen, onOutcome: (o) => said.push(o) });
  assert.equal(said.length, 1, 'a refusal is surfaced once, not on every transcript flush');
}

{
  // A flush that re-sends the same line must not start two monitors.
  const actions = createVoiceActions();
  let ran = 0;
  actions.bind('voice:monitor', async () => { ran++; return {}; });
  const engine = mkEngine();
  const cmds = scanDelta({ segments: segs('ChatPanel, track who owns the migration'), voice: ON, meetingId: 'm1' });
  await dispatchVoiceCommands(cmds, { engine, actions });
  const again = await dispatchVoiceCommands(
    scanDelta({ segments: segs('ChatPanel, track who owns the migration'), voice: ON, meetingId: 'm1' }),
    { engine, actions },
  );
  assert.equal(ran, 1, 'redelivery is not a new cause');
  assert.equal(again[0].reason, 'already-fired');
  assert.equal(outcomeMessage(again[0]), '', 'and a redelivery says nothing, or every flush is a toast');
}

{
  // Switched off in Plugins means off — including for a command the user just spoke.
  const actions = createVoiceActions();
  let ran = 0;
  actions.bind('voice:monitor', async () => { ran++; return {}; });
  const cmds = scanDelta({ segments: segs('ChatPanel, monitor the hiring plan'), voice: ON, meetingId: 'm1' });
  const out = await dispatchVoiceCommands(cmds, { engine: mkEngine(() => false), actions });
  assert.equal(ran, 0);
  assert.equal(out[0].reason, 'disabled');
}

{
  // An understood command with nowhere to go says so, rather than failing silently.
  const cmds = scanDelta({ segments: segs('ChatPanel, set a timer for 10 minutes'), voice: ON, meetingId: 'm1' });
  const out = await dispatchVoiceCommands(cmds, { engine: mkEngine(), actions: createVoiceActions() });
  assert.equal(out[0].reason, 'no-action');
  assert.match(outcomeMessage(out[0]), /isn’t wired up yet/);

  // An utterance the grammar does not recognise never becomes a command at all — ordinary
  // conversation that happens to trip the wake match must not reach an action. (The shared
  // parser drops it; this asserts the client inherits that.)
  const unknown = scanDelta({ segments: segs('ChatPanel, do the thing with the stuff'), voice: ON, meetingId: 'm1' });
  assert.deepEqual(unknown, []);
  assert.match(outcomeMessage({ ok: false, reason: 'not-understood', command: { command: 'x' } }), /didn’t recognise/);
}

{
  // One spoken request keeps ONE key while the caption grows, so a rescan cannot set a
  // second timer. The key used to carry an absolute fire time (now + duration) that moved on
  // every scan, which produced a new timer per caption update.
  const keys = new Set();
  for (const text of ['ChatPanel, set a timer', 'ChatPanel, set a timer for 10', 'ChatPanel, set a timer for 10 minutes']) {
    for (const c of scanDelta({ segments: segs(text), voice: ON, meetingId: 'm1' })) keys.add(c.key);
  }
  assert.equal(keys.size, 1, 'a growing caption must not multiply into several commands');
}

{
  // An action that throws is reported, never propagated: a bad binding must not take down
  // the meeting capture that called it.
  const actions = createVoiceActions();
  actions.bind('voice:note', async () => { throw new Error('storage full'); });
  const cmds = scanDelta({ segments: segs('ChatPanel, note that we shipped'), voice: ON, meetingId: 'm1' });
  const out = await dispatchVoiceCommands(cmds, { engine: mkEngine(), actions });
  assert.equal(out[0].ok, false);
  assert.match(outcomeMessage(out[0]), /storage full/);
}

console.log('voice-commands tests passed');
