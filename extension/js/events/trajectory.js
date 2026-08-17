// GENERATED — do not edit.
// Source of truth: chatpanel-events/trajectory.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// One turn, as an ordered, inspectable sequence.
//
// THIS LIVES IN THE SHARED PACKAGE ON PURPOSE. A trajectory is not a browser-extension
// feature: a desktop app, a mobile app and the gateway all need to answer "what happened in
// this turn, in what order, and where did the time go", and three implementations of that
// would drift into three different answers to the same question. What is client-specific is
// only the rendering — the model is shared.
//
// TWO REFERENCES, TWO LESSONS.
//
// From DevTools: the WATERFALL. A request list that only shows totals cannot answer "why
// was this slow"; laying the phases out proportionally answers it at a glance, before any
// clicking. Our phases are setup (assembling tools, connecting to MCP servers), wait (to
// first token), and work (tool calls and writing). A turn that spent 45s connecting and
// 2s thinking looks nothing like one that spent 2s connecting and 45s writing, and the
// old single duration made them identical.
//
// From the DeepSeek harness: the ENTRY LIST plus a DETAIL PANE. Every step is one row —
// system, user, context, tool call, result, answer — and selecting a row shows the whole
// of it. Rows stay short so the shape of the turn is legible; the detail pane is where
// length is allowed.
//
// What neither does, and we must: content is not here. Each entry carries a `ref`, and the
// caller resolves it from the blob store when the user actually looks. That keeps a
// trajectory cheap to build for sixty runs and honest about deleted content — a ref whose
// blob is gone resolves to "no longer stored" rather than silently showing nothing.

import { linearize } from './order.js';

/**
 * The name a human should see for a call.
 *
 * A dispatcher registers ONE tool and carries the real action in its arguments, so the raw
 * capability name is `page` for every page call. Showing that turns forty distinct actions
 * into forty identical rows — the same blindness that once stopped the loop guard exempting
 * screenshots. Lives here, not in a renderer, because every client will need it.
 */
export function displayName(call) {
  const action = call?.args?.action;
  if (typeof action !== 'string' || !action) return call?.name || 'tool';
  return action === 'describe' && call.args.tool
    ? `${call.name}.describe(${call.args.tool})`
    : `${call.name}.${action}`;
}

/** Entry kinds, in the order they conventionally appear. Used for grouping and colour. */
export const ENTRY_KINDS = Object.freeze(['system', 'user', 'context', 'route', 'tool', 'result', 'reasoning', 'assistant']);

const short = (s, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Build the ordered entries for one turn.
 *
 * `events` are that turn's events; ordering comes from `linearize`, never from wall time,
 * so a trajectory reads identically on every host and after every export.
 */
export function buildTrajectory(events) {
  const ordered = linearize(events || []);
  const entries = [];
  const calls = new Map();
  let startedAt = null;

  for (const e of ordered) {
    const p = e.payload || {};
    switch (e.type) {
      case 'turn.started':
        startedAt = e.at;
        break;

      case 'context.assembled':
        entries.push({
          kind: 'context', at: e.at, title: 'Context assembled',
          detail: `${(p.tools || []).length} tool${(p.tools || []).length === 1 ? '' : 's'} · ${p.used || 0} tokens`,
          data: { tools: p.tools || [], tokens: p.used || 0, redaction: !!p.redaction, surface: p.surface },
        });
        break;

      // The prompt blob holds system + messages + the toolset; split it into readable rows
      // at render time, since only the blob knows what was actually in it.
      // RETRIEVED MATERIAL IS INPUT, and it belongs beside the question rather than buried
      // in a tool result. 'a tool ran' and 'a tool returned five notes' are different facts,
      // and only the second explains the answer.
      case 'context.retrieved':
        entries.push({
          kind: 'context', at: e.at,
          title: p.count ? `Retrieved ${p.count} source${p.count === 1 ? '' : 's'}` : 'Retrieved material',
          detail: [p.tool, p.chars ? `${p.chars} chars` : ''].filter(Boolean).join(' · '),
          data: { tool: p.tool, count: p.count, sources: p.sources || [] },
        });
        break;

      case 'assistant.prompted':
        entries.push({ kind: 'system', at: e.at, title: 'Prompt', detail: `${p.chars || 0} chars`, ref: p.ref, expandsToMessages: true });
        break;

      // WHICH MODEL, AND WHY. Routing decisions were being recorded and then not shown,
      // which is the least useful place for them: the log knew a turn changed model three
      // times and the view that exists to explain a turn did not mention it.
      case 'policy.changed': {
        if (!String(p.dial || '').startsWith('route.')) break;
        const applied = p.dial === 'route.applied';
        entries.push({
          kind: 'route', at: e.at,
          title: applied ? `Routed to ${p.to}` : `Would route to ${p.to}`,
          detail: (p.reasons || [])[0] || '',
          data: {
            from: p.from, to: p.to, applied,
            agrees: p.agrees, strategy: p.strategy,
            reasons: p.reasons, eligible: p.eligible, rejected: p.rejected,
          },
        });
        break;
      }

      case 'automation.fired': {
        if (p.ruleId !== 'router:failover') {
          entries.push({ kind: 'route', at: e.at, title: `Rule fired: ${p.ruleId}`, detail: `class ${p.classUsed}`, data: p });
          break;
        }
        // A failover is the most consequential thing that can happen mid-turn, and the
        // reason is what makes it readable rather than alarming.
        entries.push({
          kind: 'route', at: e.at,
          title: `Failed over to ${p.to}`,
          detail: `${p.from} declined (${p.reason})`,
          data: p,
        });
        break;
      }

      case 'capability.invoked': {
        const entry = {
          kind: 'tool', at: e.at, title: displayName({ name: p.capability, args: p.args }),
          detail: short(JSON.stringify(p.args || {}), 90),
          key: p.idempotencyKey || e.id, ok: null, ms: null,
          // The facts a reader actually asks for about a call, in one place: when it
          // started in absolute time, what it was given, who asked for it, and whether it
          // could be replayed. Split across two events, they are a join the reader should
          // not have to do.
          data: {
            capability: p.capability,
            args: p.args || {},
            actor: p.actor,
            scope: p.scope,
            effects: p.effects,
            started: new Date(e.at).toISOString(),
          },
        };
        calls.set(entry.key, entry);
        entries.push(entry);
        break;
      }

      case 'capability.resulted': {
        const call = calls.get(p.idempotencyKey);
        if (call) { call.ok = p.ok; call.ms = p.cost?.ms ?? null; }
        entries.push({
          kind: 'result', at: e.at, title: `${p.capability} → ${p.ok ? 'ok' : 'failed'}`,
          detail: short(p.summary, 120), ok: !!p.ok, ms: p.cost?.ms ?? null,
          data: {
            status: p.ok ? 'completed' : 'failed',
            durationMs: p.cost?.ms ?? null,
            classUsed: p.classUsed,
            finished: new Date(e.at).toISOString(),
            result: p.summary,
          },
        });
        break;
      }

      case 'assistant.reasoning':
        entries.push({ kind: 'reasoning', at: e.at, title: 'Reasoning', detail: `${p.chars || 0} chars`, ref: p.ref });
        break;

      case 'assistant.message':
        entries.push({
          kind: 'assistant', at: e.at, title: 'Answer',
          // What it was BASED ON, on the answer row. The first thing anyone checks when an
          // answer looks wrong is what stood behind it.
          detail: [`${p.chars || 0} chars`, p.citations?.length ? `${p.citations.length} citation${p.citations.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
          ref: p.ref,
          data: p.citations?.length ? { citations: p.citations } : null,
        });
        break;

      default:
        break;
    }
  }

  for (const entry of entries) entry.offsetMs = startedAt == null ? null : entry.at - startedAt;
  return entries;
}

/**
 * The three phases of a turn, as fractions that sum to 1 — the waterfall.
 *
 * Deliberately three and not more: setup, waiting for the first token, and everything
 * after. Each has a different cause and a different fix, which is the only reason to
 * split a bar at all. `null` when the turn recorded no duration, because a bar drawn from
 * missing numbers is a confident lie.
 */
export function phasesOf(run) {
  const total = run?.ms;
  if (!Number.isFinite(total) || total <= 0) return null;
  const setup = Math.max(0, Math.min(run.prepMs || 0, total));
  const wait = Math.max(0, Math.min(run.ttftMs || 0, total - setup));
  const work = Math.max(0, total - setup - wait);
  const pct = (v) => (v / total) * 100;
  return {
    total,
    parts: [
      { key: 'setup', ms: setup, pct: pct(setup), label: 'Setup — tools and MCP servers' },
      { key: 'wait', ms: wait, pct: pct(wait), label: 'Waiting for the first word' },
      { key: 'work', ms: work, pct: pct(work), label: 'Tools and writing' },
    ].filter((p) => p.ms > 0),
  };
}

/**
 * The three LANES — input, model, tools — as spans across the turn.
 *
 * A single stacked bar says how the time divided; lanes say what was ACTIVE and when, and
 * those are different questions. Two tool calls with model thinking between them is a
 * different shape from one long call, and a stacked bar draws them identically.
 *
 * Spans are positioned as percentages of the turn, so the rendering needs no width.
 */
export function lanesOf(entries, run) {
  const total = run?.ms;
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = (ms) => Math.max(0, Math.min(100, (ms / total) * 100));
  const lanes = { input: [], model: [], tools: [] };

  for (const e of entries) {
    if (e.offsetMs == null) continue;
    const at = pct(e.offsetMs);
    if (e.kind === 'system' || e.kind === 'user' || e.kind === 'context') {
      lanes.input.push({ left: at, width: Math.max(0.6, pct(200)), label: e.title });
    } else if (e.kind === 'tool') {
      // A call's span is its own duration when known — the result carries it.
      lanes.tools.push({ left: at, width: Math.max(1, pct(e.ms || 400)), label: e.title });
    } else if (e.kind === 'assistant' || e.kind === 'reasoning') {
      lanes.model.push({ left: at, width: Math.max(1, pct(400)), label: e.title });
    }
  }
  // Waiting for the first word is model time even though nothing was emitted during it —
  // otherwise the lane looks idle for the part of the turn the user most felt.
  if (run.ttftMs > 0) lanes.model.unshift({ left: pct(run.prepMs || 0), width: pct(run.ttftMs), label: 'Waiting for the first word' });
  if (run.prepMs > 0) lanes.input.unshift({ left: 0, width: pct(run.prepMs), label: 'Setup — tools and MCP servers' });
  return lanes;
}

/**
 * Derived per-request metrics.
 *
 * A turn is not one model call. In a tool loop the model is asked, answers with a call, is
 * given the result, and is asked again — DSH calls these Request #1, #2, #3, and that
 * numbering is the thing that makes a trajectory readable: "the second request is where it
 * went wrong" is a sentence you can act on, while "the turn went wrong" is not. Our own log
 * already showed this without naming it — 36 turns carried two `context.assembled` events,
 * one per round-trip.
 *
 * Everything here is DERIVED, never stored. Throughput computed at read time cannot
 * disagree with the tokens it came from; a stored copy can, and eventually does.
 */
export function requestMetrics(req) {
  const out = Number(req?.tokensOut) || 0;
  const ttft = Number.isFinite(req?.ttftMs) ? req.ttftMs : null;
  const total = Number.isFinite(req?.ms) ? req.ms : null;
  // Generation is the part AFTER the first token: total minus the wait. Dividing tokens by
  // the total instead would blame a slow first token on the model's writing speed.
  const generationMs = total != null && ttft != null ? Math.max(0, total - ttft) : null;
  return {
    tokensIn: Number(req?.tokensIn) || 0,
    tokensOut: out,
    tokensReasoning: Number(req?.tokensReasoning) || 0,
    tokensTotal: (Number(req?.tokensIn) || 0) + out,
    ttftMs: ttft,
    generationMs,
    totalMs: total,
    // Only meaningful with both numbers and real generation time; a throughput computed
    // from a 0ms window is a very large lie.
    throughput: generationMs > 0 && out > 0 ? +(out / (generationMs / 1000)).toFixed(1) : null,
    model: req?.model || null,
    status: req?.status || 'completed',
  };
}

/**
 * Group entries into REQUESTS — one per model round-trip — so the view can show the
 * hierarchy DSH shows: a request, the calls it made, and the result that came back.
 *
 * A new request begins at each prompt (the model being asked again). Tool calls and their
 * results belong to the request that asked for them, which is what makes "hierarchy" a real
 * relationship rather than a label.
 */
export function groupRequests(entries) {
  const requests = [];
  let current = null;
  const open = () => {
    current = { index: requests.length + 1, entries: [], calls: [], answer: null, at: null };
    requests.push(current);
    return current;
  };
  for (const e of entries) {
    if (e.kind === 'system' || (!current && e.kind !== 'context')) open();
    if (!current) open();
    if (current.at == null) current.at = e.at;
    current.entries.push(e);
    e.requestIndex = current.index;
    if (e.kind === 'tool') current.calls.push(e);
    if (e.kind === 'assistant') current.answer = e;
  }
  return requests;
}

/** Filter entries by a search string, matching title and detail. */
export function filterEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => `${e.title} ${e.detail || ''}`.toLowerCase().includes(q));
}

/**
 * Group runs into THREADS, because a run on its own is not the unit anyone reasons about.
 *
 * The activity log listed 1,205 independent rows. But nobody asks "what did run 847 do" —
 * they ask what happened in a conversation, a meeting, a note. And those are not one run
 * each: a meeting holds its live monitors and its summaries, a note holds every pass over
 * it including a swarm of agents, a chat holds every message. Flattening that loses the only
 * structure the data has.
 *
 * Three levels, matching what the runs already record:
 *   thread (surface + sourceId) → turn (one run) → entries (user, context, tools, assistant)
 *
 * A run with no sourceId is its OWN thread rather than being pooled with other orphans:
 * without an id there is no evidence two runs are related, and inventing a shared parent
 * would group unrelated work under one heading — the opposite of the problem being fixed.
 */
export function threadsOf(runs = []) {
  const byKey = new Map();
  for (const run of runs) {
    if (!run) continue;
    // `kind` is the fallback that makes this work on runs recorded before surface existed —
    // and on an export of 1,215 turns, 1,203 had no surface while every one had a kind. A
    // grouping that only works on data recorded after the fix groups nothing anyone has.
    const surface = run.surface || run.turn?.surface || run.turn?.kind || run.kind || 'other';
    const sourceId = run.sourceId || run.turn?.sourceId || null;
    // THE PARENT ID IS THE KEY, ON ITS OWN. Keying on surface+id split a conversation from
    // the autocomplete done inside it — same thread, different surface — which is the exact
    // grouping this exists to produce. Ids are generated and unique, so the surface adds no
    // identity, only a way to break one thread into several.
    const key = sourceId ? `src:${sourceId}` : `run:${run.turnId || run.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, { key, surface, sourceId, runs: [], startedAt: Infinity, endedAt: -Infinity, ms: 0, tokensIn: 0, tokensOut: 0, calls: 0, errors: 0 });
    }
    const t = byKey.get(key);
    t.runs.push(run);
    const at = run.at ?? run.turn?.startedAt ?? 0;
    t.startedAt = Math.min(t.startedAt, at);
    t.endedAt = Math.max(t.endedAt, run.turn?.endedAt ?? at);
    t.ms += run.turn?.ms || 0;
    t.tokensIn += run.turn?.tokensIn || 0;
    t.tokensOut += run.turn?.tokensOut || 0;
    t.calls += run.calls?.length || 0;
    if (run.turn?.reason && run.turn.reason !== 'ok') t.errors += 1;
  }
  const threads = [...byKey.values()].map((t) => ({
    ...t,
    // A thread is named after the work it exists FOR, not after the background jobs attached
    // to it: a conversation with six autocomplete turns is still a conversation.
    surface: (t.runs.find((r) => !r.background)?.surface) || t.surface,
    startedAt: Number.isFinite(t.startedAt) ? t.startedAt : 0,
    endedAt: Number.isFinite(t.endedAt) ? t.endedAt : 0,
    // Chronological WITHIN the thread — a conversation read bottom-up is not a conversation.
    runs: [...t.runs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    turns: t.runs.length,
  }));
  // Most recently active first, which is the one question a log answers on open.
  threads.sort((a, b) => b.endedAt - a.endedAt);
  return threads;
}

/** A readable heading for a thread, from whatever it recorded. */
export function threadTitle(thread, titleFor = () => null) {
  const named = thread.sourceId ? titleFor(thread.surface, thread.sourceId) : null;
  if (named) return named;
  const first = thread.runs?.[0];
  // Falling back to the surface plus a short id beats "Untitled": it still distinguishes two
  // threads from each other, which is the minimum a heading has to do.
  const short = thread.sourceId ? String(thread.sourceId).slice(-6) : String(first?.turnId || '').slice(-6);
  const label = { chat: 'Chat', note: 'Note', meeting: 'Meeting' }[thread.surface] || (thread.surface || 'Run');
  return short ? `${label} · ${short}` : label;
}

/**
 * Split a recorded prompt into the rows a reader needs to tell things apart.
 *
 * The prompt was one row called "Prompt". But "why did it answer that" is nearly always a
 * question about WHICH input said something — the person, the page attached to their
 * message, or the instructions we added — and one row cannot answer it. So the same four
 * things that are recorded separately are shown separately:
 *
 *   SYSTEM   ours, with the tool preamble as its own row: it is the largest single thing we
 *            inject and it was hiding inside a total nobody could attribute
 *   USER     what the person typed, and nothing else
 *   CONTEXT  what was attached, one row each, named rather than pasted — including whether
 *            the model was handed it or had to ask
 *   ASSISTANT / TOOL rows come from the events, not from here
 */
export function promptEntries(prompt, at = 0) {
  const out = [];
  if (!prompt || typeof prompt !== 'object') return out;
  if (prompt.system) {
    out.push({ kind: 'system', at, title: 'System prompt', detail: `${approxChars(prompt.system)} chars`, text: prompt.system });
  }
  if (prompt.toolSystem) {
    out.push({ kind: 'system', at, title: 'Tool instructions', detail: `${approxChars(prompt.toolSystem)} chars`, text: prompt.toolSystem });
  }
  for (const m of prompt.messages || []) {
    if (!m || !String(m.content || '').trim()) continue;
    out.push({
      kind: m.role === 'assistant' ? 'assistant' : 'user',
      at, title: m.role === 'assistant' ? 'Assistant' : 'User',
      detail: '', text: String(m.content),
    });
  }
  for (const c of prompt.context || []) {
    out.push({
      kind: 'context', at,
      title: c.title || c.kind || 'Attached',
      // "read on demand" vs "included" are two very different turns that otherwise look
      // identical in a log, so the distinction is on the row rather than buried in the data.
      detail: [c.url, c.chars ? `${c.chars} chars` : '', c.deferred ? 'read on demand' : 'included'].filter(Boolean).join(' · '),
      data: c,
    });
  }
  return out;
}

const approxChars = (s) => String(s || '').length;

/**
 * Events → TURNS, each holding everything that happened inside it.
 *
 * The middle level the log was missing. A run was a row with a duration and a token count;
 * what it actually DID — what the person asked, what context came with it, which tools ran,
 * what came back — was spread across events that only shared an id. So "open the turn" had
 * nothing to open.
 *
 * A turn is the unit with a beginning and an end. Its parent is whatever it was done FOR —
 * a conversation, a note, a meeting — carried as `sourceId`, which is the identity the
 * grouping is built on. `kind` is only a label: every chat shares the kind 'chat' and they
 * are emphatically not one thread.
 */
export function turnsOf(events = []) {
  const byTurn = new Map();
  for (const e of events) {
    const id = e?.turnId || e?.payload?.turnId;
    if (!id) continue;
    if (!byTurn.has(id)) byTurn.set(id, []);
    byTurn.get(id).push(e);
  }
  const turns = [];
  for (const [turnId, evs] of byTurn) {
    const start = evs.find((e) => e.type === 'turn.started');
    const end = evs.find((e) => e.type === 'turn.ended');
    const sp = start?.payload || {};
    const ep = end?.payload || {};
    const at = start?.at ?? evs[0]?.at ?? 0;
    turns.push({
      turnId,
      at,
      // The parent. Without it a turn cannot be filed anywhere, which is a real defect and
      // not a cosmetic one — 264 of 1,215 turns in a real export were suggestions done for a
      // conversation and recorded under nothing.
      sourceId: sp.sourceId || null,
      surface: sp.surface || sp.kind || null,
      kind: sp.kind || 'chat',
      agentId: sp.agentId || null,
      background: !!sp.background,
      // Everything that happened inside, already typed: user, context, route, tool, result,
      // reasoning, assistant.
      entries: buildTrajectory(evs),
      turn: {
        startedAt: at, endedAt: end?.at ?? null, ms: ep.ms ?? null, reason: ep.reason || (end ? 'ok' : 'open'),
        kind: sp.kind || 'chat', surface: sp.surface || null, sourceId: sp.sourceId || null,
        model: ep.model || null, provider: ep.provider || null,
        tokensIn: ep.tokensIn ?? null, tokensOut: ep.tokensOut ?? null,
      },
      calls: evs.filter((e) => e.type === 'capability.invoked'),
    });
  }
  turns.sort((a, b) => a.at - b.at);
  return turns;
}

/** The whole shape in one call: threads → turns → entries. */
export function threadTree(events = []) {
  return threadsOf(turnsOf(events));
}
