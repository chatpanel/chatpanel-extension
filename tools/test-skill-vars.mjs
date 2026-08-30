// Skill prompt placeholders — {{input}} / {{selection}} / {{url}} / {{title}} / {{date}}.
//
// Three bugs made these look broken and pushed people to delete the placeholder from
// their skill instead of fixing it:
//   1. "/fix this sentence" put the typed text in the {{input}} slot AND appended it
//      again after the prompt, so the model saw it twice.
//   2. Picking a skill from the ☰ menu always substituted an EMPTY {{input}} and
//      appended whatever was typed after the prompt — so the slot the skill was built
//      around was the one thing it never received.
//   3. An invented placeholder ({{content}}) was authored, saved and run with nothing
//      anywhere saying it would never be filled; the model got the literal characters.
//
// (3) is fixed by owning the variable set in @chatpanel/events rather than as a regex
// chain in the panel. These assert the wiring, plus that the vendored copy behaves —
// a bad sync must not silently change what a skill prompt means.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SKILL_VAR_NAMES, lintSkillPrompt, substituteSkillVars,
} from '../extension/js/events/skill-vars.js';

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const settingsJs = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const assist = readFileSync(new URL('../extension/js/assist.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');

// --- the vendored contract still behaves (sync sanity) ----------------------------
assert.deepEqual(SKILL_VAR_NAMES, ['input', 'selection', 'url', 'title', 'date']);
{
  const out = await substituteSkillVars('Fix {{input}} on {{url}}', {
    args: 'this text',
    resolvers: { url: () => 'https://e.example' },
  });
  assert.equal(out.text, 'Fix this text on https://e.example');
}
{
  const out = await substituteSkillVars('Rewrite:\n{{content}}', { args: 'x' });
  assert.equal(out.text, 'Rewrite:\n{{content}}', 'an unknown placeholder is never rewritten');
  assert.equal(out.unknown[0].suggestion, 'input', 'and it points at the slot that was meant');
}

// --- the panel must not re-derive the variable set --------------------------------
assert.doesNotMatch(
  sidepanel,
  /\{\\\{\\\s\*(url|title|date|selection)\\\s\*\\\}\}/,
  'The panel must not carry its own placeholder regexes — that drift IS the {{content}} bug.',
);
assert.match(sidepanel, /await skillVars\(\)/, 'The panel should delegate to the shared contract.');
// Action-only, and 9 KB: it must not join the side panel's static first-paint graph.
assert.doesNotMatch(
  sidepanel,
  /^import .*events\/skill-vars\.js/m,
  'skill-vars must be dynamic-imported in the side panel, not statically imported.',
);
assert.doesNotMatch(
  assist,
  /^import .*events\/skill-vars\.js/m,
  'assist.js is on the panel’s static graph, so its skill-vars import must be dynamic too.',
);

// 1. Slash path: append the args only when there is no slot to put them in.
assert.match(
  sidepanel,
  /const inline = \(await skillVars\(\)\)\.lintSkillPrompt\(sk\.skill\.prompt\)\.hasInput;/,
  'The slash path should ask the contract whether the prompt has an {{input}} slot.',
);
assert.match(
  sidepanel,
  /const body = sk\.skill\.prompt \+ \(!inline && sk\.args \? `\\n\\n\$\{sk\.args\}` : ''\);/,
  'Typed args should be appended only when the prompt has no {{input}} slot.',
);

// 2. Menu path: the composer's text fills {{input}}; an empty slot parks the caret.
const applySkill = sidepanel.match(/async function applySkill\(skill\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.ok(applySkill, 'applySkill should exist');
assert.match(applySkill, /const typed = input\.value\.trim\(\);/, 'The menu path should read what is already typed.');
assert.match(
  applySkill,
  /substituteVars\(skill\.prompt, \{ args: typed \|\| CARET \}\)/,
  'The composer text should fill {{input}} instead of being appended after the prompt.',
);
assert.match(applySkill, /input\.setSelectionRange\(at, at\)/, 'With nothing typed, the caret should land in the empty slot.');
assert.doesNotMatch(
  applySkill,
  /substituteVars\(skill\.prompt, \{ args: '' \}\)/,
  'The menu path must never substitute a hard-coded empty {{input}}.',
);

// 3. Both silent failures now speak: an empty slot and an invented one.
assert.match(sidepanel, /out\.empty\.includes\('selection'\)/, 'An unfilled {{selection}} should say why.');
assert.match(sidepanel, /out\.unknown\[0\]/, 'An invented placeholder should be surfaced at run time.');
assert.match(settingsJs, /lintSkillPrompt\(prompt\)/, 'The skill editor should lint the prompt as it is written.');
assert.match(settingsJs, /s-lint-fix/, 'The editor should offer a one-click fix for an invented placeholder.');
assert.match(html, /class="s-lint"/, 'The skill template needs somewhere to show the lint.');

// The assist prompt is GENERATED from the declared set — a hand-written list is how
// the model came to invent {{content}} and then dutifully preserve it.
assert.match(assist, /skillVarGuidance\(\)/, 'The assist system prompt should be built from the declared variables.');
// The quoted form only — the comment above it deliberately quotes the old wording.
assert.doesNotMatch(assist, /'Preserve any \{\{placeholders\}\} verbatim/, 'The un-named placeholder instruction should no longer be sent to the model.');

// 4. Every substituted variable is offered as a chip in the editor, so what the editor
//    advertises and what the panel fills cannot drift apart.
const skillTpl = html.match(/<template id="skill-tpl">([\s\S]*?)<\/template>/)?.[1] || '';
assert.ok(skillTpl, 'skill template should exist');
for (const v of SKILL_VAR_NAMES) {
  assert.ok(skillTpl.includes(`data-var="{{${v}}}"`), `The editor should offer a {{${v}}} chip.`);
}
const chips = [...skillTpl.matchAll(/data-var="\{\{([a-z]+)\}\}"/g)].map((m) => m[1]);
assert.deepEqual(chips.sort(), [...SKILL_VAR_NAMES].sort(), 'The editor must offer exactly the declared set — no more, no fewer.');

assert.equal(lintSkillPrompt('Fix {{input}}').hasInput, true);

console.log('skill variable tests passed');
