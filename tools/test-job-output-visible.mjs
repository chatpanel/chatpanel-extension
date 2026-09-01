// A job that ran must be VISIBLE — in the chat list, and, when a meeting caused it, in the
// thread that meeting was watched in. Both failures looked identical to "the job never fired".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const js = read('sidepanel.js');
const html = read('sidepanel.html');
const css = read('sidepanel.css');
const widgets = read('js/widgets-panel.js');
const icons = read('js/icons.js');

// ── the chat list ────────────────────────────────────────────────────────────────
// state.index is this window's COPY. A job saves to storage, so without a refresh its chat
// only appeared once something unrelated happened to reload the index.
const runJobTurn = js.slice(js.indexOf('async function runJobTurn('));
assert.ok(
  runJobTurn.slice(0, runJobTurn.indexOf('\n}\n')).includes('refreshHistory()'),
  'runJobTurn must refresh the history index after saving, or its chat is missing from the list.',
);
assert.match(
  js,
  /\$\('btn-history'\)\.onclick[\s\S]{0,400}?refreshHistory\(\)/,
  'Opening the history drawer must re-read the index rather than trust the in-memory copy.',
);

// ── the meeting thread ───────────────────────────────────────────────────────────
assert.match(
  js,
  /async function runJobTurn\(job, \{[^}]*threadConvId/,
  'runJobTurn must accept the thread a meeting-triggered job should write into.',
);
// The ON-SCREEN fallback is captured before the first await: on meeting.ended the live
// meeting is cleared right after. The binding itself is read from storage, so it may await.
const fire = js.slice(js.indexOf('async function fireMeetingTrigger('));
const fireHead = fire.slice(0, fire.indexOf('try {'));
assert.ok(
  fireHead.includes('onScreen') && !fireHead.includes('await '),
  'fireMeetingTrigger must capture the on-screen chat before it awaits anything.',
);
// And the BINDING wins over whatever chat is open. The panel starts a new conversation every
// launch, so "the chat on screen" scattered one meeting's answers across a chat per session.
assert.match(
  fire,
  /await meetingThread\(event\.meetingId, onScreen\)/,
  'a meeting-fired job must go to the meeting\'s bound thread, not to whatever chat is open.',
);
assert.match(js, /async function meetingThread\(/, 'the binding must be resolved in one place.');
assert.match(js, /async function attachMeetingThread\(/, 'a live meeting must claim (or restore) its thread.');
assert.match(
  js,
  /state\.convCache\.get\(threadConvId\) \|\| \(await getConversation\(threadConvId\)/,
  'the bound thread must be loaded from storage when it is not the chat in memory.',
);
assert.match(fire, /runJobTurn\(hit\.job, \{[^}]*threadConvId/, 'A meeting-fired job must be handed its thread.');
assert.match(fire, /noteJobInThread\(threadConvId/, 'A notify job must leave a trace in the thread, not only a toast.');

// The row that explains the answer under it. Role is not user/assistant, so chatMessages()
// keeps it out of the model payload — the instruction (a whole transcript) never gets re-sent.
assert.match(js, /if \(m\.role === 'job'\)/, 'renderMessage must draw the job row.');
assert.match(
  js,
  /m\.role === 'user' \|\| m\.role === 'assistant'/,
  'chatMessages must still admit only user/assistant, so a job row costs no tokens.',
);
assert.match(js, /function nameThreadForMeeting/, 'A thread a job writes into must not be filed as "New chat".');

// ── and the row must say WHAT it fired on ────────────────────────────────────────
// It read "Answer the question the best way possible with the informati — question from
// Alex": an instruction severed mid-word, and no sign of the question being answered.
const panel = read('js/jobs-panel.js');
assert.match(
  js,
  /why: m\.matchSummary\(matches, \{ noun: 'questions' \}\)/,
  'A burst must be summarized by the questions themselves, not by how many there were.',
);
assert.match(js, /why: m\.matchSummary\(matches\)/, 'Text-surface batches must be summarized the same way.');
assert.doesNotMatch(js, /\$\{matches\.length\} questions/, 'A bare count is what this replaced.');
assert.match(js, /row\.title = `\$\{timeLabel\(m\.ts\)\} · \$\{text\}`/, 'The clamped job row must carry its whole reason on hover.');
assert.match(
  js,
  /\$\{icon\('timer'\)\} \$\{escapeAttr\(timeLabel\(m\.ts\)\)\} · /,
  'The time must lead the job row, or a burst of questions clamps it away.',
);
assert.match(css, /\.msg\.job-log/, 'The job row must be clamped, or a burst of questions buries the answer.');
assert.match(panel, /clipText\(text, JOB_NAME_CHARS\)/, 'A job named after its instruction must be clipped at a word.');
assert.match(
  panel,
  /was\.name === actionTextFor\(was\)\.slice\(0, JOB_NAME_CHARS\)/,
  'A job named by the OLD hard slice must still count as derived, or an edit keeps the severed name.',
);

// The shared model is what makes those two true — assert against the vendored copy the panel
// actually loads, since a green package test says nothing about a stale vendored file.
const { clipText, matchSummary, questionTrigger, jobsForEvent, createTriggerRegistry, BUILTIN_TRIGGERS } =
  await import('../extension/js/events/schedule.js');
{
  const long = 'Answer the question the best way possible with the information in the meeting';
  assert.equal(clipText(long, 60), 'Answer the question the best way possible with the…');
  const [hit] = jobsForEvent(
    [{ id: 'j', name: 'n', enabled: true, trigger: questionTrigger.id, params: {}, action: { kind: 'prompt', text: 'x' } }],
    { type: 'meeting.transcript.delta', segments: [{ t: 1, speaker: 'Alex Rivera', text: 'which credential did you use for the shared bucket' }] },
    { registry: createTriggerRegistry(BUILTIN_TRIGGERS) },
  );
  assert.match(hit.match.why, /which credential did you use/, 'the row must name the question, not just the asker');
  const burst = matchSummary(
    [1, 2, 3].map((i) => ({ segment: { t: i, speaker: 'Alex Rivera', text: `question ${i} about the bucket` } })),
    { noun: 'questions' },
  );
  assert.match(burst, /^3 questions: /);
  assert.ok(burst.includes('question 2'), 'every question in a burst must be named');
}

// ── deleting a widget ────────────────────────────────────────────────────────────
// The button existed and drew nothing: 'trash' is not an icon name (the alias is 'delete').
const paths = JSON.parse(icons.match(/export const ICON_PATHS = (\{[\s\S]*?\});\n/)[1]);
const alias = JSON.parse(icons.match(/export const ICON_ALIAS = (\{[\s\S]*?\});\n/)[1]);
for (const [, name] of html.matchAll(/data-icon="([^"]+)"/g)) {
  assert.ok(paths[alias[name] || name], `data-icon="${name}" resolves to no icon — the button renders empty.`);
}
assert.match(html, /id="widget-delete"[^>]*data-icon="delete"/, 'The widget delete button must draw something.');
assert.match(widgets, /widget-row-del/, 'Every widget row needs its own delete — not one hidden inside the widget.');
assert.ok(
  !/\bconfirm\(`/.test(widgets) && !/[^.\w]confirm\('/.test(widgets),
  'Native confirm() does not render in a side panel — deletion must use the DOM modal.',
);
assert.match(widgets, /confirmDelete/, 'Widget deletion must confirm through confirm-modal.js.');
assert.match(css, /\.widget-row-del/, 'The row delete must be styled (and visible without hover).');

console.log('ok — a job that ran is in the chat list, in its thread, and says what it fired on');
