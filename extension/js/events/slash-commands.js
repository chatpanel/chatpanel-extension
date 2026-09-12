// GENERATED — do not edit.
// Source of truth: chatpanel-events/slash-commands.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// slash-commands.js — the `/command` grammar of a chat composer, declared ONCE.
//
// A skill, a saved recipe and a client's built-in command all answer to a slash. Which
// ones exist, how a half-typed prefix is matched, what a chosen item inserts, and how a
// sent run is LABELLED all lived in the extension's side panel, and the desktop had to copy
// them the day its composer wanted `/summarize` too. This module is that copy, made the
// original: a third client (mobile, a channel bot) inherits the grammar instead of
// re-deriving it.
//
// What is NOT here is deliberate:
//   • the BUILT-IN list — `/search`, `/history`, `/monitor` — is what a client can DO,
//     and a desktop with no live meeting has no `/tldr`. Each client passes its own.
//   • the prompt expansion — `expandSkillPrompt` in skill-vars.js, so a composer that only
//     needs the menu never pays for the variable layer.
//   • the entitlement — `skillsAllowed` is decided by the caller against its licence.

function normalizePrefix(prefix) {
  return String(prefix || '')
    .toLowerCase()
    .replace(/^\//, '')
    .replace(/\s+/g, ' ');
}

function skillItem(skill) {
  return {
    type: 'skill',
    command: skill.command || '',
    icon: skill.icon || '🎓',
    description: skill.description || skill.name || '',
    skill,
  };
}

// A saved recipe is a /command too. It is not a skill: nothing is expanded into a prompt.
// The line becomes a plain request to run it, and the `recipe` tool does the rest.
function recipeItem(recipe) {
  return { type: 'recipe', command: recipe.name || '', icon: '🧩', description: recipe.description || 'Saved recipe', recipe };
}

/** Skills that are switched on. Absence of the flag means enabled (older records have none). */
export function enabledSkills(skills) {
  return (Array.isArray(skills) ? skills : []).filter((s) => !!s && s.enabled !== false);
}

/**
 * The items a composer offers for what has been typed so far.
 *
 * @param builtins      the client's own commands — `{ command, icon, description, feature? }`.
 *                      One with a `feature` is shown LOCKED when `features[feature]` is
 *                      false: a Free user should still discover what Pro unlocks.
 * @param skills        the user's skills; only enabled ones with a command are offered
 * @param recipes       saved recipes; enabled ones by name
 * @param prefix        what follows the slash, possibly with a subcommand ("history m")
 * @param skillsAllowed whether skills are offered at all (Pro on the extension)
 * @param features      `{ liveMeetings: true }` — what the licence unlocks
 */
export function slashCommandItems({
  builtins = [],
  skills = [],
  recipes = [],
  prefix = '',
  skillsAllowed = false,
  features = {},
} = {}) {
  const normalized = normalizePrefix(prefix);
  const own = (Array.isArray(builtins) ? builtins : []).map((item) => ({
    type: 'builtin',
    ...item,
    locked: !!item.feature && !features[item.feature],
  }));
  const skillItems = skillsAllowed ? enabledSkills(skills).map(skillItem) : [];
  const recipeItems = (recipes || []).filter((r) => r && r.enabled !== false && r.name).map(recipeItem);
  return [...own, ...skillItems, ...recipeItems]
    .filter((item) => item.command && item.command.toLowerCase().startsWith(normalized))
    .slice(0, 12);
}

/** Is the composer's text a slash command still being typed — the moment to show the menu? */
export const SLASH_TYPING_RE = /^\/([a-z0-9_-]*(?:\s+[a-z0-9_-]*)?)$/i;

/** "/summarize the thread" → the enabled skill whose command is `summarize`, and the rest. */
export function matchSlashSkill(text, skills = []) {
  const m = /^\/([a-z0-9_-]+)\s*([\s\S]*)$/i.exec(String(text || ''));
  if (!m) return null;
  const skill = enabledSkills(skills).find((s) => String(s.command || '').toLowerCase() === m[1].toLowerCase());
  return skill ? { skill, args: m[2].trim() } : null;
}

/** "/open_bug Crash on start" → the recipe, and the rest of the line as its input. */
export function matchSlashRecipe(text, recipes = []) {
  const m = /^\/([a-z0-9_-]+)\s*([\s\S]*)$/i.exec(String(text || ''));
  if (!m) return null;
  const recipe = (recipes || []).find((r) => r && r.enabled !== false && String(r.name || '').toLowerCase() === m[1].toLowerCase());
  return recipe ? { recipe, args: m[2].trim() } : null;
}

/** What the model receives for a recipe command: a request, not a prompt expansion. */
export function recipeInvocationText(recipe, args = '') {
  const a = String(args || '').trim();
  return `Run the saved recipe "${recipe.name}"${a ? ` with this input: ${a}` : ''}. Use the recipe tool; if a parameter is missing, ask for it.`;
}

export function slashCommandInsert(item) {
  return item?.command ? `/${item.command} ` : '/';
}

/**
 * How a skill invocation should READ once it has been sent.
 *
 * The model must receive the whole prompt — that is what a skill IS. The user's own bubble
 * echoing it back is a separate question with a different answer: a screen of instructions
 * they wrote themselves buries the thread the skill was asked to read. So the send keeps
 * the expansion as the message CONTENT (model, exports and memory capture see exactly what
 * they always saw) and carries this beside it, for display only.
 *
 * Null for anything that is not a command, so callers attach it unconditionally and older
 * messages — which have none — keep rendering as they did.
 */
export function skillInvocationOf(skill, args = '') {
  if (!skill?.command) return null;
  return {
    command: skill.command,
    args: String(args || '').trim(),
    name: skill.name || '',
    icon: skill.icon || '🎓',
  };
}

/** The one line an invocation is worth: `/command args`, exactly as typed. */
export function skillInvocationLabel(inv) {
  if (!inv?.command) return '';
  return `/${inv.command}${inv.args ? ` ${inv.args}` : ''}`;
}
