// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-board.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The board — where a team's members meet: a message board, not a log.
//
// One board per run. A THREAD per task (and one per ask, discussion or proposal); POSTS in
// threads — a member's findings, its notes, a question, a person's answer, a draft, a
// decision — and REPLIES hanging off posts. Members do not read each other's transcripts:
// a task ends with FINDINGS (claims with the refs they came from, I-K1), those become posts
// in its thread, and a later task reads the threads it depends on, threaded and sized like a
// shielded tool result. A member that disagrees replies where it disagrees; a member that
// is stuck ASKS, and its task waits for a person — on either client — to answer. A person
// posting is a member posting, and a person's decision on any post wins.
//
// The board is the run's record: durable (every change is an event the run store folds with
// `foldBoard`), attributable per member, and — after a run — what can become draft briefs
// and be promoted on convergence (W7), rather than evaporating with the run.
//
// Findings are parsed GENEROUSLY from a model's answer through the structured layer, and a
// task whose answer cannot be read as findings is not lost: its whole answer becomes one
// `draft` finding. A member that only wrote prose still contributed.

import { defineSchema, describeSchema, coerce } from './structured.js';

export const FINDING_KINDS = Object.freeze(['claim', 'draft', 'link', 'question', 'answer']);
export const MAX_FINDINGS_PER_TASK = 40;
export const BOARD_TEXT_MAX = 12_000;

export const FINDINGS_SCHEMA = defineSchema({
  name: 'findings',
  purpose: 'what this task established, each item on its own with where it came from',
  fields: {
    findings: {
      type: 'object[]', required: true, maxItems: MAX_FINDINGS_PER_TASK,
      describe: 'one entry per fact, draft, link or open question — never a paragraph of several',
      fields: {
        kind: { type: 'enum', values: FINDING_KINDS, default: 'claim' },
        text: { type: 'string', required: true, max: 2000 },
        refs: { type: 'string[]', maxItems: 8, describe: 'record ids or URLs this rests on, when any' },
        confidence: { type: 'number', describe: '0–1, how sure' },
      },
    },
  },
  nothing: { findings: [] },
});

/** The instruction appended to every task so the answer can be read as findings. */
export function findingsInstruction() {
  return `When you are done, end your answer with your findings in this shape:\n${describeSchema(FINDINGS_SCHEMA)}`;
}

/**
 * Read a task's answer into findings. The JSON block, when present; otherwise the whole
 * answer as one draft — a member that only wrote prose still contributed.
 */
export function parseFindings(text, { role, taskId } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const got = coerce(raw, FINDINGS_SCHEMA);
  const list = Array.isArray(got?.value?.findings) ? got.value.findings.filter((f) => f && String(f.text || '').trim()) : [];
  const stamp = (f, i) => ({
    id: `${taskId || 't'}:${i + 1}`,
    kind: FINDING_KINDS.includes(f.kind) ? f.kind : 'claim',
    text: String(f.text).trim().slice(0, 2000),
    refs: Array.isArray(f.refs) ? f.refs.map(String).filter(Boolean).slice(0, 8) : [],
    // Absent or zero reads as "not stated": a model that gives no number is not 0% sure.
    confidence: Number.isFinite(Number(f.confidence)) && Number(f.confidence) > 0 ? Math.min(1, Number(f.confidence)) : null,
    role: role || null,
    taskId: taskId || null,
  });
  if (list.length) return list.slice(0, MAX_FINDINGS_PER_TASK).map(stamp);
  // No JSON block: the prose is the finding. Strip a fenced JSON tail that failed to parse.
  const prose = raw.replace(/```json[\s\S]*$/i, '').trim() || raw;
  return [stamp({ kind: 'draft', text: prose.slice(0, 2000), refs: [] }, 0)];
}

// ── threads, posts, asks ────────────────────────────────────────────────────────────────

export const THREAD_KINDS = Object.freeze(['task', 'ask', 'discussion', 'proposal']);
export const THREAD_STATUSES = Object.freeze(['open', 'waiting', 'resolved', 'approved', 'rejected']);
export const POST_KINDS = Object.freeze(['finding', 'note', 'question', 'answer', 'draft', 'decision']);
export const POST_STATUSES = Object.freeze(['open', 'proposed', 'approved', 'rejected']);
export const ASK_TYPES = Object.freeze(['info', 'budget', 'permission', 'direction']);
export const RUNNER = 'runner';
export const PERSON = 'person';
export const MAX_POST_TEXT = 4000;

const clip = (t, n) => String(t || '').trim().slice(0, n);
const refsOf = (r) => (Array.isArray(r) ? r.map(String).filter(Boolean).slice(0, 8) : []);

/** The empty folded state — what a run record holds, what `foldBoard` grows. */
export function emptyBoardState() { return { threads: [], posts: [] }; }

/**
 * Fold one board event into a state (pure; the gateway's run store and both clients use it).
 * Ids dedupe: an answer posted through the gateway and echoed by the running client's runner
 * arrives twice with one id and lands once.
 */
export function foldBoard(state, ev) {
  const s = state && Array.isArray(state.threads) && Array.isArray(state.posts) ? state : emptyBoardState();
  const type = String(ev?.type || '');
  const p = ev?.payload && typeof ev.payload === 'object' ? ev.payload : ev || {};
  if (type === 'board.thread' && p.thread?.id) {
    if (!s.threads.some((t) => t.id === p.thread.id)) s.threads.push({ ...p.thread });
  } else if (type === 'board.post' && p.post?.id) {
    if (!s.posts.some((x) => x.id === p.post.id)) s.posts.push({ ...p.post });
    const t = s.threads.find((x) => x.id === p.post.threadId);
    if (t) { t.lastAt = p.post.at; t.lastBy = p.post.by; t.posts = (t.posts || 0) + 1; }
  } else if (type === 'board.decision' && p.postId) {
    const x = s.posts.find((q) => q.id === p.postId);
    if (x) { x.status = p.status; x.decidedBy = p.by; x.decidedAt = p.at ?? ev?.at; }
  } else if (type === 'board.thread-status' && p.threadId) {
    const t = s.threads.find((x) => x.id === p.threadId);
    if (t) { t.status = p.status; if (p.status !== 'waiting') t.waitingOn = null; }
  }
  return s;
}

/**
 * The live board a run works on. `state` seeds it (a resume); `onEvent` receives every
 * change as the event the run store folds. The legacy findings API (`add`, `all`, `byTask`)
 * stays: a finding is a post of kind `finding` in its task's thread.
 */
export function createBoard({ now = () => Date.now(), newId = null, state = null, onEvent = null } = {}) {
  const st = state && Array.isArray(state.threads) ? { threads: state.threads.map((t) => ({ ...t })), posts: (state.posts || []).map((x) => ({ ...x })) } : emptyBoardState();
  const listeners = new Set();
  let seq = st.posts.length + st.threads.length;
  const mk = (prefix) => (newId ? newId(prefix) : `${prefix}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  const say = (type, payload) => { const ev = { type, at: now(), ...payload }; if (onEvent) onEvent(type, ev); return ev; };
  const threadOf = (id) => st.threads.find((t) => t.id === id);
  const postOf = (id) => st.posts.find((x) => x.id === id);
  const threadForTask = (taskId) => st.threads.find((t) => t.kind === 'task' && t.taskId === taskId);

  const api = {
    /** Open a thread. A task's thread is opened once; asking for it again returns it. */
    openThread({ id = null, taskId = null, kind = 'discussion', title = '', by = RUNNER, status = 'open', ask = null } = {}) {
      if (kind === 'task' && taskId) { const had = threadForTask(taskId); if (had) return had; }
      const thread = { id: id || mk('th'), kind: THREAD_KINDS.includes(kind) ? kind : 'discussion', taskId, title: clip(title, 200), by, status: THREAD_STATUSES.includes(status) ? status : 'open', at: now(), posts: 0, ...(ask ? { ask } : {}) };
      st.threads.push(thread);
      say('board.thread', { thread: { ...thread } });
      return thread;
    },
    /** A post in a thread; `replyTo` makes it a reply. */
    post({ id = null, threadId, by, kind = 'note', text = '', refs = [], replyTo = null, status = 'open', finding = null, ask = null } = {}) {
      const t = threadOf(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      if (id && postOf(id)) return postOf(id);
      const post = {
        id: id || mk('p'), threadId, by: String(by || RUNNER), kind: POST_KINDS.includes(kind) ? kind : 'note',
        text: clip(text, MAX_POST_TEXT), refs: refsOf(refs), replyTo, status: POST_STATUSES.includes(status) ? status : 'open', at: now(),
        ...(finding ? { finding } : {}), ...(ask ? { ask } : {}),
      };
      st.posts.push(post);
      t.lastAt = post.at; t.lastBy = post.by; t.posts = (t.posts || 0) + 1;
      say('board.post', { post: { ...post } });
      for (const l of listeners) l(post);
      return post;
    },
    /** A reply hangs off a post and lives in that post's thread. */
    reply({ postId, ...args }) {
      const target = postOf(postId || args.replyTo);
      if (!target) throw new Error(`no post ${postId}`);
      return api.post({ ...args, threadId: target.threadId, replyTo: target.id });
    },
    /** A person's (or the judge's) decision on a post. */
    decide(postId, status, by = PERSON) {
      const x = postOf(postId);
      if (!x || !['approved', 'rejected', 'proposed', 'open'].includes(status)) return null;
      x.status = status; x.decidedBy = by; x.decidedAt = now();
      say('board.decision', { postId, status, by, at: x.decidedAt });
      return x;
    },
    setThreadStatus(threadId, status, extra = {}) {
      const t = threadOf(threadId);
      if (!t || !THREAD_STATUSES.includes(status)) return null;
      t.status = status; if (status !== 'waiting') t.waitingOn = null; Object.assign(t, extra);
      say('board.thread-status', { threadId, status, ...extra });
      return t;
    },
    /**
     * A member is stuck: open an ask thread (status `waiting`) with the question as its
     * first post. The runner waits on it; a person answers from either client.
     */
    ask({ taskId = null, by, type = 'info', text, options = [], timeoutMs = 0, title = '' } = {}) {
      const ask = { type: ASK_TYPES.includes(type) ? type : 'info', options: (Array.isArray(options) ? options : []).map(String).slice(0, 6), timeoutMs };
      const thread = api.openThread({ taskId, kind: 'ask', title: title || clip(text, 120), by, status: 'waiting', ask });
      thread.waitingOn = PERSON;
      const post = api.post({ threadId: thread.id, by, kind: 'question', text, ask });
      return { thread, post };
    },
    /** The answer to an ask — from a person, on any client. Resolves the thread. */
    answer(threadId, { id = null, text, by = PERSON } = {}) {
      const t = threadOf(threadId);
      if (!t) return null;
      const post = api.post({ id, threadId, by, kind: 'answer', text });
      api.setThreadStatus(threadId, 'resolved', { answeredAt: post.at });
      return post;
    },
    thread: threadOf,
    threadForTask,
    threads: () => st.threads.map((t) => ({ ...t })),
    posts: (threadId = null) => st.posts.filter((x) => !threadId || x.threadId === threadId).map((x) => ({ ...x })),
    postById: postOf,
    /** Every ask still waiting — what a client pins at the top. */
    waiting: () => st.threads.filter((t) => t.kind === 'ask' && t.status === 'waiting').map((t) => ({ ...t })),
    /** The whole board, for the run record and for a resume. */
    state: () => ({ threads: st.threads.map((t) => ({ ...t })), posts: st.posts.map((x) => ({ ...x })) }),

    // ── findings, as before: a finding is a post in its task's thread ──
    add(list, { by = null } = {}) {
      let n = 0;
      for (const f of Array.isArray(list) ? list : [list]) {
        if (!f || !f.text) continue;
        const t = f.taskId ? (threadForTask(f.taskId) || api.openThread({ taskId: f.taskId, kind: 'task', title: f.taskId })) : (st.threads.find((x) => x.kind === 'discussion' && x.title === 'findings') || api.openThread({ kind: 'discussion', title: 'findings' }));
        api.post({ id: f.id, threadId: t.id, by: by || f.role || RUNNER, kind: 'finding', text: f.text, refs: f.refs, finding: { kind: f.kind || 'claim', confidence: f.confidence ?? null } });
        n += 1;
      }
      return n;
    },
    all: () => st.posts.filter((x) => x.kind === 'finding').map(asFinding(st)),
    byTask: (taskId) => api.all().filter((f) => f.taskId === taskId),
    byRole: (role) => api.all().filter((f) => f.role === role),
    onFinding(fn) { const l = (p) => { if (p.kind === 'finding') fn(asFinding(st)(p)); }; listeners.add(l); return () => listeners.delete(l); },
    get size() { return st.posts.filter((x) => x.kind === 'finding').length; },
  };
  return api;
}

/** A finding post in the legacy finding shape (what merge, briefs and lanes read). */
function asFinding(st) {
  return (p) => {
    const t = st.threads.find((x) => x.id === p.threadId);
    return { id: p.id, kind: p.finding?.kind || 'claim', text: p.text, refs: p.refs || [], confidence: p.finding?.confidence ?? null, role: p.by, taskId: t?.taskId || null, at: p.at, status: p.status };
  };
}

/** Findings from a folded state (a run record read from the store). */
export function findingsOf(state) {
  const st = state && Array.isArray(state.posts) ? state : emptyBoardState();
  return st.posts.filter((x) => x.kind === 'finding').map(asFinding(st));
}

/**
 * What a later task READS: the findings of the tasks it depends on (or everything so far),
 * sized. Newest are kept whole; the oldest are what get cut, and the cut is stated.
 */
export function boardText(source, { taskIds = null, max = BOARD_TEXT_MAX, role = null } = {}) {
  // A board (threads + posts) reads threaded; a bare findings array reads as before.
  const state = source && typeof source.state === 'function' ? source.state() : (source && Array.isArray(source.posts) ? source : null);
  const lines = state ? threadedLines(state, { taskIds, role }) : findingLines(source, taskIds);
  if (!lines.length) return '';
  const head = state ? 'The board so far' : 'Findings so far';
  const out = lines.join('\n');
  if (out.length <= max) return `${head}:\n${out}`;
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (size + lines[i].length + 1 > max) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return `${head} (${lines.length - kept.length} earlier lines omitted for length):\n${kept.join('\n')}`;
}

function findingLines(findings, taskIds) {
  return (findings || []).filter((f) => !taskIds || taskIds.includes(f.taskId))
    .map((f) => `- [${f.kind}${f.role ? ` · ${f.role}` : ''}${f.confidence != null ? ` · ${Math.round(f.confidence * 100)}%` : ''}] ${f.text}${f.refs?.length ? ` (refs: ${f.refs.join(', ')})` : ''}`);
}

/**
 * What a member READS: the task threads it depends on (or every task thread), the answered
 * asks and settled discussions — never rejected posts — threaded, a reply under its post.
 * A person's decision is marked so a member treats it as settled.
 */
function threadedLines(state, { taskIds, role }) {
  const out = [];
  const posts = state.posts;
  const threads = state.threads.filter((t) => {
    if (t.kind === 'task') return !taskIds || taskIds.includes(t.taskId);
    if (t.kind === 'ask') return t.status === 'resolved' && (!role || t.by === role || t.by === RUNNER);
    if (t.kind === 'discussion') return true;
    return false; // a proposal is the run's output, not a member's input
  });
  for (const t of threads) {
    const own = posts.filter((x) => x.threadId === t.id && x.status !== 'rejected');
    if (!own.length) continue;
    out.push(`## ${t.kind}${t.by && t.by !== RUNNER ? ` by ${t.by}` : ''}: ${t.title}${t.status === 'resolved' && t.kind === 'ask' ? ' (answered)' : ''}`);
    const line = (x, depth) => {
      const tag = [x.kind === 'finding' ? (x.finding?.kind || 'claim') : x.kind, x.by, x.finding?.confidence != null ? `${Math.round(x.finding.confidence * 100)}%` : null, x.status === 'approved' ? 'APPROVED' : x.status === 'proposed' ? 'proposed' : null, x.kind === 'decision' || x.by === PERSON ? 'SETTLED' : null].filter(Boolean).join(' · ');
      out.push(`${'  '.repeat(depth)}- [${tag}] ${x.text}${x.refs?.length ? ` (refs: ${x.refs.join(', ')})` : ''}`);
      for (const r of own.filter((y) => y.replyTo === x.id)) line(r, depth + 1);
    };
    for (const x of own.filter((y) => !y.replyTo)) line(x, 0);
  }
  return out;
}

/** Findings → the claim shape a draft brief takes (W7): text + refs as `{ kind, id }`. */
export function toBriefClaims(findings) {
  return (findings || [])
    .filter((f) => f.kind === 'claim' && f.text)
    .map((f) => ({
      text: f.text,
      refs: (f.refs || []).map((r) => {
        const m = /^([a-z][a-z0-9_-]*):(?!\/\/)(.+)$/.exec(String(r));
        return m ? { kind: m[1], id: m[2] } : { kind: 'url', id: String(r) };
      }),
      by: f.role || 'team',
      confidence: f.confidence,
    }));
}
