import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// ── The cap the prompt asks for is the cap the parser enforces ───────────────────
//
// suggestions.js keeps MAX_ITEMS as a literal because it sits on the side panel's FIRST PAINT
// and the shared schema layer is 50 KB that no panel needs to paint — the schema is imported
// at the call site instead. A literal that drifts from the schema means the model is asked for
// one number and the reply is trimmed to another, which is the exact class of bug this whole
// change removes. So it is asserted rather than trusted.
{
  const { MAX_SUGGESTIONS } = await import('../extension/js/events/extraction.js');
  const src = readFileSync(new URL('../extension/js/suggestions.js', import.meta.url), 'utf8');
  const literal = Number(/const MAX_ITEMS = (\d+);/.exec(src)?.[1]);
  assert.equal(literal, MAX_SUGGESTIONS,
    'suggestions.js MAX_ITEMS has drifted from MAX_SUGGESTIONS in @chatpanel/events/extraction.js');
}

// ── Every name a suggestion path reads must actually exist ───────────────────────
//
// Two of them did not. `PROVIDERS.byo` read `meeting?.id` and `getMeetingSuggestions` read a
// bare `sourceId` — both declared on a DIFFERENT function. Optional chaining does not protect
// an UNDECLARED identifier: it throws ReferenceError. The throw happened inside the fallback
// chain's attempt callback, which reads any throw as "that candidate failed" — so both
// features silently produced nothing, AND each attempt cooled every candidate in the shared
// memo, taking page suggestions down with them for a minute at a time.
//
// A unit test cannot reach these paths without a browser, so the check is static: no
// identifier may be read inside a function that nothing in scope declares.
{
  const src = readFileSync(new URL('../extension/js/suggestions.js', import.meta.url), 'utf8');
  const declared = new Set([
    ...[...src.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^import\s*\{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())),
  ]);
  for (const name of ['meeting', 'sourceId']) {
    assert.equal(declared.has(name), false,
      `if \`${name}\` is now a top-level binding this guard needs rethinking`);
  }
  // `meeting` may only be read inside getMeetingSuggestions, which takes it as a parameter.
  const meetingFn = /export async function getMeetingSuggestions\([\s\S]*?\n\}/.exec(src)?.[0] || '';
  assert.ok(meetingFn, 'getMeetingSuggestions not found');
  const outside = src.replace(meetingFn, '');
  assert.doesNotMatch(outside, /\bmeeting\??\./,
    'something outside getMeetingSuggestions reads `meeting`, which is not declared there');
  // `sourceId` may only be read where it is a parameter or a property key being written.
  for (const fn of [meetingFn]) {
    assert.doesNotMatch(fn, /sourceId\s*[,}]/,
      'getMeetingSuggestions reads a bare `sourceId` it does not declare — use meeting.id');
  }
}

// ── Suggestions go through the ONE structured-call path ──────────────────────────
{
  const src = readFileSync(new URL('../extension/js/suggestions.js', import.meta.url), 'utf8');
  assert.match(src, /runStructured\(\{/, 'suggestions must call the shared capability');
  assert.match(src, /candidates: suggestionCandidates\(settings\)/, 'and hand it the whole candidate list');
  assert.match(src, /\bchain,/, 'with the feature\'s own health memo, not a private wrapper');
  assert.doesNotMatch(src, /loadStreamChat/, 'the private streamChat loader should be gone');
}
