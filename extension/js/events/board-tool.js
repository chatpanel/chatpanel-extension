// GENERATED — do not edit.
// Source of truth: chatpanel-events/board-tool.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The `board` tool — how a member operates on the board.
//
// Every role gets it, whatever its grants: it reaches nothing outside the run. Four actions:
// `read` the threads this member may see, `post` a note or draft in a thread, `reply` to a
// post (agree, dispute with a ref, extend), and `ask` — open an ask thread and WAIT for a
// person to answer it, from either client. Members do not chat freely: a post is typed, a
// reply hangs off a post, and an ask pauses the member's own task, never the run.
//
// Bound per task: the member's role and task are fixed at bind time, so a member cannot post
// as someone else, and its ask lands in its own task's context.

import { boardText, POST_KINDS, ASK_TYPES } from './team-board.js';

export const BOARD_TOOL_NAME = 'board';
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;

export function boardToolSpec() {
  return {
    name: BOARD_TOOL_NAME,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description:
      'The team board — where the other members\' work is, and where you speak to them and to the user. '
      + 'Actions: {"action":"read"} the threads you may see; '
      + '{"action":"post","kind":"note|draft|question","text":"…","refs":["…"]} a post in your task\'s thread; '
      + '{"action":"reply","postId":"…","kind":"note","text":"…","refs":["…"]} a reply to another member\'s post — agree, dispute with a ref, extend; '
      + '{"action":"ask","type":"info|budget|permission|direction","text":"what you need and why","options":["…"]} asks the USER and waits for the answer (minutes). '
      + 'Ask only when you are stuck — a fact you could not find, a choice only the user can make. Otherwise decide, say what you assumed, and go on.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'post', 'reply', 'ask'] },
        kind: { type: 'string', enum: POST_KINDS.filter((k) => k !== 'finding' && k !== 'answer' && k !== 'decision') },
        text: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } },
        postId: { type: 'string', description: 'For reply: the post to reply to.' },
        threadId: { type: 'string', description: 'For post: another thread you may see (default: your task\'s).' },
        type: { type: 'string', enum: [...ASK_TYPES], description: 'For ask.' },
        options: { type: 'array', items: { type: 'string' }, description: 'For ask: choices to offer the user.' },
      },
      required: ['action'],
    },
  };
}

const json = (v) => JSON.stringify(v);

/**
 * @param board     the run's live board (team-board.js createBoard)
 * @param role      the member's role id
 * @param taskId    the member's task
 * @param taskIds   the tasks this member may read (its dependencies, or null for all)
 * @param waitFor   `async (threadId, timeoutMs, signal) => { text, by } | null` — the runner's answer box
 * @param onAsk     `(thread, post) => void` — the runner marks the task waiting
 */
export function boardToolProvider({ board, role, taskId, taskIds = null, waitFor = null, onAsk = null, askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS, signal = null } = {}) {
  const ownThread = () => board.threadForTask(taskId) || board.openThread({ taskId, kind: 'task', title: taskId, by: 'runner' });
  return {
    id: 'board',
    specs: [boardToolSpec()],
    system: 'Other members\' work is on the board (the `board` tool): read it before repeating a lookup, reply where you disagree, and ask the user only when you are stuck.',
    async execute(name, input) {
      if (name !== BOARD_TOOL_NAME) return json({ error: `Unknown tool: ${name}` });
      const action = String(input?.action || '');
      if (action === 'read') {
        const text = boardText(board, { taskIds, role });
        const threads = board.threads().filter((t) => t.kind !== 'proposal').map((t) => ({ id: t.id, kind: t.kind, title: t.title, status: t.status, by: t.by, posts: t.posts }));
        return json({ board: text || 'Nothing on the board yet.', threads, postIds: board.posts().filter((p) => p.kind !== 'answer').map((p) => ({ id: p.id, threadId: p.threadId, by: p.by, kind: p.kind, head: p.text.slice(0, 80) })) });
      }
      const text = String(input?.text || '').trim();
      if (action === 'post' || action === 'reply') {
        if (!text) return json({ error: `${action} needs text.` });
        let threadId = ownThread().id;
        let replyTo = null;
        if (action === 'reply') {
          const target = board.postById(String(input?.postId || ''));
          if (!target) return json({ error: `No post ${input?.postId}. Read the board for post ids.` });
          threadId = target.threadId; replyTo = target.id;
        } else if (input?.threadId && board.thread(String(input.threadId))) {
          threadId = String(input.threadId);
        }
        const post = board.post({ threadId, by: role, kind: input?.kind || 'note', text, refs: input?.refs, replyTo });
        return json({ posted: post.id, threadId, replyTo });
      }
      if (action === 'ask') {
        if (!text) return json({ error: 'ask needs text — what you need and why.' });
        if (typeof waitFor !== 'function') return json({ error: 'This run cannot wait for the user. Decide on your best assumption and say what you assumed.' });
        const { thread, post } = board.ask({ taskId, by: role, type: input?.type, text, options: input?.options, timeoutMs: askTimeoutMs });
        onAsk?.(thread, post);
        const answer = await waitFor(thread.id, askTimeoutMs, signal);
        if (!answer) return json({ answered: false, threadId: thread.id, hint: 'No answer arrived in time. Proceed on your best assumption, say what you assumed, and note that the user did not answer.' });
        return json({ answered: true, threadId: thread.id, answer: answer.text, by: answer.by });
      }
      return json({ error: `Unknown action "${action}". Use read, post, reply or ask.` });
    },
  };
}

/**
 * The runner's answer box: `wait(threadId, ms, signal)` resolves when `answer(threadId, …)`
 * is called — by the host, from its own UI or from the run store's tail when the OTHER
 * client answered. An answer that arrives before anyone waits is kept.
 */
export function createAnswerBox() {
  const waiting = new Map(); // threadId -> resolve
  const early = new Map(); // threadId -> answer
  return {
    wait(threadId, timeoutMs, signal = null) {
      if (early.has(threadId)) { const a = early.get(threadId); early.delete(threadId); return Promise.resolve(a); }
      return new Promise((resolve) => {
        let timer = null;
        const done = (v) => { clearTimeout(timer); waiting.delete(threadId); signal?.removeEventListener?.('abort', onAbort); resolve(v); };
        const onAbort = () => done(null);
        waiting.set(threadId, done);
        if (timeoutMs > 0) timer = setTimeout(() => done(null), timeoutMs);
        if (typeof timer?.unref === 'function') timer.unref();
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
    answer(threadId, answer) {
      const a = { text: String(answer?.text ?? answer ?? ''), by: answer?.by || 'person', id: answer?.id || null };
      const w = waiting.get(threadId);
      if (w) w(a); else early.set(threadId, a);
      return !!w;
    },
    get pending() { return [...waiting.keys()]; },
  };
}

/** The host's toolset with the board tool added — first, so it is read first. */
export function withBoardTool(toolset, provider) {
  if (!toolset) {
    return {
      specs: [...provider.specs], system: provider.system,
      execute: (name, input) => provider.execute(name, input),
    };
  }
  const own = new Set(provider.specs.map((s) => s.name));
  return {
    ...toolset,
    specs: [...provider.specs, ...(toolset.specs || []).filter((s) => !own.has(s.name))],
    system: [provider.system, toolset.system].filter(Boolean).join('\n\n'),
    execute: (name, input, ...rest) => (own.has(name) ? provider.execute(name, input) : toolset.execute(name, input, ...rest)),
  };
}
