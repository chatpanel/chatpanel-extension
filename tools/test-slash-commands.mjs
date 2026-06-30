import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { slashCommandInsert, slashCommandItems } from '../extension/js/slash-commands.js';

const skills = [
  { command: 'summarize', icon: '📝', description: 'Summarize a page' },
  { command: 'review', icon: '🔍', description: 'Review code' },
];

const freeRoot = slashCommandItems({
  skills,
  prefix: '',
  skillsAllowed: false,
  canMeetings: false,
});
assert.deepEqual(
  freeRoot.map((item) => item.command),
  ['search', 'history', 'history chats', 'history meetings', 'monitor', 'tldr'],
  'Free users should discover built-in commands (search + history + meeting monitors) even when custom skills are gated.',
);
assert.equal(
  freeRoot.find((item) => item.command === 'history meetings')?.locked,
  true,
  'Meeting-history command should be visible but marked locked without meeting access.',
);
assert.equal(
  freeRoot.find((item) => item.command === 'monitor')?.locked,
  true,
  'Meeting monitor commands should be visible but locked without meeting access.',
);
assert.equal(
  freeRoot.some((item) => item.command === 'summarize'),
  false,
  'Free users should not see custom skills in slash suggestions.',
);

const proRoot = slashCommandItems({
  skills,
  prefix: '',
  skillsAllowed: true,
  canMeetings: true,
});
assert.deepEqual(
  proRoot.map((item) => item.command).slice(0, 4),
  ['search', 'history', 'history chats', 'history meetings'],
  'Built-in commands should appear before custom skills.',
);
assert.equal(
  proRoot.find((item) => item.command === 'history meetings')?.locked,
  false,
  'Meeting-history command should not be locked when meeting access is available.',
);
assert.ok(
  proRoot.some((item) => item.command === 'summarize'),
  'Pro users should still see custom skill slash commands.',
);

assert.deepEqual(
  slashCommandItems({ skills, prefix: 'history m', skillsAllowed: true, canMeetings: true }).map((item) => item.command),
  ['history meetings'],
  'Slash suggestions should filter commands with spaces, including history subcommands.',
);

assert.equal(
  slashCommandInsert({ command: 'history meetings' }),
  '/history meetings ',
  'Choosing a subcommand should insert the complete command prefix.',
);

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
assert.match(sidepanel, /slashCommandItems/, 'Sidepanel should use shared built-in slash commands.');
assert.match(sidepanel, /can\(state\.license,\s*'liveMeetings'\)/, 'Slash menu should know whether meeting history is unlocked.');
assert.match(sidepanel, /upsell\('liveMeetings'[^)]*Meeting history search/, 'Sending meeting-only history search without access should show the Pro gate.');

console.log('slash command tests passed');
