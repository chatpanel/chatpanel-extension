// Every built-in CLI agent must be reachable two ways, or it looks "not configurable":
//   1. it back-fills into an EXISTING user's saved agent list (they never see a fresh default),
//   2. it is selectable in the Add-agent kind picker.
// Hermes exposed the second gap: the agent existed but the dropdown didn't offer it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = readFileSync(new URL('../extension/js/store.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');

// The built-in bridge agents, keyed by bridgeAgent — the CLI kind the picker selects, which
// is not always the agent id (the Claude agent's id is 'claude-code', its kind is 'claude').
const builtins = [...store.matchAll(/kind: 'bridge',\s*\n\s*bridgeAgent: '([a-z-]+)'/g)].map((m) => m[1]);
assert.ok(builtins.includes('hermes'), 'hermes is a built-in bridge agent');
assert.ok(builtins.length >= 8, `found ${builtins.length} built-in agents`);

// 1. Back-fill: new built-ins reach users whose list was saved before they shipped.
assert.match(store, /missingBuiltins/, 'the defaults back-fill into an existing list');
assert.match(store, /removedBuiltins\.has\(a\.id\)/, 'without resurrecting one the user deleted');

// 2. Every built-in is offered by the kind picker, and has a human label.
const options = [...html.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1]);
for (const id of builtins) {
  assert.ok(options.includes(id), `the Add-agent picker offers "${id}" (otherwise it can't be configured)`);
  assert.match(settings, new RegExp(`\\b${id}: '[^']+'`), `AGENT_KIND_LABEL has a label for "${id}"`);
}

console.log(`ok — all ${builtins.length} built-in agents back-fill AND are selectable (incl. hermes)`);
