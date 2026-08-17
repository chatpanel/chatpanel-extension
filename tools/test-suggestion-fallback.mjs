import assert from 'node:assert/strict';
import { suggestionCandidates } from '../extension/js/suggestions.js';

// A local model that is not running used to kill suggestions outright: the picker skipped
// bridge/CLI agents entirely, then took the FIRST endpoint with a model whether or not it
// was reachable. One dead endpoint, no suggestions — while a working CLI agent and a
// working remote endpoint sat unused.

const local = { id: 'ollama', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', apiKey: '' };
const remote = { id: 'oai', name: 'Remote', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', apiKey: 'k' };
const bridge = { id: 'cc', name: 'Claude Code', kind: 'bridge', command: 'claude' };

const settings = (over = {}) => ({ endpoints: [local, remote], agents: [bridge], ...over });
const ids = (list) => list.map((t) => t.id);

// Every configured model is a candidate — nothing is silently excluded.
const all = suggestionCandidates(settings({ activeAgentId: 'cc' }));
assert.ok(ids(all).includes('ollama') && ids(all).includes('oai'), 'an endpoint was dropped');
assert.ok(ids(all).includes('cc'), 'the CLI agent was excluded, which is what left users with no suggestions');

// A bridge agent goes LAST. Spawning a CLI to write four short strings is real cost and
// latency — a reason to defer it, never a reason to have none at all.
assert.equal(ids(all).at(-1), 'cc', 'the costly candidate is not last');

// An explicit choice leads, even when it is the expensive one.
assert.equal(ids(suggestionCandidates(settings({ ui: { suggestions: { targetId: 'cc' } } })))[0], 'cc');

// An endpoint with no model cannot answer and is not offered.
const noModel = suggestionCandidates({ endpoints: [{ id: 'blank', baseUrl: 'http://x/v1' }, remote] });
assert.deepEqual(ids(noModel), ['oai']);

// No duplicates when the active agent is also in the endpoint list — otherwise a dead
// endpoint would be retried twice before moving on.
const dupes = suggestionCandidates({ endpoints: [local, local, remote], activeAgentId: 'ollama' });
assert.deepEqual(ids(dupes), ['ollama', 'oai']);

// Nothing configured is still nothing — the caller must be able to say "no model".
assert.deepEqual(suggestionCandidates({}), []);

// Budgets are applied per kind: a CLI agent has no temperature to set.
const b = all.find((t) => t.id === 'cc');
assert.equal(b.maxTokens, 160);
assert.equal(b.temperature, undefined);
assert.equal(all.find((t) => t.id === 'oai').temperature, 0.4);

console.log('✓ suggestions: every model is a candidate, cheapest first, CLI last but never excluded');
