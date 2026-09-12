// The extension's `/commands`: the shared grammar (js/events/slash-commands.js — matching,
// insertion, the invocation label) with THIS client's built-ins on top. Which commands a
// client can offer is the one part that is genuinely its own: `/monitor` and `/tldr` need a
// live meeting, `/search` renders SERPs in background tabs, and the desktop has neither.

import { slashCommandItems as sharedItems } from './events/slash-commands.js';

export {
  SLASH_TYPING_RE,
  matchSlashSkill,
  matchSlashRecipe,
  recipeInvocationText,
  slashCommandInsert,
  skillInvocationOf,
  skillInvocationLabel,
} from './events/slash-commands.js';

const BUILTIN_COMMANDS = [
  {
    command: 'search',
    icon: '🔎',
    description: 'Search the web and attach the results as context.',
  },
  {
    command: 'history',
    icon: '🕘',
    description: 'Search prior chats. Pro includes meeting transcripts.',
  },
  {
    command: 'history chats',
    icon: '💬',
    description: 'Search previous ChatPanel chats.',
  },
  {
    command: 'history meetings',
    icon: '🎙️',
    description: 'Search saved meeting transcripts.',
    feature: 'liveMeetings',
  },
  {
    command: 'monitor',
    icon: '👁',
    description: 'Keep answering a question as the live meeting progresses.',
    feature: 'liveMeetings',
  },
  {
    command: 'tldr',
    icon: '📌',
    description: 'Keep a running TL;DR of the live meeting (optional focus).',
    feature: 'liveMeetings',
  },
];

export function slashCommandItems({
  skills = [],
  recipes = [],
  prefix = '',
  skillsAllowed = false,
  canMeetings = false,
} = {}) {
  return sharedItems({
    builtins: BUILTIN_COMMANDS,
    skills,
    recipes,
    prefix,
    skillsAllowed,
    features: { liveMeetings: canMeetings },
  });
}
