// F6 S6 / F3.5 — the Plugins page lists skills with their declared access.
//
// F3 calls this the honest version of an extension gallery: because a skill's reach is
// declared and computable from its record BEFORE it runs, a user approves a set they can
// see rather than discovering it in use. This asserts the lens shows that reach and derives
// it from the record rather than reading a field the record could set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');

// skills are a plugin kind, ordered after the infrastructure ones
assert.match(src, /skill: 'Skills'/, 'Skills is a titled plugin kind');
assert.match(src, /agent: 10, skill: 11/, 'and ordered last, after agents');

// they are added to the lens
assert.match(src, /id: `skill:\$\{sk\.id\}`, kind: 'skill'/, 'each skill becomes a plugin row');
assert.match(src, /skillAccessLine\(sk\)/, 'the row shows its declared access');
assert.match(src, /state: isSkillEnabled\(sk\) \? '' : 'off'/, 'a disabled skill reads as off');

// the access line is derived, and covers the reach that matters
const fn = src.match(/function skillAccessLine\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(fn, 'skillAccessLine should exist');
for (const [what, needle] of [
  ['page', /reads the page/],
  ['chats', /reads chats/],
  ['meetings', /reads meetings/],
  ['mcp', /MCP tools/],
  ['scripts', /runs code/],
  ['review flag', /flagged for review/],
  ['provenance', /from another tool/],
]) {
  assert.match(fn, needle, `the access line should mention ${what}`);
}
// derived from the record, not a stored trust/access field
assert.doesNotMatch(fn, /skill\.access\b|skill\.trust\b/, 'reach is computed, never read from a field the record could set');

console.log('plugins skills tests passed');
