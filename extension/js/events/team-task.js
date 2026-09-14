// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-task.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A task is a conversation, and a model call is one attempt at continuing it.
//
// A member's task keeps its TRANSCRIPT — the wire messages so far: the request, what the
// model said, the tools it called and what came back — apart from whichever model or CLI
// agent happens to be answering. When that model fails, is handed off, or the process
// itself dies and the run is resumed a month later from the store, the next model does not
// start over: it is given the transcript and told to continue. The same thing a chat window
// does when a person switches models mid-conversation; here it is what makes a run survive
// a process, a model, or an API going away.
//
// Every attempt, hand-off and continuation is said on the board (a runner post in the
// task's thread) and in the run's events, so the record — on the gateway, read by either
// client — is enough to pick the task up from anywhere.

export const STEP_MAX_CHARS = 4000; // one persisted message's content
export const TASK_TRANSCRIPT_MAX_CHARS = 60_000; // a task's whole persisted transcript

const clipStr = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more chars omitted from the record]` : s);

/** A wire message trimmed for the record: tool results and long answers are clipped. */
export function clipMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { role: m.role };
  if (typeof m.content === 'string') out.content = clipStr(m.content, STEP_MAX_CHARS);
  else if (m.content != null) out.content = m.content;
  if (m.tool_calls) out.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: c.type || 'function', function: { name: c.function?.name, arguments: clipStr(String(c.function?.arguments ?? ''), STEP_MAX_CHARS) } }));
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  // The member's reasoning, when the model streams it: on the record for the board and the
  // scorecard, never sent back on the wire (messagesFor drops it).
  if (typeof m.thought === 'string') out.thought = clipStr(m.thought, STEP_MAX_CHARS);
  // When the step happened and under which attempt — the work log orders by these.
  if (Number.isFinite(m.at)) out.at = m.at;
  if (Number.isFinite(m.attempt)) out.attempt = m.attempt;
  return out;
}

/** A step that is the member thinking aloud — no content, no call — recorded, not replayed. */
export function isThought(m) {
  return !!m && m.role === 'assistant' && typeof m.thought === 'string' && m.content == null && !(Array.isArray(m.tool_calls) && m.tool_calls.length);
}

/** The record's copy of a transcript: clipped per message and bounded as a whole (oldest tool traffic goes first). */
export function clipTranscript(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role && m.role !== 'system').map(clipMessage);
  let size = list.reduce((n, m) => n + JSON.stringify(m).length, 0);
  // Drop the oldest tool exchanges (assistant tool_calls + tool results) until it fits,
  // never the first user message (the task) and never the last message.
  for (let i = 1; size > TASK_TRANSCRIPT_MAX_CHARS && i < list.length - 1; ) {
    const m = list[i];
    if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) { size -= JSON.stringify(m).length; list.splice(i, 1); } else i += 1;
  }
  return list;
}

/** The messages beyond what the record already holds — what one attempt added. */
export function newSteps(prev, next) {
  const a = Array.isArray(prev) ? prev.length : 0;
  return (Array.isArray(next) ? next : []).slice(a);
}

/**
 * What the next model is told when it continues another's work. `kind`:
 *   handoff  — the previous attempt (another model / agent) stopped: an error, a person's choice
 *   resume   — the run itself was stopped or died and is being resumed from the record
 *   answer   — the task waited on a person and the answer is now on the board
 */
export function continuationNote({ kind = 'handoff', from = '', to = '', reason = '', answer = '' } = {}) {
  const who = from ? ` by ${from}` : '';
  if (kind === 'answer') return `The user has answered your question on the board (see the board, or: ${answer}). Continue the task from where you left off — do not repeat work already done above — and finish with your findings.`;
  if (kind === 'resume') return `This task was interrupted (${reason || 'the run was stopped'}) and is being resumed${to ? ` by ${to}` : ''}. Everything above is the work done so far — read it, do not redo it. Continue from where it stopped and finish with your findings.`;
  return `You are continuing this task. A previous attempt${who} stopped (${reason || 'it did not finish'}). Everything above is its work so far — read it, do not redo lookups already made. Continue from where it stopped and finish with your findings.`;
}

/**
 * The messages to send for an attempt: the task's transcript plus a continuation note when
 * there is one; the bare task when there is not. `system` travels separately (the host puts
 * it first) so a transcript never carries a role prompt that a later role might not share.
 */
export function messagesFor(task, { prompt, note = null } = {}) {
  const transcript = (Array.isArray(task?.transcript) ? task.transcript : []).filter((m) => !isThought(m));
  if (!transcript.length) return [{ role: 'user', content: String(prompt || '') }];
  const last = transcript[transcript.length - 1];
  // A transcript that ends in an unanswered tool call cannot be continued as-is: close it.
  const closed = last?.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length
    ? [...transcript, ...last.tool_calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: 'This call was not answered: the attempt stopped here.' }))]
    : transcript;
  return note ? [...closed, { role: 'user', content: note }] : closed;
}

/**
 * Fold what a host returned into the task's transcript. A host that hands back its wire
 * transcript (`res.transcript`) is taken as is (minus system); one that only returns text
 * gets the messages it was sent plus one assistant message — still a continuation.
 */
export function mergeTranscript(sent, res) {
  const returned = Array.isArray(res?.transcript) ? res.transcript.filter((m) => m && m.role !== 'system') : null;
  if (returned && returned.length >= sent.length) return returned;
  const text = String(res?.text || '');
  return text ? [...sent, { role: 'assistant', content: text }] : sent;
}

/**
 * The control channel a host holds on a running team: a person's hand-off of a task to a
 * named model (from the board, either client), or a stop of one task. The runner subscribes.
 */
export function createControl() {
  const listeners = new Set();
  const pending = new Map(); // taskId -> { model, by } asked before the task subscribed
  const api = {
    handoff(taskId, model, by = 'person', reason = '') {
      const req = { type: 'handoff', taskId, model, by, reason };
      let taken = false;
      for (const fn of listeners) { if (fn(req) === true) taken = true; }
      if (!taken) pending.set(taskId, req);
      return taken;
    },
    _subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _pendingFor(taskId) { const r = pending.get(taskId); if (r) pending.delete(taskId); return r || null; },
  };
  return api;
}
