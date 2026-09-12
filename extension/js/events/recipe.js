// GENERATED — do not edit.
// Source of truth: chatpanel-events/recipe.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Recipes — a multi-step tool workflow written down once and run by name, with no model
// in the loop.
//
// Skills are prompts: they tell a model what to do and the model decides which tools to
// call. A recipe is the other thing — the DECISION already made, as data: "open_bug" is
// `create_issue` with `labels: ["bug"]` baked in and `title`/`body` filled from the
// caller; "triage_pair" fetches two issues at once; "search_then_read" searches, then
// reads the first hit. It runs identically every time, from any client, with no tokens
// spent deciding, and it is the shape the harness spine calls class R: declarative,
// permissioned, never agent-written code. Amendment A2 asked for automations to be
// authored conversationally and approved before they run; this is what gets approved.
//
// Four modes, matching the primitives a round already has: `call` (one tool),
// `parallel` (independent calls, run through tool-round.js so reads overlap), `batch` (one
// tool, many argument sets) and `pipeline` (each step may map values out of the previous
// step's result with `inputMapping`: "$text" for its text, "$json" for it parsed,
// "$json.items.0.key" for a path inside).
//
// Two properties are load-bearing:
//   • DRY RUN before side effects — `dryRunRecipe` resolves every parameter and names
//     every unknown tool, missing required field and destructive call without executing
//     anything. It is the propose step of propose → approve → activate.
//   • PARTIAL FAILURE IS RECOVERABLE — a parallel/batch run returns every sibling's result
//     plus `failedIndexes`; a pipeline stops at the failing step and returns the outputs
//     of the steps before it, plus which mappings resolved and which did not. Nothing is
//     retried blindly, and nothing that succeeded is lost.
//
// Pure. Execution, tool specs and traits are injected; nothing here knows a model, a
// window, or where recipes are stored.

import { runToolRound } from './tool-round.js';
import { toolTraits, needsConfirmation } from './tool-traits.js';

export const RECIPE_MODES = Object.freeze(['call', 'parallel', 'batch', 'pipeline']);

export class RecipeError extends Error {
  constructor(code, message) { super(message); this.name = 'RecipeError'; this.code = code; }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isParamRef = (v) => isRecord(v) && typeof v.$param === 'string' && Object.keys(v).every((k) => k === '$param' || k === 'default');

/** Every `{ "$param": name }` a recipe reads, in first-seen order. */
export function recipeParams(recipe) {
  const names = [];
  const seen = new Set();
  const walk = (v) => {
    if (isParamRef(v)) { if (!seen.has(v.$param)) { seen.add(v.$param); names.push({ name: v.$param, required: !('default' in v), default: v.default }); } return; }
    if (Array.isArray(v)) v.forEach(walk);
    else if (isRecord(v)) Object.values(v).forEach(walk);
  };
  walk(recipe);
  return names;
}

/** Structural validity — the errors a person authoring one needs to see. */
export function validateRecipe(recipe) {
  const errors = [];
  if (!isRecord(recipe)) return { ok: false, errors: ['recipe must be an object'] };
  if (!recipe.name || typeof recipe.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(recipe.name)) errors.push('name: a short identifier (letters, digits, _ -) is required');
  if (!RECIPE_MODES.includes(recipe.mode)) errors.push(`mode: one of ${RECIPE_MODES.join(', ')}`);
  const call = (c, where) => {
    if (!isRecord(c)) { errors.push(`${where}: must be an object`); return; }
    if (!c.tool || typeof c.tool !== 'string') errors.push(`${where}.tool: required`);
    if (c.arguments !== undefined && !isRecord(c.arguments)) errors.push(`${where}.arguments: must be an object`);
    if (c.inputMapping !== undefined && (!isRecord(c.inputMapping) || Object.values(c.inputMapping).some((m) => typeof m !== 'string' || !/^\$(text|json)(\.[^.\s]+)*$/.test(m)))) {
      errors.push(`${where}.inputMapping: values must be "$text", "$json" or "$json.<path>"`);
    }
    if (c.onMappingMissing !== undefined && !['continue', 'fail'].includes(c.onMappingMissing)) errors.push(`${where}.onMappingMissing: "continue" or "fail"`);
  };
  switch (recipe.mode) {
    case 'call': call(recipe, 'recipe'); break;
    case 'parallel':
      if (!Array.isArray(recipe.calls) || !recipe.calls.length) errors.push('calls: a non-empty array');
      else recipe.calls.forEach((c, i) => call(c, `calls[${i}]`));
      break;
    case 'batch':
      if (!recipe.tool || typeof recipe.tool !== 'string') errors.push('tool: required');
      if (!Array.isArray(recipe.items) || !recipe.items.length) errors.push('items: a non-empty array');
      else recipe.items.forEach((it, i) => { if (!isRecord(it) || !isRecord(it.arguments)) errors.push(`items[${i}].arguments: must be an object`); });
      break;
    case 'pipeline':
      if (!Array.isArray(recipe.steps) || !recipe.steps.length) errors.push('steps: a non-empty array');
      else {
        recipe.steps.forEach((s, i) => call(s, `steps[${i}]`));
        if (isRecord(recipe.steps[0]) && recipe.steps[0].inputMapping) errors.push('steps[0].inputMapping: the first step has no previous result');
      }
      break;
    default: break;
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Substitute parameters. Returns the plan — a list of concrete calls in the recipe's mode
 * — and the names of any parameters missing without a default. A missing parameter is
 * reported, not thrown: the caller decides whether to ask for it or fail.
 */
export function expandRecipe(recipe, params = {}) {
  const v = validateRecipe(recipe);
  if (!v.ok) return { ok: false, errors: v.errors, missing: [], plan: null };
  const missing = new Set();
  const fill = (x) => {
    if (isParamRef(x)) {
      if (Object.prototype.hasOwnProperty.call(params, x.$param) && params[x.$param] !== undefined) return params[x.$param];
      if ('default' in x) return x.default;
      missing.add(x.$param);
      return undefined;
    }
    if (Array.isArray(x)) return x.map(fill);
    if (isRecord(x)) {
      const out = {};
      for (const [k, val] of Object.entries(x)) { const f = fill(val); if (f !== undefined) out[k] = f; }
      return out;
    }
    return x;
  };
  const one = (c) => ({ tool: c.tool, arguments: fill(c.arguments || {}), ...(c.inputMapping ? { inputMapping: { ...c.inputMapping } } : {}), ...(c.onMappingMissing ? { onMappingMissing: c.onMappingMissing } : {}) });
  let calls;
  switch (recipe.mode) {
    case 'call': calls = [one(recipe)]; break;
    case 'parallel': calls = recipe.calls.map(one); break;
    case 'batch': calls = recipe.items.map((it) => ({ tool: recipe.tool, arguments: fill(it.arguments) })); break;
    case 'pipeline': calls = recipe.steps.map(one); break;
    default: calls = [];
  }
  return { ok: missing.size === 0, errors: [], missing: [...missing], plan: { name: recipe.name, mode: recipe.mode, calls } };
}

// ── mapping ──────────────────────────────────────────────────────────────────────────

const textOf = (r) => (typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.text === 'string' ? r.text : r == null ? '' : JSON.stringify(r));

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

/**
 * Resolve one step's `inputMapping` against the previous result.
 * @returns `{ arguments, mapped: { [arg]: value }, skipped: [{ arg, expr, reason }] }`
 */
export function mapInput(previous, mapping = {}, base = {}) {
  const args = { ...base };
  const mapped = {};
  const skipped = [];
  const text = textOf(previous);
  let json;
  for (const [arg, expr] of Object.entries(mapping || {})) {
    if (expr === '$text') { args[arg] = text; mapped[arg] = text; continue; }
    if (!expr.startsWith('$json')) { skipped.push({ arg, expr, reason: 'unknown expression' }); continue; }
    if (json === undefined) json = parseJson(text);
    if (!json.ok) { skipped.push({ arg, expr, reason: 'previous result is not JSON' }); continue; }
    let cur = json.value;
    const path = expr.slice(5).split('.').filter(Boolean);
    let found = true;
    for (const seg of path) {
      if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
      else if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
      else { found = false; break; }
    }
    if (!found || cur === undefined) { skipped.push({ arg, expr, reason: 'path not found in previous result' }); continue; }
    args[arg] = cur;
    mapped[arg] = cur;
  }
  return { arguments: args, mapped, skipped };
}

// ── dry run ──────────────────────────────────────────────────────────────────────────

/**
 * Everything a person should know before approving: unknown tools, missing required
 * fields, destructive calls, and which arguments a pipeline will only learn at run time.
 *
 * @param specs    the tool specs the runtime will execute against (for existence and
 *                 required fields); omit to skip those checks
 * @param traitsOf `(tool) => traits`; defaults to toolTraits on the spec or name
 */
export function dryRunRecipe(recipe, params = {}, { specs = null, traitsOf = null } = {}) {
  const ex = expandRecipe(recipe, params);
  if (!ex.plan) return { ok: false, errors: ex.errors, missing: ex.missing, calls: [], warnings: [], destructive: [] };
  const byName = specs ? new Map(specs.filter((s) => s?.name).map((s) => [s.name, s])) : null;
  const traits = traitsOf || ((tool) => toolTraits(byName?.get(tool) || tool));
  const warnings = [];
  const destructive = [];
  const calls = ex.plan.calls.map((c, i) => {
    const spec = byName?.get(c.tool);
    const known = byName ? !!spec : null;
    const t = traits(c.tool);
    const mappedLater = new Set(Object.keys(c.inputMapping || {}));
    const required = Array.isArray(spec?.parameters?.required) ? spec.parameters.required : Array.isArray(spec?.inputSchema?.required) ? spec.inputSchema.required : [];
    const missingRequired = required.filter((k) => c.arguments[k] === undefined && !mappedLater.has(k));
    const row = { index: i, tool: c.tool, arguments: c.arguments, known, traits: t, missingRequired, mappedLater: [...mappedLater] };
    if (known === false) warnings.push({ index: i, code: 'unknown_tool', message: `No tool named "${c.tool}" is available.` });
    if (missingRequired.length) warnings.push({ index: i, code: 'missing_required', message: `"${c.tool}" needs ${missingRequired.join(', ')}.` });
    if (needsConfirmation(t)) { destructive.push(i); warnings.push({ index: i, code: 'destructive', message: `"${c.tool}" is destructive.` }); }
    if (ex.plan.mode === 'pipeline' && i > 0 && !mappedLater.size) warnings.push({ index: i, code: 'no_mapping', message: `steps[${i}] uses nothing from the previous step; was that intended?` });
    return row;
  });
  const blocking = ex.missing.length > 0 || warnings.some((w) => w.code === 'unknown_tool' || w.code === 'missing_required');
  return { ok: !blocking, errors: [], missing: ex.missing, plan: ex.plan, calls, warnings, destructive };
}

// ── run ──────────────────────────────────────────────────────────────────────────────

const defaultIsError = (r) => {
  if (r == null) return false;
  if (typeof r === 'string') return /^error:/i.test(r) || /^\{\s*"error"/.test(r);
  return typeof r === 'object' && (r.error != null || r.isError === true);
};

/**
 * Run an expanded plan. `execute(tool, arguments, meta)` is the host's toolset executor —
 * every guard, redaction and confirmation it wraps applies unchanged, because a recipe is
 * a way of composing calls, never a way around them.
 */
export async function runPlan(plan, { execute, traitsOf, concurrent, isError = defaultIsError, onStart, onDone } = {}) {
  if (typeof execute !== 'function') throw new RecipeError('BAD_RUN', 'execute required');
  if (!plan || !Array.isArray(plan.calls)) throw new RecipeError('BAD_PLAN', 'plan.calls required');
  const meta = { recipe: plan.name, mode: plan.mode };

  if (plan.mode === 'pipeline') {
    const steps = [];
    let previous;
    for (let i = 0; i < plan.calls.length; i += 1) {
      const c = plan.calls[i];
      let args = c.arguments;
      let mapped = {};
      let skipped = [];
      if (i > 0 && c.inputMapping) {
        const m = mapInput(previous, c.inputMapping, c.arguments);
        args = m.arguments; mapped = m.mapped; skipped = m.skipped;
        if (skipped.length && c.onMappingMissing === 'fail') {
          steps.push({ index: i, tool: c.tool, arguments: args, mappedArguments: mapped, skippedMappings: skipped, result: null, status: 'skipped' });
          return { status: 'failed', failedStep: i, reason: 'mapping_missing', steps, finalResult: null };
        }
      }
      onStart?.({ name: c.tool, input: args }, i);
      let result;
      try { result = await execute(c.tool, args, { ...meta, step: i }); } catch (e) { result = { error: `Tool ${c.tool} failed: ${e?.message || e}` }; }
      onDone?.({ name: c.tool, input: args }, i, result);
      const failed = isError(result);
      steps.push({ index: i, tool: c.tool, arguments: args, mappedArguments: mapped, skippedMappings: skipped, result, status: failed ? 'failed' : 'ok' });
      if (failed) return { status: 'failed', failedStep: i, reason: 'tool_error', steps, finalResult: null };
      previous = result;
    }
    return { status: 'completed', steps, finalResult: previous };
  }

  const calls = plan.calls.map((c) => ({ name: c.tool, input: c.arguments }));
  const round = await runToolRound(calls, {
    execute: (call, i) => execute(call.name, call.input, { ...meta, index: i }),
    traitsOf: traitsOf ? (c) => traitsOf(c.name) : undefined,
    concurrent, isError, onStart, onDone,
  });
  return { status: round.status, succeeded: round.succeeded, failed: round.failed, failedIndexes: round.failedIndexes, results: round.results, coalesced: round.coalesced };
}

/** Expand, then run. Missing parameters fail before anything executes. */
export async function runRecipe(recipe, params, options) {
  const ex = expandRecipe(recipe, params);
  if (!ex.plan) throw new RecipeError('INVALID', ex.errors.join('; '));
  if (!ex.ok) throw new RecipeError('MISSING_PARAMS', `missing: ${ex.missing.join(', ')}`);
  return runPlan(ex.plan, options);
}
