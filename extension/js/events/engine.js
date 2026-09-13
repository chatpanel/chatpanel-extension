// GENERATED — do not edit.
// Source of truth: chatpanel-events/engine.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// An ENGINE — what actually runs an agent's turns — as a declaration, and its one-line label.
//
// The model is a variable, not a constant (architecture-pillars.md §13). An agent card names
// the engine it runs on, and there are four ways to say it:
//
//   { kind: 'model',     providerId?, model }   an endpoint the client calls; `providerId` is
//                                               the endpoint / gateway destination, because the
//                                               same model at two providers is two engines
//   { kind: 'harness',   harnessId, model? }    a CLI coding agent the bridge runs (Claude
//                                               Code, Codex, …) — ChatPanel delegates a whole
//                                               task to it; `model` is what it was asked to run
//   { kind: 'auto',      policy }               the recruiter picks, by policy, from the
//                                               engine cards (§13.4) — the default
//   { kind: 'assistant' }                       the built-in Assistant: whatever model the chat
//                                               is on right now (`engineOf` resolves it)
//
// The RECORD keeps a flatter shape — `{ kind: 'model'|'harness', id, model? }`, see
// scorecard.js `normalizeEngine` — because a record says what DID run, and `auto` and
// `assistant` never run anything themselves. `engineRef` maps a spec to that shape once a
// choice was made, so the scorecard's `byEngine` and the model ledger key the same way.
//
// Pure, dependency-free; team.js and agent.js both import from here, never from each other.

export const ENGINE_KINDS = Object.freeze(['model', 'harness', 'auto', 'assistant']);
export const ROUTE_PREFERS = Object.freeze(['cheapest-that-clears', 'best-quality', 'fastest', 'balanced']);
export const HARNESS_ID_RE = /^[a-zA-Z0-9_.:@+-]{1,120}$/;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 200) => (v == null || v === '' ? undefined : String(v).trim().slice(0, n) || undefined);
const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? undefined : n; };
const refs = (xs) => (Array.isArray(xs) ? [...new Set(xs.map((x) => str(typeof x === 'string' ? x : engineKeyOf(x), 200)).filter(Boolean))] : undefined);

/** A routing policy, normalized: an unknown preference is `balanced`; floors and ceilings are numbers or absent. */
export function normalizePolicy(p) {
  const src = isRecord(p) ? p : {};
  const floor = {}; const ceiling = {};
  const q = num(src.floor?.quality); if (q !== undefined) floor.quality = Math.max(0, Math.min(1, q));
  const av = num(src.floor?.availability); if (av !== undefined) floor.availability = Math.max(0, Math.min(1, av));
  const c = num(src.ceiling?.costPerTask); if (c !== undefined && c >= 0) ceiling.costPerTask = c;
  const l = num(src.ceiling?.latencyMs); if (l !== undefined && l >= 0) ceiling.latencyMs = Math.round(l);
  const allow = refs(src.allow); const deny = refs(src.deny);
  return {
    prefer: ROUTE_PREFERS.includes(src.prefer) ? src.prefer : 'balanced',
    ...(Object.keys(floor).length ? { floor } : {}),
    ...(Object.keys(ceiling).length ? { ceiling } : {}),
    ...(allow?.length ? { allow } : {}),
    ...(deny?.length ? { deny } : {}),
  };
}

/**
 * An engine spec as stored. A string is read the obvious way — `assistant`, `auto`, a
 * `harness:<id>` / `model:<id>` prefix, or a bare model id — because a person types these
 * and a model proposes them in prose. Anything unreadable is `auto`, the honest default.
 */
export function normalizeEngineSpec(e) {
  if (e == null || e === '') return { kind: 'auto', policy: normalizePolicy() };
  if (typeof e === 'string') {
    const s = e.trim();
    if (s === 'assistant' || s === 'auto') return s === 'assistant' ? { kind: 'assistant' } : { kind: 'auto', policy: normalizePolicy() };
    const m = /^(model|harness):(.+)$/.exec(s);
    if (m) return m[1] === 'harness' ? { kind: 'harness', harnessId: m[2].trim() } : { kind: 'model', model: m[2].trim() };
    return { kind: 'model', model: s };
  }
  if (!isRecord(e)) return { kind: 'auto', policy: normalizePolicy() };
  const kind = ENGINE_KINDS.includes(e.kind) ? e.kind : (e.harnessId ? 'harness' : e.model ? 'model' : e.policy ? 'auto' : 'auto');
  if (kind === 'assistant') return { kind };
  if (kind === 'auto') return { kind, policy: normalizePolicy(e.policy) };
  if (kind === 'harness') {
    const harnessId = str(e.harnessId || e.id, 120);
    if (!harnessId) return { kind: 'auto', policy: normalizePolicy() };
    const model = str(e.model, 200);
    return { kind, harnessId, ...(model ? { model } : {}) };
  }
  const model = str(e.model || e.id, 200);
  if (!model) return { kind: 'auto', policy: normalizePolicy() };
  const providerId = str(e.providerId || e.destination || e.endpointId, 120);
  return { kind: 'model', ...(providerId ? { providerId } : {}), model };
}

/** Is this a spec a validator should accept? Returns the errors, with a prefix. */
export function validateEngineSpec(e, where = 'engine') {
  const errors = [];
  if (e == null || e === '') return errors;
  if (typeof e === 'string') return errors; // every string reads as something
  if (!isRecord(e)) return [`${where}: a string or an object`];
  if (e.kind !== undefined && !ENGINE_KINDS.includes(e.kind)) errors.push(`${where}.kind: one of ${ENGINE_KINDS.join(', ')}`);
  if (e.kind === 'harness' && !str(e.harnessId || e.id)) errors.push(`${where}.harnessId: which harness`);
  if (e.kind === 'harness' && str(e.harnessId || e.id) && !HARNESS_ID_RE.test(String(e.harnessId || e.id).trim())) errors.push(`${where}.harnessId: a short identifier`);
  if (e.kind === 'model' && !str(e.model || e.id)) errors.push(`${where}.model: which model`);
  if (e.kind === 'auto' && e.policy !== undefined && !isRecord(e.policy)) errors.push(`${where}.policy: an object`);
  if (e.kind === 'auto' && isRecord(e.policy) && e.policy.prefer !== undefined && !ROUTE_PREFERS.includes(e.policy.prefer)) errors.push(`${where}.policy.prefer: one of ${ROUTE_PREFERS.join(', ')}`);
  return errors;
}

/**
 * The record's shape for a spec that names something concrete — `{ kind, id, model? }`,
 * the same fields scorecard.js keys `byEngine` on and the model ledger is keyed by. `auto`
 * and `assistant` have no ref: nothing ran yet.
 */
export function engineRef(spec) {
  const s = normalizeEngineSpec(spec);
  if (s.kind === 'harness') return { kind: 'harness', id: s.harnessId, ...(s.model ? { model: s.model } : {}) };
  if (s.kind === 'model') return s.providerId ? { kind: 'model', id: s.providerId, model: s.model } : { kind: 'model', id: s.model };
  return null;
}

/** The ledger key of a spec, or null when it names nothing concrete. Same key as `engineKey` in scorecard.js. */
export function engineKeyOf(spec) {
  const r = engineRef(spec);
  return r ? `${r.kind}:${r.id}${r.model && r.model !== r.id ? `/${r.model}` : ''}` : null;
}

/** One phrase a person reads on a card: "Claude Code", "gpt-4o at openrouter", "auto · cheapest that clears", "the chat's model". */
export function describeEngine(spec, { harnessName = (id) => id, providerName = (id) => id } = {}) {
  const s = normalizeEngineSpec(spec);
  if (s.kind === 'assistant') return 'the chat’s model';
  if (s.kind === 'auto') return `auto · ${s.policy.prefer.replace(/-/g, ' ')}`;
  if (s.kind === 'harness') return `${harnessName(s.harnessId)}${s.model ? ` (${s.model})` : ''}`;
  return `${s.model}${s.providerId ? ` at ${providerName(s.providerId)}` : ''}`;
}

/**
 * The role tier today's appointers understand (`cheap` / `balanced` / `strong`) for a spec:
 * the bridge to `prefer` until the recruiter routes by card (§13.4, step 5).
 */
export function tierOf(spec) {
  const s = normalizeEngineSpec(spec);
  if (s.kind !== 'auto') return 'balanced';
  return { 'best-quality': 'strong', 'cheapest-that-clears': 'cheap', fastest: 'cheap', balanced: 'balanced' }[s.policy.prefer] || 'balanced';
}
