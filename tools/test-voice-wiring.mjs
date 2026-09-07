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
  assert.ok(referenced.size >= 6, `expected the voice UI to reference several ids, saw ${referenced.size}`);
  for (const id of referenced) {
    assert.ok(idsInHtml.has(id), `sidepanel.html has no #${id}, but the JS reaches for it — the control would be silently dead`);
  }
}

// ── and every control in the overlay must be wired to something ────────────────
{
  const overlay = html.slice(html.indexOf('id="voice-overlay"'), html.indexOf('</div>', html.indexOf('voice-privacy')));
  for (const m of overlay.matchAll(/<button[^>]*\bid="([^"]+)"/g)) {
    const id = m[1];
    assert.match(panel, new RegExp(`\\$\\('${id}'\\)\\.onclick`), `#${id} is in the overlay but nothing wires its onclick`);
  }
}

// ── the states the JS writes are the states the CSS styles ─────────────────────
{
  const written = new Set([...mode.matchAll(/setState\('([a-z]+)'/g)].map((m) => m[1]));
  // LABEL is the module's own list of what it can display.
  const labelDecl = mode.match(/const LABEL = \{([^}]+)\}/);
  assert.ok(labelDecl, 'voice-mode must declare a LABEL map of the states it can show');
  const labelled = new Set([...labelDecl[1].matchAll(/(\w+):/g)].map((x) => x[1]));
  for (const st of written) assert.ok(labelled.has(st), `voice-mode writes state "${st}" but LABEL has no text for it`);
  for (const st of ['listening', 'thinking', 'speaking']) {
    assert.ok(css.includes(`[data-state="${st}"]`), `sidepanel.css does not style the "${st}" state — the orb would not change`);
  }
}

// ── motion is the signal, so reduced-motion must not leave three identical rings ─
{
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.voice-orb')));
  assert.ok(rm.includes('animation: none'), 'reduced motion must stop the orb animation');
  assert.ok(/thinking"\].*border-style|speaking"\].*opacity/s.test(rm.slice(0, 400)),
    'with motion suppressed the orb still has to distinguish the states some other way');
}

// ── the privacy line is not optional ───────────────────────────────────────────
{
  assert.ok(idsInHtml.has('voice-privacy'), 'the overlay must have somewhere to say where audio is handled');
  assert.match(mode, /voice-privacy/, 'voice-mode must fill it in');
  assert.match(mode, /bothLocal/, 'and it must distinguish fully-local from anything else');
}

// ── speech must never be a static import on a first-paint entry ────────────────
// (the budget test measures bytes; this one names the rule, so a violation reads as
// "you broke the deferral" rather than "the number went up")
{
  for (const [name, src] of [['sidepanel.js', panel]]) {
    for (const mod of ['speech.js', 'read-aloud.js', 'voice-loop.js', 'voice-mode.js']) {
      const staticImport = new RegExp(`^import[^\\n]*from '\\./js/${mod.replace('.', '\\.')}'`, 'm');
      assert.ok(!staticImport.test(src), `${name} statically imports ${mod} — it must be await import()ed at the call site`);
    }
  }
}

// ── the capability modules stay platform-free where they claim to be ───────────
{
  // voice-loop is the one that must run under node with no DOM — it is why the
  // loop is testable at all.
  const loop = read('js/voice-loop.js');
  for (const bad of ['document.', 'window.', 'chrome.', 'navigator.']) {
    assert.ok(!loop.includes(bad), `voice-loop.js touches ${bad} — every platform capability there is meant to be injected`);
  }
  // speech.js may use window/Audio (it is the audio layer) but must not reach into
  // the panel's DOM.
  assert.ok(!speech.includes('document.querySelector'), 'speech.js must not reach into the page it is used from');
  assert.ok(!readAloud.includes("import('./voice-mode.js')"), 'read-aloud must not depend on voice mode — the Speak button works without it');
}

// ── mute and the waveform ──────────────────────────────────────────────────────
{
  assert.ok(idsInHtml.has('voice-mute'), 'the overlay needs a mute control — a live mic in a noisy room is the common case');
  assert.ok(idsInHtml.has('voice-wave'), 'and a canvas for the waveform');
  assert.match(panel, /\$\('voice-mute'\)\.onclick/, 'mute must be wired');
  assert.match(mode, /toggleMute/, 'and the session must expose the toggle');
  // Muted is a state the user can be left in, so it needs a label and a look.
  assert.match(mode, /muted:/, 'LABEL must name the muted state');
  assert.ok(css.includes('[data-state="muted"]'), 'the orb must stop breathing when muted — it is not listening');
  // The waveform is signal-driven; it must hide when there is no signal.
  assert.match(mode, /stopWave|classList\.add\('hidden'\)/, 'the canvas must hide when nothing is playing');
  assert.match(mode, /getByteFrequencyData/, 'the waveform must read the analyser, not a timer');
  assert.match(mode, /prefers-reduced-motion/, 'and must not animate for someone who asked it not to');

  // The waveform must follow whatever is making sound NOW — the mic while
  // listening, the speaker while speaking. A shape that only moves for one of them
  // leaves the other half of the conversation looking dead.
  assert.match(mode, /d\.analyser/, 'listening must draw from the microphone');
  assert.match(mode, /speaker\.analyser/, 'speaking must draw from the playing audio');
  // Re-read per frame: neither analyser exists at the moment the loop is armed.
  assert.match(mode, /getAnalyser\(\)/, 'the analyser must be re-read each frame, not captured once');
  assert.match(read('js/dictation.js'), /analyser: \(\) => micAnalyser/, 'dictation must expose its mic tap');

  // Thinking is the longest wait; it needs both motion and streaming text or it
  // reads as a hang.
  assert.ok(css.includes('voice-think'), 'the thinking state needs its own motion');
  assert.match(mode, /onTurnDelta/, 'partial reply text must reach the overlay');
  assert.match(panel, /onTurnDelta,/, 'and the panel must hand the subscription to voice mode');
  // Match the CALL inside the stream's flush, not merely the function's existence —
  // a defined-but-never-called notifier passes a looser check while the overlay
  // sits on "Thinking…" for the whole generation.
  const flushBody = panel.slice(panel.indexOf('const flush = () => {'), panel.indexOf('let dl = null'));
  assert.match(flushBody, /notifyTurnDelta\(assistant\)/,
    'the streaming flush must emit the partial text — defining the notifier is not enough');

  // Drawing must not WRITE. A render that persists config re-triggers the refresh
  // that re-renders it, and the select rebuilds under the cursor several times a
  // second — which is what "the selection is super jittery" was.
  const settingsSrc = read('settings.js');
  const voicesRenderer = settingsSrc.slice(settingsSrc.indexOf('function renderTtsVoices'), settingsSrc.indexOf('function renderTtsDtype'));
  // sel.onchange assignments are fine — those run on interaction, not on draw.
  const drawBody = voicesRenderer.replace(/sel\.onchange[^;]*;/g, '');
  assert.ok(!/selectTtsModel\(/.test(drawBody),
    'renderTtsVoices must not call selectTtsModel while DRAWING — that is a render→post→render loop');
  assert.match(settingsSrc, /function setOptions/, 'options must only be rewritten when they actually change');
}

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

console.log('✓ voice wiring: every id exists, every overlay button is wired, states match CSS, reduced-motion still distinguishes them, privacy line present, no static speech imports, loop stays DOM-free, settings TTS manager wired, mute + signal-driven waveform, TTS search wired, recorded voices confirmed + mic released, auto-stop + phonetic prompt + retry keeps the take, waveform follows mic AND speaker, thinking streams, rendering never writes config, voices rename + re-record in place');
