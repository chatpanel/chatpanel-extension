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
// The model is a variable, not a constant (architecture-pillars.md §13): every task fact also
// says which ENGINE did it — a model endpoint or a harness (a CLI coding agent), and for a
// harness the model it was asked to run — so `summarize` can split the card by engine
// (`byEngine`) and a recruiter can tell an agent that did well on a small model from one
// that was carried by a large one. And where the task ran in a git checkout (§14), the fact
// carries `scm`: the branch and HEAD before and after, commits made, a PR when one was
// opened, and whether it merged — the one outcome that does not come from a judge.
//
// Dependency-free: hashing is `crypto.subtle` (browser, Node, a phone), injectable for tests.

export const SCORECARD_ENTRY_KINDS = Object.freeze(['task.done', 'task.failed', 'rating', 'created', 'interaction', 'role']);
export const ROLE_KINDS = Object.freeze(['ic', 'orchestrator', 'manager', 'manager-of-managers']);
export const SCORECARD_VERSION = 1;
export const ENGINE_KINDS = Object.freeze(['model', 'harness']);

/**
 * An engine as the record keeps it: `{ kind, id, model?, label? }`. `kind` is `model` (an
 * endpoint the client calls) or `harness` (a CLI coding agent the bridge runs — `id` is the
 * harness, `model` the model it was asked to run, when one was named). A host that does not
 * say the kind gets `model`, which is the honest default for a bare model id. A string is
 * an id.
 */
export function normalizeEngine(e) {
  if (!e) return null;
  const src = typeof e === 'string' ? { id: e } : e;
  const id = String(src.id || src.harnessId || src.model || '').trim();
  if (!id) return null;
  const kind = ENGINE_KINDS.includes(src.kind) ? src.kind : (src.harnessId ? 'harness' : 'model');
  const model = src.model != null && String(src.model).trim() && String(src.model) !== id ? String(src.model).trim() : undefined;
  return { kind, id, ...(model ? { model } : {}), ...(src.label && String(src.label) !== id ? { label: String(src.label).slice(0, 120) } : {}) };
}

/** One key per engine — what `byEngine` groups on and what the model ledger will be keyed by. */
export function engineKey(e) {
  const n = normalizeEngine(e);
  return n ? `${n.kind}:${n.id}${n.model ? `/${n.model}` : ''}` : null;
}

/** What a task did in a checkout, as the record keeps it. Strings clipped, counts rounded. */
export function normalizeScm(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v, n = 200) => (v == null || v === '' ? undefined : String(v).slice(0, n));
  const out = {
    repo: str(s.repo, 300), remote: str(s.remote, 300), base: str(s.base, 120), branch: str(s.branch, 120),
    head: str(s.head, 64), headAfter: str(s.headAfter, 64),
    commits: s.commits != null ? Math.max(0, Math.round(Number(s.commits) || 0)) : undefined,
    pr: str(s.pr, 300),
    merged: s.merged === true ? true : s.merged === false ? false : undefined,
    dirty: s.dirty === true ? true : s.dirty === false ? false : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}

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
    ...(normalizeEngine(fact.engine) ? { engine: normalizeEngine(fact.engine) } : {}),
    ...(normalizeScm(fact.scm) ? { scm: normalizeScm(fact.scm) } : {}),
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
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
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
  // Per engine: how many tasks, how they went, how big, and the ratings that were ABOUT a
  // task on it. A rating names its task by `about` (the seq of the entry it rates), by
  // taskId, or — failing both — by runId when that run had exactly one task on the card.
  const engines = new Map(); // key -> { engine, tasks, done, failed, tokens, ratings[] }
  const engineOfEntry = new Map(); // seq -> key
  const byTask = new Map(); const byRun = new Map(); // taskId -> seq, runId -> [seq]
  const scm = { tasks: 0, commits: 0, prs: 0, merged: 0 };
  for (const e of list) {
    for (const t of e.tools || []) tools.add(t);
    for (const a of e.with || []) withAgents.add(a);
    for (const a of e.created || []) created.add(a);
    if (e.roleKind && (e.kind === 'task.done' || e.kind === 'task.failed' || e.kind === 'role')) roles[e.roleKind] = (roles[e.roleKind] || 0) + 1;
    if (e.model) models.set(e.model, (models.get(e.model) || 0) + 1);
    if (e.kind === 'task.done' || e.kind === 'task.failed') {
      const key = engineKey(e.engine);
      if (key) {
        const row = engines.get(key) || { engine: normalizeEngine(e.engine), tasks: 0, done: 0, failed: 0, tokens: 0, ratings: [] };
        row.tasks += 1; row[e.kind === 'task.done' ? 'done' : 'failed'] += 1; row.tokens += e.size?.tokens || 0;
        engines.set(key, row);
        engineOfEntry.set(e.seq, key);
        if (e.taskId) byTask.set(`${e.runId || ''}/${e.taskId}`, e.seq);
        if (e.runId) byRun.set(e.runId, [...(byRun.get(e.runId) || []), e.seq]);
      }
      if (e.scm) { scm.tasks += 1; scm.commits += e.scm.commits || 0; if (e.scm.pr) scm.prs += 1; if (e.scm.merged) scm.merged += 1; }
    }
  }
  for (const e of list) {
    if (e.kind !== 'rating' || !e.rating) continue;
    const seq = e.rating.about != null ? e.rating.about
      : e.taskId && byTask.has(`${e.runId || ''}/${e.taskId}`) ? byTask.get(`${e.runId || ''}/${e.taskId}`)
        : e.runId && (byRun.get(e.runId) || []).length === 1 ? byRun.get(e.runId)[0] : null;
    const key = seq != null ? engineOfEntry.get(seq) : null;
    if (key) engines.get(key).ratings.push(e.rating.score);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const byEngine = [...engines.values()].sort((a, b) => b.tasks - a.tasks).map((r) => ({
    key: engineKey(r.engine), ...r.engine, tasks: r.tasks, done: r.done, failed: r.failed,
    failRate: r.tasks ? Math.round((r.failed / r.tasks) * 1000) / 1000 : 0,
    tokens: r.tasks ? Math.round(r.tokens / r.tasks) : 0, // mean per task — the cost proxy until the ledger prices it
    rating: { avg: mean(r.ratings), count: r.ratings.length },
  }));
  // 1 − spread of rating across engines it was rated on (≥ 2): low spread = robust to routing;
  // high spread = it NEEDS a particular engine, a fact a recruiter respects, not a penalty.
  const ratedEngines = byEngine.filter((r) => r.rating.avg != null).map((r) => r.rating.avg);
  const engineIndependence = ratedEngines.length >= 2 ? Math.round((1 - (Math.max(...ratedEngines) - Math.min(...ratedEngines))) * 1000) / 1000 : null;
  // Leverage (rating above the engine's own mean) and efficiency (rating ÷ cost) wait on the
  // model ledger (§13.2, with A1): they need every engine's mean, which one card cannot know.
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
    byEngine,
    engineIndependence,
    scm,
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
export function fit(job, type, summary = null, { qualityOf = null, costOf = null, adjust = true } = {}) {
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
  let adjusted = null;
  if (summary && summary.entries) {
    const doneRate = summary.jobsDone + summary.jobsFailed ? summary.jobsDone / (summary.jobsDone + summary.jobsFailed) : 0.5;
    // The track record uses the MODEL-ADJUSTED rating when the caller can say what the
    // engines were worth (§13.3): an agent rated 0.82 mostly on a weak engine ranks above
    // one rated 0.82 on a frontier model. The reasons say so, and a person can turn it off.
    adjusted = adjust && qualityOf && summary.rating.avg != null ? adjustSummary(summary, { qualityOf, costOf: costOf || undefined }) : null;
    const rated = summary.rating.avg == null ? 0.5 : (adjusted?.adjusted ?? summary.rating.avg);
    record = doneRate * 0.5 + rated * 0.5;
    reasons.push(`${summary.jobsDone} done, ${summary.jobsFailed} failed${summary.rating.avg != null ? (adjusted && adjusted.adjusted !== adjusted.raw ? `, rated ${Math.round(adjusted.raw * 100)}% raw, ${Math.round(adjusted.adjusted * 100)}% adjusted — ${adjusted.basis[0] || 'engine-corrected'}` : `, rated ${Math.round(summary.rating.avg * 100)}%`) : ''}`);
    if (adjusted?.leverage != null && adjusted.leverage > 0.05) reasons.push(`adds ${adjusted.leverage} over its engines' own quality`);
    if (adjusted?.efficiency) reasons.push(`cleared the bar cheapest on ${adjusted.efficiency.engine}`);
    if (summary.roles.orchestrator + summary.roles.manager + summary.roles['manager-of-managers'] > 0) reasons.push(`has led: ${summary.roles.orchestrator} as orchestrator, ${summary.roles.manager} as manager`);
  } else {
    reasons.push('no record yet');
  }
  const wantSize = Number(job?.size?.steps) || 0;
  const sizeScore = !wantSize ? 1 : Math.min(1, (summary?.size?.largestSteps || 0) / wantSize) * 0.5 + 0.5;
  if (wantSize && (summary?.size?.largestSteps || 0) < wantSize) reasons.push(`largest task so far ${summary?.size?.largestSteps || 0} steps; this one is ~${wantSize}`);
  const score = Math.round((needScore * 0.6 + record * 0.3 + sizeScore * 0.1) * 1000) / 1000;
  return { score, reasons, parts: { needs: needScore, record, size: sizeScore }, ...(adjusted ? { adjusted } : {}) };
}

// ── Agent scores, normalised by engine (§13.3) — what the model ledger's cards make possible ──

/**
 * The model-adjusted view of an agent's card (scorecard.js `summarize()`), given what its
 * engines are worth: `qualityOf(key)` → the engine's quality in [0, 1] (the card's mean
 * rating for the job kind when observed, else the router's guess) or null when unknown.
 *
 *   leverage      rating on an engine minus that engine's quality, weighted by tasks — what
 *                 the agent's prompt and tools add that the model does not supply on its own
 *   adjusted      the raw rating corrected for the engines it ran on: work done on a weak
 *                 engine counts for more, on a strong one for less; `k` bounds the correction
 *   efficiency    adjusted rating ÷ cost per task on the cheapest engine that cleared `bar`
 *                 (`costOf(key)` → $/task or a token proxy; null when nothing is priced)
 *
 * Returns `{ raw, adjusted, leverage, efficiency, basis[] }` with `basis` the reasons a
 * person reads ("60 % of its tasks ran on a 0.3-quality engine").
 */
export function adjustSummary(summary, { qualityOf = () => null, costOf = () => null, reference = 0.6, k = 0.3, bar = 0.5 } = {}) {
  const raw = summary?.rating?.avg ?? null;
  const rows = (summary?.byEngine || []).filter((r) => r.key);
  const known = rows.map((r) => ({ ...r, quality: qualityOf(r.key) })).filter((r) => Number.isFinite(r.quality));
  const totalTasks = known.reduce((n, r) => n + r.tasks, 0);
  const basis = [];
  if (raw == null || !known.length || !totalTasks) return { raw, adjusted: raw, leverage: null, efficiency: null, basis: raw == null ? ['not rated yet'] : ['engines not rated yet — raw rating used'] };
  // Correction: how far below the reference the engines it ran on sit, task-weighted.
  const correction = k * known.reduce((s, r) => s + (r.tasks / totalTasks) * (reference - r.quality), 0);
  const adjusted = Math.max(0, Math.min(1, raw + correction));
  const weak = known.filter((r) => r.quality < reference);
  if (weak.length) basis.push(`${Math.round((weak.reduce((n, r) => n + r.tasks, 0) / totalTasks) * 100)} % of its tasks ran on ${weak.length === 1 ? `a ${weak[0].quality}-quality engine` : 'engines below the reference'}`);
  const strong = known.filter((r) => r.quality > reference);
  if (strong.length && !weak.length) basis.push(`ran on engines above the reference (${strong.map((r) => r.quality).join(', ')})`);
  // Leverage over the engines it was rated on.
  const rated = known.filter((r) => r.rating?.avg != null);
  const ratedTasks = rated.reduce((n, r) => n + r.rating.count, 0);
  const leverage = ratedTasks ? r3(rated.reduce((s, r) => s + (r.rating.count / ratedTasks) * (r.rating.avg - r.quality), 0)) : null;
  if (leverage != null) basis.push(`${leverage >= 0 ? '+' : ''}${leverage} over its engines' own quality`);
  // Efficiency on the cheapest engine that cleared the bar.
  const cleared = rated.filter((r) => r.rating.avg >= bar).map((r) => ({ ...r, cost: costOf(r.key) ?? (r.tokens || null) })).filter((r) => r.cost != null && r.cost > 0).sort((a, b) => a.cost - b.cost);
  const efficiency = cleared.length ? { value: r3(adjusted / cleared[0].cost), engine: cleared[0].key, costPerTask: cleared[0].cost } : null;
  return { raw: r3(raw), adjusted: r3(adjusted), leverage, efficiency, basis };
}

