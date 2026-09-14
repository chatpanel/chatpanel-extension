// Agent teams, bound to the extension: the shared runner given this client's model turn,
// this client's toolset narrowed by a role's grants, this client's roster — and the
// gateway's run store, so the desktop reads the board as it grows and can stop the run.
//
// The desktop has the same binding (electron/chat/teams.js) over the same package; what
// differs is only what a client is: here a model turn is `streamChat` against a resolved
// target (redaction on the way out, restore on the way back, the round/shield/gate inside),
// a toolset comes from `buildTurnTools` with the groups a role may hold, and the roster is
// the panel's endpoints and agents through the shared appointer.
//
// Deferred: loaded by turn-tools.js only when a team can run, so a turn with no teams
// pays nothing, and the panel's first paint never carries the runner.

import { runTeam } from './events/team-run.js';
import { createAnswerBox } from './events/board-tool.js';
import { createControl } from './events/team-task.js';
import { grantAllows } from './events/team.js';
import { resolveTeam } from './events/agent.js';
import { appoint } from './events/cowriter-router.js';
import { swarmCandidates } from './notes-swarm-router.js';
import { canUseAgent } from './license.js';
import { getTarget, resolveTarget } from './store.js';
import { normalizeGatewayUrl, getGatewayToken, handshakeGatewayToken } from './gateway.js';

const FLUSH_EVERY_MS = 400;
const TIMEOUT_MS = 8000;
const SYNC_GIVE_UP_AFTER = 8; // consecutive failed appends before the record is left behind

function gatewayBase(settings) {
  return normalizeGatewayUrl(settings?.gatewayUrl || 'http://127.0.0.1:4320');
}

async function gwFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const token = getGatewayToken();
    const headers = { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    return res.ok ? { ok: true, data: json } : { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A transcript as text every provider path accepts: a tool round becomes what the earlier
 * attempt did and what came back, as assistant text — the next model reads it as the work
 * so far, whatever provider is behind it.
 */
export function flattenForWire(messages) {
  const out = [];
  let acc = null;
  const flush = () => { if (acc) { out.push({ role: 'assistant', content: acc.join('\n') }); acc = null; } };
  for (const m of messages || []) {
    if (!m || !m.role || m.role === 'system') continue;
    if (m.role === 'assistant' && typeof m.thought === 'string' && m.content == null && !m.tool_calls?.length) continue; // a thought: recorded, not replayed
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      acc = acc || [];
      if (m.content) acc.push(String(m.content));
      for (const c of m.tool_calls) acc.push(`[called ${c.function?.name || 'a tool'} with ${String(c.function?.arguments || '{}').slice(0, 1500)}]`);
    } else if (m.role === 'tool') {
      acc = acc || [];
      acc.push(`[result: ${String(m.content || '').slice(0, 3000)}]`);
    } else {
      flush();
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
    }
  }
  flush();
  // Two assistant messages in a row confuse some providers: fold them.
  return out.reduce((acc2, m) => { const last = acc2.at(-1); if (last && last.role === m.role && m.role === 'assistant') last.content += `\n\n${m.content}`; else acc2.push({ ...m }); return acc2; }, []);
}

/**
 * The gateway's run store, from this client (gateway 0.6.78+). A POST carries the extension
 * Origin, which authorizes it; Chrome omits Origin on GETs to a permitted host, so reads and
 * the SSE tail need the token — handed over once by the same handshake prefs-sync uses.
 */
export function runStore(settings) {
  const base = gatewayBase(settings);
  let shook = null;
  const withToken = async (fn) => { if (!getGatewayToken()) await (shook ||= handshakeGatewayToken(base)); return fn(); };
  return {
    list: (opts = {}) => withToken(() => gwFetch(`${base}/v1/teams/runs?limit=${Number(opts.limit) || 50}`)),
    get: (id) => withToken(() => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}`)),
    create: (run) => gwFetch(`${base}/v1/teams/runs`, { method: 'POST', body: JSON.stringify({ ...run, client: 'extension' }) }),
    append: (id, events) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/events`, { method: 'POST', body: JSON.stringify({ events }) }),
    stop: (id) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
    // The board, from a person (gateway 0.6.81+): answer an ask, decide on a post, post a note.
    answer: (id, body) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ ...body, by: 'person' }) }),
    decide: (id, body) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify({ ...body, by: 'person' }) }),
    post: (id, body) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/post`, { method: 'POST', body: JSON.stringify({ ...body, by: 'person' }) }),
    // A task's continuation (gateway 0.6.85+): hand a task to another model; the checkpoint to resume; claim it when resuming.
    handoff: (id, body) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/handoff`, { method: 'POST', body: JSON.stringify({ ...body, by: 'person' }) }),
    checkpoint: (id) => withToken(() => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/checkpoint`)),
    claim: (id) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/claim`, { method: 'POST', body: JSON.stringify({ client: 'extension' }) }),
    remove: (id) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // The records (gateway 0.6.87+ / 0.6.89+): an agent's attested scorecard; every engine's card.
    scorecard: (agentId) => withToken(() => gwFetch(`${base}/v1/agents/${encodeURIComponent(agentId)}/scorecard`)),
    engines: () => withToken(() => gwFetch(`${base}/v1/engines`)),
    /** Tail a run's events (SSE). Returns a stop function. */
    tail(id, onEvent, { after = -1 } = {}) {
      const ctrl = new AbortController();
      (async () => {
        let res;
        try {
          if (!getGatewayToken()) await (shook ||= handshakeGatewayToken(base));
          const token = getGatewayToken();
          res = await fetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}/events?after=${after}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
        } catch { return; }
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* not ours */ }
              }
            }
          }
        } catch { /* aborted */ }
      })();
      return () => ctrl.abort();
    },
  };
}

/**
 * The roster: the panel's endpoints and agents, usable ones only, in trust order — the
 * target the person is chatting with first (`like`), then the rest as configured. Ties in
 * the appointer go to roster order, so this order is the preference.
 */
export function rosterFor(settings, license, { like = '' } = {}) {
  const all = swarmCandidates({ canUseAgent }, settings, license).filter((c) => c.enabled !== false);
  return [...all.filter((c) => c.id === like), ...all.filter((c) => c.id !== like)];
}

/**
 * What a candidate IS, for the record (events scorecard.js `normalizeEngine`): an installed
 * agent is a harness — the bridge agent, and the model it was asked to run when one is
 * named — and an endpoint is a model at a destination (the endpoint id), which is what the
 * model ledger will be keyed by (pillars §13.2).
 */
export function engineOfCandidate(c) {
  if (!c) return null;
  if (c.kind === 'bridge') {
    const id = c.bridgeAgent || c.id;
    return { kind: 'harness', id, ...(c.model && c.model !== id ? { model: c.model } : {}) };
  }
  return { kind: 'model', id: c.id, ...(c.model ? { model: c.model } : {}), ...(c.name ? { label: c.name } : {}) };
}

/**
 * A team as the runner needs it: roles that stand for agents (`agent: <id>`) are filled from
 * the pool (`settings.agentPool`, the shared `agents` section) — prompt, grants, skills,
 * engine, working directory. The Assistant's engine is the target this chat is on; a
 * `harness` engine becomes the installed agent that runs that CLI, a `model` engine the
 * endpoint that serves that model (at that endpoint id when the card names one), so
 * `callModel` is handed a target id this panel can resolve. Throws when a role names an
 * agent the pool does not have — a team is not run with a hole in it.
 */
export function resolveTeamHere(team, settings, license, { like = '' } = {}) {
  const candidates = rosterFor(settings, license, { like });
  const chat = candidates.find((c) => c.id === like) || null;
  const chatModel = chat ? (chat.kind === 'bridge' ? { kind: 'harness', harnessId: chat.bridgeAgent || chat.id, model: chat.model || undefined } : { kind: 'model', providerId: chat.id, model: chat.model || chat.id }) : null;
  const targetFor = (engine) => {
    if (engine.kind === 'harness') {
      const c = candidates.find((x) => x.kind === 'bridge' && (x.bridgeAgent === engine.harnessId || x.id === engine.harnessId) && (!engine.model || !x.model || x.model === engine.model) && x.usable)
        || candidates.find((x) => x.kind === 'bridge' && (x.bridgeAgent === engine.harnessId || x.id === engine.harnessId));
      return c ? c.id : null;
    }
    if (engine.kind === 'model') {
      const c = (engine.providerId ? candidates.find((x) => x.id === engine.providerId && (!x.model || x.model === engine.model)) : null)
        || candidates.find((x) => x.kind !== 'bridge' && x.model === engine.model && x.usable)
        || candidates.find((x) => x.kind !== 'bridge' && x.model === engine.model);
      return c ? c.id : null;
    }
    return null;
  };
  return resolveTeam(team, Array.isArray(settings.agentPool) ? settings.agentPool : [], { chatModel, targetFor });
}

/**
 * `(role, { exclude }) => { model, label, mode, engine, reasons, alternatives }` — a usable
 * pinned model wins; otherwise the nearest tier, skipping what `exclude` names (models that
 * failed as unavailable this run). `engine`, `reasons` and `alternatives` go on the record
 * as `task.routed` — which engine, why, who else could have.
 */
export function appointerFor(settings, license, { like = '' } = {}) {
  const candidates = rosterFor(settings, license, { like });
  const others = (chosen, n = 3) => candidates.filter((x) => x.usable && x.id !== chosen.id).slice(0, n).map(engineOfCandidate);
  return (role, { exclude = null } = {}) => {
    if (role.model && !exclude?.has?.(role.model)) {
      const c = candidates.find((x) => (x.id === role.model || x.model === role.model) && x.usable);
      if (c) return { model: c.id, label: c.model, mode: role.mode === 'subagent' && c.kind === 'bridge' ? 'subagent' : 'model', engine: engineOfCandidate(c), reasons: ['pinned by the role'], alternatives: others(c) };
    }
    const a = appoint({ id: role.id, prefer: role.prefer || 'balanced' }, candidates, { exclude });
    if (!a) return null;
    const reasons = [`nearest to ${role.prefer || 'balanced'} (${a.tier}) in trust order`, ...(a.id === like ? ['the target this chat is using'] : a.kind === 'bridge' ? ['an installed agent'] : [])];
    return { model: a.id, label: a.model, mode: role.mode === 'subagent' && a.mode === 'subagent' ? 'subagent' : 'model', engine: engineOfCandidate(a), reasons, alternatives: others(a) };
  };
}

/**
 * The bridge says `scm` twice per attempt — before (where the agent starts) and after (what
 * moved). One record per task: the first HEAD stays `head`, the last becomes `headAfter`,
 * commits add up across rounds. The runner records it as task.scm and on the scorecard.
 */
export function foldScm(prev, e) {
  if (!e || e.type !== 'scm') return prev;
  const base = prev || {};
  const out = e.phase === 'before'
    ? { ...base, repo: e.repo || base.repo, remote: e.remote || base.remote, branch: e.branch || base.branch, head: base.head || e.head, dirty: e.dirty }
    : { ...base, repo: e.repo || base.repo, remote: e.remote || base.remote, branch: e.branch || base.branch, head: base.head || e.headBefore || e.head, headAfter: e.head, commits: (base.commits || 0) + (Number(e.commits) || 0), dirty: e.dirty };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Events to the gateway as they happen — batched, ordered, flushed on the way out. */
// The runs this panel is running right now: an answer from this panel's own UI reaches the
// runner directly as well as through the gateway (which the desktop uses).
const liveRuns = new Map();
export const liveRun = (id) => liveRuns.get(String(id || '')) || null;

export function createRunSync({ store, runId, team, request, onStopRequested = null, onRemote = null, resuming = false }) {
  let queue = [];
  let timer = null;
  let dead = false;
  let stopTail = null;
  let failures = 0;
  let inflight = Promise.resolve();
  // One append at a time, in order — the immediate flush of a run.done used to race the
  // timer's flush and could land before the events it followed. A failed append (the gateway's
  // 8 s timeout, a restart) puts the batch back at the FRONT and tries again on the next
  // flush; only a run of failures gives the record up. One miss used to end the sync for the
  // rest of the run, and the store showed "running" forever for a run that had finished.
  const flush = () => {
    timer = null;
    inflight = inflight.then(async () => {
      if (dead || !queue.length) return;
      const batch = queue; queue = [];
      const res = await store.append(runId, batch);
      if (res.ok) { failures = 0; return; }
      queue = [...batch, ...queue];
      if (++failures >= SYNC_GIVE_UP_AFTER) { dead = true; return; }
      if (!timer) timer = setTimeout(flush, Math.min(FLUSH_EVERY_MS * 2 ** failures, 10_000));
    });
    return inflight;
  };
  return {
    async start() {
      // A resumed run exists on the store already: claim it rather than create it.
      const res = resuming && store.claim ? await store.claim(runId) : await store.create({ id: runId, team, request });
      if (!res.ok) { dead = true; return false; }
      // Watch our own run for what ANOTHER client did: a stop, an answer to an ask, a decision.
      if (onStopRequested || onRemote) stopTail = store.tail(runId, (ev) => { if (ev?.type === 'run.stop-requested') onStopRequested?.(); else if (String(ev?.type || '').startsWith('board.')) onRemote?.(ev); });
      return true;
    },
    push(type, payload) {
      if (dead) return;
      queue.push({ type, ...payload });
      // What a person must see NOW goes at once: the end, and an ask (the thread before it
      // in the queue goes with it — an answer must not beat its own question to the store).
      if (type === 'run.done' || type === 'task.waiting' || type === 'run.waiting') { flush(); return; }
      if (!timer) timer = setTimeout(flush, FLUSH_EVERY_MS);
    },
    async end() {
      // The way out: whatever is queued (the run's end, above all) gets its retries now.
      for (let i = 0; i < 3 && !dead; i++) { if (timer) clearTimeout(timer); await flush(); if (!queue.length) break; }
      stopTail?.();
    },
    get synced() { return !dead; },
  };
}

/**
 * Run a team in the panel. `deps` is what only the surface has: `streamChat`,
 * `buildTurnTools` (turn-tools), the settings/license, the bridge, and `emit` for the trail.
 */
export async function runTeamHere({ team, request, settings, license, like = '', bridgeUrl, bridgeAvailable, signal, emit = () => {}, streamChat, buildTurnTools, runId = null, store = null, askTimeoutMs = 10 * 60_000, resume = null }) {
  const ac = new AbortController();
  signal?.addEventListener?.('abort', () => ac.abort(), { once: true });
  const id = runId || resume?.runId || `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const gw = store || runStore(settings);
  // A person's answers to the members' asks — from this panel, or from the desktop through
  // the gateway (the store's `board.post` of kind answer, on our tail).
  const answers = createAnswerBox();
  const control = createControl();
  const sync = createRunSync({
    store: gw, runId: id, team: team.name, request, resuming: !!resume, onStopRequested: () => ac.abort(),
    onRemote: (ev) => {
      const post = ev.payload?.post;
      if (ev.type === 'board.post' && post?.kind === 'answer') answers.answer(post.threadId, { text: post.text, by: post.by, id: post.id });
      else if (ev.type === 'task.handoff-requested' && ev.payload?.taskId && ev.payload?.model) control.handoff(ev.payload.taskId, ev.payload.model, ev.payload.by || 'person', ev.payload.reason || '');
    },
  });
  await sync.start();
  liveRuns.set(id, { answers, control, stop: () => ac.abort(), team: team.name });
  const appointRole = appointerFor(settings, license, { like });
  // Roles that stand for agents, filled from the pool now — the cards as they are at run time.
  const resolved = resolveTeamHere(team, settings, license, { like });
  const roleOf = (rid) => resolved.roles.find((r) => r.id === rid) || null;
  // WHAT A HARNESS ROLE TAKES TO THE BRIDGE (pillars §14.2): its grants, so the bridge can
  // leash a push to the job's own branch or refuse one; and, when the agent's card names a
  // repository, a WORKTREE of it for this run — `cp/<team>/<run>` — shared by every harness
  // role on that repository, so the Reviewer reads what the Implementer wrote. A project's
  // and a job's own ids replace the team/run pair when project.js and job.js land (step 3).
  const runFor = (r) => {
    if (!r) return null;
    const harness = r.engine?.kind === 'harness';
    if (!harness) return null;
    const workspace = r.workdir ? { repo: r.workdir, projectId: team.name, jobId: id } : null;
    return { grants: r.grants || ['none'], ...(workspace ? { workspace } : {}) };
  };

  // A role's toolset: the same builder a turn uses, with only the groups the role may hold.
  const toolsFor = async (role) => {
    const g = role.grants || ['none'];
    if (g.includes('none')) return undefined;
    const allowedServers = (settings.mcpServers || []).filter((s) => s && grantAllows(g, 'mcp', s.id));
    return buildTurnTools({
      resolvedAgent: { id: 'team' }, settings: { ...settings, mcpServers: allowedServers }, license, bridgeUrl, bridgeAvailable,
      userText: request,
      includeHistory: grantAllows(g, 'data') || grantAllows(g, 'history'),
      includeWebSearch: grantAllows(g, 'web'),
      includeMcp: allowedServers.length > 0,
      mcpMode: allowedServers.length ? 'on' : 'off',
    });
  };

  // `signal` is the TASK's: an ask nobody answered aborts this member's turn, not the run's.
  const callModel = async ({ taskId, role, model, system, prompt, messages: transcript, tools, onDelta, onStep, signal: taskSignal }) => {
    const target = resolveTarget(getTarget(settings, model), settings);
    if (!target) return { ok: false, error: `no target for "${model}"` };
    const run = runFor(roleOf(role));
    // The task's transcript, when it has one, flattened for the wire: every provider path
    // here (OpenAI, Anthropic, a relayed agent) takes user/assistant text; not every one takes
    // another model's tool_calls. The record keeps the real shape (below).
    const sent = Array.isArray(transcript) && transcript.length ? transcript : [{ role: 'user', content: prompt }];
    const messages = flattenForWire(sent);
    let text = '';
    let usage = null;
    let scm = null; // the checkout a harness worked in, from the bridge's scm events
    // What this attempt adds to the transcript, rebuilt from the loop's tool events.
    const added = [];
    const open = new Map();
    // The member's reasoning, when the provider streams it: one thought step per stretch,
    // closed by the next call or the end — on the record for the board, never on the wire.
    let thought = '';
    const closeThought = () => { if (!thought.trim()) return; const step = { role: 'assistant', content: null, thought: thought.trim(), at: Date.now() }; thought = ''; added.push(step); onStep?.(step); };
    try {
      const out = await streamChat({
        agent: { ...target, systemPrompt: [target.systemPrompt, system].filter(Boolean).join('\n\n'), ...(run ? { run } : {}) },
        messages, settings, signal: taskSignal || ac.signal, tools,
        onDelta: (d) => { text += d; onDelta?.(d, text); },
        onEvent: (e) => {
          if (e?.type === 'usage') usage = e;
          if (e?.type === 'scm') scm = foldScm(scm, e);
          if (e?.type === 'reasoning' && e.text) thought += e.text;
          if (e?.type === 'tool' && e.phase === 'start') {
            closeThought();
            emit('task.tool', { runId: id, at: Date.now(), taskId, role, name: e.name, text: e.input?.action || '' });
            const call = { id: e.callId || `c${added.length}`, type: 'function', function: { name: e.name, arguments: JSON.stringify(e.input ?? {}) } };
            open.set(call.id, call);
            const asked = { role: 'assistant', content: null, tool_calls: [call] };
            added.push(asked); onStep?.(asked);
          } else if (e?.type === 'tool' && e.phase === 'done') {
            const callId = e.callId || [...open.keys()].at(-1);
            if (callId) { open.delete(callId); const answered = { role: 'tool', tool_call_id: callId, content: String(e.result ?? '') }; added.push(answered); onStep?.(answered); }
          }
        },
        usage: { surface: 'team', sourceId: id },
      });
      closeThought();
      const full = typeof out === 'string' ? out : (out?.text ?? text);
      const final = full || text;
      const wire = [...sent, ...added, ...(final.trim() ? [{ role: 'assistant', content: final }] : [])];
      return { ok: true, text: final, usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : null, aborted: ac.signal.aborted || taskSignal?.aborted, transcript: wire, ...(scm ? { scm } : {}) };
    } catch (e) {
      closeThought();
      const wire = [...sent, ...added, ...(text.trim() ? [{ role: 'assistant', content: text }] : [])];
      if (ac.signal.aborted || taskSignal?.aborted) return { ok: true, text, aborted: true, usage: null, transcript: wire };
      return { ok: false, error: e?.message || String(e), text, transcript: wire };
    }
  };

  try {
    const result = await runTeam({
      team: resolved, request, callModel, appoint: appointRole, runId: id, signal: ac.signal, answers, askTimeoutMs, resume, control,
      toolsFor: (role) => toolsFor(role),
      emit: (type, payload) => { sync.push(type, payload); emit(type, payload); },
    });
    return { ...result, synced: sync.synced };
  } finally {
    liveRuns.delete(id);
    await sync.end();
  }
}

/**
 * Resume a run from its record, here: the checkpoint from the gateway, the team from the
 * shared section, the same binding a chat turn uses. Finished tasks are carried; interrupted
 * ones continue their transcripts on the roster as it is now. Runs in the background; the
 * Board shows it like any run.
 */
export async function resumeRunHere(settings, license, { runId, streamChat, buildTurnTools, bridgeUrl = '', bridgeAvailable = false, emit = () => {} }) {
  if (liveRun(runId)) return { ok: false, error: 'this run is already running here' };
  const store = runStore(settings);
  const cp = await store.checkpoint(runId);
  if (!cp.ok || !cp.data?.checkpoint) return { ok: false, error: cp.error || 'no checkpoint on the record' };
  const rec = await store.get(runId);
  const teamName = rec.ok ? rec.data?.run?.team : '';
  const team = (settings.teams || []).find((t) => t?.name === teamName);
  if (!team) return { ok: false, error: `the team "${teamName}" is no longer saved` };
  runTeamHere({ team, request: rec.data?.run?.request || '', settings, license, bridgeUrl, bridgeAvailable, streamChat, buildTurnTools, emit, resume: cp.data.checkpoint, store })
    .catch((e) => console.warn('[chatpanel] team resume:', e?.message || e));
  return { ok: true, runId };
}

/** A person hands a task to another model: through the gateway (the record, the other client) and straight to a run this panel runs. */
export async function handoffTask(settings, { runId, taskId, model, reason = '' }) {
  const r = await runStore(settings).handoff(runId, { taskId, model, reason });
  const live = liveRun(runId);
  if (live && !r.ok) live.control.handoff(taskId, model, 'person', reason);
  return r.ok || !!live ? { ok: true } : { ok: false, error: r.error };
}

/** A person answers an ask: through the gateway (the record, the other client) and, when this panel runs it, straight to the runner. */
export async function answerAsk(settings, { runId, threadId, text }) {
  const r = await runStore(settings).answer(runId, { threadId, text });
  const live = liveRun(runId);
  if (live && !r.ok) live.answers.answer(threadId, { text, by: 'person' });
  return r.ok || !!live ? { ok: true } : { ok: false, error: r.error };
}
