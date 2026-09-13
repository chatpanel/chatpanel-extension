// GENERATED — do not edit.
// Source of truth: chatpanel-events/scorecard.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// An agent's scorecard — an immutable record of what it actually did, and matching on it.
//
// A scorecard is a CHAIN of entries, one per fact, append-only: a task it finished (how big,
// with which tools, alongside whom, in which role), a rating a job gave it, an agent it
// created, an interaction. Every entry carries the hash of the one before and its own hash,
// so an edit anywhere breaks every link after it; the gateway's store adds its own mark
// (an HMAC over the hash with a key only the store holds) so an entry a client — or an
// agent — wrote for itself shows as unattested. The facts are produced by the runner and
// attested by the store, never written by the agent: the only way to a better scorecard is
// the work.
//
// `summarize` turns the chain into the card a recruiter reads; `fit` scores an agent type
// against a job's needs with that record — the same function the evaluator starts from, so
// an application's fit has reasons a person can read and overrule.
//
// Dependency-free: hashing is `crypto.subtle` (browser, Node, a phone), injectable for tests.

export const SCORECARD_ENTRY_KINDS = Object.freeze(['task.done', 'task.failed', 'rating', 'created', 'interaction', 'role']);
export const ROLE_KINDS = Object.freeze(['ic', 'orchestrator', 'manager', 'manager-of-managers']);
export const SCORECARD_VERSION = 1;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Canonical JSON: keys sorted at every level, so the same fact hashes the same everywhere. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonical(v[k])}`)).filter(Boolean).join(',')}}`;
}

/** SHA-256 over text, as hex; `subtle` is injectable (a runtime without it passes its own). */
export async function sha256(text, { subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw new Error('scorecard: no crypto.subtle — pass one');
  return hex(await subtle.digest('SHA-256', enc.encode(String(text))));
}

/** The fields a hash covers — everything but the hash and the store's mark. */
function hashable(e) {
  const { hash: _h, sig: _s, ...rest } = e;
  return rest;
}

/**
 * A new entry chained onto `prev` (the last entry, or null for the first). Pure apart from
 * the digest: the caller (the store) decides whether it is attested.
 */
export async function makeEntry(fact, prev, { now = () => Date.now(), subtle } = {}) {
  if (!fact || typeof fact !== 'object') throw new Error('scorecard: an entry needs a fact');
  if (!SCORECARD_ENTRY_KINDS.includes(fact.kind)) throw new Error(`scorecard: kind must be one of ${SCORECARD_ENTRY_KINDS.join(', ')}`);
  if (!fact.agentId) throw new Error('scorecard: agentId required');
  const e = {
    v: SCORECARD_VERSION,
    seq: prev ? prev.seq + 1 : 0,
    agentId: String(fact.agentId),
    kind: fact.kind,
    at: Number(fact.at) || now(),
    ...(fact.projectId ? { projectId: String(fact.projectId) } : {}),
    ...(fact.jobId ? { jobId: String(fact.jobId) } : {}),
    ...(fact.runId ? { runId: String(fact.runId) } : {}),
    ...(fact.taskId ? { taskId: String(fact.taskId) } : {}),
    ...(fact.model ? { model: String(fact.model) } : {}),
    ...(fact.size ? { size: sizeOf(fact.size) } : {}),
    ...(fact.roleKind ? { roleKind: ROLE_KINDS.includes(fact.roleKind) ? fact.roleKind : 'ic' } : {}),
    ...(Array.isArray(fact.tools) && fact.tools.length ? { tools: [...new Set(fact.tools.map(String))].sort() } : {}),
    ...(Array.isArray(fact.with) && fact.with.length ? { with: [...new Set(fact.with.map(String))].sort() } : {}),
    ...(Array.isArray(fact.created) && fact.created.length ? { created: [...new Set(fact.created.map(String))] } : {}),
    ...(fact.rating ? { rating: { by: String(fact.rating.by || 'person'), score: clamp01(fact.rating.score), ...(fact.rating.note ? { note: String(fact.rating.note).slice(0, 500) } : {}), ...(fact.rating.about != null ? { about: Number(fact.rating.about) } : {}) } } : {}),
    ...(Array.isArray(fact.refs) && fact.refs.length ? { refs: fact.refs.map(String).slice(0, 12) } : {}),
    ...(fact.error ? { error: String(fact.error).slice(0, 300) } : {}),
    prev: prev ? prev.hash : null,
  };
  e.hash = await sha256(canonical(hashable(e)), { subtle });
  return e;
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const sizeOf = (s) => ({ ms: Math.max(0, Math.round(Number(s.ms) || 0)), steps: Math.max(0, Math.round(Number(s.steps) || 0)), tools: Math.max(0, Math.round(Number(s.tools) || 0)), findings: Math.max(0, Math.round(Number(s.findings) || 0)), tokens: Math.max(0, Math.round(Number(s.tokens) || 0)) });

/** Does every link hold? Returns `{ ok, at }` — `at` is the seq of the first broken entry. */
export async function verifyChain(entries, { subtle } = {}) {
  let prev = null;
  for (const e of entries || []) {
    if (!e || typeof e !== 'object') return { ok: false, at: prev ? prev.seq + 1 : 0, why: 'not an entry' };
    if ((prev ? prev.seq + 1 : 0) !== e.seq) return { ok: false, at: e.seq, why: 'seq' };
    if ((prev ? prev.hash : null) !== e.prev) return { ok: false, at: e.seq, why: 'prev' };
    const h = await sha256(canonical(hashable(e)), { subtle });
    if (h !== e.hash) return { ok: false, at: e.seq, why: 'hash' };
    prev = e;
  }
  return { ok: true, at: null, length: (entries || []).length };
}

/**
 * The store's mark. `key` is raw bytes only the store holds; an HMAC-SHA-256 over the hash.
 * Anyone can re-hash the chain; only the store can mark it, so an entry written elsewhere
 * is honest about being unattested. Injectable `subtle` again.
 */
export async function attest(entry, key, { subtle = globalThis.crypto?.subtle } = {}) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { ...entry, sig: hex(await subtle.sign('HMAC', k, enc.encode(entry.hash))) };
}
export async function verifyAttested(entries, key, { subtle = globalThis.crypto?.subtle } = {}) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const out = [];
  for (const e of entries || []) {
    const sig = e?.sig ? new Uint8Array(e.sig.match(/../g).map((x) => parseInt(x, 16))) : null;
    out.push(!!sig && await subtle.verify('HMAC', k, sig, enc.encode(e.hash)));
  }
  return { ok: out.every(Boolean), attested: out.filter(Boolean).length, of: out.length };
}

/** The card a recruiter reads. */
export function summarize(entries, { recent = 5 } = {}) {
  const list = (entries || []).filter((e) => e && e.kind);
  const done = list.filter((e) => e.kind === 'task.done');
  const failed = list.filter((e) => e.kind === 'task.failed');
  const sum = (k) => done.reduce((n, e) => n + (e.size?.[k] || 0), 0);
  const largest = done.reduce((m, e) => Math.max(m, e.size?.steps || 0), 0);
  const tools = new Set(); const withAgents = new Set(); const created = new Set();
  const roles = { ic: 0, orchestrator: 0, manager: 0, 'manager-of-managers': 0 };
  const models = new Map();
  for (const e of list) {
    for (const t of e.tools || []) tools.add(t);
    for (const a of e.with || []) withAgents.add(a);
    for (const a of e.created || []) created.add(a);
    if (e.roleKind && (e.kind === 'task.done' || e.kind === 'task.failed' || e.kind === 'role')) roles[e.roleKind] = (roles[e.roleKind] || 0) + 1;
    if (e.model) models.set(e.model, (models.get(e.model) || 0) + 1);
  }
  const ratings = list.filter((e) => e.kind === 'rating' && e.rating).map((e) => e.rating.score);
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
  const recentRatings = ratings.slice(-recent);
  const refs = [...new Set(list.flatMap((e) => e.refs || []))].slice(-recent);
  return {
    agentId: list[0]?.agentId || null,
    entries: list.length,
    jobsDone: done.length,
    jobsFailed: failed.length,
    size: { ms: sum('ms'), steps: sum('steps'), tools: sum('tools'), findings: sum('findings'), tokens: sum('tokens'), largestSteps: largest },
    tools: [...tools].sort(),
    workedWith: [...withAgents].sort(),
    created: [...created],
    roles,
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ model: m, tasks: n })),
    rating: { avg, count: ratings.length, recent: recentRatings.length ? recentRatings.reduce((a, b) => a + b, 0) / recentRatings.length : null },
    refs,
    since: list[0]?.at || null,
    last: list.at(-1)?.at || null,
    head: list.at(-1)?.hash || null,
  };
}

/**
 * How well an agent TYPE fits a job, with that type's record. `job.needs` is
 * `{ skills[], tools[], grants[] }`; `type` carries `skills[]`, `tools[]`, `grants[]`; the
 * summary is `summarize()`'s. Returns `{ score, reasons }` in [0, 1] — needs first (a type
 * without the tools cannot do the job), track record second, size third.
 */
export function fit(job, type, summary = null) {
  const needs = job?.needs || {};
  const have = (xs) => new Set((xs || []).map((x) => String(x).toLowerCase()));
  const skills = have(type?.skills); const tools = have(type?.tools); const grants = have(type?.grants);
  const reasons = [];
  const coverage = (want, has, label) => {
    const w = (want || []).map((x) => String(x).toLowerCase());
    if (!w.length) return 1;
    const hit = w.filter((x) => has.has(x));
    if (hit.length < w.length) reasons.push(`missing ${label}: ${w.filter((x) => !has.has(x)).join(', ')}`);
    return hit.length / w.length;
  };
  const cSkills = coverage(needs.skills, skills, 'skills');
  const cTools = coverage(needs.tools, tools, 'tools');
  const cGrants = coverage(needs.grants, grants, 'grants');
  const needScore = (cSkills * 0.5 + cTools * 0.3 + cGrants * 0.2);
  if (needScore === 1) reasons.push('has every skill, tool and grant the job names');
  let record = 0.5; // a fresh type is neither trusted nor distrusted
  if (summary && summary.entries) {
    const doneRate = summary.jobsDone + summary.jobsFailed ? summary.jobsDone / (summary.jobsDone + summary.jobsFailed) : 0.5;
    const rated = summary.rating.avg == null ? 0.5 : summary.rating.avg;
    record = doneRate * 0.5 + rated * 0.5;
    reasons.push(`${summary.jobsDone} done, ${summary.jobsFailed} failed${summary.rating.avg != null ? `, rated ${Math.round(summary.rating.avg * 100)}%` : ''}`);
    if (summary.roles.orchestrator + summary.roles.manager + summary.roles['manager-of-managers'] > 0) reasons.push(`has led: ${summary.roles.orchestrator} as orchestrator, ${summary.roles.manager} as manager`);
  } else {
    reasons.push('no record yet');
  }
  const wantSize = Number(job?.size?.steps) || 0;
  const sizeScore = !wantSize ? 1 : Math.min(1, (summary?.size?.largestSteps || 0) / wantSize) * 0.5 + 0.5;
  if (wantSize && (summary?.size?.largestSteps || 0) < wantSize) reasons.push(`largest task so far ${summary?.size?.largestSteps || 0} steps; this one is ~${wantSize}`);
  const score = Math.round((needScore * 0.6 + record * 0.3 + sizeScore * 0.1) * 1000) / 1000;
  return { score, reasons, parts: { needs: needScore, record, size: sizeScore } };
}
