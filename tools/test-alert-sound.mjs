// A timer that finishes silently is a timer that did not go off.
//
// Jobs and widget timers delivered a chrome notification and nothing else — and a
// notification is a thing you SEE, which is no use at all for the one feature whose entire
// point is telling you about something while you are looking elsewhere. On Windows especially
// Chrome's own notifications frequently arrive silent (Focus Assist, per-app settings), so
// "the OS will chime" was never a plan.
//
// The awkward part is WHERE. A service worker has no audio API at all — no `new Audio()`, no
// AudioContext — and a worker also cannot `import()`. Both constraints shape this.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');

// ── the chime itself: synthesized, and it never throws ───────────────────────────
{
  const played = [];
  class FakeParam { constructor() { this.value = 0; } setValueAtTime() {} exponentialRampToValueAtTime() {} }
  class FakeNode { constructor(k) { this.kind = k; this.gain = new FakeParam(); this.frequency = new FakeParam(); }
    connect() {} disconnect() {} start(t) { played.push([this.frequency.value, t]); } stop() {} }
  globalThis.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = 'running'; }
    createGain() { return new FakeNode('gain'); }
    createOscillator() { return new FakeNode('osc'); }
    close() {}
  };
  const { playAlert, closeAlertAudio, DEFAULT_GAIN } = await import('../extension/js/alert-sound.js');

  assert.equal(await playAlert(), true, 'it must actually play');
  assert.ok(played.length >= 2, 'the chime is more than one note');
  assert.ok(played.every(([f]) => f > 0), 'every note needs a frequency');
  // A suspended context is the NORMAL state in an offscreen document — there is no user
  // gesture there, and without resume() the timer would be silent for the exact reason the
  // feature exists to avoid.
  assert.match(read('js/alert-sound.js'), /if \(ctx\.state === 'suspended'\) await ctx\.resume\(\);/);

  const before = played.length;
  await playAlert({ repeat: 2 });
  assert.ok(played.length - before > before, 'repeat must sound it more than once');

  assert.ok(DEFAULT_GAIN > 0 && DEFAULT_GAIN < 0.5, 'audible, but it must not startle someone in headphones');
  closeAlertAudio();

  // No audio at all → false, never a throw. A timer whose sound failed must still notify.
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  assert.equal(await playAlert(), false, 'a context with no audio must resolve false');
}

// Synthesized, not an asset: nothing to 404, nothing to decode, nothing in the package.
const sound = read('js/alert-sound.js');
assert.doesNotMatch(sound, /\.(mp3|wav|ogg|m4a)\b/i, 'the chime must be generated, not shipped');
assert.doesNotMatch(sound, /^\s*import\s/m, 'and must stay dependency-free — it runs in three contexts');

// ── the worker path: static, because import() throws in a service worker ─────────
const bg = read('background.js');
assert.match(
  bg, /^import \{ playAlertViaOffscreen \} from '\.\/js\/offscreen-host\.js';$/m,
  'the worker must import the alert STATICALLY — a lazily-imported chime is one that never '
  + 'plays, because import() is disallowed on ServiceWorkerGlobalScope',
);
const host = read('js/offscreen-host.js');
assert.doesNotMatch(host, /await import\(|import\(['"]/, 'nothing on the worker graph may import() at runtime');

// It must fire independently of the notification, and never block it.
assert.match(bg, /soundAlert\(job\)\.catch\(\(\) => \{\}\);/, 'unawaited — the alert must not gate the notification');
const deliver = /async function deliverNotify\([\s\S]*?\n\}/.exec(bg)?.[0] || '';
assert.ok(deliver.indexOf('soundAlert') < deliver.indexOf('chrome.notifications'),
  'sound first: the notification may be suppressed by the OS, the sound is ours');

// ── off is a real choice ─────────────────────────────────────────────────────────
assert.match(bg, /if \(ui\?\.alertSound === false\) return;/, 'a chiming browser is unwelcome in a shared office');
assert.match(read('js/store.js'), /alertSound: true,/, 'but the default is on — that is the whole feature');
assert.match(read('settings.html'), /id="pref-alert-sound"/, 'and it needs a switch');
const settings = read('settings.js');
assert.match(settings, /settings\.ui\.alertSound = \$\('pref-alert-sound'\)\.checked;/, 'which saves');
assert.match(settings, /\$\('pref-alert-sound'\)\.onchange/, 'on change');
assert.match(settings, /playAlert\(\)\.catch/, 'and plays a sample — otherwise you can only test it by waiting for a timer');

// ── opening the offscreen document must not cost 6.3 MB ──────────────────────────
// It used to load the WebLLM runtime eagerly, which was tolerable while running the model was
// the only reason to open it. A two-note chime cannot cost six megabytes.
assert.match(read('offscreen.html'), /src="js\/offscreen\.js"/, 'the page loads the router');
const router = read('js/offscreen.js');
assert.doesNotMatch(router, /^\s*import .* from/m, 'the router must import nothing statically');
assert.match(router, /import\('\.\/offscreen-webllm\.js'\)/, 'the engine is fetched on the first message that needs it');
assert.match(router, /import\('\.\/alert-sound\.js'\)/, 'and so is the chime');
assert.match(
  read('js/offscreen-webllm.js'), /export function handleWebllmMessage\(msg\)/,
  'the engine must EXPORT its handler — a listener registered at module scope would attach '
  + 'after the very message that loaded it',
);
// One document, two uses: its reasons must cover both at creation, since Chrome allows one.
assert.match(host, /const REASONS = \['WORKERS', 'AUDIO_PLAYBACK'\];/);
assert.match(host, /single offscreen document/i, 'two callers racing to create it is success, not failure');

console.log('alert sound: ok');
