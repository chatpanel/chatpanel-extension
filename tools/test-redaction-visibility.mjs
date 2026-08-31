// The privacy promise must be visible AND the record of it must itself be safe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVault, redactText, redactionSummary } from '../extension/js/pii-redact.js';
import { validateEvent } from '../extension/js/events/event.js';

// 1. The emitted event conforms to the declared schema — counts only, never values.
const vault = createVault();
redactText('Mail alex@example.com and call 555-867-5309.', vault, { tier: 'basic' });
const summary = redactionSummary(vault);
assert.ok(summary.total >= 2, 'the vault caught the email and the phone number');
const counts = {};
for (const t of summary.types) counts[t.type] = t.count;

const evt = {
  v: 1, id: 'e1', ts: 1, type: 'privacy.redacted',
  actor: { kind: 'user', id: 'u1' }, scope: { kind: 'session', id: 's1' },
  host: 'extension', seq: 0, at: 1_700_000_000_000, causes: [], payload: { counts },
};
const res = validateEvent(evt);
assert.ok(res === true || res?.ok !== false, `privacy.redacted must validate: ${JSON.stringify(res)}`);
assert.ok(!JSON.stringify(counts).includes('alex@example.com'), 'no real value in the payload');
assert.ok(!JSON.stringify(counts).includes('555'), 'no real value in the payload');

// 2. providers.js emits it, and emits the schema's shape (not an ad-hoc one).
const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
assert.match(providers, /turn\.emit\('privacy\.redacted', \{ counts \}\)/, 'emitted with the declared shape');

// 3. The settings page renders it from that event, and says values are not logged.
const settings = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
assert.match(settings, /e\?\.type !== 'privacy\.redacted'/, 'the Activity view reads the event');
assert.match(settings, /never logged/, 'the UI states that values are not recorded');

console.log('ok — redaction is visible by entity type, and the record carries no values');
