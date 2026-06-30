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
