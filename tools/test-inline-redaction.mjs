// Redaction visible IN the conversation: the answer came back about a different person and
// nothing on screen explained why. This is that explanation, in place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');

// PER-TURN, not per-conversation: the vault accumulates (PERSON_1 must mean the same person
// every turn), so the message shows what THIS turn added.
assert.match(providers, /const knownTokens = new Set\(vault \? vault\.byToken\.keys\(\) : \[\]\)/, 'snapshots before redacting');
assert.match(providers, /filter\(\(t\) => !knownTokens\.has\(t\)\)/, 'reports only the delta');

// PLACEHOLDERS ONLY in the event — the message is persisted, so a value here would write PII
// to disk. The panel resolves originals from the live vault instead.
assert.match(providers, /onEvent\?\.\(\{ type: 'redaction', tokens: added, counts \}\)/, 'emits tokens + counts');
const emitBlock = providers.slice(providers.indexOf('const knownTokens'), providers.indexOf("onEvent?.({ type: 'redaction'"));
assert.ok(!/byToken\.get|\.value/.test(emitBlock), 'no real values are put on the event');

// The message stores exactly that, and the bubble renders it beside Actions.
assert.match(panel, /assistant\.redaction = \{ tokens: ev\.tokens \|\| \[\], counts: ev\.counts \|\| \{\} \}/, 'stored on the message');
assert.match(panel, /if \(m\.redaction\?\.tokens\?\.length\) html \+= renderRedaction\(m\)/, 'rendered in the bubble');
assert.match(panel, /Redacted \(\$\{r\.tokens\.length\}\)/, 'summarised with a count');

// Masked by default; Reveal reads the LIVE vault, never the stored message.
assert.match(panel, /data-masked="1">••••••••/, 'values masked until revealed');
assert.match(panel, /state\.piiVaults\.get\(state\.conv\?\.id\)/, 'reveal resolves from the in-memory vault');
assert.match(panel, /no longer in memory/, 'and says so honestly once the vault is gone');

console.log('ok — per-turn redaction shown inline; placeholders persisted, values only in memory');
