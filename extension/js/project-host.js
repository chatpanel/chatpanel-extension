// The executive loop, bound to THIS panel (F8 §12.2.5): a goal handed to the `team` tool's
// `project` action becomes a project on the gateway's record, and `runProject` (the shared
// loop, events/project-run.js) drives it with this panel's own pieces — the executive's
// structured call on the roster's strongest model, the pool through `recruiterFor`, each
// round run through `runTeamHere` (so a job's work is a run on the board with threads and a
// work log), and the person asked on the same card a page action uses.
//
// Deferred: loaded by turn-tools.js through team-host.js only when a project is started, so
// a turn with no teams pays nothing for it. Every project event lands on the gateway
// (`/v1/projects/:id/events`) as it happens; the desktop reads the same record.

import { runProject as runProjectLoop } from './events/project-run.js';
import { normalizeProject } from './events/project.js';
import { starterAgents } from './events/agent.js';
import { runTeamHere, recruiterFor, appointerFor, gatewayBase, gwFetch } from './team-host.js';
import { getTarget, resolveTarget } from './store.js';
import { sourceGuardFor, sourcePolicySettings, sourceUrlsOf } from './events/source-gate.js';
import { getGatewayToken, handshakeGatewayToken } from './gateway.js';

const DEFAULT_BUDGET = { tokens: 200000, ms: 3600000 };
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40);

/** The gateway's project record, from this panel. */
export function projectStore(settings) {
  const base = gatewayBase(settings);
  let shook = null;
  const withToken = async (fn) => { if (!getGatewayToken()) await (shook ||= handshakeGatewayToken(base)); return fn(); };
  return {
    list: (opts = {}) => withToken(() => gwFetch(`${base}/v1/projects?limit=${Number(opts.limit) || 50}`)),
    get: (id) => withToken(() => gwFetch(`${base}/v1/projects/${encodeURIComponent(id)}`)),
    jobs: () => withToken(() => gwFetch(`${base}/v1/projects/jobs`)),
    create: (body) => withToken(() => gwFetch(`${base}/v1/projects`, { method: 'POST', body: JSON.stringify(body) })),
    append: (id, events) => gwFetch(`${base}/v1/projects/${encodeURIComponent(id)}/events`, { method: 'POST', body: JSON.stringify({ events }) }),
  };
}

/** The executive's card: the pool's own when a person edited it, else the starter. */
export function executiveFor(settings) {
  const pool = Array.isArray(settings?.agentPool) ? settings.agentPool : [];
  return pool.find((a) => a && a.id === 'executive' && a.enabled !== false) || starterAgents().find((a) => a.id === 'executive');
}

/**
 * Run a goal as a project, here. `ask` is the person's card (`{ type, text, options }` →
 * `{ text, by }`); absent, the loop stops wherever the gate wants a person. `emit` gets every
 * project event for the trail. Returns project-run.js's result (the record left out — it is
 * on the gateway).
 */
export async function runProjectHere({ goal, title = '', doneWhen = '', budget = null, settings, license, like = '', bridgeUrl, bridgeAvailable, streamChat, buildTurnTools, emit = () => {}, ask = null, signal = null }) {
  const id = `${slug(title || goal) || 'project'}-${Date.now().toString(36)}`;
  const project = normalizeProject({
    id, title: String(title || '').trim() || String(goal).trim().slice(0, 80), goal, doneWhen,
    budget: budget && Object.keys(budget).length ? budget : DEFAULT_BUDGET,
    stakeholder: 'person', status: 'draft', createdBy: 'person',
  });
  const store = projectStore(settings);
  // The record is the gateway's; a gateway that is not there does not stop the loop — the
  // person still gets the result in the chat, and the events are kept for the trail.
  let synced = (await store.create({ id, project, by: 'person' })).ok;
  // Events go to the record in order, batched: whatever queued while the last append was
  // in flight goes in the next.
  let queue = [];
  let chain = Promise.resolve();
  const flush = async () => {
    if (!synced || !queue.length) return;
    const batch = queue; queue = [];
    const r = await store.append(id, batch);
    if (!r.ok) synced = false;
  };
  const push = (ev) => { queue.push(ev); chain = chain.then(flush); };

  const executive = executiveFor(settings);
  // The goal's sources narrow the roster (events/source-gate.js), as a team run's request
  // does: an internal address in the goal keeps the executive and every job within reach.
  const guard = sourceGuardFor(sourcePolicySettings(settings?.privacy), sourceUrlsOf([{ role: 'user', content: String(goal || '') }]));
  const appointRole = appointerFor(settings, license, { like, guard });
  // The executive's call: the shared structured layer on the roster's strongest model (its
  // card says best-quality), the card's prompt as the system. Returns the shaped value.
  const plan = async (prompt, schema) => {
    const a = appointRole({ id: 'executive', prefer: 'strong' });
    const target = a?.model ? resolveTarget(getTarget(settings, a.model), settings) : null;
    if (!target) return null;
    const { runStructured, STRUCTURED_SYSTEM } = await import('./structured-call.js');
    emit('project.thinking', { projectId: id, at: Date.now(), by: 'executive', model: a.label || a.model, what: schema?.name || 'plan' });
    return runStructured({ target, schema, prompt, settings, signal, maxTokens: 2500, system: [executive?.prompt, STRUCTURED_SYSTEM].filter(Boolean).join('\n\n'), usage: { surface: 'project', sourceId: id } });
  };
  const runJobs = ({ team, request }) => runTeamHere({ team, request, settings, license, like, bridgeUrl, bridgeAvailable, streamChat, buildTurnTools, signal, emit });

  const result = await runProjectLoop({
    project, pool: Array.isArray(settings.agentPool) ? settings.agentPool : [], executive: executive?.id || 'executive',
    gate: settings.gate || null,
    plan, recruit: recruiterFor(settings, license, { like }), runJobs, ask, signal,
    emit: (type, ev) => { const { projectId: _p, ...flat } = ev; push({ type, ...flat }); emit(type, ev); },
  });
  await chain;
  await flush();
  const { record: _r, ...out } = result;
  return { ...out, synced };
}
