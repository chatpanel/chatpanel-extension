// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-worklog.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The work log — a task's thread as the record of the work, not just its posts.
//
// A task is a conversation (team-task.js): every step is on the record as it happens — the
// prompt, the member's text, its reasoning when the model streams it, each tool call and
// what came back — beside the attempts (which model, when, how it ended), the hand-offs, the
// posts in its thread, and how the task ended. The board drew the posts alone, and a task
// that failed before its first post looked like nothing had happened. This folds all of it
// into ONE ordered timeline, the same in both clients, so what a member did, tried, was told
// and produced is read in one place — by a person, by the next wave, and by whoever rates
// the member (evidence first: calls made, findings kept, models burned, budget spent).
//
// Pure: a run record (team-record.js) in, entries out. No rendering here.

import { isThought } from './team-task.js';

export const WORKLOG_KINDS = Object.freeze(['attempt', 'prompt', 'note', 'thought', 'text', 'call', 'result', 'handoff', 'post', 'end']);

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); } catch { return { raw: String(raw || '') }; }
}

/** One line for a tool call: `find web_search "…"` — the dispatcher's action stands in front. */
export function describeCall(call) {
  const name = call?.function?.name || call?.name || 'tool';
  const args = parseArgs(call?.function?.arguments ?? call?.arguments);
  const action = args?.action ? ` ${args.action}` : '';
  const inner = args?.args && typeof args.args === 'object' ? args.args : args;
  const first = inner && typeof inner === 'object' ? Object.entries(inner).find(([k, v]) => k !== 'action' && k !== 'args' && (typeof v === 'string' || typeof v === 'number')) : null;
  return `${name}${action}${first ? ` ${first[0]}=${JSON.stringify(String(first[1]).slice(0, 120))}` : ''}`;
}

/**
 * The timeline of one task: `[{ kind, at, by, attempt, ... }]`, oldest first. Every entry has
 * an `at`; a step recorded without one (an older build) inherits its attempt's, so the order
 * still holds. `by` is the role for what the member did, `runner` for the runner's lines, and
 * whoever posted for a post.
 */
export function workLogFor(run, taskId) {
  const task = (run?.tasks || []).find((t) => t.id === taskId);
  if (!task) return [];
  const by = task.role || task.id;
  const out = [];
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  const baseAt = num(task.startedAt, num(attempts[0]?.at, num(run?.startedAt, 0)));
  attempts.forEach((a, i) => out.push({ kind: 'attempt', at: num(a.at, baseAt + i), by: 'runner', attempt: i + 1, model: a.model || '', engine: a.engine || null, continued: !!a.continued, status: a.status || null, error: a.error || null }));

  // Steps: stamped ones sort by their time; unstamped ones follow their attempt in order.
  const steps = Array.isArray(task.transcript) ? task.transcript : [];
  const calls = new Map();
  let lastAt = baseAt;
  let attemptOf = 1;
  steps.forEach((m, i) => {
    if (!m || !m.role) return;
    if (Number.isFinite(m.attempt)) attemptOf = m.attempt;
    else if (attempts.length) attemptOf = Math.max(attemptOf, 1 + attempts.findLastIndex((x) => num(x.at, 0) <= lastAt + 1));
    // Unstamped: after everything before it, and after its attempt began.
    const at = Number.isFinite(m.at) ? m.at : Math.max(lastAt, num(attempts[attemptOf - 1]?.at, 0)) + 1;
    lastAt = Math.max(lastAt, at);
    const attempt = attemptOf;
    if (m.role === 'user') {
      out.push({ kind: i === 0 ? 'prompt' : 'note', at, by: 'runner', attempt, text: str(m.content) });
    } else if (m.role === 'assistant') {
      if (isThought(m)) { out.push({ kind: 'thought', at, by, attempt, text: m.thought }); return; }
      if (typeof m.content === 'string' && m.content.trim()) out.push({ kind: 'text', at, by, attempt, text: m.content });
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const id = c.id || `c${i}`;
        calls.set(id, c);
        out.push({ kind: 'call', at, by, attempt, callId: id, name: c.function?.name || 'tool', args: parseArgs(c.function?.arguments), text: describeCall(c) });
      }
    } else if (m.role === 'tool') {
      const c = m.tool_call_id ? calls.get(m.tool_call_id) : null;
      out.push({ kind: 'result', at, by: 'tool', attempt, callId: m.tool_call_id || null, name: c?.function?.name || m.name || 'tool', text: str(m.content), error: /^error[:\s]/i.test(str(m.content)) });
    }
  });

  for (const h of Array.isArray(task.handoffs) ? task.handoffs : []) out.push({ kind: 'handoff', at: num(h.at, lastAt), by: h.by || 'person', from: h.from || '', to: h.to || '', text: h.reason || '' });

  // The thread's posts — a member's findings, a question, an answer, a decision, the runner's notes.
  const thread = (run?.threads?.threads || []).find((t) => t.taskId === taskId && t.kind === 'task');
  if (thread) for (const p of (run.threads.posts || []).filter((x) => x.threadId === thread.id)) out.push({ kind: 'post', at: num(p.at, lastAt), by: p.by || '', post: p, text: p.text || '' });

  // What the member is saying right now — the attempt's text before it is a step.
  const lastText = [...out].reverse().find((e) => e.kind === 'text');
  if (task.status === 'running' && task.text && task.text !== lastText?.text) out.push({ kind: 'text', at: num(run?.lastEventAt, lastAt + 1), by, attempt: attemptOf, text: task.text, live: true });

  if (task.endedAt || ['ok', 'failed', 'over-budget', 'stopped', 'waiting'].includes(task.status)) {
    // Findings: the task's count, or the finding posts in its thread — a member's board posts
    // count as its answer (team-run.js), and a record folded from an older run has only those.
    const findings = Math.max(num(task.findings, 0), out.filter((e) => e.kind === 'post' && e.post?.kind === 'finding').length);
    const tools = Math.max(num(task.tools, 0), out.filter((e) => e.kind === 'call').length);
    out.push({ kind: 'end', at: num(task.endedAt, num(run?.lastEventAt, lastAt + 2)), by: 'runner', status: task.status, error: task.error || null, ms: num(task.ms, 0), findings, tools, text: endText({ ...task, findings, tools }, attempts) });
  }
  return out.sort((a, b) => a.at - b.at || WORKLOG_KINDS.indexOf(a.kind) - WORKLOG_KINDS.indexOf(b.kind));
}

function endText(task, attempts) {
  const tried = attempts.length > 1 ? ` after ${attempts.length} models (${attempts.map((a) => a.model).join(' → ')})` : '';
  const s = task.status;
  if (s === 'ok') return `done${tried} · ${task.findings || 0} finding${task.findings === 1 ? '' : 's'} · ${task.tools || 0} tool call${task.tools === 1 ? '' : 's'}`;
  if (s === 'waiting') return 'waiting on a person';
  if (s === 'over-budget') return `stopped at the budget${tried}`;
  if (s === 'stopped') return `stopped${tried}`;
  return `failed${tried}${task.error ? `: ${task.error}` : ''}`;
}

/** The log as text — for a brief, a rating, a test: one line per entry, results shortened. */
export function workLogText(entries, { resultChars = 200 } = {}) {
  return (entries || []).map((e) => {
    switch (e.kind) {
      case 'attempt': return `▸ attempt ${e.attempt}: ${e.model}${e.continued ? ' (continues)' : ''}`;
      case 'prompt': return `▸ task: ${e.text}`;
      case 'note': return `▸ runner → ${e.text}`;
      case 'thought': return `${e.by} (thinking): ${e.text}`;
      case 'text': return `${e.by}: ${e.text}`;
      case 'call': return `${e.by} → ${e.text}`;
      case 'result': return `  ← ${e.name}: ${e.text.length > resultChars ? `${e.text.slice(0, resultChars)}…` : e.text}`;
      case 'handoff': return `▸ handed from ${e.from} to ${e.to} by ${e.by}${e.text ? ` — ${e.text}` : ''}`;
      case 'post': return `${e.by} posted ${e.post?.kind || 'note'}: ${e.text}`;
      case 'end': return `▸ ${e.text}`;
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

/**
 * What the log says about the work, as numbers — the evidence a rating starts from, before
 * any opinion (a judge's, a peer's, a person's) is added beside it.
 */
export function workLogEvidence(entries) {
  const ev = { calls: 0, results: 0, resultErrors: 0, thoughts: 0, texts: 0, attempts: 0, handoffs: 0, posts: 0, findings: 0, requests: 0, decided: { approved: 0, rejected: 0 }, status: null, ms: 0 };
  for (const e of entries || []) {
    if (e.kind === 'call') ev.calls++;
    else if (e.kind === 'result') { ev.results++; if (e.error) ev.resultErrors++; }
    else if (e.kind === 'thought') ev.thoughts++;
    else if (e.kind === 'text') ev.texts++;
    else if (e.kind === 'attempt') ev.attempts++;
    else if (e.kind === 'handoff') ev.handoffs++;
    else if (e.kind === 'post') { ev.posts++; if (e.post?.kind === 'finding') ev.findings++; if (e.post?.kind === 'request') ev.requests++; if (e.post?.status === 'approved') ev.decided.approved++; if (e.post?.status === 'rejected') ev.decided.rejected++; }
    else if (e.kind === 'end') { ev.status = e.status; ev.ms = e.ms; ev.findings = Math.max(ev.findings, e.findings || 0); }
  }
  return ev;
}
