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

export function slashCommandItems({
  skills = [],
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
  return [...builtins, ...skillItems]
    .filter((item) => item.command && item.command.toLowerCase().startsWith(normalized))
    .slice(0, 12);
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
