// The send queue you can actually steer: send-now, drop, reorder.
//
// Two halves, tested as two halves. The MODEL is shared (@chatpanel/events/queue.js,
// vendored to extension/js/events) and is exercised here against the vendored copy the
// panel really loads — a green package test says nothing if the copy in the extension is
// stale or was hand-edited. The WIRING is source-level: the card, the four actions, the
// chord and the styles, so a rename that quietly unhooks a button fails the build.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const { pendingQueue, dequeue, moveQueued, promoteQueued } = await import('../extension/js/events/queue.js');

const u = (id) => ({ id, role: 'user', content: id, queued: true });
const a = (id) => ({ id, role: 'assistant', content: id });

// 1) The queue is the trailing run of unanswered user messages — no second list to drift.
{
  const messages = [u('asked'), a('answered'), u('q1'), u('q2'), u('q3')];
  assert.deepEqual(pendingQueue(messages).map((e) => e.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(pendingQueue([u('asked'), a('answered')]), []);
}

// 2) Steering promotes, and the rest keep their order behind it — the drain then answers
//    them in that order, so what the card shows is what the model is handed.
{
  const messages = [a('answered'), u('q1'), u('q2'), u('q3')];
  const steered = promoteQueued(messages, 'q3');
  assert.deepEqual(pendingQueue(steered).map((e) => e.id), ['q3', 'q1', 'q2']);
}

// 3) Dropping removes only from the queue. A stale click on an answered turn — the card
//    redrawn under a slow hand — must never delete history.
{
  const messages = [u('asked'), a('answered'), u('q1'), u('q2')];
  assert.deepEqual(dequeue(messages, 'q1').map((m) => m.id), ['asked', 'answered', 'q2']);
  assert.equal(dequeue(messages, 'asked'), messages);
}

// 4) Reorder stops at both ends, so a queued question can never be moved above the reply
//    it was typed over.
{
  const messages = [u('asked'), a('answered'), u('q1'), u('q2')];
  assert.equal(moveQueued(messages, 'q1', -1), messages);
  assert.equal(moveQueued(messages, 'q2', 1), messages);
  assert.deepEqual(moveQueued(messages, 'q1', 1).map((m) => m.id), ['asked', 'answered', 'q2', 'q1']);
}

// 5) The panel uses the SHARED model rather than its own idea of what is queued: the old
//    hand-rolled "walk back while role === user" loop must not come back.
assert.match(js, /import\('\.\/js\/events\/queue\.js'\)/, 'The panel should load the shared queue model.');
assert.match(js, /queueApi\.pendingQueue\(/, 'The drain should ask the shared model what is queued.');
assert.doesNotMatch(
  js,
  /for \(let i = conv\.messages\.length - 1; i >= 0 && conv\.messages\[i\]\.role === 'user'; i--\)/,
  'The queue should have exactly one definition — the shared one.',
);

// 6) All three verbs are wired, on the row they act on.
assert.match(js, /function queueCard\(/, 'Queued messages should render as one card.');
assert.match(js, /sendQueueNow\(message\.id\)/, 'Each queued row should offer send-now.');
assert.match(js, /nudgeQueued\(message\.id, -1\)/, 'Each queued row should offer move-up.');
assert.match(js, /nudgeQueued\(message\.id, 1\)/, 'Each queued row should offer move-down.');
assert.match(js, /dropQueued\(message\.id\)/, 'Each queued row should offer remove.');
assert.match(js, /queueApi\.promoteQueued\(/, 'Send-now should promote before interrupting.');
assert.match(js, /stopStream\(\); \/\/ its finally drains/, 'Send-now should interrupt the running reply.');

// 7) Send-now is reachable from the keyboard while a reply streams, and the button says
//    what it is about to do instead of always claiming to send.
assert.match(js, /send\(\{ steer: true \}\)/, 'Cmd/Ctrl+Enter should steer while streaming.');
assert.match(js, /MOD_LABEL/, 'The tooltip should name the right modifier key per platform.');
assert.match(js, /classList\.toggle\('queueing'/, 'The send button should show when it is queueing.');

// 8) Styled, including the disabled ends of the reorder controls.
for (const rule of [/\.queue-card/, /\.queue-list/, /\.q-item/, /\.q-btn:disabled/, /\.send-btn\.queueing/]) {
  assert.match(css, rule, `Queue card styling missing: ${rule}`);
}

console.log('queue controls tests passed');
