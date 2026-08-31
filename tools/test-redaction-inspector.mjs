// "Is redaction actually working?" needs the before → after pairs, not just counts. They
// exist only in the in-memory vault — the Activity log deliberately stores counts only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVault, redactText } from '../extension/js/pii-redact.js';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// The pairs come from the LIVE vault for the open conversation, not from storage.
assert.match(panel, /state\.piiVaults\.get\(state\.conv\?\.id\)/, 'reads the in-memory vault');
assert.match(panel, /vault\?\.byToken \|\| new Map\(\)/, 'uses the token → value map');
// Nothing is written anywhere: no storage call in the inspector block.
const block = panel.slice(panel.indexOf('WHAT WAS ACTUALLY REDACTED IN THIS CONVERSATION'), panel.indexOf('// Auto-detect categories.'));
assert.ok(!/chrome\.storage|localStorage|writeText\(/.test(block), 'the inspector never persists or copies values');
// Masked by default; revealing is an explicit action.
assert.match(block, /'•'\.repeat/, 'values are masked until revealed');
assert.match(block, /Reveal.*the original values/s, 'revealing is opt-in');

// And the vault genuinely holds what the inspector will show.
const v = createVault();
redactText('Email alex@example.com about the plan.', v, { tier: 'basic' });
const pairs = [...v.byToken];
assert.ok(pairs.length >= 1, 'the vault records a pair');
assert.match(pairs[0][0], /^\[\[[A-Z]+_\d+\]\]$/, 'token side is a placeholder');
assert.match(pairs[0][1], /@example\.com/, 'value side is the original');

console.log('ok — live before→after pairs from memory, masked by default, never persisted');
