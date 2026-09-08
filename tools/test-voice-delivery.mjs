// The delivery path: from a caption arriving to a command actually being dispatched.
//
// Everything upstream of this was tested — the parser, the intents, the gate, the dedupe —
// and a spoken command still did nothing, intermittently, in a way that looked like the
// wake word had not been heard. The hole was in the plumbing between them, and it could not
// be reached by a test because the drain read the wall clock. It takes one now.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  scanDelta, createUtteranceGate, createVoiceDrain, outcomeMessage,
} = await import('../extension/js/voice-commands.js');
const { UTTERANCE_SETTLE_MS } = await import('../extension/js/events/voice-intents.js');

const NOTE = 'Okay, chat panel. Take the notes of whatever that we spoke so far in chat panel notes.';

/** A drain wired to a clock we control, collecting what it dispatches. */
function harness(clock) {
  const gate = createUtteranceGate();
  const dispatched = [];
  const drain = createVoiceDrain({
    gate,
    actions: { run: async () => ({ ok: true }) },
    engine: {
      dispatch: async (ev) => {
        dispatched.push(ev.payload.command);
        return [{ ruleId: 'rule:voice-command', fired: true, result: { ok: true, command: ev.payload.command } }];
      },
    },
    isLive: () => true,
    now: () => clock.t,
    // The silence timer is the OTHER delivery route; a test of the caption route must not be
    // rescued by it, so it is captured rather than run.
    setTimer: (fn, ms) => { clock.pending = { fn, ms }; return 1; },
    clearTimer: () => { clock.pending = null; },
  });
  return { gate, drain, dispatched };
}

/** Feed one caption, the way onMeetingDelta does — scan, then drain what the scan took. */
async function caption(h, clock, text) {
  const ready = scanDelta({
    segments: [{ t: clock.t, speaker: 'You', text }],
    voice: { enabled: true, from: 'me' },
    meetingId: 'm',
    sinceTs: clock.t - 1,
    now: clock.t,
    gate: h.gate,
  });
  await h.drain('m', ready);
  return ready;
}

// ── a command that comes due AS a caption lands is not thrown away ─────────
//
// `commandsFromSegments` ends in `gate.offer(found, now).due(now)` when it is given a gate —
// it OFFERS and it DRAINS. So a request whose settle window expires at the moment the next
// caption arrives leaves the gate inside the scan and is returned to the caller. The panel
// discarded that return value and then asked the gate again, which by then held nothing:
// the command was gone, and with nothing left waiting there was no timer to come back for it
// either. It survived only if the speaker fell silent — the one thing nobody does while
// demonstrating a feature, which is why this read as "it worked, then nothing worked".
{
  const clock = { t: 1_700_000_000_000, pending: null };
  const h = harness(clock);

  await caption(h, clock, NOTE);
  assert.equal(h.dispatched.length, 0, 'still being said — nothing acts yet');

  // The next caption lands after the settle window. THIS is the scan that drains.
  clock.t += UTTERANCE_SETTLE_MS + 1000;
  const ready = await caption(h, clock, `${NOTE} So that is good.`);
  assert.ok(ready.length >= 1, 'the scan is what took it out of the gate');
  assert.equal(h.dispatched.length, 1, 'and it must still be dispatched — this is the bug');
  assert.match(h.dispatched[0].command, /Take the notes/);
}

// ── the silence route still works, and neither route double-fires ──────────
{
  const clock = { t: 1_700_000_000_000, pending: null };
  const h = harness(clock);
  await caption(h, clock, NOTE);
  assert.equal(h.dispatched.length, 0);
  assert.ok(clock.pending, 'with something waiting, the drain must arrange to come back');

  // The speaker stops. No more captions — only the timer.
  clock.t += UTTERANCE_SETTLE_MS + 1000;
  await clock.pending.fn();
  await new Promise((r) => setImmediate(r)); // the timer callback does not await its own drain
  assert.equal(h.dispatched.length, 1, 'silence still delivers');

  // And a redelivery of the very same caption afterwards does nothing.
  clock.t += 4000;
  await caption(h, clock, `${NOTE} So that is good.`);
  assert.equal(h.dispatched.length, 1, 'said once, done once');
}

// ── the product's own name, said as a word, is not a second command ────────
//
// "…take the notes of whatever we spoke so far in CHAT PANEL notes" holds the wake phrase
// twice. The second was read as a fresh address, which cut the command down to "…so far"
// (losing where the notes were meant to go) and emitted "notes. So that is good." as a
// command of its own — which noteIntent matched. One request, two notes.
{
  const clock = { t: 1_700_000_000_000, pending: null };
  const h = harness(clock);
  await caption(h, clock, NOTE);
  clock.t += UTTERANCE_SETTLE_MS + 1000;
  await caption(h, clock, `${NOTE} So that is good.`);
  assert.equal(h.dispatched.length, 1, 'one spoken request is one command');
  assert.match(
    h.dispatched[0].command, /in chat panel notes/,
    'and it keeps the words the mention used to truncate away',
  );
}

// ── a monitor that was refused must not be reported as started ─────────────
//
// Every refusal in addMonitor used to `return` bare, which an `await` cannot tell from
// success, so the spoken path toasted "Watching: …" over the top of the explanation that had
// just been shown. The user got a confirmation, no card, and no reason.
{
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const add = /async function addMonitor\([\s\S]*?\n\}/.exec(panel)[0];
  assert.match(add, /return \{ ok: true, monitor: m \}/, 'success is stated');
  for (const reason of ['no-meeting', 'not-entitled', 'analyzer-off', 'no-prompt', 'no-conversation']) {
    assert.ok(add.includes(`'${reason}'`), `and "${reason}" comes back as a reason, not as silence`);
  }
  // Both spoken call sites must ASK, and must not announce twice.
  const sites = panel.match(/const r = await addMonitor\([^)]*\);/g) || [];
  assert.equal(sites.length, 2, 'the bound intent and the refined kind');
  for (const s of sites) assert.match(s, /announce: false/, 'the caller reports it, so addMonitor stays quiet');
  assert.equal(
    (panel.match(/if \(!r\?\.ok\) throw new Error\(/g) || []).length, 2,
    'and a refusal becomes a failed outcome rather than a "Watching:" toast',
  );
}

// ── and a declined command says so ─────────────────────────────────────────
assert.match(
  outcomeMessage({ ok: false, reason: 'not-a-request', command: { command: 'go to google.com and search' } }),
  /couldn’t tell what you wanted/i,
);

console.log('ok — a caption that settles mid-conversation is delivered, once, whole, and refusals are reported');
