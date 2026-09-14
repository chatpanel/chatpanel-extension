// GENERATED — do not edit.
// Source of truth: chatpanel-events/recruit.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Recruiting — applying and evaluating, the step between a posted job and a run (F8 §12.2.4,
// architecture-pillars.md §13.4).
//
// Applications are COMPUTED, not asked for: every agent in the pool applies to every job at
// once, scored by `fit` (scorecard.js) on its skills, tools, grants and its attested record —
// the model-ADJUSTED rating when the engine rows say what its engines were worth. Recruiting
// costs one model turn per job, not one per applicant, and that turn is optional.
//
// What is recruited is an (agent, engine) PAIR. An agent's engine may be fixed (`model`,
// `harness`), the chat's (`assistant`), or `auto` with a policy; `routeFor` resolves it
// against the ENGINE ROWS the host knows — every model or harness it can run, with reach,
// capabilities, quality / latency / cost (the engine card's observed values over the router's
// guess, `engineRow`) and whether it is available right now. Requirements eliminate first
// (reach from the project's privacy setting — never learned, only typed; a work grant needs a
// harness; tools need `tools`), the policy orders what survives over observed values, and the
// agent's own record on each engine breaks ties. An agent whose engine does not clear is
// still an applicant — a person should see it — but is not recruitable now.
//
// The EVALUATOR is one structured call (RECRUIT_SCHEMA) over the top applications: the pick
// and why, or "none fits" with the agent that should exist. The call is the host's
// (`runStructured` in a client; a gateway without a model skips it): `decide` takes its parsed
// answer when there is one and falls back to the best fit above a floor when there is not, so
// a job is recruited with or without a model. The decision lands on the project record as
// events (`recruitEvents`) — the pick and the reasons on the job, a proposal as a decision a
// person reads — never as a mutation.
//
// Pure, dependency-free; imports only what the gateway already vendors (scorecard.js,
// model-ledger.js, engine.js, agent.js, job.js, team.js, structured.js, budget.js).

import { fit, engineKey, normalizeEngine } from './scorecard.js';
import { cardOverride, DEFAULT_MIN_CALLS } from './model-ledger.js';
import { normalizeEngineSpec, engineKeyOf, describeEngine } from './engine.js';
import { engineOf, agentFromForm, normalizeAgent, resolveTeam } from './agent.js';
import { applyAll, jobToRole } from './job.js';
import { WORK_GRANTS } from './team.js';
import { defineSchema, describeSchema, coerce } from './structured.js';
import { normalizeBudget } from './budget.js';

export const MIN_FIT = 0.5;
export const TOP_APPLICANTS = 5;
export const MAX_BRIEF_IN_PROMPT = 1500;
const REACH_RANK = { device: 0, trusted: 1, any: 2 };

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const clip = (s, n) => String(s || '').trim().slice(0, n);
const lower = (xs) => (Array.isArray(xs) ? xs : []).map((x) => String(x).toLowerCase());

// ── The evaluator's answer ────────────────────────────────────────────────────────────────

export const RECRUIT_SCHEMA = defineSchema({
  name: 'recruit',
  purpose: 'which applicant gets the job, or that none fits and what agent should exist',
  fields: {
    // Not `required`: an emptied required field reads as "nothing" and would drop the proposal that rides beside it.
    pick: { type: 'string', max: 64, describe: 'the id of the ONE applicant to recruit, or "" when none fits' },
    why: { type: 'string', required: true, max: 400, describe: 'one or two sentences a person reads on the job page' },
    confidence: { type: 'number', describe: '0 to 1' },
    proposalName: { type: 'string', max: 60, describe: 'when none fits: the agent that should exist' },
    proposalPurpose: { type: 'string', max: 300 },
    proposalSkills: { type: 'string[]', maxItems: 12 },
    proposalGrants: { type: 'string[]', maxItems: 8, describe: 'from: data, web, history, mcp, shell, fs:write, scm:read, scm:push, scm:pr' },
  },
  nothing: { pick: '', why: 'none fits' },
});

// ── Engine rows: what the host can run, as the recruiter reads it ─────────────────────────

/**
 * One row from a host's candidate (a router model — `inferCandidate`'s shape: `id`, `model`,
 * `reach`, `capabilities`, `quality`, `latencyMs`, `costPer1k`, `available`, `classUsed`;
 * or anything carrying an `engine` ref) with its engine CARD applied: observed quality,
 * latency, cost and availability replace the guess where there is enough history, and a
 * withdrawn capability is gone. A bridge agent (`classUsed 'A'` / `kind 'bridge'`) is a
 * harness — `claude/opus` is the harness `claude` asked to run `opus` — keyed the way the
 * desktop's appointer and the engine ledger key it.
 */
export function engineRow(candidate, { card = null, minCalls = DEFAULT_MIN_CALLS, jobKind = null } = {}) {
  if (!isRecord(candidate)) return null;
  const c = candidate;
  let engine = c.engine ? normalizeEngine(c.engine) : null;
  if (!engine) {
    const name = String(c.model || c.id || '');
    if (!name) return null;
    if (c.kind === 'bridge' || c.kind === 'harness' || c.classUsed === 'A') {
      const slash = name.indexOf('/');
      engine = slash > 0 ? { kind: 'harness', id: name.slice(0, slash), model: name.slice(slash + 1) } : { kind: 'harness', id: name };
    } else engine = { kind: 'model', id: name };
  }
  const key = engineKey(engine);
  if (!key) return null;
  const { override, observed } = cardOverride(card, { minCalls, jobKind });
  const withdrawn = new Set(card?.capabilities?.withdrawn || []);
  const capabilities = [...new Set(lower(c.capabilities))].filter((x) => !withdrawn.has(x));
  if (withdrawn.size && lower(c.capabilities).some((x) => withdrawn.has(x))) observed.push('capabilities');
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const reach = REACH_RANK[c.reach] != null ? c.reach : 'any';
  // A model on this machine costs nothing per token — the router's own rule (`costOf`), kept
  // here for a host that has no guess to offer; an unknown cost anywhere else stays unknown
  // and orders as the dearest, so "we did not price it" never reads as "free".
  const costPer1k = override.costPer1k ?? num(c.costPer1k) ?? (reach === 'device' && engine.kind === 'model' ? 0 : null);
  return {
    key,
    engine,
    label: clip(c.label || c.name || engineName(engine), 120),
    reach,
    capabilities,
    quality: override.quality ?? num(c.quality),
    latencyMs: override.latencyMs ?? num(c.latencyMs),
    costPer1k,
    costPerTask: num(card?.cost?.perTask),
    availability: num(card?.availability?.rate),
    available: override.available ?? (c.available !== false && c.usable !== false),
    observed,
  };
}
const engineName = (e) => `${e.id}${e.model && e.model !== e.id ? `/${e.model}` : ''}`;

/** Rows from a host's candidates and the cards it holds (by key). */
export function engineRows(candidates, { cards = {}, minCalls, jobKind } = {}) {
  const out = []; const seen = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const row = engineRow(c, { card: null, minCalls, jobKind });
    if (!row || seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(cards[row.key] ? engineRow(c, { card: cards[row.key], minCalls, jobKind }) : row);
  }
  return out;
}

// ── What the job needs of an engine ───────────────────────────────────────────────────────

/**
 * Requirements eliminate; they are never traded for cost or speed. A work grant (`shell`,
 * `fs:write`, `scm:*`) can only be exercised by a harness — a chat model has no shell. Tools
 * or any grant beyond `none` mean the turn may call tools. Reach is the project's privacy
 * ceiling, typed, never learned.
 */
export function needForJob(job, { reach = 'any' } = {}) {
  const grants = lower(job?.needs?.grants).filter((g) => g !== 'none');
  const tools = lower(job?.needs?.tools);
  const harness = grants.some((g) => WORK_GRANTS.includes(g));
  const capabilities = [];
  const why = [];
  if (tools.length || grants.length) { capabilities.push('tools'); why.push('the job uses tools'); }
  if (harness) why.push(`a work grant (${grants.filter((g) => WORK_GRANTS.includes(g)).join(', ')}) needs an agent tool`);
  const r = REACH_RANK[reach] != null ? reach : 'any';
  if (r !== 'any') why.push(`reach ≤ ${r} (the project's privacy setting)`);
  return { capabilities, harness, reach: r, why };
}

// ── Routing: the engine for this agent on this job ────────────────────────────────────────

const meets = (row, need, policy) => {
  const why = [];
  if (row.available === false) why.push('unavailable right now');
  if (REACH_RANK[row.reach] > REACH_RANK[need.reach]) why.push(`reach ${row.reach} exceeds ${need.reach}`);
  if (need.harness && row.engine.kind !== 'harness') why.push('not an agent tool');
  const missing = need.capabilities.filter((c) => !row.capabilities.includes(c));
  // A harness brings its own tools; the capability list of a bridge agent is the host's guess.
  if (missing.length && !(row.engine.kind === 'harness' && missing.every((c) => c === 'tools'))) why.push(`lacks ${missing.join(', ')}`);
  if (policy) {
    const matches = (refs) => (refs || []).some((k) => k === row.key || k === `${row.engine.kind}:${row.engine.id}` || k === row.engine.id || k === row.engine.model);
    if (policy.allow?.length && !matches(policy.allow)) why.push('not on the policy\'s allow list');
    if (policy.deny?.length && matches(policy.deny)) why.push('on the policy\'s deny list');
    if (policy.floor?.quality != null && row.quality != null && row.quality < policy.floor.quality) why.push(`quality ${row.quality} under the floor ${policy.floor.quality}`);
    if (policy.floor?.availability != null && row.availability != null && row.availability < policy.floor.availability) why.push(`availability ${row.availability} under the floor ${policy.floor.availability}`);
    if (policy.ceiling?.costPerTask != null && row.costPerTask != null && row.costPerTask > policy.ceiling.costPerTask) why.push(`$${row.costPerTask}/task over the ceiling`);
    if (policy.ceiling?.latencyMs != null && row.latencyMs != null && row.latencyMs > policy.ceiling.latencyMs) why.push(`${row.latencyMs} ms over the ceiling`);
  }
  return why;
};

const ownRating = (summary, key) => (summary?.byEngine || []).find((r) => r.key === key)?.rating?.avg ?? null;

/** Order the rows that clear by the policy's preference; the agent's own record on an engine breaks ties. */
function orderByPolicy(rows, prefer, summary) {
  const q = (r) => r.quality ?? 0.5;
  const cost = (r) => r.costPerTask ?? r.costPer1k ?? null;
  const maxCost = Math.max(...rows.map((r) => cost(r) ?? 0), 0) || 1;
  const maxLat = Math.max(...rows.map((r) => r.latencyMs ?? 0), 0) || 1;
  const own = (r) => { const v = ownRating(summary, r.key); return v == null ? 0 : v - 0.5; };
  const score = (r) => {
    switch (prefer) {
      case 'cheapest-that-clears': return -((cost(r) ?? maxCost) / maxCost) + q(r) * 0.01;
      case 'best-quality': return q(r) - ((cost(r) ?? maxCost) / maxCost) * 0.01;
      case 'fastest': return -((r.latencyMs ?? maxLat) / maxLat) + q(r) * 0.01;
      default: return q(r) * 0.5 + (1 - (cost(r) ?? maxCost) / maxCost) * 0.25 + (1 - (r.latencyMs ?? maxLat) / maxLat) * 0.25;
    }
  };
  return rows.map((r) => ({ row: r, score: score(r) + own(r) * 0.05 })).sort((a, b) => b.score - a.score).map((x) => x.row);
}

const rowLine = (r) => `${r.key} (quality ${r.quality ?? '?'}${r.observed.includes('quality') ? ' observed' : ''}${r.costPerTask != null ? `, $${r.costPerTask}/task` : r.costPer1k != null ? `, $${r.costPer1k}/1k` : ''}${r.latencyMs != null ? `, ${r.latencyMs} ms` : ''})`;

/**
 * The engine this agent would run this job on, and why — `{ engine, key, reasons,
 * alternatives, exploration, clears }`; `clears: false` (engine null) when nothing does, with
 * the reasons. `rows` are the host's `engineRows`; an empty roster trusts a fixed spec and
 * refuses `auto` (nothing to pick from). `explore` takes one tier cheaper than the policy's
 * pick when a cheaper row clears — the project loop's bounded exploration (§13.4); never for
 * a harness.
 */
export function routeFor(agent, job, { rows = [], summary = null, need = null, reach = 'any', chatModel = null, explore = false } = {}) {
  const n = need || needForJob(job, { reach });
  const spec = engineOf(agent, { chatModel });
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const none = (reasons) => ({ engine: null, key: null, reasons, alternatives: [], exploration: false, clears: false });
  if (spec.kind !== 'auto') {
    const key = engineKeyOf(spec);
    const exact = list.find((r) => r.key === key);
    // A harness card without a model matches any row of that harness; a model spec without a
    // provider matches the row that runs that model anywhere.
    const near = exact || list.find((r) => r.engine.kind === spec.kind && (spec.kind === 'harness' ? r.engine.id === spec.harnessId && !spec.model : (r.engine.id === spec.model || r.engine.model === spec.model) && !spec.providerId));
    if (!list.length) return { engine: normalizeEngine({ kind: spec.kind, id: spec.kind === 'harness' ? spec.harnessId : (spec.providerId || spec.model), model: spec.model }), key, reasons: [`${describeEngine(spec)} — pinned by the agent; no roster to check it against`], alternatives: [], exploration: false, clears: true };
    if (!near) return none([`${describeEngine(spec)} is pinned by the agent but is not installed or configured here`]);
    const why = meets(near, n, null);
    if (why.length) return none([`${describeEngine(spec)} is pinned by the agent but ${why.join('; ')}`]);
    return { engine: near.engine, key: near.key, reasons: ['pinned by the agent', ...n.why], alternatives: [], exploration: false, clears: true };
  }
  if (!list.length) return none(['engine is auto and the roster is empty']);
  const policy = spec.policy || {};
  const rejected = [];
  const cleared = list.filter((r) => { const why = meets(r, n, policy); if (why.length) rejected.push(`${r.key}: ${why.join('; ')}`); return !why.length; });
  if (!cleared.length) return none([`no engine clears ${n.harness ? 'an agent tool with ' : ''}${n.capabilities.join(', ') || 'the requirements'}${n.reach !== 'any' ? ` within reach ${n.reach}` : ''}${policy.prefer ? ` under ${policy.prefer}` : ''}`, ...rejected.slice(0, 4)]);
  const ordered = orderByPolicy(cleared, policy.prefer || 'balanced', summary);
  let pick = ordered[0];
  let exploration = false;
  const cost = (r) => r.costPerTask ?? r.costPer1k ?? null;
  if (explore && pick.engine.kind !== 'harness') {
    const cheaper = ordered.filter((r) => r.engine.kind !== 'harness' && cost(r) != null && cost(pick) != null && cost(r) < cost(pick)).sort((a, b) => cost(b) - cost(a));
    if (cheaper.length) { exploration = true; pick = cheaper[0]; }
  }
  const reasons = [
    exploration ? `exploration: one tier cheaper than the policy's pick (${ordered[0].key})` : `${(policy.prefer || 'balanced').replace(/-/g, ' ')}: ${rowLine(pick)}`,
    ...n.why,
  ];
  const own = ownRating(summary, pick.key);
  if (own != null) reasons.push(`this agent rated ${Math.round(own * 100)}% on it before`);
  if (policy.floor?.quality != null || policy.ceiling?.costPerTask != null || policy.ceiling?.latencyMs != null) reasons.push(`${cleared.length} of ${list.length} engines clear the policy`);
  return { engine: pick.engine, key: pick.key, reasons, alternatives: ordered.filter((r) => r !== pick).slice(0, 4).map((r) => r.engine), exploration, clears: true };
}

// ── Applying: the whole pool at once ──────────────────────────────────────────────────────

/** `qualityOf` / `costOf` for `adjustSummary`, read from the rows: what each engine is worth. */
export function engineWorth(rows) {
  const byKey = new Map((rows || []).filter(Boolean).map((r) => [r.key, r]));
  return {
    qualityOf: (key) => byKey.get(key)?.quality ?? null,
    costOf: (key) => { const r = byKey.get(key); return r ? (r.costPerTask ?? null) : null; },
  };
}

/**
 * Every eligible agent applies: `fit` (needs → adjusted record → size) plus the engine it
 * would run on. `summaries` are scorecard cards by agent id (`summarize()`); `rows` are
 * `engineRows`. Best first, recruitable (an engine clears) before not. Each application is
 * `{ agentId, engine?, fit, reasons, pitch, at, covers }` — job.js's shape, the record's, plus
 * `covers` (has a skill the job names) for `decide`; the record drops it.
 */
export function applications(job, pool, { summaries = {}, rows = [], reach = 'any', chatModel = null, adjust = true, now = Date.now() } = {}) {
  const need = needForJob(job, { reach });
  const worth = engineWorth(rows);
  const fitFn = (j, agent, summary) => {
    const f = fit(j, { ...agent, tools: agent.tools || agent.grants }, summary, adjust ? worth : { adjust: false });
    const route = routeFor(agent, j, { rows, summary, need, chatModel });
    return { score: f.score, reasons: [...f.reasons, ...route.reasons].slice(0, 8), ...(route.clears ? { engine: route.engine } : {}), covers: coversSkills(j, agent) };
  };
  // `covers` — has at least one skill the job names (or the job names none) — rides on the
  // live application for `decide`; the record keeps job.js's shape and drops it.
  const covered = new Map((pool || []).map((a) => [a?.id, coversSkills(job, a)]));
  return applyAll(job, pool, fitFn, { cards: summaries, now }).map((a) => ({ ...a, covers: covered.get(a.agentId) !== false }));
}

/** A job that names skills is not given to an agent with none of them on fit alone: tools and grants it never asked for count for nothing. */
function coversSkills(job, agent) {
  const want = lower(job?.needs?.skills);
  if (!want.length) return true;
  const has = new Set(lower(agent?.skills));
  return want.some((s) => has.has(s));
}

// ── Evaluating: one structured call, or none ──────────────────────────────────────────────

/** The evaluator's instruction: the job, the top applicants with their fit, engine and reasons, the shape to answer in. */
export function evaluatorPrompt(job, apps, pool = [], { rows = [], top = TOP_APPLICANTS } = {}) {
  const byId = new Map((pool || []).map((a) => [a.id, a]));
  const rowOf = new Map((rows || []).filter(Boolean).map((r) => [r.key, r]));
  const needs = job?.needs || {};
  const lines = (apps || []).slice(0, top).map((a) => {
    const agent = byId.get(a.agentId) || {};
    const key = a.engine ? engineKey(a.engine) : null;
    const row = key ? rowOf.get(key) : null;
    return `- ${a.agentId} (fit ${Math.round((a.fit || 0) * 100)}%)${agent.purpose ? ` — ${clip(agent.purpose, 160)}` : ''}; skills: ${(agent.skills || []).join(', ') || 'none'}; grants: ${(agent.grants || []).join(', ') || 'none'}; ${key ? `engine: ${row ? rowLine(row) : key}` : 'NOT RECRUITABLE NOW — no engine clears'}; ${(a.reasons || []).slice(0, 4).join('; ')}`;
  });
  return [
    `You are the evaluator for the job "${clip(job?.title, 200)}" on project ${job?.projectId || '?'}. Recruit ONE applicant, or say none fits.`,
    `Brief: ${clip(job?.brief, MAX_BRIEF_IN_PROMPT)}`,
    `Needs — skills: ${(needs.skills || []).join(', ') || 'none named'}; tools: ${(needs.tools || []).join(', ') || 'none named'}; grants: ${(needs.grants || []).join(', ') || 'none'}${job?.budget ? `; budget: ${Object.entries(job.budget).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.`,
    '',
    'Applicants, best computed fit first (fit = the skills, tools and grants the job names, then the attested record, then size):',
    ...(lines.length ? lines : ['- (no one applied)']),
    '',
    'Rules: prefer the applicant that has what the job names and a record of clearing work like it on the engine shown; never pick one marked NOT RECRUITABLE NOW; a lower fit is right only when its reasons show the higher one lacks something the brief needs. When no applicant has the skills the job names, answer pick "" and propose the agent that should exist.',
    '',
    describeSchema(RECRUIT_SCHEMA),
  ].join('\n');
}

/**
 * The evaluator's answer, read through the schema and checked against the applications: a
 * pick must be a recruitable applicant, else it is "none". Returns `{ pick, why, confidence,
 * proposal }` or null when the text is unreadable.
 */
export function parseEvaluation(text, apps = []) {
  const got = coerce(text, RECRUIT_SCHEMA);
  if (!got) return null;
  const v = got.value;
  const pick = String(v.pick || '').trim();
  const app = pick ? (apps || []).find((a) => a.agentId === pick) : null;
  const proposal = v.proposalName ? { name: clip(v.proposalName, 60), purpose: clip(v.proposalPurpose, 300), skills: (v.proposalSkills || []).map((s) => clip(s, 80)).filter(Boolean), grants: (v.proposalGrants || []).map((g) => clip(g, 64)).filter(Boolean) } : null;
  if (app && app.engine) return { pick, why: clip(v.why, 400) || 'the evaluator\'s pick', confidence: r3(v.confidence), proposal: null };
  return { pick: '', why: app ? `the evaluator picked ${pick}, which no engine can run right now` : clip(v.why, 400) || 'none fits', confidence: r3(v.confidence), proposal };
}

/**
 * The decision: the evaluator's when one was made; else the best recruitable fit at or above
 * `minFit`; else none, with the agent the job's needs describe as the proposal. Returns
 * `{ kind: 'recruit', agentId, engine, fit, why, by }` or `{ kind: 'none', why, proposal, by }`.
 */
export function decide(job, apps, { evaluation = null, minFit = MIN_FIT } = {}) {
  const list = apps || [];
  if (evaluation && evaluation.pick) {
    const app = list.find((a) => a.agentId === evaluation.pick && a.engine);
    if (app) return { kind: 'recruit', agentId: app.agentId, engine: app.engine, fit: app.fit, why: evaluation.why, by: 'evaluator' };
  }
  if (evaluation && !evaluation.pick) return { kind: 'none', why: evaluation.why, proposal: evaluation.proposal || proposalFromNeeds(job), by: 'evaluator' };
  const best = list.find((a) => a.engine && a.covers !== false);
  if (best && best.fit >= minFit) return { kind: 'recruit', agentId: best.agentId, engine: best.engine, fit: best.fit, why: `best fit (${Math.round(best.fit * 100)}%): ${(best.reasons || [])[0] || 'meets the needs'}`, by: 'fit' };
  const why = !list.length ? 'no one in the pool applies to jobs'
    : !best ? (list.some((a) => a.engine) ? `no applicant has a skill the job names (${(job?.needs?.skills || []).join(', ')})` : `${list.length} applied but no engine clears for any of them: ${(list[0].reasons || []).find((r) => /engine|pinned|roster/.test(r)) || 'see the applications'}`)
      : `the best fit is ${Math.round(best.fit * 100)}%, under the ${Math.round(minFit * 100)}% floor: ${(best.reasons || []).find((r) => /missing/.test(r)) || best.reasons?.[0] || ''}`;
  return { kind: 'none', why, proposal: proposalFromNeeds(job), by: 'fit' };
}

/** The agent a job's needs describe — what to propose when no one fits. */
export function proposalFromNeeds(job) {
  const needs = job?.needs || {};
  return { name: clip(job?.title, 60) || 'New agent', purpose: `Does jobs like "${clip(job?.title, 80)}".`, skills: [...(needs.skills || [])], grants: (needs.grants || []).length ? [...needs.grants] : ['none'] };
}

/**
 * A proposal as an agent card for a person to approve — validated by the pool's own form
 * (agentFromForm), engine `auto`, `createdBy: 'evaluator'`, its origin the job. Nothing
 * joins the pool without a decision (D-A2): this returns the card, it does not store it.
 */
export function proposalToAgent(proposal, job, { by = 'evaluator' } = {}) {
  const p = proposal || proposalFromNeeds(job);
  const known = new Set(['data', 'web', 'history', 'mcp', ...WORK_GRANTS]);
  const grants = (p.grants || []).map((g) => String(g).toLowerCase()).filter((g) => known.has(g) || /^mcp:/.test(g));
  return agentFromForm({
    name: p.name, purpose: p.purpose, skills: p.skills,
    prompt: `You are ${p.name}. ${p.purpose || ''}\n\nYou were proposed for the job "${clip(job?.title, 200)}" because no agent in the pool fit it. Do work like it well; ask on the thread when the brief is unclear.`,
    grants: grants.length ? grants : ['none'], engine: { kind: 'auto', prefer: 'balanced' }, appliesTo: ['jobs'], createdBy: by,
    origin: { kind: 'proposal', projectId: job?.projectId, jobId: job?.id },
  });
}

// ── Landing it on the record ──────────────────────────────────────────────────────────────

/**
 * The budget a recruit gets: the job's own when it has one, else an equal share of what the
 * project has left (its budget minus its spend) across the jobs still to be recruited — so
 * one unbudgeted job cannot take the whole project. `record` is the project record
 * (project.js `foldProject`).
 */
export function carveBudget(job, record = null) {
  if (job?.budget && Object.keys(job.budget).length) return normalizeBudget(job.budget);
  const cap = record?.page?.budget || {};
  const spent = record?.spend || {};
  const waiting = Math.max(1, (record?.jobs || []).filter((j) => ['open', 'evaluating'].includes(j.status)).length);
  const out = {};
  for (const k of ['tokens', 'calls', 'ms', 'usd']) {
    if (!(Number(cap[k]) > 0)) continue;
    const left = Math.max(0, Number(cap[k]) - (Number(spent[k]) || 0));
    if (left > 0) out[k] = k === 'usd' ? Math.round((left / waiting) * 100) / 100 : Math.max(1, Math.floor(left / waiting));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The events that record a recruiting pass on the project (project.js fold): the job moves
 * to `evaluating` with its applications, then to `recruited` with the pair, the budget and
 * the why — or back to `open`, with the proposal as a decision a person reads.
 */
export function recruitEvents(job, apps, decision, { by = 'evaluator', at = Date.now(), record = null } = {}) {
  const events = [{ type: 'job.updated', at, job: { id: job.id, status: 'evaluating', applications: (apps || []).map(({ covers: _c, ...a }) => a) }, by }];
  if (decision?.kind === 'recruit') {
    const budget = carveBudget(job, record);
    events.push({ type: 'job.updated', at, job: { id: job.id, status: 'recruited', recruited: { agentId: decision.agentId, engine: decision.engine, ...(budget ? { budget } : {}), by: decision.by || by, at, why: clip(decision.why, 600) } }, by });
  } else {
    events.push({ type: 'job.updated', at, job: { id: job.id, status: 'open' }, by });
    const p = decision?.proposal;
    events.push({ type: 'project.decision', at, by, kind: 'proposal', text: `No one in the pool fits "${clip(job.title, 120)}": ${clip(decision?.why, 400)}${p ? ` Proposed: ${p.name}${p.skills?.length ? ` — skills ${p.skills.join(', ')}` : ''}${p.grants?.length ? `; grants ${p.grants.join(', ')}` : ''}.` : ''}`, refs: [`job:${job.id}`] });
  }
  return events;
}

/**
 * One pass, end to end: apply → (evaluate) → decide → the events. `ask(prompt) → text |
 * null` is the host's structured call; absent or failing, the fit decides. Returns
 * `{ applications, evaluation, decision, events, prompt }`.
 */
export async function recruitJob(job, pool, { summaries = {}, rows = [], reach = 'any', chatModel = null, record = null, ask = null, minFit = MIN_FIT, by = 'evaluator', now = Date.now() } = {}) {
  const apps = applications(job, pool, { summaries, rows, reach, chatModel, now });
  const prompt = evaluatorPrompt(job, apps, pool, { rows });
  let evaluation = null;
  if (ask && apps.some((a) => a.engine)) {
    try { const text = await ask(prompt, RECRUIT_SCHEMA); evaluation = text == null ? null : (typeof text === 'string' ? parseEvaluation(text, apps) : parseEvaluation(JSON.stringify(text), apps)); } catch { evaluation = null; }
  }
  const decision = decide(job, apps, { evaluation, minFit });
  return { applications: apps, evaluation, decision, events: recruitEvents(job, apps, decision, { by: decision.by === 'evaluator' ? by : 'fit', at: now, record }), prompt };
}

// ── A run's job board (§15.2): the host's `recruit` hook, shared ─────────────────────────

/**
 * What a host hands the runner as `recruit`: one pass over the pool for a sub-task's job,
 * the pick made into a ROLE the run can appoint (job.js `jobToRole`, resolved through the
 * pool so it carries the agent's prompt, grants, skills and a model target — agent.js
 * `resolveTeam`). Returns `{ role, agentId, engine, why, fit, applications, events }` or,
 * when no one is recruited, `{ why, proposal, applications, events }` with `proposal` the
 * agent card a person may approve (the runner posts it). `create` is that card once
 * approved — the host has persisted it to its pool before calling — and it applies with
 * the rest. `events` are the project-record events of the pass (recruit.js `recruitEvents`)
 * for a host that has a project to land them on; the run's own record has its own.
 */
export async function recruitForRun(job, pool, { rows = [], summaries = {}, reach = 'any', chatModel = null, targetFor = null, ask = null, minFit = MIN_FIT, create = null, now = Date.now() } = {}) {
  const list = (Array.isArray(pool) ? pool : []).filter((a) => a && a.id);
  if (create && isRecord(create)) {
    try { const made = normalizeAgent(create); if (!list.some((a) => a.id === made.id)) list.push(made); } catch { /* an unusable card applies as nothing */ }
  }
  const pass = await recruitJob(job, list, { summaries, rows, reach, chatModel, ask, minFit, now });
  const d = pass.decision;
  if (d.kind !== 'recruit') {
    const card = proposalToAgent(d.proposal || proposalFromNeeds(job), job, { by: d.by || 'evaluator' });
    return { why: d.why, proposal: card?.ok === false ? null : (card?.agent || card), applications: pass.applications, events: pass.events };
  }
  const agent = list.find((a) => a.id === d.agentId);
  const base = jobToRole(job, agent);
  let role = { ...base, agent: agent.id, engine: d.engine };
  try {
    role = resolveTeam({ name: 'recruit', roles: [role], budget: { tokens: 1 } }, list, { chatModel, targetFor }).roles[0];
  } catch { /* unresolved: the runner's appointer decides from the engine */ }
  return { role, agentId: d.agentId, engine: d.engine, why: d.why, fit: d.fit ?? null, applications: pass.applications, events: pass.events };
}
