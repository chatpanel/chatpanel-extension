// Live meeting monitors accumulate, they do not refresh in place.
//
// The reported bug: a monitor "keeps refreshing instead of appending", and repeats what it
// already said. Both came from one line — `m.answer = out.trim()` replaced the answer every
// tick — and one prompt that asked for "a SINGLE concise answer ... up to date" while never
// telling the model what it had already reported.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// --- findings accumulate ----------------------------------------------------------
assert.match(src, /m\.findings\.push\(\{ t: Date\.now\(\), text \}\)/, 'a new finding is appended, not substituted');
assert.doesNotMatch(src, /^\s*m\.answer = out\.trim\(\);$/m, 'the replace-every-tick line must be gone');
assert.match(src, /m\.findings\.slice\(-40\)/, 'the list is capped — a long meeting must not grow without bound');

// --- the model is told what it already said ----------------------------------------
assert.match(src, /ALREADY REPORTED — do not repeat any of this/, 'prior findings go into the prompt');
assert.match(src, /deltaInstruction\(prior\)/, 'and the delta instruction is actually used');
const promptFn = src.match(/function monitorPrompt\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(promptFn, 'monitorPrompt should exist');
assert.equal((promptFn.match(/deltaInstruction\(prior\)/g) || []).length, 2, 'both accumulating kinds get it');

// --- a running TL;DR is the deliberate exception ------------------------------------
// It is a summary; one that accumulated would stop being one.
assert.match(src, /const ACCUMULATES = \(m\) => m\?\.kind !== 'tldr'/, 'TL;DR still replaces');
assert.match(src, /if \(!accumulate\) \{\n\s*m\.answer = text;/, 'and takes the replace path');

// --- "nothing new" must not become a card saying "NOTHING NEW" -----------------------
// Models wrap, bold and punctuate a sentinel; a strict equality check would append every
// one of those as a finding, which is exactly the noise the sentinel prevents.
const nothingNew = src.match(/function isNothingNew\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(nothingNew, 'isNothingNew should exist');
assert.match(nothingNew, /replace\(/, 'punctuation and emphasis are stripped before comparing');
assert.match(nothingNew, /toUpperCase\(\)/, 'and case is ignored');

// --- nothing is ever lost -----------------------------------------------------------
assert.match(
  src,
  /if \(!Array\.isArray\(m\.findings\)\) m\.findings = m\.answer/,
  'a monitor saved before findings existed keeps the answer the user can already see',
);
assert.match(
  src,
  /if \(!m\.findings\?\.length\) m\.answer = `⚠ \$\{m\.error\}`/,
  'a failed tick must not erase findings the meeting already produced',
);
assert.match(src, /m\.lastChecked = Date\.now\(\)/, '"checked, nothing new" is recorded — it means still watching');

// --- the card folds ------------------------------------------------------------------
const body = src.match(/function monitorBodyHtml\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(body, 'monitorBodyHtml should exist');
assert.match(body, /Earlier findings \(\$\{earlier\.length\}\)/, 'older findings collapse behind a count');
assert.match(body, /found\[found\.length - 1\]/, 'the newest is the one shown open');
assert.match(body, /No new information as of/, 'a still-watching monitor says so rather than looking stalled');

console.log('monitor findings tests passed');
