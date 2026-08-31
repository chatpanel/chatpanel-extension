// Disabling a model in Settings must take it out of routing — and look like it has.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidatesFrom } from '../extension/js/model-router.js';

const agent = (over = {}) => ({ id: 'a1', name: 'Hermes', kind: 'bridge', model: 'some/model', ...over });
const cands = (s) => candidatesFrom(s, (t) => t);

// Enabled by default.
assert.equal(cands({ agents: [agent()] })[0].available, true);

// Disabled → not an available candidate.
assert.equal(cands({ agents: [agent({ enabled: false })] })[0].available, false);

// THE BUG: a routing override saved earlier could assert availability and win, so an agent
// switched off in Settings still showed as a live candidate. The explicit disable is the
// user's current instruction and must outrank the stored hint.
{
  const s = { agents: [agent({ enabled: false })], ui: { routing: { models: { a1: { available: true } } } } };
  assert.equal(cands(s)[0].available, false, 'an explicit disable beats a stale override');
}
// The override still works where it isn't contradicting an explicit disable.
{
  const s = { agents: [agent()], ui: { routing: { models: { a1: { available: false } } } } };
  assert.equal(cands(s)[0].available, false, 'an override can still mark an enabled model unavailable');
}

// The shared router refuses to route to an unavailable model at decision time.
const router = readFileSync(new URL('../extension/js/events/router.js', import.meta.url), 'utf8');
assert.match(router, /if \(!m\.available\).*'unavailable'/s, 'unavailable candidates are rejected when deciding');

// And the settings row shows it, rather than looking like every other candidate.
const settings = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
assert.match(settings, /m\.available === false\) row\.classList\.add\('is-off'\)/, 'the row is marked off');

console.log('ok — a disabled model is excluded from routing and visibly off in the list');
