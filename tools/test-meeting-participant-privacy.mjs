// A tool result goes straight to whatever model is driving the turn — often a cloud one. So a
// "helpful" no-match must never answer by listing who WAS in the user's meetings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { personMatches } from '../extension/js/meeting-people.js';

const src = readFileSync(new URL('../extension/js/history-rag.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('if (!rows.length && participant)'), src.indexOf('return formatMeetingList'));

// It must not put participant names into the result.
assert.ok(!/\.people\)/.test(block) || !/join\(', '\)/.test(block), 'no participant list is emitted');
assert.ok(!/names\.join/.test(block), 'names are never joined into the response');
// It may report COUNTS — those carry no identity.
assert.match(block, /withPeople/, 'reports how many meetings hold participant data');
// And it must stop the model concluding zero attendance.
assert.match(block, /Do NOT report zero attendance/i, 'blocks the false-negative conclusion');
assert.match(block, /Ask the user for the exact name/i, 'asks the human, who already knows it');

// Matching stays explicit: substring or regex, never fuzzy guessing between people.
assert.equal(personMatches('Jordan Blake', 'jordan'), true, 'substring matches');
assert.equal(personMatches('Jordan Blake', '/jord/'), true, 'regex matches');
assert.equal(personMatches('Jordan Blake', 'jordy'), false, 'a nickname does NOT silently match');
assert.equal(personMatches('Jamie Okafor', 'jordan'), false, 'and a different person never does');

console.log('ok — no participant names leave the device; counts + guidance instead');
