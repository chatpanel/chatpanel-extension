import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  skillInvocationLabel,
  skillInvocationOf,
  slashCommandInsert,
  slashCommandItems,
} from '../extension/js/slash-commands.js';

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

// A sent skill run is labelled by the command that started it. The expanded prompt stays
// the message content — the model, exports and memory capture must see what they always
// saw — so the label travels beside it rather than replacing it.
assert.deepEqual(
  skillInvocationOf({ command: 'hninsights', name: 'HN Insights', icon: '📰' }, '  '),
  { command: 'hninsights', args: '', name: 'HN Insights', icon: '📰' },
  'An invocation should record the command, its name and its icon.',
);
assert.equal(
  skillInvocationLabel(skillInvocationOf({ command: 'hninsights' }, 'top comments only')),
  '/hninsights top comments only',
  'Typed arguments belong in the label — they are what makes two runs different.',
);
assert.equal(
  skillInvocationLabel(skillInvocationOf({ command: 'hninsights' })),
  '/hninsights',
  'With no arguments the label is the bare command, with no trailing space.',
);
assert.equal(
  skillInvocationOf({ command: '' }, 'x'),
  null,
  'Anything without a command yields null, so callers can attach it unconditionally.',
);
assert.equal(skillInvocationOf(null), null, 'A missing skill must not throw.');
assert.equal(skillInvocationLabel(null), '', 'A message with no invocation has no label.');

assert.match(
  sidepanel,
  /if \(skillInvocation\) userMsg\.skillInvocation = skillInvocation;/,
  'Sending a /command should tag the message with its invocation.',
);
assert.match(
  sidepanel,
  /content: text,/,
  'The message content must stay the expanded prompt — the label is display only.',
);
assert.match(
  sidepanel,
  /delete m\.skillInvocation;/,
  'Editing a skill run drops the chip: the edited text is no longer what the command expands to.',
);

console.log('slash command tests passed');

// F8 §17: a pool agent answers to its own /command — a one-role team named after the card
// (team-org.js soloTeam), drawn as an agent in the menu and phrased as one for the model.
{
  const { teamsWithSolos } = await import('../extension/js/events/team-org.js');
  const { matchSlashTeam, teamInvocationText } = await import('../extension/js/slash-commands.js');
  const { starterAgents } = await import('../extension/js/events/agent.js');
  const teams = teamsWithSolos([{ name: 'research', roles: [{ id: 'r', prompt: 'p', grants: ['none'] }], budget: { ms: 1 } }], starterAgents());
  const items = slashCommandItems({ teams, prefix: 'reviewe' });
  assert.equal(items.length, 1, 'the reviewer alone (review, review-editor and review-checker are built in too)');
  assert.equal(items[0].command, 'reviewer');
  assert.equal(items[0].agent, 'reviewer', 'the item knows it is an agent');
  assert.equal(items[0].icon, '🧑‍💻');
  assert.ok(slashCommandItems({ teams, prefix: 'rev' }).some((i) => i.command === 'review' && !i.agent), 'the built-in team is there with nothing saved');
  const m = matchSlashTeam('/reviewer read the diff on main', teams);
  assert.equal(m.team.name, 'reviewer');
  assert.match(teamInvocationText(m.team, m.args), /^Run the agent "reviewer" .* read the diff on main/);
  assert.equal(slashCommandItems({ teams, prefix: 'res' })[0].icon, '🧑‍🤝‍🧑', 'a saved team is still a team');
  console.log('slash-commands: agents as commands ok');
}
