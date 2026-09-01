// GENERATED — do not edit.
// Source of truth: chatpanel-events/queue.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// THE SEND QUEUE — what someone typed while a reply was still streaming, and what they are
// allowed to do about it before it is answered.
//
// Typing over a running answer is not a mistake to be prevented; it is how people think. But
// a queue you can only ADD to is a trap, and in three specific ways:
//
//   • the thought that arrives mid-answer is often the URGENT one — it should not have to
//     wait out a reply it was meant to redirect (steer);
//   • the reply frequently answers a queued question before it is ever sent, and sending it
//     anyway spends a turn on something nobody wants any more (dequeue);
//   • the order things occur to you is not the order they should be asked in (reorder).
//
// The queue is deliberately NOT a second list living beside the transcript. It IS the
// trailing run of user messages that has no reply after it — exactly the set a client
// answers when the current stream ends. One definition means what is drawn and what is sent
// can never disagree, and a message cannot be "in the queue" but missing from the turn.
//
// Every function here is a pure transform: it returns a NEW array, or the array it was given
// (by identity) when the operation was a no-op, so a caller can tell "nothing changed" from
// "changed" without diffing. No clock, no ids minted, no DOM, no storage — the panel, a
// mobile client, the gateway and the bridge can all reason about the same queue.
//
// STEERING, honestly: no engine we speak to accepts new input into a run already in flight
// (the bridge closes a CLI's stdin with the prompt; HTTP streaming has no upstream channel).
// So "send now" is promote-then-interrupt: the partial answer stays in the transcript as
// context, and the next turn opens with the message the user wanted read first. This module
// owns the ORDER half of that — the client owns the abort.

const isUser = (m) => !!m && m.role === 'user';

/**
 * The pending queue: the trailing run of user messages with no reply after it.
 *
 * Returned oldest-first — the order they will be sent in — as
 * `{ message, id, index, position }`, where `index` is the position in the whole
 * transcript and `position` the position within the queue.
 */
export function pendingQueue(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let start = list.length;
  while (start > 0 && isUser(list[start - 1])) start--;
  const out = [];
  for (let i = start; i < list.length; i++) {
    out.push({ message: list[i], id: list[i].id, index: i, position: i - start });
  }
  return out;
}

/** Is this message currently in the queue (rather than already answered)? */
export function isQueued(messages, id) {
  return pendingQueue(messages).some((e) => e.id === id);
}

/**
 * Drop a queued message — the question the running reply already answered.
 *
 * Only ever removes from the pending run: an id from further up the transcript is a
 * no-op, so a stale click can never delete a turn that has already been answered.
 */
export function dequeue(messages, id) {
  const queue = pendingQueue(messages);
  const hit = queue.find((e) => e.id === id);
  if (!hit) return messages;
  const next = messages.slice();
  next.splice(hit.index, 1);
  return next;
}

/** Move a queued message by `delta` places (-1 up, +1 down). Clamped: past either end is a no-op. */
export function moveQueued(messages, id, delta) {
  const queue = pendingQueue(messages);
  const from = queue.findIndex((e) => e.id === id);
  if (from < 0) return messages;
  const step = Math.trunc(Number(delta) || 0);
  const to = from + step;
  if (!step || to < 0 || to >= queue.length) return messages;
  return reordered(messages, queue, from, to);
}

/**
 * Put a queued message at the FRONT — the ordering half of "send now".
 *
 * The rest of the queue keeps its relative order behind it: steering is a statement about
 * what to read first, not an instruction to throw away everything else that was typed.
 */
export function promoteQueued(messages, id) {
  const queue = pendingQueue(messages);
  const from = queue.findIndex((e) => e.id === id);
  if (from <= 0) return messages; // absent, or already first
  return reordered(messages, queue, from, 0);
}

function reordered(messages, queue, from, to) {
  const block = queue.map((e) => e.message);
  const [moved] = block.splice(from, 1);
  block.splice(to, 0, moved);
  return messages.slice(0, queue[0].index).concat(block);
}
