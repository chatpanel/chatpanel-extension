// A job watches TEXT, not meetings. Same triggers, same batching, three surfaces — and the
// note surface offers rather than spends, because observe() runs off every keystroke.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobsForEvent, createTriggerRegistry, BUILTIN_TRIGGERS, questionTrigger, TEXT_DELTA }
  from '../extension/js/events/schedule.js';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const notes = read('notes.js');
const panel = read('sidepanel.js');
const pane = read('js/jobs-panel.js');
const tt = read('js/text-triggers.js');

// ── the contract: one matcher, gated on where the text came from ─────────────────
const reg = createTriggerRegistry(BUILTIN_TRIGGERS);
const job = (sources) => [{ id: 'j', name: 'n', enabled: true, trigger: questionTrigger.id, params: { sources }, action: { kind: 'prompt', text: 'x' } }];
const said = [{ t: 1, speaker: 'You', text: 'why is the sky blue?' }];
const fire = (sources, event) => jobsForEvent(job(sources), event, { registry: reg }).length;

assert.equal(fire(undefined, { type: 'meeting.transcript.delta', meetingId: 'm', segments: said }), 1);
assert.equal(fire(undefined, { type: TEXT_DELTA, source: 'note', segments: said }), 0,
  'a job stored before sources existed must not silently start watching notes');
assert.equal(fire(['note'], { type: TEXT_DELTA, source: 'note', segments: said }), 1);
assert.equal(fire(['chat'], { type: TEXT_DELTA, source: 'chat', segments: said }), 1);

// ── the surfaces are wired, and share one pipeline ───────────────────────────────
assert.match(panel, /fireTextTrigger\('chat', conv\.id/, 'a sent chat message must be matched.');
assert.match(panel, /async function fireTextTrigger\(/, 'and through one entry point.');
assert.match(notes, /async function scanJobTriggers\(/, 'a note being typed must be matched.');
assert.match(notes, /scanJobTriggers\(\);/, 'hooked into the debounced observer, not its own timer.');
for (const [src, name] of [[panel, 'sidepanel'], [notes, 'notes']]) {
  assert.match(src, /freshText\(/, `${name} must only match text it has not matched before`);
}

// ── notes OFFER, they do not spend ───────────────────────────────────────────────
// observe() fires off every keystroke; a job that ran itself here would burn tokens on
// half-written sentences and write into a document someone is still holding.
assert.match(notes, /boardSuggestions\.push\(\{\s*role: 'job'/, 'a note match must become a board chip.');
assert.ok(!/queueMatch\(/.test(notes), 'notes must NOT auto-run a job through the batch pipeline.');
assert.match(notes, /apply: \(\) => \{ jobHits\.delete\(id\); runJobOnNote/, 'spending it must take a click.');
assert.match(notes, /await runNoteJob\(\{/, 'and must reuse the note-job runner, not a second one.');

// ── per-question disable ─────────────────────────────────────────────────────────
assert.match(notes, /const key = `job:\$\{id\}:\$\{qs\.join\('\|'\)/, 'the key must be the questions themselves.');
assert.match(notes, /if \(boardDismissed\.has\(key\)\) continue;/, 'a dismissed question must stay dismissed.');
assert.match(notes, /if \(e\.altKey\) \{ drop\(\); return; \}/, 'one chip must be refusable on its own.');
assert.match(notes, /chip\.oncontextmenu/, 'and by right-click, for anyone who never finds alt.');

// ── reachable from the form ──────────────────────────────────────────────────────
assert.match(pane, /id="job-where"/, 'the form must let a job say where to watch.');
assert.match(pane, /TRIGGER_SOURCES/, 'offering exactly the surfaces the contract knows.');
assert.match(pane, /return on\.length \? on : \['meeting'\]/, 'an empty pick must mean meetings, never everywhere.');
assert.match(tt, /export function freshText/, 'the watermark belongs to the shared pipeline.');

console.log('ok — one trigger contract across meetings, chats and notes; notes offer and can be refused per question');
