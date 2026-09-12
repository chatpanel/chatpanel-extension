// The `recipe` tool — a workflow the model did once, kept as data, and run by name.
//
// The engine is @chatpanel/events recipe.js: a recipe is `call` / `parallel` / `batch` /
// `pipeline` with `{ "$param": "x" }` slots, expanded, dry-run and run with no model in
// the loop. What is here is the CONVERSATIONAL half the spine's amendment A2 asked for —
// authored in chat, approved before it exists, declarative, never agent-written code:
//
//   save     the model proposes a recipe from what it just did ("you fetched two issues
//            and compared them — keep that as `triage_pair`?"). The dry run is what the
//            PERSON sees on the card: every step, every slot, every warning. Approval
//            stores it; nothing runs.
//   dry_run  the same report, on demand, for a saved recipe with real parameters.
//   run      expand with the given parameters and execute through the turn's OWN toolset —
//            so the destructive gate, redaction, the loop guard and the shield all apply
//            to every step exactly as if the model had called it. A recipe composes calls;
//            it is never a way around them.
//
// One registered tool, not three: a spec per verb is per-turn token cost on every armed
// turn, and the description already lists the saved recipes by name and parameters, which
// is the whole catalogue. Bound LATE to the toolset it lives in (`bind`), because the
// toolset that runs its steps is the one it is a member of.

import { validateRecipe, expandRecipe, dryRunRecipe, runPlan, recipeParams, RECIPE_MODES } from './events/recipe.js';

export const RECIPE_TOOL_NAME = 'recipe';

const RECIPE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/i;

function catalogue(recipes) {
  const list = (recipes || []).filter((r) => r && r.enabled !== false && r.name);
  if (!list.length) return 'No recipes saved yet.';
  return `Saved recipes: ${list.map((r) => {
    const ps = recipeParams(r).map((p) => (p.required ? p.name : `${p.name}?`));
    return `${r.name}(${ps.join(', ')})${r.description ? ` — ${r.description}` : ''}`;
  }).join('; ')}.`;
}

/**
 * One spec. The shape a model needs to `save` is spelled out once, compactly; the
 * engine's validator names anything it got wrong.
 */
export function recipeToolSpec(recipes) {
  return {
    name: RECIPE_TOOL_NAME,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description:
      `Saved, repeatable tool workflows — run by name with no re-planning. ${catalogue(recipes)} `
      + 'Actions: {"action":"run","name":"<recipe>","params":{…}} runs one; '
      + '{"action":"dry_run","name":"<recipe>","params":{…}} shows what it would do without running; '
      + '{"action":"save","recipe":{…}} proposes a NEW one after you have done a multi-step task the '
      + 'user may repeat — the user approves it on a card. A recipe: {"name":"open_bug","description":"…",'
      + '"mode":"call","tool":"<tool name, e.g. mcp_github__create_issue>","arguments":{"title":{"$param":"title"},"labels":["bug"]}}. '
      + `Modes: ${RECIPE_MODES.join(' | ')} — parallel takes "calls":[{tool,arguments}], batch takes "tool"+"items":[{arguments}], `
      + 'pipeline takes "steps":[{tool,arguments,inputMapping:{arg:"$json.path"|"$text"}}]. '
      + 'Use {"$param":"x"} for anything the user will supply each time; a "default" makes it optional.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'dry_run', 'save'] },
        name: { type: 'string', description: 'Recipe name, for run / dry_run.' },
        params: { type: 'object', description: 'Parameter values, for run / dry_run.', additionalProperties: true },
        recipe: { type: 'object', description: 'The recipe to save, for save.', additionalProperties: true },
      },
      required: ['action'],
    },
  };
}

/** The card a person approves: what it does, step by step, and what the dry run flagged. */
export function describeRecipeForApproval(recipe, report) {
  const lines = [`${recipe.name}${recipe.description ? ` — ${recipe.description}` : ''}`, `Mode: ${recipe.mode}`];
  const ps = recipeParams(recipe);
  if (ps.length) lines.push(`Parameters: ${ps.map((p) => (p.required ? p.name : `${p.name} (optional)`)).join(', ')}`);
  const calls = report?.calls || [];
  calls.forEach((c, i) => {
    const args = JSON.stringify(c.arguments);
    lines.push(`${calls.length > 1 ? `${i + 1}. ` : ''}${c.tool}${args && args !== '{}' ? ` ${args.length > 140 ? `${args.slice(0, 137)}…` : args}` : ''}${c.mappedLater?.length ? ` (+ ${c.mappedLater.join(', ')} from the previous step)` : ''}`);
  });
  for (const w of report?.warnings || []) lines.push(`⚠ ${w.message}`);
  lines.push('Saved recipes run with no further planning; destructive steps still ask each time.');
  return lines.join('\n');
}

const json = (v) => JSON.stringify(v);

/**
 * @param recipes     the saved list (settings.recipes)
 * @param confirmSave async (detail, recipe) => 'allow' | 'deny' — the surface's card. Absent on a
 *                    surface with no window: `save` is then refused, `run` still works.
 * @param saveRecipe  async (recipe) => void — persist an approved one
 */
export function recipeToolProvider({ recipes = [], confirmSave = null, saveRecipe = null } = {}) {
  let bound = null; // { execute, specs, traits, hiddenVia }
  const byName = new Map((recipes || []).filter((r) => r?.name && r.enabled !== false).map((r) => [r.name, r]));

  // Steps name REAL tools; a tool that lives behind a dispatcher (`mcp_gh__get_issue`
  // behind `mcp`) is reached through it, so every guard that keys on the action fires.
  const execute = (tool, args, meta) => {
    if (!bound) return json({ error: 'The recipe tool is not bound to a toolset yet.' });
    const via = bound.hiddenVia?.get(tool);
    return via ? bound.execute(via, { action: tool, args }, meta) : bound.execute(tool, args, meta);
  };
  const specsForDryRun = () => (bound ? [...(bound.specs || []), ...(bound.reach || [])].filter((s) => s?.name !== RECIPE_TOOL_NAME) : null);
  const traitsOf = (tool) => bound?.traits?.get(tool) || null;

  return {
    id: 'recipe',
    specs: [recipeToolSpec(recipes)],
    system: byName.size ? 'Saved recipes exist (see the `recipe` tool). When the user asks for one by name or describes what one does, run it rather than re-planning the steps.' : '',
    bind(toolset) {
      bound = { execute: toolset.execute.bind(toolset), specs: toolset.specs, reach: toolset.reach, traits: toolset.traits, hiddenVia: toolset.hiddenVia };
    },
    async execute(name, input) {
      if (name !== RECIPE_TOOL_NAME) return json({ error: `Unknown tool: ${name}` });
      const action = String(input?.action || '');

      if (action === 'save') {
        const recipe = input?.recipe;
        const v = validateRecipe(recipe);
        if (!v.ok) return json({ error: 'The recipe is not valid.', problems: v.errors });
        if (!RECIPE_NAME_RE.test(recipe.name)) return json({ error: 'name must be a short identifier: letters, digits, _ or -.' });
        if (byName.has(recipe.name)) return json({ error: `A recipe named "${recipe.name}" already exists. Pick another name.` });
        if (!confirmSave || !saveRecipe) return json({ error: 'Saving a recipe needs the user\'s approval, which this surface cannot ask for. Describe the recipe to the user and suggest saving it from the side panel.' });
        const report = dryRunRecipe(recipe, {}, { specs: specsForDryRun(), traitsOf: bound ? (t) => traitsOf(t) || undefined : null });
        // Missing parameters are the POINT of a template; only structural problems block.
        const blocking = (report.warnings || []).filter((w) => w.code === 'unknown_tool');
        if (blocking.length) return json({ error: 'The recipe names tools that are not available in this conversation.', problems: blocking.map((w) => w.message) });
        const detail = describeRecipeForApproval(recipe, report);
        const decision = await confirmSave(detail, recipe);
        if (decision !== 'allow') return json({ error: `The user did not save "${recipe.name}". Do not propose it again this turn.`, declined: true });
        const stored = { ...recipe, enabled: true, createdAt: Date.now() };
        await saveRecipe(stored);
        byName.set(stored.name, stored);
        return json({ saved: stored.name, params: recipeParams(stored).map((p) => p.name), hint: `Run it later with {"action":"run","name":"${stored.name}","params":{…}} or by typing /${stored.name}.` });
      }

      const recipe = byName.get(String(input?.name || ''));
      if (!recipe) return json({ error: `No recipe named "${input?.name}".`, available: [...byName.keys()] });
      const params = input?.params && typeof input.params === 'object' ? input.params : {};

      if (action === 'dry_run') {
        const report = dryRunRecipe(recipe, params, { specs: specsForDryRun(), traitsOf: bound ? (t) => traitsOf(t) || undefined : null });
        return json({ name: recipe.name, ok: report.ok, missing: report.missing, calls: report.calls.map((c) => ({ tool: c.tool, arguments: c.arguments, known: c.known, destructive: c.traits?.destructive === true, mappedLater: c.mappedLater })), warnings: report.warnings });
      }

      if (action === 'run') {
        const ex = expandRecipe(recipe, params);
        if (!ex.plan) return json({ error: 'The saved recipe is not valid.', problems: ex.errors });
        if (!ex.ok) return json({ error: `Missing parameter(s): ${ex.missing.join(', ')}.`, params: recipeParams(recipe) });
        const result = await runPlan(ex.plan, { execute, traitsOf: (t) => traitsOf(t) || undefined });
        return json({ name: recipe.name, ...result });
      }

      return json({ error: `Unknown action "${action}". Use run, dry_run or save.` });
    },
  };
}
