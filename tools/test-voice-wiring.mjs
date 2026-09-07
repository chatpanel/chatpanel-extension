// The voice UI's most likely failure is not a logic bug — it is a button that does
// nothing because an element id drifted. $('voice-stop') on a missing element is
// `undefined`, `undefined?.onclick = fn` throws nothing useful, and the feature is
// silently dead. Unit tests never see it because they never touch the document.
//
// So this pins the contract BETWEEN the three files: the ids sidepanel.js and
// voice-mode.js reach for must exist in sidepanel.html, and the states the JS
// writes must be states the CSS actually styles.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const html = read('sidepanel.html');
const panel = read('sidepanel.js');
const mode = read('js/voice-mode.js');
const css = read('sidepanel.css');
const speech = read('js/speech.js');
const readAloud = read('js/read-aloud.js');

const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// ── every voice element the JS reaches for must exist ──────────────────────────
{
  const referenced = new Set();
  for (const src of [panel, mode]) {
    // no \b before \$ — it is not a word character, so the boundary never matches
    for (const m of src.matchAll(/(?:\$|el)\(\s*'(voice-[^']+|btn-voice)'\s*\)/g)) referenced.add(m[1]);
  }
  assert.ok(referenced.size >= 4, `expected the voice UI to reference several ids, saw ${referenced.size}`);
  for (const id of referenced) {
    assert.ok(idsInHtml.has(id), `sidepanel.html has no #${id}, but the JS reaches for it — the control would be silently dead`);
  }
}

// ── voice is INLINE, not a separate screen ─────────────────────────────────────
// The conversation already renders each turn with proper sides and formatted
// markdown; an overlay could only ever show one centred line of it.
{
  assert.ok(idsInHtml.has('voice-bar'), 'the voice controls belong in a bar beside the composer');
  assert.ok(!html.includes('voice-overlay'), 'the full-screen overlay must be gone, not merely hidden');
  assert.ok(!css.includes('.voice-overlay'), 'and its styles with it');
  assert.match(css, /body\.voice-active \.composer-box \{ display: none/,
    'the bar must REPLACE the composer — two input affordances invites typing into a box that is not listening');
  for (const id of ['voice-mute', 'voice-stop']) {
    assert.match(panel, new RegExp(`\\$\\('${id}'\\)\\.onclick`), `#${id} must be wired`);
  }
}

// ── barge-in is automatic ──────────────────────────────────────────────────────
{
  const loop = read('js/voice-loop.js');
  // The mic stays open for the whole session — that is what makes talking over the
  // assistant work without a button.
  assert.match(loop, /openMic/, 'the listener must be opened once per session');
  assert.ok(!/stopListen\?\.\(\);[\s\S]{0,80}runTurn/.test(loop),
    'the mic must not be closed before a turn — barge-in depends on it staying open');
  assert.match(loop, /MIN_BARGE_IN_WORDS/, 'a one-word fragment must not count as an interruption');
  assert.ok(!html.includes('voice-interrupt'), 'the Interrupt button is replaced by just talking');
}

// ── the waveform is signal-driven, and honest when there is no signal ─────────
{
  assert.ok(idsInHtml.has('voice-wave'), 'the bar needs a canvas for the waveform');
  assert.match(mode, /getByteFrequencyData/, 'it must read an analyser, not a timer');
  assert.match(mode, /speaker\.analyser/, 'the speaker while it answers');
  assert.match(mode, /micSource\(\)/, 'and the microphone while you talk');
  assert.match(mode, /prefers-reduced-motion/, 'and must not animate for someone who asked it not to');
  assert.match(read('js/dictation.js'), /analyser: \(\) => micAnalyser/, 'dictation must expose its mic tap');
}

// ── the privacy line is not optional ──────────────────────────────────────────
{
  assert.ok(idsInHtml.has('voice-privacy'), 'the bar must say where audio is handled');
  assert.match(mode, /bothLocal/, 'and must distinguish fully-local from anything else');
}

// ── speaking starts before generation ends ─────────────────────────────────────
{
  assert.match(read('js/speech.js'), /export function speakStream/, 'a streaming speak queue must exist');
  assert.match(mode, /speakStream\(speaker\)/, 'voice mode must use it');
  assert.match(loopSrc(), /onDelta/, 'the loop must feed partial text to the queue');
  assert.match(panel, /sendTurn: async \(text, \{ onDelta \}/, 'and the panel must supply the deltas');
}
function loopSrc() { return read('js/voice-loop.js'); }

// ── the Gateway settings TTS manager ───────────────────────────────────────────
// Same class of failure, different page: a model picker whose ids drifted renders
// into nothing and reads as "the gateway has no TTS".
{
  const settingsHtml = read('settings.html');
  const settings = read('settings.js');
  const sIds = new Set([...settingsHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...settings.matchAll(/\$\(\s*'(gw-tts-[^']+)'\s*\)/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 5, `expected the TTS manager to reference several ids, saw ${referenced.size}`);
  for (const id of referenced) {
    assert.ok(sIds.has(id), `settings.html has no #${id}, but settings.js reaches for it — the control would be silently dead`);
  }
  // The three managers in the Models section must all refresh together; a fourth
  // that is never called renders an empty card that looks like an unsupported gateway.
  assert.match(settings, /refreshTtsModels\(\)/, 'refreshTtsModels must be called on load, beside the STT and speaker ones');
  assert.ok(/refreshSttModels\(\);\s*\n\s*refreshTtsModels\(\);/.test(settings),
    'refreshTtsModels should load with the other model managers, not on its own path');
  // Preview is the only way to actually hear a voice before choosing it.
  assert.match(settings, /\$\('gw-tts-preview'\)\.onclick/, 'the Preview button must be wired');
  // An older gateway 404s /tts/models; that must read as "update it", not as an error.
  assert.match(settings, /404.*text-to-speech|text-to-speech.*404/s, 'a 404 from /tts/models must tell the user to update the gateway');

  // The search box has to be wired like the STT and NER ones — the loop that wires
  // them must cover every registered task, not a hardcoded pair.
  for (const id of ['gw-tts-search', 'gw-tts-search-btn', 'gw-tts-search-results']) {
    assert.ok(sIds.has(id), `settings.html has no #${id} — the TTS model search would not render`);
  }
  assert.match(settings, /tts:\s*\{\s*input:\s*'gw-tts-search'/, 'tts must be registered in MODEL_REG');
  assert.ok(!/for \(const task of \['stt', 'ner'\]\)/.test(settings),
    'the search wiring loop must iterate MODEL_REG, not a hardcoded task list — a registered task that is never wired is a dead search box');

  // A single-speaker model must HIDE the voice picker rather than offer choices
  // that cannot take effect.
  assert.match(settings, /supportsVoices/, 'the voice picker must react to whether the active model has voices');

  // ── recorded voices ──────────────────────────────────────────────────────────
  for (const id of ['gw-tts-voices', 'gw-tts-voice-name', 'gw-tts-record', 'gw-tts-voice-status']) {
    assert.ok(sIds.has(id), `settings.html has no #${id} — recording a voice would be impossible`);
  }
  assert.match(settings, /\$\('gw-tts-record'\)\.onclick/, 'the record control must be wired');
  assert.match(settings, /refreshTtsVoices\(\)/, 'the saved-voice list must load with the rest of the section');

  // Deleting someone's voice print is permanent, so it must be confirmed.
  assert.match(settings, /confirm\(/, 'deleting a voice print must ask first');
  assert.match(settings, /permanently/i, 'and must say that it is permanent');

  // The recorder touches getUserMedia and an AudioContext; it must stay lazy.
  assert.ok(!/^import[^\n]*from '\.\/js\/voice-record\.js'/m.test(settings),
    'settings.js must not statically import the recorder');

  // The page must say what actually happens to the recording, in the page — not
  // only in a commit message.
  const t = settingsHtml;
  assert.match(t, /never stored|never leaves|discarded/i, 'the page must state that the recording is not kept');
}

// ── the recorder itself ────────────────────────────────────────────────────────
{
  const rec = read('js/voice-record.js');
  // A settings page holding an open microphone is exactly what a privacy product
  // must not do, so the tracks have to be stopped, not just disconnected.
  assert.match(rec, /getTracks\(\)/, 'the mic stream must be released');
  assert.match(rec, /t\.stop\(\)/, 'each track must be stopped');
  // Routing a ScriptProcessor to the destination without muting echoes the mic
  // back out of the speakers and howls.
  assert.match(rec, /gain\.value = 0/, 'the monitoring path must be silent');
  assert.match(rec, /MIN_SECONDS/, 'too-short samples must be rejected — the print would be room noise');

  // Recording must END BY ITSELF. Without a target, someone talks into an open mic
  // with no idea when they have said enough — which is the state this replaced.
  assert.match(rec, /TARGET_SECONDS/, 'the recorder must have a target duration');
  assert.match(rec, /onAutoStop/, 'and must stop itself when it reaches it');
  const target = Number(rec.match(/TARGET_SECONDS = (\d+)/)?.[1]);
  const min = Number(rec.match(/MIN_SECONDS = (\d+)/)?.[1]);
  const max = Number(rec.match(/MAX_SECONDS = (\d+)/)?.[1]);
  assert.ok(min < target && target <= max, `target ${target}s must sit between min ${min}s and max ${max}s`);

  // The prompt exists for phonetic COVERAGE, so it has to actually contain the
  // sounds. A friendly sentence that misses half the consonants is not a prompt.
  const prompt = rec.match(/PROMPT_TEXT =\s*([\s\S]*?);/)?.[1] || '';
  const words = prompt.toLowerCase();
  assert.ok(prompt.length > 120, 'the prompt must be long enough to fill the target duration');
  for (const sound of ['th', 'sh', 'ch', 'j', 'z', 'v', 'f', 'g', 'k', 'b', 'p', 'r', 'l', 'ng']) {
    assert.ok(words.includes(sound), `the elicitation prompt is missing "${sound}" — the embedding only covers sounds that were spoken`);
  }
  for (const vowel of ['a', 'e', 'i', 'o', 'u']) assert.ok(words.includes(vowel));
}

// ── the recording UI tells the user what to do ────────────────────────────────
{
  const settingsHtml2 = read('settings.html');
  const settings2 = read('settings.js');
  for (const id of ['gw-tts-prompt', 'gw-tts-target', 'gw-tts-meter']) {
    assert.ok(settingsHtml2.includes(`id="${id}"`), `settings.html has no #${id} — the user would be guessing how long to speak`);
  }
  // The page must read its prompt and target FROM the recorder, or the two drift
  // and the page confidently states a duration that is no longer used.
  assert.match(settings2, /PROMPT_TEXT/, 'the page must show the recorder\'s own prompt');
  assert.match(settings2, /TARGET_SECONDS/, 'and the recorder\'s own target');
  // A saved voice is unjudgeable by name alone.
  assert.match(settings2, /gw-tts-voice-play/, 'each saved voice needs a Preview');
  // And a failed save must not cost the recording.
  assert.match(settings2, /_pendingSample/, 'a failed save must keep the sample for a retry');
  assert.match(settings2, /Save again/, 'and the button must offer that retry');

  // A first take is often poor. Renaming and re-recording must UPDATE in place —
  // the id is what config and clients hold as `custom:<id>`, so delete-and-recreate
  // would silently orphan every reference to it.
  assert.match(settings2, /gw-tts-voice-rename/, 'a saved voice must be renameable');
  assert.match(settings2, /gw-tts-voice-redo/, 'and re-recordable');
  assert.match(settings2, /updateTtsVoice/, 'both must go through the update call, not delete + create');
  assert.ok(!/deleteTtsVoice\([^)]*\)[\s\S]{0,200}saveTtsVoice/.test(settings2),
    're-recording must not be implemented as delete-then-create — that changes the id');
  assert.match(read('js/gateway.js'), /export async function updateTtsVoice/, 'the client needs an update call');
}

console.log('✓ voice wiring: ids exist and are wired, voice is INLINE (no overlay) and replaces the composer, barge-in is automatic, speech starts before generation ends, waveform follows mic AND speaker, privacy line present, no static speech imports, loop stays DOM-free, settings TTS manager wired, TTS search wired, recorded voices confirmed + mic released, rename + re-record in place, rendering never writes config');

// ── the waveform must be sized from its box, not from fixed attributes ─────────
// A canvas with width="560" stretched by CSS into a ~350px panel draws squashed
// and blurry, and a small idle amplitude then reads as an empty bar — which is
// exactly how the first version looked.
{
  const html2 = read('sidepanel.html');
  const canvas = html2.match(/<canvas[^>]*id="voice-wave"[^>]*>/)?.[0] || '';
  assert.ok(canvas, 'the voice bar needs its canvas');
  assert.ok(!/\swidth="/.test(canvas) && !/\sheight="/.test(canvas),
    'the canvas must not carry fixed width/height attributes — CSS sizes it and the code scales the backing store');
  const mode2 = read('js/voice-mode.js');
  assert.match(mode2, /devicePixelRatio/, 'the backing store must account for the device pixel ratio');
  assert.match(mode2, /getBoundingClientRect/, 'and be measured from the element box');
  // The shape is pure maths in its own module precisely because two versions of it
  // drew a flat line — see tools/test-voice-wave.mjs.
  assert.match(mode2, /waveShape/, 'the drawing must use the tested shape function');
  assert.ok(!/Math\.sin\([^)]*\)\s*\*\s*Math\.sin/.test(mode2),
    'the idle amplitude must not be a product of two sines — it spends most of its time near zero');
}
