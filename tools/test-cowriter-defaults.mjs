// The co-writer is on by default, its panel fits on a laptop, and the two gears say what
// they do.
//
// Three reports, one panel:
//   • it was opt-in, so most people never met it at all;
//   • the team panel had no height ceiling, so on a short screen its bottom half — the role
//     pickers, the spend meter — was off the viewport with no way to scroll to it;
//   • "Ambient" and "Focus" carried their meaning only in a `title` tooltip, on buttons
//     people click rather than hover. The difference between them is whether the thing
//     WRITES for you, which is the one thing worth knowing here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const js = read('notes.js');
const css = read('notes.css');

// ── on by default, but an explicit "off" is still off ────────────────────────────
const pref = /function readCowriterPref\(\)[\s\S]*?\n\}/.exec(js)?.[0] || '';
assert.ok(pref, 'readCowriterPref not found');
assert.match(
  pref, /!== '0'/,
  'only a stored "0" may mean off — a comparison against "1" makes the ABSENCE of a value '
  + 'mean off, which is what kept this opt-in',
);
assert.doesNotMatch(pref, /=== '1'/, 'the old opt-in comparison must not come back');
assert.match(pref, /catch \{ return true; \}/, 'a private window throws on access; the default is still the default');
// Writing the choice must not be able to stop the choice taking effect.
assert.ok(
  /try \{ localStorage\.setItem\('chatpanel\.notes\.cowriter'/.test(js),
  'the write must be guarded too',
);

// Enabling it by default is only safe because none of these guards moved.
assert.match(js, /if \(!editor\) return;/, 'no configured model must mean no call, not an error');
assert.match(js, /if \(!budgetOk\(\)\)/, 'the per-minute spend cap must still gate the model call');
assert.match(js, /return finish\(cwSuggestions\.length, true\); \/\/ saved a token/,
  'the free deterministic pass must still run before any token is spent');
assert.match(js, /let swarmGear = localStorage\.getItem\('chatpanel\.notes\.gear'\) \|\| 'ambient'/,
  'and the default gear must stay the one that writes nothing');

// ── the panel has to fit on the screen it is opened on ───────────────────────────
const menu = /\.swarm-menu \{[^}]*\}/.exec(css)?.[0] || '';
assert.ok(menu, '.swarm-menu must be styled');
assert.match(menu, /max-height:\s*min\(/, 'the tallest menu in the app needs a ceiling');
assert.match(menu, /overflow-y:\s*auto/, 'and must scroll inside itself rather than off-screen');
assert.match(menu, /vh/, 'the ceiling must be relative to the viewport, not a fixed pixel guess');
assert.match(menu, /overscroll-behavior:\s*contain/, 'its scroll must not continue into the note');
assert.match(menu, /max-width:\s*min\(/, 'and it must not run off a narrow window either');

// ── the gears must say what they do, on screen ───────────────────────────────────
const notes = /const GEAR_NOTE = \{[\s\S]*?\n\};/.exec(js)?.[0] || '';
assert.ok(notes, 'GEAR_NOTE not found');
for (const gear of ['ambient', 'focus']) {
  assert.ok(new RegExp(`${gear}:`).test(notes), `${gear} needs an explanation`);
}
assert.match(notes, /Nothing is written for you/, 'Ambient must say the thing that defines it');
assert.match(notes, /writes alongside you/, 'and Focus must say the opposite plainly');
assert.match(notes, /accept-or-reject/, 'Focus must say the drafts are still yours to refuse');
assert.match(notes, /spend cap/, 'and that the cost guardrail still applies');
// Rendered, not just declared.
assert.match(js, /gearNote\.textContent = GEAR_NOTE\[swarmGear\]/, 'the note must reflect the SELECTED gear');
assert.match(js, /gearNote\.className = 'swarm-gear-note';/, 'and be in the panel');
assert.match(js, /menu\.appendChild\(gearNote\);/, 'actually appended, not just built');
assert.match(js, /How much should the team do\?/, 'the pair needs a heading that frames the choice');
// The buttons carry a one-line summary of their own, so the choice reads without the note.
assert.match(js, /<b>🌙 Ambient<\/b><span>Suggests only<\/span>/);
assert.match(js, /<b>\$\{icon\('zap'\)\} Focus<\/b><span>Writes with you<\/span>/);

// Styled from tokens, so both themes are right.
for (const rule of ['.sg-opt {', '.swarm-gear-note {']) {
  const block = new RegExp(`${rule.replace(/[.{]/g, (c) => '\\' + c)}[^}]*\\}`).exec(css)?.[0] || '';
  assert.ok(block, `${rule} must be styled`);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, `${rule} must use tokens`);
}

console.log('cowriter defaults: ok');
