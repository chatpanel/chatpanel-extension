// Skill DISCOVERY — the model can use any installed skill without the user adding it first.
//
// Level 0 is a compact catalog in the system prompt (name + one line each, ranked, capped),
// added only on turns that already arm tools. skill_open loads one skill's full instructions
// on demand — its body fetched only then — and skill_file reads a reference only after the
// skill has been opened. This is what makes Add optional.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { skillCatalogSystem, rankSkills, skillHandle } from '../extension/js/skill-runtime.js';
import { skillEntry, skillDiscoveryProvider } from '../extension/js/skill-files.js';

const SKILLS = [
  { id: 'a', name: 'Summarize', command: 'summarize', description: 'Summarize a page or document', enabled: true },
  { id: 'b', name: 'Foundry', command: 'microsoft-foundry', description: 'Build agents on Azure AI Foundry', enabled: true,
    origin: { source: 'bridge', id: '.system/foundry' }, files: { references: ['auth.md'] } },
  { id: 'c', name: 'Off', command: 'off', description: 'disabled one', enabled: false },
];

// --- catalog: ranked, compact, skips disabled ------------------------------------
{
  const sys = skillCatalogSystem(SKILLS, { userText: 'help me authenticate to azure foundry' });
  assert.match(sys, /SKILLS AVAILABLE/);
  assert.match(sys, /microsoft-foundry: Build agents on Azure/, 'lists the skill and its one-liner');
  assert.doesNotMatch(sys, /\boff\b:/, 'a disabled skill is not offered');
  assert.match(sys, /skill_open/, 'and tells the model how to load one');
  // The azure question should float foundry above summarize.
  assert.ok(sys.indexOf('microsoft-foundry') < sys.indexOf('summarize'), 'relevance ranks the match first');
}

// --- an explicitly named skill is always included, even past the cap -------------
{
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Skill ${i}`, command: `skill-${i}`, description: 'x', enabled: true }));
  many.push({ id: 'special', name: 'Kubernetes', command: 'kube-deploy', description: 'deploy to k8s', enabled: true });
  const sys = skillCatalogSystem(many, { userText: 'run the kube-deploy skill please', cap: 8 });
  assert.match(sys, /kube-deploy/, '"use the kube-deploy skill" must include it even though it ranked past the cap');
}

// --- the provider: open loads a body, and gates references -----------------------
{
  const bodies = { 'microsoft-foundry': 'FULL FOUNDRY INSTRUCTIONS' };
  const reads = [];
  const entries = SKILLS.filter((s) => s.enabled).map((s) => skillEntry(s, { prompt: s.command === 'microsoft-foundry' ? null : s.prompt || 'inline body' }));
  const p = skillDiscoveryProvider({
    entries,
    loadPrompt: async (e) => (e.prompt != null ? e.prompt : bodies[e.command]),
    read: async (origin, path) => { reads.push([origin.id, path]); return { text: `REF ${path}` }; },
  });
  assert.ok(p, 'provider exists when there are skills');
  assert.deepEqual(p.specs.map((s) => s.name).sort(), ['skill_file', 'skill_open']);

  // open a bridge-only skill → its body is fetched now
  const opened = await p.execute('skill_open', { name: 'microsoft-foundry' });
  assert.match(opened, /FULL FOUNDRY INSTRUCTIONS/);
  assert.match(opened, /ships reference files: references\/auth\.md/, 'and points at its references');

  // references are readable only AFTER opening
  const beforeOpen = await skillDiscoveryProvider({ entries, loadPrompt: async () => 'x', read: async () => ({ text: 'y' }) })
    .execute('skill_file', { skill: 'microsoft-foundry', path: 'references/auth.md' });
  assert.match(beforeOpen, /Open the skill first/, 'a reference is gated behind the open');

  const ref = await p.execute('skill_file', { skill: 'microsoft-foundry', path: 'references/auth.md' });
  assert.equal(ref, 'REF references/auth.md');
  assert.deepEqual(reads, [['.system/foundry', 'references/auth.md']], 'read against the bridge origin');

  // a path the skill did not declare is refused
  assert.match(await p.execute('skill_file', { skill: 'microsoft-foundry', path: '../../etc/passwd' }), /Not available/);
}

// --- no skills, no provider -------------------------------------------------------
assert.equal(skillDiscoveryProvider({ entries: [] }), null);
assert.equal(skillCatalogSystem([], {}), '');

// --- wiring: discovery is skipped when a skill was explicitly invoked ------------
const turn = readFileSync(new URL('../extension/js/turn-tools.js', import.meta.url), 'utf8');
assert.match(turn, /if \(!skillRun\) \{[\s\S]*skillDiscoveryProvider/, 'discovery only when no skill was invoked');
assert.match(turn, /listBridgeSkills\(bridgeUrl, skillDirs\)/, 'the installed skills are pulled from the bridge, with custom folders');
assert.match(turn, /!seen\.has\(e\.command\)/, "the user's added copy wins a handle clash");
assert.match(turn, /!skillRun && toolset && catalogEntries\.length \? skillCatalogSystem/, 'the catalog rides the system prompt only in discovery mode');

console.log('skill discovery tests passed');
