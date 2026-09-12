// The composer's live "What the model receives" panel.
//
// Two bugs it has now had, both of which made a PRIVACY indicator lie, which is the worst
// class of bug this panel can carry:
//
//   1. It awaited the detector before drawing anything, so on the model tier the panel sat
//      empty for the whole round-trip — and every error was swallowed by a bare `catch`, so
//      a detector that was down produced a panel that simply never appeared. Silence reads
//      as "nothing to redact" while the shield in the composer is still lit.
//   2. On the deterministic tier it showed a person's name back unredacted with no note,
//      which reads as "this is fine". Patterns cannot catch a name; only the detector can.
//   3. A detector that was missing or down REPLACED the panel with an orange sentence. The
//      user asked what the model receives; the answer they got was about the failure, and
//      the redactions that were still going to happen (emails, phones, cards, dictionary)
//      vanished from the screen along with it.
//
// So this file asserts the CONTRACT: the panel paints from the deterministic layer first,
// upgrades when the detector lands, and says something specific in every other case.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

// ── the seam the two-pass paint depends on ───────────────────────────────────
globalThis.chrome = {
  runtime: { getURL: (p) => p, id: 'preview-test', sendMessage: async () => ({}) },
  storage: {
    onChanged: { addListener() {} },
    local: { async get() { return {}; }, async set() {}, async remove() {} },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const { previewRedaction } = await import('../extension/js/providers.js');

const settings = (mode) => ({
  ui: {
    piiRedaction: {
      mode,
      tier: 'full',
      preview: true,
      dictionary: [],
      scope: { chat: true, context: true, history: true, toolResults: true },
      detection: {
        // A CONFIGURED detector whose endpoint cannot answer — the point is that
        // `detect: false` never reaches it, and that `detect: true` fails LOUDLY rather
        // than returning silence. `backend` matters: without it detectEntities returns []
        // before trying anything, which is the "on but not set up" state the panel now
        // reports separately.
        backend: 'endpoint',
        timeoutMs: 400,
        url: 'http://127.0.0.1:9/ner',
        types: { person: true, org: true, location: true, number: true },
      },
    },
  },
});

const SAMPLE = 'Jordan Blake at jordan@example.com, call 415-555-0134.';

// Pass 1 must be instant and must not touch the detector — that is what puts something on
// screen while the model is still thinking.
{
  const started = Date.now();
  const fast = await previewRedaction(settings('model'), SAMPLE, { detect: false });
  const ms = Date.now() - started;
  assert.ok(ms < 500, `the deterministic pass must be instant, took ${ms}ms — it is what the typist sees first`);
  assert.match(fast.redacted, /\[\[EMAIL_\d+\]\]/, 'patterns catch the email with no detector');
  assert.match(fast.redacted, /\[\[PHONE_\d+\]\]/, 'and the phone number');
  assert.deepEqual(fast.detector, [], 'detect:false must not call the detector');
  // …and it CANNOT catch the name. That limit is exactly what the panel has to disclose.
  assert.ok(fast.redacted.includes('Jordan Blake'), 'patterns cannot catch a name — the note exists to say so');
}

// The deterministic tier never calls the detector at all, whatever `detect` says.
{
  const det = await previewRedaction(settings('deterministic'), SAMPLE);
  assert.deepEqual(det.detector, [], 'the detector runs on the model tier only');
  assert.match(det.redacted, /\[\[EMAIL_\d+\]\]/);
  assert.ok(det.redacted.includes('Jordan Blake'));
}

// Pass 2 against a dead detector must REJECT, so the caller can report it. Returning an
// empty entity list here would be indistinguishable from "found nothing", and the panel
// would draw a confident preview that had checked nothing.
{
  await assert.rejects(
    () => previewRedaction(settings('model'), SAMPLE),
    'a detector that cannot be reached must surface as an error, never as "no entities"',
  );
}

// ── the panel's own contract, asserted on source ─────────────────────────────
// runPiiPreview is DOM- and module-graph-bound, so the structure is what is checkable —
// and structure is precisely what regressed both times.
const panel = read('extension/sidepanel.js');
const body = panel.slice(panel.indexOf('async function runPiiPreview()'), panel.indexOf('async function togglePiiPreview()'));
assert.ok(body, 'runPiiPreview should still exist');

assert.match(body, /previewRedaction\([^)]*\{\s*detect:\s*false\s*\}/s,
  'the panel must paint the deterministic pass BEFORE awaiting the detector');
assert.ok(body.indexOf('detect: false') < body.indexOf("paintPiiPreview(panel, fast, mode, 'failed'"),
  'the instant paint has to come first, or there is nothing on screen while the model thinks');
assert.match(body, /catch \(err\)[\s\S]*paintPiiPreview\(panel, fast, mode, 'failed', err\)/,
  'a detector failure must be REPORTED in the panel, never swallowed');
// THE DETERMINISTIC RESULT SURVIVES THE FAILURE. Both broken states hand the painter the
// pass-1 result, so a missing or dead detector costs the user the NAMES and not the panel.
for (const state of ["'failed'", "'nodetector'"]) {
  assert.ok(body.includes(`paintPiiPreview(panel, fast, mode, ${state}`),
    `the ${state} state must still show what WAS redacted, not replace it with the warning`);
}

// No bare `catch {}` may wrap the detector call again — that is the exact line that made a
// down detector look like a clean prompt.
const bareCatches = body.match(/catch \{ \/\* best-effort/g) || [];
assert.equal(bareCatches.length, 0, 'the swallow-everything catch must not come back');

// The painter lives in its own module — small, focused, and OFF the side panel's first
// paint (it is reached through an `await import()` at the call site).
assert.match(body, /await import\('\.\/js\/redact-preview\.js'\)|paintPiiPreview\(/,
  'the panel paints through the redact-preview module');
assert.doesNotMatch(panel.slice(0, panel.indexOf('async function init')),
  /^import .*redact-preview\.js/m,
  'the preview painter must not be a static import — it is action-only weight');
const painter = read('extension/js/redact-preview.js');
assert.match(painter, /rp-warn/, 'a detector that is not answering must look different from one that found nothing');
assert.match(painter, /are NOT redacted/, 'and it must say plainly what is no longer covered');
assert.match(painter, /Patterns only/, 'the deterministic tier must disclose that it cannot catch names');
assert.match(painter, /rp-upgrade/, 'and offer the one-click fix');
// The warning is a NOTE under the text, not the text's replacement: the painter renders the
// redacted draft whenever it has one, in every state.
assert.match(painter, /if \(!result\)/, 'the painter must handle "no result" as the special case, not the norm');
assert.match(painter, /Replaced \$\{tally\}/, 'and say what was replaced, by kind');

const css = read('extension/sidepanel.css');
for (const cls of ['rp-note', 'rp-upgrade', 'rp-warn', 'rp-sum']) {
  assert.ok(css.includes(`.redact-preview .${cls}`), `${cls} is rendered but has no style`);
}

// An unconfigured detector returns [] rather than throwing, so "detection is on" and
// "detection can run" are different facts and the panel must check the second itself.
{
  const bare = settings('model');
  delete bare.ui.piiRedaction.detection.backend;
  const out = await previewRedaction(bare, SAMPLE);
  assert.deepEqual(out.detector, [], 'an unconfigured detector reports nothing, quietly');
  assert.ok(out.redacted.includes('Jordan Blake'),
    'which is exactly why the panel must say so — this looks identical to "found no names"');
}
assert.match(body, /'nodetector'/,
  'the panel must detect "model tier on, no detector configured" itself — it is the commonest broken state');
assert.match(painter, /no detector is set up/, 'and say so in words');

// ── the reply itself must never carry a placeholder ─────────────────────────
// Redaction is for the model's benefit. A [[PERSON_5]] on screen where a colleague's name
// belongs is always a bug, and an invisible one — the turn that caused it is over by the
// time anyone reads it. streamChat restores against the turn's vault, but not every path
// HAS one: a local agent under "redact for remote only" runs with none, while tool results
// reaching it can already carry placeholders minted elsewhere.
{
  const { createVault, redactText } = await import('../extension/js/pii-redact.js');
  const { displayText } = await import('../extension/js/pii-pipeline.js');

  const vault = createVault();
  const red = redactText('Jordan Blake met Alex Rivera in Springfield', vault, {
    entities: [
      { value: 'Jordan Blake', type: 'PERSON' },
      { value: 'Alex Rivera', type: 'PERSON' },
      { value: 'Springfield', type: 'LOCATION' },
    ],
    tier: 'full',
  });
  assert.match(red, /\[\[PERSON_1\]\]/, 'the model should have seen placeholders');
  assert.equal(displayText(red, vault), 'Jordan Blake met Alex Rivera in Springfield',
    'and the reader must see the real names back');

  // A token this vault never minted is REPORTED rather than silently dropped: the text is
  // what the reader gets, and the warning is what says a path is still leaking.
  assert.match(displayText('see [[PERSON_9]]', vault), /PERSON_9/);
  assert.equal(displayText('plain text', null), 'plain text');
  assert.equal(displayText('', vault), '');
}

// The render boundary must actually call it — this is the guarantee, and it is one line
// away from being lost in a refactor.
{
  const panel = read('extension/sidepanel.js');
  const renders = (panel.match(/renderMarkdown\(displayText\(/g) || []).length;
  assert.ok(renders >= 2,
    'every place a message body is rendered must scrub placeholders first — found ' + renders);
}

console.log('redaction preview tests passed');
