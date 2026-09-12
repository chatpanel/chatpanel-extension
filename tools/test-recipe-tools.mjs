// Recipes on the panel: proposed by the model, approved on a card, run by name through the
// turn's own toolset — so every guard underneath still fires.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { recipeToolProvider, recipeToolSpec, describeRecipeForApproval, RECIPE_TOOL_NAME } from '../extension/js/recipe-tools.js';
import { buildToolset } from '../extension/js/toolset.js';
import { mcpDispatchProvider, MCP_TOOL_NAME } from '../extension/js/mcp-dispatch.js';
import { withDestructiveGate } from '../extension/js/events/tool-traits.js';
import { slashCommandItems, matchSlashRecipe, recipeInvocationText } from '../extension/js/slash-commands.js';

const ran = [];
const server = {
  remote: true,
  specs: [
    { name: 'mcp_gh__search_issues', description: 'Search issues.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
    { name: 'mcp_gh__get_issue', description: 'Get one issue.', parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] }, annotations: { readOnlyHint: true } },
    { name: 'mcp_gh__create_issue', description: 'Create an issue.', parameters: { type: 'object', properties: { title: { type: 'string' }, labels: { type: 'array' } }, required: ['title'] } },
    { name: 'mcp_gh__delete_issue', description: 'Delete an issue.', parameters: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] } },
  ],
  execute: async (n, a) => { ran.push([n, a]); return n === 'mcp_gh__search_issues' ? JSON.stringify({ items: [{ number: 7 }] }) : JSON.stringify({ ok: true, tool: n, args: a }); },
};
const openBug = { name: 'open_bug', description: 'File a bug', mode: 'call', tool: 'mcp_gh__create_issue', arguments: { title: { $param: 'title' }, labels: ['bug'] }, enabled: true };
const searchRead = { name: 'search_read', mode: 'pipeline', steps: [{ tool: 'mcp_gh__search_issues', arguments: { query: { $param: 'q' } } }, { tool: 'mcp_gh__get_issue', arguments: {}, inputMapping: { number: '$json.items.0.number' }, onMappingMissing: 'fail' }], enabled: true };

// Assemble exactly as turn-tools does: dispatcher → toolset → gate → bind.
function arm({ recipes = [], confirmSave = null, saveRecipe = null, confirmDestructive = null } = {}) {
  const mcp = mcpDispatchProvider(buildToolset([server]));
  const provider = recipeToolProvider({ recipes, confirmSave, saveRecipe });
  let toolset = buildToolset([mcp, provider]);
  toolset = withDestructiveGate(toolset, { confirm: confirmDestructive, only: (n) => toolset.remoteTools.has(n) });
  provider.bind(toolset);
  return toolset;
}

// ── the spec lists the catalogue; a turn with no recipes and no window registers nothing ──
{
  const spec = recipeToolSpec([openBug, { ...searchRead, enabled: false }]);
  assert.match(spec.description, /open_bug\(title\) — File a bug/);
  assert.doesNotMatch(spec.description, /search_read/, 'a disabled recipe is not offered');
  assert.ok(JSON.stringify(spec).length < 2200, `one spec, kept terse (${JSON.stringify(spec).length})`);
  const turnTools = readFileSync(new URL('../extension/js/turn-tools.js', import.meta.url), 'utf8');
  assert.match(turnTools, /if \(savedRecipes\.some\(\(r\) => r && r\.enabled !== false\) \|\| \(confirmRecipeSave && saveRecipe\)\)/, 'registered only when there is something to run or a way to save');
  assert.match(turnTools, /if \(toolset && recipeProvider\) recipeProvider\.bind\(toolset\);/, 'bound to the toolset it is a member of');
}

// ── save: dry run on the card, stored only on Allow, refused with nobody to ask ──────────
{
  const seen = [];
  const saved = [];
  const tools = arm({ confirmSave: async (detail, r) => { seen.push(detail); return r.name === 'open_bug' ? 'allow' : 'deny'; }, saveRecipe: async (r) => saved.push(r) });
  assert.ok(tools.specs.some((s) => s.name === RECIPE_TOOL_NAME));
  const ok = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: openBug }));
  assert.equal(ok.saved, 'open_bug');
  assert.deepEqual(ok.params, ['title']);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].enabled, true);
  assert.match(seen[0], /open_bug — File a bug\nMode: call\nParameters: title\nmcp_gh__create_issue \{"labels":\["bug"\]\}/, 'the card shows the step with its slot');
  assert.doesNotMatch(seen[0], /unknown_tool|not available/, 'a known hidden tool is known — reach, not just the menu');
  assert.equal(ran.length, 0, 'saving runs nothing');
  // Declined: not stored, and the model is told not to nag.
  const no = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { ...searchRead, name: 'other' } }));
  assert.equal(no.declined, true);
  assert.equal(saved.length, 1);
  // A recipe naming a tool this conversation does not have is refused before the card.
  const ghost = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { name: 'ghost', mode: 'call', tool: 'mcp_nope__x', arguments: {} } }));
  assert.match(ghost.error, /not available/);
  assert.equal(seen.length, 2, 'no card for an impossible recipe');
  // Invalid shape: the validator's words come back.
  const bad = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { name: 'x', mode: 'pipeline', steps: [] } }));
  assert.ok(bad.problems.some((p) => /steps:/.test(p)));
  // No window: refused, and run still works.
  const blind = arm({ recipes: [openBug] });
  const refused = JSON.parse(await blind.execute(RECIPE_TOOL_NAME, { action: 'save', recipe: { ...openBug, name: 'again' } }));
  assert.match(refused.error, /cannot ask/);
}

// ── run: through the dispatcher, so the destructive gate fires on the real action ────────
{
  ran.length = 0;
  const asked = [];
  const tools = arm({ recipes: [openBug, searchRead, { name: 'nuke', mode: 'call', tool: 'mcp_gh__delete_issue', arguments: { number: { $param: 'n' } }, enabled: true }], confirmDestructive: async (q) => { asked.push(q.name); return 'deny'; } });
  const r = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'open_bug', params: { title: 'Crash' } }));
  assert.equal(r.status, 'completed');
  assert.deepEqual(ran[0], ['mcp_gh__create_issue', { title: 'Crash', labels: ['bug'] }], 'the hidden tool ran through the dispatcher with real values');
  const missing = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'open_bug', params: {} }));
  assert.match(missing.error, /Missing parameter\(s\): title/);
  const p = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'search_read', params: { q: 'login' } }));
  assert.equal(p.status, 'completed');
  assert.deepEqual(p.steps[1].mappedArguments, { number: 7 });
  const nuked = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'nuke', params: { n: 1 } }));
  assert.equal(nuked.status, 'failed', 'a declined destructive step fails the recipe');
  assert.deepEqual(asked, ['mcp_gh__delete_issue'], 'the gate asked about the REAL action, not "recipe"');
  const unknown = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'run', name: 'nope' }));
  assert.deepEqual(unknown.available, ['open_bug', 'search_read', 'nuke']);
  const dry = JSON.parse(await tools.execute(RECIPE_TOOL_NAME, { action: 'dry_run', name: 'nuke', params: { n: 2 } }));
  assert.equal(dry.calls[0].destructive, true);
  assert.equal(dry.calls[0].known, true);
  assert.ok(dry.warnings.some((w) => w.code === 'destructive'));
}

// ── /recipe as a slash command: a request to run, never a prompt expansion ───────────────
{
  const items = slashCommandItems({ recipes: [openBug, { ...searchRead, enabled: false }], prefix: 'o' });
  assert.deepEqual(items.map((i) => `${i.type}:${i.command}`), ['recipe:open_bug']);
  const m = matchSlashRecipe('/open_bug Crash on start', [openBug]);
  assert.equal(m.recipe.name, 'open_bug');
  assert.equal(m.args, 'Crash on start');
  assert.equal(matchSlashRecipe('/nope x', [openBug]), null);
  assert.match(recipeInvocationText(openBug, 'Crash'), /Run the saved recipe "open_bug" with this input: Crash/);
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(sidepanel, /matchSlashRecipe\(raw, state\.settings\.recipes\)/);
  assert.match(sidepanel, /confirmRecipeSave: async \(detail\) =>/);
  assert.match(sidepanel, /title: 'Save this recipe\?'/);
  assert.match(sidepanel, /saveRecipe: async \(recipe\) =>/);
  const settings = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /import\('\.\/js\/settings-recipes\.js'\)/, 'the settings section is deferred');
}

// ── the approval text reads as steps and warnings ────────────────────────────────────────
{
  const text = describeRecipeForApproval(searchRead, { calls: [{ tool: 'a', arguments: { query: 'x' } }, { tool: 'b', arguments: {}, mappedLater: ['number'] }], warnings: [{ message: 'careful' }] });
  assert.match(text, /1\. a \{"query":"x"\}\n2\. b \(\+ number from the previous step\)\n⚠ careful/);
}

console.log('recipe tools tests passed');
