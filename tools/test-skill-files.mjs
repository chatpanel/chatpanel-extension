// F6 — progressive disclosure, level 2.
//
// A packaged skill ships a lean SKILL.md plus reference documents it deliberately does not
// inline: that is what lets a knowledge-base skill carry a book's worth of material and
// cost nothing until a question needs one chapter. ChatPanel imported the SKILL.md and
// ignored everything it pointed at, so a skill would send the model to `references/auth.md`
// and the model had no way to open it — which reads as the skill being wrong.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skillFileProvider, SKILL_FILE_TOOL } from '../extension/js/skill-files.js';
import { skillPackageFiles, skillRunFromSkill, skillToolSystem } from '../extension/js/skill-runtime.js';

const PKG = {
  id: 'foundry', name: 'Foundry', mcpMode: 'none',
  origin: { source: 'bridge', id: '.system/foundry' },
  files: { references: ['auth.md', 'setup.md'], scripts: ['run.py'], assets: ['logo.png'] },
};

// --- the index the model is shown -------------------------------------------------
{
  const files = skillPackageFiles(PKG);
  assert.deepEqual(files, ['references/auth.md', 'references/setup.md', 'assets/logo.png']);
  // Scripts are tier-3 code that runs in the bridge behind the scanner. Handing a model
  // the SOURCE instead carries the injection surface with none of the usefulness.
  assert.ok(!files.some((f) => f.startsWith('scripts/')), 'scripts are never offered as text');
  assert.deepEqual(skillPackageFiles({}), [], 'a skill with no package offers nothing');
}
{
  const run = skillRunFromSkill(PKG, {});
  assert.deepEqual(run.files, ['references/auth.md', 'references/setup.md', 'assets/logo.png']);
  assert.equal(run.origin.source, 'bridge');
  const sys = skillToolSystem(run, []);
  assert.match(sys, /references\/auth\.md/, 'the system prompt lists what exists');
  assert.match(sys, /NOT included above/, 'and is explicit that the contents are not inlined');
  assert.match(sys, /only when the task needs it/, 'level 0 must discourage reading everything');
}

// --- the tool ---------------------------------------------------------------------
const make = (over = {}) => {
  const calls = [];
  const p = skillFileProvider({
    skillRun: skillRunFromSkill(PKG, {}),
    read: async (origin, path) => { calls.push([origin.id, path]); return { text: `body of ${path}` }; },
    ...over,
  });
  return { p, calls };
};

{
  const { p, calls } = make();
  assert.equal(p.specs.length, 1, 'ONE tool, not one per file — a tool per document would multiply the per-turn schema cost by package size');
  assert.equal(p.specs[0].name, SKILL_FILE_TOOL);
  // The enum is what the model sees; it should not have to guess a path.
  assert.deepEqual(p.specs[0].input_schema.properties.path.enum, ['references/auth.md', 'references/setup.md', 'assets/logo.png']);
  assert.equal(await p.execute(SKILL_FILE_TOOL, { path: 'references/auth.md' }), 'body of references/auth.md');
  assert.deepEqual(calls, [['.system/foundry', 'references/auth.md']], 'the bridge path is used, not the local id');
}

{
  // The enum is a hint to the model, never a guarantee about what arrives — so the
  // allowlist is re-checked. A prompt cannot talk the model into requesting a path the
  // skill never declared.
  const { p, calls } = make();
  for (const evil of ['../../.ssh/id_rsa', 'scripts/run.py', 'references/../../secret', '/etc/hosts', '']) {
    const out = await p.execute(SKILL_FILE_TOOL, { path: evil });
    assert.match(out, /^Not available/, `should refuse ${JSON.stringify(evil)}`);
  }
  assert.deepEqual(calls, [], 'a refused path never reaches the bridge');
}

{
  // A missing reference must not fail the turn: the model can still answer from SKILL.md.
  const { p } = make({ read: async () => { throw new Error('bridge down'); } });
  assert.match(await p.execute(SKILL_FILE_TOOL, { path: 'references/auth.md' }), /Could not read references\/auth\.md: bridge down/);
}

{
  const { p } = make({ read: async () => ({ text: 'x'.repeat(40_000) }) });
  const out = await p.execute(SKILL_FILE_TOOL, { path: 'references/auth.md' });
  assert.ok(out.length < 30_000, 'one reference document, not a corpus dumped into the context');
  assert.match(out, /truncated/, 'and truncation is stated, not silent');
}

// --- no package, no tool ------------------------------------------------------------
// An empty tool advertised on every turn is pure token cost.
assert.equal(skillFileProvider({ skillRun: skillRunFromSkill({ id: 'plain' }, {}), read: async () => ({}) }), null);
assert.equal(skillFileProvider({ skillRun: skillRunFromSkill(PKG, {}), read: null }), null, 'no reader, no tool');
assert.equal(
  skillFileProvider({ skillRun: { ...skillRunFromSkill(PKG, {}), origin: null }, read: async () => ({}) }),
  null,
  'a skill with files but no origin has nothing to fetch from',
);

// --- wiring --------------------------------------------------------------------------
const turn = readFileSync(new URL('../extension/js/turn-tools.js', import.meta.url), 'utf8');
assert.match(turn, /skillRun\?\.files\?\.length && skillRun\.origin\?\.source/, 'the tool is added only when the skill ships files');
assert.doesNotMatch(turn, /^import .*skill-files\.js/m, 'and is dynamic-imported — it is not needed on most turns');

console.log('skill file tests passed');
