const BUILTIN_COMMANDS = [
  {
    type: 'builtin',
    command: 'search',
    icon: '🔎',
    description: 'Search the web and attach the results as context.',
  },
  {
    type: 'builtin',
    command: 'history',
    icon: '🕘',
    description: 'Search prior chats. Pro includes meeting transcripts.',
  },
  {
    type: 'builtin',
    command: 'history chats',
    icon: '💬',
    description: 'Search previous ChatPanel chats.',
  },
  {
    type: 'builtin',
    command: 'history meetings',
    icon: '🎙️',
    description: 'Search saved meeting transcripts.',
    feature: 'liveMeetings',
  },
  {
    type: 'builtin',
    command: 'monitor',
    icon: '👁',
    description: 'Keep answering a question as the live meeting progresses.',
    feature: 'liveMeetings',
  },
  {
    type: 'builtin',
    command: 'tldr',
    icon: '📌',
    description: 'Keep a running TL;DR of the live meeting (optional focus).',
    feature: 'liveMeetings',
  },
];

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

export function slashCommandItems({
  skills = [],
  recipes = [],
  prefix = '',
  skillsAllowed = false,
  canMeetings = false,
} = {}) {
  const normalized = normalizePrefix(prefix);
  const builtins = BUILTIN_COMMANDS.map((item) => ({
    ...item,
    locked: item.feature === 'liveMeetings' && !canMeetings,
  }));
  const skillItems = skillsAllowed ? (skills || []).map(skillItem) : [];
  const recipeItems = (recipes || []).filter((r) => r && r.enabled !== false && r.name).map(recipeItem);
  return [...builtins, ...skillItems, ...recipeItems]
    .filter((item) => item.command && item.command.toLowerCase().startsWith(normalized))
    .slice(0, 12);
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
