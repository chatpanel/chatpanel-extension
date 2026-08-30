// F6 S1 — the skill record moves to @chatpanel/events.
//
// The extension side of that: every shipped skill must satisfy the contract, a stored
// v1 skill must survive the v2 loader field for field, and the module must not join the
// boot path while doing it. store.js is imported by every entry point, so a static
// import here would put the manifest module plus the capability contract behind it on
// first paint — which is a release gate, not a preference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SKILL_MANIFEST_VERSION, declaredAccess, needsBridge, normalizeSkill, trustOf,
  upcastSkill, validateSkill,
} from '../extension/js/events/skill-manifest.js';

const store = readFileSync(new URL('../extension/js/store.js', import.meta.url), 'utf8');

// --- first paint ------------------------------------------------------------------
assert.doesNotMatch(
  store,
  /^import .*events\/skill-manifest\.js/m,
  'store.js is on every entry point’s boot path — skill-manifest must be dynamic-imported.',
);
assert.match(
  store,
  /await import\('\.\/events\/skill-manifest\.js'\)/,
  'The write path should reach the shared normalizer.',
);
// The READ path (getSettings → settings-merge) runs on boot and must stay a cheap legacy
// migration; canonical shape is applied on write.
const readPath = store.match(/function normalizeSkillMcpDefaults\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(readPath, 'the read-path migration should still exist');
assert.doesNotMatch(readPath, /await import|normalizeSkill\b/, 'The read path must not pull the manifest module.');

// --- every shipped skill satisfies the contract -----------------------------------
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
};
const { defaultSkills } = await import('../extension/js/store.js');
const shipped = defaultSkills();
assert.ok(shipped.length, 'there should be built-in skills');
for (const skill of shipped) {
  assert.doesNotThrow(() => validateSkill(skill), `shipped skill '${skill.id}' must validate`);
  assert.equal(trustOf(skill), 'built-in', `shipped skill '${skill.id}' should be built-in`);
  assert.equal(needsBridge(skill), false, 'no shipped skill carries scripts');
  // The access set has to be computable for every one of them — it is what an install
  // review and the Plugins lens will read.
  assert.ok(Array.isArray(declaredAccess(skill).reads));
}

// --- a stored v1 skill survives ----------------------------------------------------
// Exactly the record shape users have in chrome.storage today, from before F6 existed.
const storedV1 = {
  id: 'my-skill', name: 'My skill', command: 'mine', icon: '🎓',
  description: 'does a thing', context: 'page', prompt: 'Do the thing with {{input}}.',
  historyContext: 'chats', mcpMode: 'selected', mcpServerIds: ['fs'], agentId: 'ep-1',
  meeting: true, enabled: false,
};
const carried = upcastSkill(storedV1);
assert.equal(carried.v, SKILL_MANIFEST_VERSION);
for (const [k, v] of Object.entries(storedV1)) assert.deepEqual(carried[k], v, `v1 field '${k}' changed`);

const saved = normalizeSkill(storedV1);
assert.equal(saved.enabled, false, 'an explicit off must survive a save');
assert.deepEqual(saved.mcpServerIds, ['fs']);
assert.equal(saved.agentId, 'ep-1', 'fields the contract does not know about are carried, not dropped');

// --- the coercions that exist because a skill can now arrive from outside -----------
const imported = normalizeSkill({
  id: 'evil', name: 'Evil', trust: 'built-in', builtin: true,
  origin: { source: 'skills-sh', id: 'someone/evil', hash: 'sha256-abc' },
  files: { references: ['ok.md', '../../.ssh/id_rsa'] },
});
assert.equal(imported.trust, undefined, 'a record must not be able to assert its own trust');
assert.equal(imported.builtin, false, '“we shipped it” is not something an import may claim');
assert.equal(trustOf(imported), 'community');
assert.deepEqual(imported.files, { references: ['ok.md'] }, 'a traversal path is dropped, not stored');

console.log('skill manifest tests passed');
