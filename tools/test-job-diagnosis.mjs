// "It isn't triggering" has several causes, and they used to be indistinguishable: a bare
// `continue` at every guard, a trigger wired behind an unrelated switch, and no way to change
// a job once made. This locks down the answers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { utteranceLooksComplete } from '../extension/js/events/schedule.js';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const panel = read('sidepanel.js');
const jobs = read('js/jobs.js');
const pane = read('js/jobs-panel.js');
const bg = read('background.js');
const css = read('sidepanel.css');

// ── meeting triggers are not gated on spoken commands ────────────────────────────
// They shared one function: `voice.enabled === false` returned before the triggers fired, and
// an `await voiceRuntime()` that threw took them down with it. Two features, one switch.
const delta = panel.slice(panel.indexOf('async function onMeetingDelta('));
// To the next top-level declaration: the body has nested blocks, so the first `\n}` is not it.
const end = delta.search(/\n(?:async )?function /);
// Comments stripped: this function's own comment NAMES both things it must run before, and
// an assertion that matched prose would pass on a file that says the right thing and does
// the wrong one.
const body = (end > 0 ? delta.slice(0, end) : delta).replace(/^\s*\/\/.*$/gm, '');
assert.ok(
  body.indexOf('fireMeetingTrigger(') < body.indexOf('voiceRuntime()'),
  'meeting-triggered jobs must fire before — and independently of — the spoken-command runtime.',
);
assert.ok(
  body.indexOf('fireMeetingTrigger(') < body.indexOf('voice.enabled === false'),
  'turning spoken commands off must not disable meeting-triggered jobs.',
);

// ── a half-spoken line waits; a finished one does not ────────────────────────────
assert.equal(utteranceLooksComplete('the product is just amazing because'), false);
assert.equal(utteranceLooksComplete('we should ship it'), true);
assert.match(panel, /function waitForCompleteUtterance/, 'the trigger path must be able to wait for the rest of a sentence.');
assert.match(
  panel,
  /if \(!meetingId \|\| !seg\) return seg;[\s\S]{0,220}?if \(utteranceLooksComplete\(seg\.text\)\) return seg;/,
  'a line that already reads as finished must cost nothing — speed is not the problem.',
);
// The claim/ceiling/cooldown are taken before the wait, so a redelivered caption cannot
// double-fire while we sit there.
const fire = panel.slice(panel.indexOf('async function fireMeetingTrigger('));
assert.ok(
  fire.indexOf('claimOccurrence') < fire.indexOf('waitForCompleteUtterance'),
  'dedup must be settled before the wait, not after it.',
);

// ── a retry re-runs the job, rather than an empty turn ───────────────────────────
// A job turn is single-shot: the instruction is not in the thread, so "Retry" re-ran a turn
// with no question in it and the model had nothing to answer.
assert.match(panel, /if \(assistantMsg\.job\?\.jobId\) \{ await retryJobAnswer/, 'Retry on a job answer must re-run the job.');
assert.match(panel, /async function retryJobAnswer/, 'the re-run path must exist.');
assert.match(panel, /job: \{\s*jobId: job\.id,/, 'the answer must carry what produced it.');

// ── every guard says why ─────────────────────────────────────────────────────────
assert.match(jobs, /export async function logSkip/, 'a withheld run must be recordable.');
assert.match(jobs, /export const SKIP_REASONS/, 'the reasons must be worded once, not per call site.');
for (const [src, name] of [[panel, 'sidepanel'], [bg, 'background']]) {
  assert.match(src, /logSkip\(/, `${name} must record why it declined to run a job.`);
}
assert.ok(
  !/withinLimits\((entry\.job|hit\.job|job)\)\)\) continue;/.test(panel + bg),
  'no daily-limit guard may still be a bare continue.',
);
assert.match(pane, /function statusLine/, 'the pane must answer "why has this not fired" without expanding anything.');
assert.match(pane, /run\.skipped/, 'skips must be told apart from runs in the history list.');
assert.match(css, /\.job-why/, 'the status line must be styled.');

// ── a job can be edited ──────────────────────────────────────────────────────────
assert.match(pane, /loadIntoForm = \(job\)/, 'the create form must double as the editor.');
assert.match(pane, /edit\.onclick = \(\) => loadIntoForm\?\.\(job\)/, 'every job card needs an edit button.');
assert.match(pane, /id="job-cancel"/, 'editing must be abandonable.');
assert.match(pane, /export function whenValueFor/, 'a stored schedule must map back onto the form.');
// An edit must not quietly reset what the form does not own.
assert.match(pane, /\.\.\.\(was \|\| \{\}\),/, 'an edit must preserve enabled/limits/onMissed/source.');
assert.match(pane, /'__keep'/, 'a job the form cannot express must be editable without being rewritten.');
assert.match(pane, /new Option\('Just notify me…', 'notify'\)/, 'timers and reminders must be editable too.');

// ── one meeting, one thread ──────────────────────────────────────────────────────
// The Jobs pane logged four runs while the thread showed two: the panel opens a NEW
// conversation on every launch, so each panel session filed its answers somewhere else.
const meetings = read('js/store-meetings.js');
assert.match(meetings, /export async function getMeetingThread/, 'the binding must be durable, not in-memory.');
assert.match(meetings, /export async function setMeetingThread/, 'and writable exactly once per meeting.');
assert.match(
  meetings,
  // Not anchored to the end of the list: the meeting's side keys grow (the title/tags
  // meta key landed after this), and what matters is that the thread goes with it.
  /remove\(\[meetingKey\(id\)[^\]]*threadKey\(id\)[^\]]*\]\)/,
  'deleting a meeting must take its thread binding with it — an orphan is a quiet leak.',
);
assert.match(
  panel,
  /if \(!thread && threadConvId && event\?\.meetingId\) setMeetingThread/,
  'a deleted thread must be re-bound, so the rest of the call does not scatter again.',
);

// ── a burst of questions is a batch, not one answer and twelve drops ─────────────
// Reported from a real call: 13 questions asked, 1 answered, the rest logged
// "skipped — fired moments ago (cooldown)" and never answered by anything.
assert.match(jobs, /export const BATCHES/, 'answer-producing actions must be named as batching.');
assert.match(jobs, /export const batches = \(job\)/, 'and the policy asked once, not per call site.');
assert.ok(
  /BATCHES = Object\.freeze\(\['skill', 'prompt'\]\)/.test(jobs),
  'notify and monitor must NOT batch — one reminder is the whole point of a reminder.',
);
// The batching lives in ONE module so notes, chats and meetings cannot drift apart.
const tt = read('js/text-triggers.js');
assert.match(tt, /export const BATCH_MS = 6_000/, 'the window must be short — a late answer has been overtaken.');
assert.match(tt, /export function queueMatch\(/, 'a trigger inside the window must be queued, never dropped.');
assert.match(tt, /export async function flushBatch\(/, 'and the batch must fire on its own timer.');
assert.match(tt, /export function freshText\(/, 'a re-read source must only ever match text it has not matched.');
assert.ok(!/const BATCH_MS/.test(panel), 'the panel must not keep a second copy of the batching.');
assert.match(panel, /tt\.queueMatch\(hit\.job, hit\.match/, 'the meeting path must use the shared pipeline.');
// The ordering that matters: batching is checked BEFORE the cooldown can skip anything.
const fireBody = fire.replace(/^\s*\/\/.*$/gm, '');
assert.ok(
  fireBody.indexOf('m.batches(hit.job)') < fireBody.indexOf('withinCooldown'),
  'an answer-producing job must reach the batch before the cooldown gets to drop it.',
);
// Questions still asked while an answer is being written start the NEXT batch.
assert.match(tt, /if \(b\.matches\.length && !b\.timer\)/, 'asks during a run must not be lost.');

// The prompt names every question, and what was already answered.
assert.match(panel, /WHAT TO ANSWER — every one of these was asked/, 'the batch must be stated as a list.');
assert.match(panel, /Group the ones that are really the same question/, 'related asks must be grouped, not repeated.');
assert.match(panel, /ALREADY ANSWERED EARLIER IN THIS MEETING/, 'a single-shot run must be told what it covered.');
assert.match(panel, /async function recentlyAnswered\(/, 'and that must come from the run log.');
assert.match(panel, /asked: m\.matchTexts\(/, 'each run must record the questions it answered.');
assert.match(panel, /meetingId: event\?\.meetingId/, 'scoped to the meeting, so another call does not suppress answers.');

console.log('ok — triggers fire independently, batch a burst instead of dropping it, wait only when cut off, explain every skip, land in one thread, and can be edited');
