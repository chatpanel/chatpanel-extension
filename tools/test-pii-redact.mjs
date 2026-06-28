import assert from 'node:assert/strict';

import {
  createVault, redactText, restoreText, hasToken, vaultToJSON, vaultFromJSON,
} from '../extension/js/pii-redact.js';

// --- basic deterministic tier: emails / phones / ip / ssn / key / card ---
{
  const v = createVault();
  const src = 'Email alex@example.com, call +1 (415) 555-0142, host 10.0.0.5, ssn 123-45-6789, key sk-abcdefghijklmnop1234, card 4242 4242 4242 4242.';
  const red = redactText(src, v, { tier: 'basic' });
  assert.match(red, /\[\[EMAIL_1\]\]/);
  assert.match(red, /\[\[PHONE_1\]\]/);
  assert.match(red, /\[\[IP_1\]\]/);
  assert.match(red, /\[\[SSN_1\]\]/);
  assert.match(red, /\[\[KEY_1\]\]/);
  assert.match(red, /\[\[CARD_1\]\]/);
  assert.doesNotMatch(red, /alex@example\.com/);
  assert.doesNotMatch(red, /4242/);
  assert.equal(restoreText(red, v), src, 'restore must reproduce the original exactly');
}

// --- a bare 10-digit number (typed without separators) is treated as a phone ---
{
  const v = createVault();
  const red = redactText('call me on 9320434444 ok', v, { tier: 'basic' });
  assert.match(red, /\[\[PHONE_1\]\]/);
  assert.equal(restoreText(red, v), 'call me on 9320434444 ok');
}

// --- false positives are NOT redacted: bare long id, non-Luhn 16-digit ---
{
  const v = createVault();
  const src = 'Order 20650912079 and bad card 1111 1111 1111 1111 stay as-is.';
  const red = redactText(src, v, { tier: 'basic' });
  assert.match(red, /20650912079/, 'a bare 11-digit id is not a phone');
  assert.match(red, /1111 1111 1111 1111/, 'a non-Luhn number is not a card');
  assert.equal(red, src);
}

// --- consistency: same value -> same token within a vault ---
{
  const v = createVault();
  const red = redactText('alex@example.com and again alex@example.com', v, { tier: 'basic' });
  assert.equal((red.match(/\[\[EMAIL_1\]\]/g) || []).length, 2);
  assert.doesNotMatch(red, /EMAIL_2/);
}

// --- full tier: known entities, case-insensitive, longest-first, restore canonical ---
{
  const v = createVault();
  const entities = [
    { value: 'Alex Rivera', type: 'PERSON' },
    { value: 'Atlas', type: 'PROJECT' },
  ];
  const src = 'Alex Rivera leads Atlas; alex rivera owns it.';
  const red = redactText(src, v, { tier: 'full', entities });
  assert.equal((red.match(/\[\[PERSON_1\]\]/g) || []).length, 2, 'both casings map to the same person token');
  assert.match(red, /\[\[PROJECT_1\]\]/);
  assert.doesNotMatch(red, /Rivera/i);
  // lowercase mention restores to the canonical entity value
  assert.equal(restoreText(red, v), 'Alex Rivera leads Atlas; Alex Rivera owns it.');
}

// --- entity tier does NOT fire on the basic tier ---
{
  const v = createVault();
  const red = redactText('Alex Rivera here', v, { tier: 'basic', entities: [{ value: 'Alex Rivera', type: 'PERSON' }] });
  assert.equal(red, 'Alex Rivera here', 'names are only redacted in full tier');
}

// --- user dictionary: exact value + regex pattern ---
{
  const v = createVault();
  const dictionary = [
    { value: 'Project Phoenix', type: 'PROJECT' },
    { pattern: 'EMP-\\d+', type: 'EMPID' },
  ];
  const red = redactText('Project Phoenix ticket EMP-123 and EMP-99.', v, { tier: 'basic', dictionary });
  assert.match(red, /\[\[PROJECT_1\]\]/);
  assert.match(red, /\[\[EMPID_1\]\] and \[\[EMPID_2\]\]/);
  assert.equal(restoreText(red, v), 'Project Phoenix ticket EMP-123 and EMP-99.');
}

// --- dictionary: pseudonymize ('alias', permanent) vs redact ('type', reversible) ---
{
  const v = createVault();
  const dictionary = [
    { value: 'John', alias: 'Alex' },   // pseudonymize → permanent substitution
    { value: 'Acme', type: 'COMPANY' },   // redact → reversible placeholder
    { pattern: 'EMP-\\d+', alias: 'EID' }, // regex pseudonymize
  ];
  const red = redactText('John from Acme, badge EMP-7', v, { tier: 'basic', dictionary });
  assert.equal(red, 'Alex from [[COMPANY_1]], badge EID');
  // restore brings back only the reversible one; the aliases are permanent
  assert.equal(restoreText(red, v), 'Alex from Acme, badge EID');
}

// --- a broken user regex must not throw ---
{
  const v = createVault();
  const red = redactText('safe text', v, { tier: 'basic', dictionary: [{ pattern: '([', type: 'X' }] });
  assert.equal(red, 'safe text');
}

// --- hasToken (used by streaming restore) ---
assert.equal(hasToken('see [[EMAIL_1]] here'), true);
assert.equal(hasToken('nothing to see'), false);

// --- restore leaves unknown tokens untouched ---
{
  const v = createVault();
  assert.equal(restoreText('keep [[UNKNOWN_9]] as-is', v), 'keep [[UNKNOWN_9]] as-is');
}

// --- vault survives serialize/deserialize (persist per conversation) ---
{
  const v = createVault();
  const red = redactText('ping alex@example.com', v, { tier: 'basic' });
  const v2 = vaultFromJSON(vaultToJSON(v));
  assert.equal(restoreText(red, v2), 'ping alex@example.com');
  // and continues numbering correctly after rehydrate
  const more = redactText('and jordan@example.com', v2, { tier: 'basic' });
  assert.match(more, /\[\[EMAIL_2\]\]/);
}

console.log('pii redact tests passed');
