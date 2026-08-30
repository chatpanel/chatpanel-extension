// F6 S3 — where skills can come from, as a registry rather than a panel.
//
// The bridge is the first registration and deliberately the LOCAL one: the bytes are
// already on this machine, so nothing crosses the network and nothing needs the scanner
// that gates fetched packages. A hub is the same three functions with a different fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSkillSourceRegistry } from '../extension/js/events/skill-sources.js';
import { bridgeSkillSource } from '../extension/js/skill-source-bridge.js';
import { trustOf } from '../extension/js/events/skill-manifest.js';

const settingsJs = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');

// A bridge that answers, standing in for the real one.
function fakeBridge({ skills = [], fail = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error(fail);
    const path = new URL(url).pathname;
    if (path === '/skills') return json({ ok: true, skills });
    const m = /^\/skills\/([^/]+)$/.exec(path);
    if (m) {
      const hit = skills.find((s) => s.id === decodeURIComponent(m[1]));
      return hit ? json({ ok: true, skill: { ...hit, prompt: `body of ${hit.id}` } }) : json({ ok: false, error: 'unknown skill' }, 404);
    }
    return json({ ok: false, error: 'nope' }, 404);
  };
  return calls;
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const REC = [
  { id: 'graphify', name: 'graphify', description: 'Knowledge graphs', origin: { source: 'local', id: 'graphify', hash: 'sha256-a' } },
  { id: 'foundry', name: 'foundry', description: 'Azure agents', files: { references: ['auth.md'] }, origin: { source: 'agents-dir', id: 'foundry', hash: 'sha256-b' } },
];

function reg({ supported = true, skills = REC, fail = null } = {}) {
  const calls = fakeBridge({ skills, fail });
  const r = createSkillSourceRegistry();
  r.add(bridgeSkillSource({ bridgeUrl: () => 'http://127.0.0.1:4319', supported: () => supported }));
  return { r, calls };
}

// --- the source behaves ------------------------------------------------------------
{
  const { r } = reg();
  const [section] = await r.search({});
  assert.equal(section.source, 'bridge');
  assert.equal(section.trust, 'local');
  assert.deepEqual(section.items.map((s) => s.id), ['graphify', 'foundry']);
  // Provenance is stamped by the registry from the REGISTRATION, so a record cannot
  // relabel where it came from — but its content hash survives, since only the fetcher
  // knows what was actually read.
  assert.equal(section.items[0].origin.source, 'bridge');
  assert.equal(section.items[0].origin.hash, 'sha256-a');
  assert.equal(trustOf(section.items[0]), 'community', 'a file on disk is not "ours"');
}

// --- an older bridge, and an absent one ---------------------------------------------
{
  // /health omits `skills` on a bridge that predates F6. Asking it anyway would 404;
  // an absent source is not an error the user has to interpret.
  const { r, calls } = reg({ supported: false });
  const [section] = await r.search({});
  assert.equal(section.absent, true);
  assert.equal(section.error, undefined);
  assert.deepEqual(calls, [], 'an unsupported bridge must not be called at all');
}
{
  const { r } = reg({ fail: 'ECONNREFUSED' });
  const [section] = await r.search({});
  assert.match(section.error, /ECONNREFUSED/);
  assert.deepEqual(section.items, [], 'a dead bridge costs its own section, nothing else');
}

// --- the list level carries no bodies; read fetches one ------------------------------
{
  const { r, calls } = reg();
  const [section] = await r.search({});
  assert.equal(section.items[0].prompt, undefined, 'level 0 is not the document');
  const full = await r.read('bridge', 'graphify');
  assert.equal(full.prompt, 'body of graphify');
  assert.ok(calls.some((c) => c.endsWith('/skills/graphify')), 'the body is fetched only when asked for');
}

// --- filtering, and an id that needs encoding ---------------------------------------
{
  const { r } = reg();
  const [section] = await r.search({ query: 'azure' });
  assert.deepEqual(section.items.map((s) => s.id), ['foundry'], 'matches the description too');
}
{
  const { r, calls } = reg({ skills: [{ id: 'a b/c', name: 'odd' }] });
  await r.read('bridge', 'a b/c').catch(() => {});
  assert.ok(calls.some((c) => c.includes('/skills/a%20b%2Fc')), 'a name is encoded, never pasted into a path');
}

// --- the extension wiring ------------------------------------------------------------
assert.match(providers, /skills: json\.skills \|\| null/, 'checkBridge must surface the /health capability flag.');
assert.match(html, /id="skill-sources-card"/, 'the Skills tab needs somewhere to show them');
assert.match(html, /id="skill-sources-card" *[^>]*class="card hidden"|class="card hidden" id="skill-sources-card"/, 'the section starts hidden — an absent source shows nothing');
assert.match(settingsJs, /createSkillSourceRegistry/, 'settings should build the registry');
assert.match(settingsJs, /bridgeState\?\.ok && bridgeState\.skills/, 'the source is gated on the advertised capability');
// Loaded on demand: the Skills tab is not the settings page's first paint.
assert.doesNotMatch(
  settingsJs,
  /^import .*skill-source-bridge\.js/m,
  'the skill sources should be dynamic-imported, not on the boot path',
);
// Adding one keeps its provenance, or the card above cannot say where it came from and
// an update check has nothing to compare against.
const addFn = settingsJs.match(/async function addSkillFromSource\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(addFn, 'addSkillFromSource should exist');
assert.match(addFn, /\.\.\.full, id: uid\(\)/, 'the copy keeps the fetched record, including its origin');
assert.match(addFn, /while \(taken\.has\(command\)\)/, 'a clashing slash-command must not silently shadow an existing skill');
assert.match(addFn, /can\(license, 'customSkills'\)/, 'adding a skill is still gated like adding one by hand');

// --- search reaches the SOURCE, and the result cannot be interpreted as markup ---------
assert.match(settingsJs, /reg\.search\(\{ query: skillSourceQuery \}\)/, 'the query must go to the source, not filter what it already returned');
assert.match(settingsJs, /seq !== skillSourceSeq/, 'a slow source answering late must not overwrite a newer query');
assert.match(settingsJs, /setTimeout\(\(\) => renderSkillSources\(\), 180\)/, 'searching should be debounced — a keystroke can reach a remote hub');
// A description is written by whoever authored the skill. The highlighter builds text
// nodes and a <mark>; the settings page is the last place to interpret a stranger's markup.
const mark = settingsJs.match(/function markMatch\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(mark, 'markMatch should exist');
assert.doesNotMatch(mark, /innerHTML/, 'a skill description must never be set as HTML');
assert.match(mark, /createElement\('mark'\)/);

console.log('skill source tests passed');
