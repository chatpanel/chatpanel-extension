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
import { grantAllows } from './events/team.js';
import { appoint } from './events/cowriter-router.js';
import { swarmCandidates } from './notes-swarm-router.js';
import { canUseAgent } from './license.js';
import { getTarget, resolveTarget } from './store.js';
import { normalizeGatewayUrl, getGatewayToken, handshakeGatewayToken } from './gateway.js';

const FLUSH_EVERY_MS = 400;
const TIMEOUT_MS = 8000;

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
    remove: (id) => gwFetch(`${base}/v1/teams/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
 * `(role, { exclude }) => { model, label, mode }` — a usable pinned model wins; otherwise the
 * nearest tier, skipping what `exclude` names (models that failed as unavailable this run).
 */
export function appointerFor(settings, license, { like = '' } = {}) {
  const candidates = rosterFor(settings, license, { like });
  return (role, { exclude = null } = {}) => {
    if (role.model && !exclude?.has?.(role.model)) {
      const c = candidates.find((x) => (x.id === role.model || x.model === role.model) && x.usable);
      if (c) return { model: c.id, label: c.model, mode: role.mode === 'subagent' && c.kind === 'bridge' ? 'subagent' : 'model' };
    }
    const a = appoint({ id: role.id, prefer: role.prefer || 'balanced' }, candidates, { exclude });
    return a ? { model: a.id, label: a.model, mode: role.mode === 'subagent' && a.mode === 'subagent' ? 'subagent' : 'model' } : null;
  };
}

/** Events to the gateway as they happen — batched, ordered, flushed on the way out. */
// The runs this panel is running right now: an answer from this panel's own UI reaches the
// runner directly as well as through the gateway (which the desktop uses).
const liveRuns = new Map();
export const liveRun = (id) => liveRuns.get(String(id || '')) || null;

export function createRunSync({ store, runId, team, request, onStopRequested = null, onRemote = null }) {
  let queue = [];
  let timer = null;
  let dead = false;
  let stopTail = null;
  const flush = async () => {
    timer = null;
    if (dead || !queue.length) return;
    const batch = queue; queue = [];
    const res = await store.append(runId, batch);
    if (!res.ok) dead = true;
  };
  return {
    async start() {
      const res = await store.create({ id: runId, team, request });
      if (!res.ok) { dead = true; return false; }
      // Watch our own run for what ANOTHER client did: a stop, an answer to an ask, a decision.
      if (onStopRequested || onRemote) stopTail = store.tail(runId, (ev) => { if (ev?.type === 'run.stop-requested') onStopRequested?.(); else if (String(ev?.type || '').startsWith('board.')) onRemote?.(ev); });
      return true;
    },
    push(type, payload) {
      if (dead) return;
      queue.push({ type, ...payload });
      if (type === 'run.done') { flush(); return; }
      if (!timer) timer = setTimeout(flush, FLUSH_EVERY_MS);
    },
    async end() { if (timer) clearTimeout(timer); await flush(); stopTail?.(); },
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
  const id = runId || `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const gw = store || runStore(settings);
  // A person's answers to the members' asks — from this panel, or from the desktop through
  // the gateway (the store's `board.post` of kind answer, on our tail).
  const answers = createAnswerBox();
  const sync = createRunSync({
    store: gw, runId: id, team: team.name, request, onStopRequested: () => ac.abort(),
    onRemote: (ev) => { const post = ev.payload?.post; if (ev.type === 'board.post' && post?.kind === 'answer') answers.answer(post.threadId, { text: post.text, by: post.by, id: post.id }); },
  });
  await sync.start();
  liveRuns.set(id, { answers, stop: () => ac.abort(), team: team.name });
  const appointRole = appointerFor(settings, license, { like });

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

  const callModel = async ({ taskId, role, model, system, prompt, tools, onDelta }) => {
    const target = resolveTarget(getTarget(settings, model), settings);
    if (!target) return { ok: false, error: `no target for "${model}"` };
    const messages = [{ role: 'user', content: prompt }];
    let text = '';
    let usage = null;
    try {
      const out = await streamChat({
        agent: { ...target, systemPrompt: [target.systemPrompt, system].filter(Boolean).join('\n\n') },
        messages, settings, signal: ac.signal, tools,
        onDelta: (d) => { text += d; onDelta?.(d, text); },
        onEvent: (e) => {
          if (e?.type === 'usage') usage = e;
          if (e?.type === 'tool' && e.phase === 'start') emit('task.tool', { runId: id, at: Date.now(), taskId, role, name: e.name, text: e.input?.action || '' });
        },
        usage: { surface: 'team', sourceId: id },
      });
      const full = typeof out === 'string' ? out : (out?.text ?? text);
      return { ok: true, text: full || text, usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : null, aborted: ac.signal.aborted };
    } catch (e) {
      if (ac.signal.aborted) return { ok: true, text, aborted: true, usage: null };
      return { ok: false, error: e?.message || String(e), text };
    }
  };

  try {
    const result = await runTeam({
      team, request, callModel, appoint: appointRole, runId: id, signal: ac.signal, answers, askTimeoutMs, resume,
      toolsFor: (role) => toolsFor(role),
      emit: (type, payload) => { sync.push(type, payload); emit(type, payload); },
    });
    return { ...result, synced: sync.synced };
  } finally {
    liveRuns.delete(id);
    await sync.end();
  }
}

/** A person answers an ask: through the gateway (the record, the other client) and, when this panel runs it, straight to the runner. */
export async function answerAsk(settings, { runId, threadId, text }) {
  const r = await runStore(settings).answer(runId, { threadId, text });
  const live = liveRun(runId);
  if (live && !r.ok) live.answers.answer(threadId, { text, by: 'person' });
  return r.ok || !!live ? { ok: true } : { ok: false, error: r.error };
}
