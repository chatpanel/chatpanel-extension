// A job that ran must be visible where the user is looking.
//
// Three reports, one theme — the work happened and left no trace anyone would find:
//
//   • "I saw a notification but nothing happened in ChatPanel." deliverNotify sent its
//     CP_JOB_FIRED broadcast and wrote its run log only in the FALLBACK branch, after a
//     `return` in the success path. A timer that fired normally therefore left nothing in an
//     open panel and nothing in the job's own history — the OS notification was the entire
//     record, and it vanishes when dismissed.
//
//   • "It's added multiple times." A live caption grows across flushes, so one sentence
//     arrives as a series of prefixes of itself; every one of them went into the instruction
//     and the model answered the same question four times.
//
//   • "It should show up in the chat window itself." An unattended run's whole output was a
//     six-second toast offering to open it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const { dedupeTriggerLines } = await import('../extension/js/text-triggers.js');

// ── a growing caption is ONE thing that was said ─────────────────────────────────
{
  const growing = [
    'so I want to know',
    'so I want to know how is the weather',
    'so I want to know how is the weather in Fairview?',
  ];
  assert.deepEqual(
    dedupeTriggerLines(growing), ['so I want to know how is the weather in Fairview?'],
    'prefixes of one sentence must collapse to the finished sentence',
  );
  // Order of arrival must not matter — flushes can land out of order.
  assert.equal(dedupeTriggerLines([...growing].reverse()).length, 1);
  // Case and whitespace vary between flushes of the same words.
  assert.deepEqual(dedupeTriggerLines(['What is the weather', 'what  is   the weather.']).length, 1);
  // But genuinely different questions must all survive, in the order they were asked.
  assert.deepEqual(
    dedupeTriggerLines(['what is the weather', 'who is on the call', 'what is the weather']),
    ['what is the weather', 'who is on the call'],
  );
  assert.deepEqual(dedupeTriggerLines([]), []);
  assert.deepEqual(dedupeTriggerLines(['', '   ', null, undefined]), []);
  assert.deepEqual(dedupeTriggerLines(undefined), [], 'must not throw on a missing batch');
}
// …and the instruction builder must actually use it.
assert.match(
  read('sidepanel.js'), /dedupeTriggerLines\(batch\.map/,
  'textJobContext must dedupe before turning matches into an instruction',
);

// ── a fired timer leaves a trace in BOTH places, always ──────────────────────────
const bg = read('background.js');
const deliver = /async function deliverNotify\([\s\S]*?\n\}/.exec(bg)?.[0] || '';
assert.ok(deliver, 'deliverNotify not found');
// The bug was a `return` in the success path that skipped both. Neither may sit behind one.
assert.doesNotMatch(
  deliver, /how = 'notification';\s*\n\s*return;/,
  'the success path must not return before announcing and logging the run',
);
assert.match(deliver, /type: 'CP_JOB_FIRED', jobId: job\.id/, 'the panel must be told, and told WHICH job');
assert.match(deliver, /await jobs\.logRun\(job\.id, \{/, 'and the run must reach the job history');
assert.ok(
  deliver.indexOf("sendMessage({ type: 'CP_JOB_FIRED'") > deliver.indexOf('chrome.notifications'),
  'the broadcast belongs after delivery is attempted, so it can report HOW it was delivered',
);

// The panel must show it, and refresh the pane that lists runs.
const panel = read('sidepanel.js');
const fired = /msg\?\.type === 'CP_JOB_FIRED'\)[\s\S]{0,600}?\} else if/.exec(panel)?.[0] || '';
assert.ok(fired, "the panel's CP_JOB_FIRED branch not found");
assert.match(fired, /toast\(/, 'an open panel must say a timer went off');
assert.match(fired, /refreshJobRuns/, 'and the Jobs pane must not keep showing the previous run');
assert.match(read('js/jobs-panel.js'), /export function refreshJobRuns\(\)/);

// ── an unattended answer opens, rather than offering to ──────────────────────────
const tail = /\/\/ Already on screen, in the thread[\s\S]*?\n\}/.exec(panel)?.[0] || '';
assert.ok(tail, 'the end of runJobTurn not found');
assert.match(tail, /await openConversation\(conv\.id\)/, 'an idle panel must SHOW the answer');
assert.match(
  tail, /const idle = !state\.conv \|\| !\(state\.conv\.messages \|\| \[\]\)\.some/,
  'idle must mean "the chat on screen is empty", which is what a freshly-opened panel is',
);
assert.match(
  tail, /toastAction\(/,
  'but a user mid-conversation must keep the toast — yanking them out of what they are '
  + 'typing is worse than a missed notification',
);

console.log('job visibility: ok');
