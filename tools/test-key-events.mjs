// The bug this exists to prevent is invisible in a screenshot.
//
// A rawKeyDown fires `keydown` and nothing else. An editor that commits on the CHARACTER
// event — a Google Sheets cell, a rich text field, a code editor — sees the key arrive and
// never acts on it. So `press_key Enter` "succeeded" while committing nothing, and
// thirty-five values concatenated into one cell. Twice, because the first fix copied the
// same broken shape.

import assert from 'node:assert/strict';
import { keyEventsFor } from '../extension/js/page-actions-cdp.js';

const ENTER = { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' };
const TAB = { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', text: '\t' };
const ESC = { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' };
const DOWN = { windowsVirtualKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' };

// A committing key must be keyDown WITH text, or editors ignore it.
const [enterDown, enterUp] = keyEventsFor(ENTER);
assert.equal(enterDown.type, 'keyDown', 'Enter sent as rawKeyDown will not commit a cell');
assert.equal(enterDown.text, '\r');
assert.equal(enterDown.unmodifiedText, '\r');
assert.equal(enterDown.key, 'Enter');
assert.equal(enterUp.type, 'keyUp');
assert.ok(!('text' in enterUp), 'keyUp must not carry text');

assert.equal(keyEventsFor(TAB)[0].type, 'keyDown');
assert.equal(keyEventsFor(TAB)[0].text, '\t');

// Keys that genuinely produce no character stay raw — sending text for them would insert
// a stray glyph.
for (const def of [ESC, DOWN]) {
  const [down] = keyEventsFor(def);
  assert.equal(down.type, 'rawKeyDown', `${def.key} should stay raw`);
  assert.ok(!('text' in down), `${def.key} must not carry text`);
}

// A modified key is a SHORTCUT, not a character: Cmd+Enter must not type a carriage
// return into the field it is meant to act on.
const [modDown] = keyEventsFor(ENTER, 4 /* meta */);
assert.equal(modDown.type, 'rawKeyDown');
assert.ok(!('text' in modDown), 'a modified Enter must not produce text');
assert.equal(modDown.modifiers, 4);

// The virtual key code survives either path — it is what the page matches on.
assert.equal(keyEventsFor(ENTER)[0].windowsVirtualKeyCode, 13);
assert.equal(keyEventsFor(ENTER, 4)[0].windowsVirtualKeyCode, 13);

console.log('✓ key events: committing keys carry text, raw keys do not, modifiers suppress it');
