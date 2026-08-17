import assert from 'node:assert/strict';
import { sheetsAdapter, rowsToKeystrokes, SHEETS_TOOL } from '../extension/js/adapters/sheets.js';

// A spreadsheet is a canvas: no DOM grid, no accessibility tree, and A1 has no stable
// coordinate. Three runs clicked (20,40), then (10,10), then a hand-built sequence — each
// hit the menu bar, typed into nothing, and reported success. "Where is A1 on screen" has
// no reliable answer; "put this value in A1" does.

assert.equal(sheetsAdapter.matches('https://docs.google.com/spreadsheets/d/abc/edit'), true);
assert.equal(sheetsAdapter.matches('https://docs.google.com/document/d/abc/edit'), false);
assert.equal(sheetsAdapter.matches('https://example.com'), false);

// Tabs move a column, newlines move a row — the same keystrokes a person's paste produces.
assert.equal(rowsToKeystrokes([['Multiplier', 'Result'], ['2 x 1', 2]]), 'Multiplier\tResult\n2 x 1\t2');
// A blank cell must still take its column, or every value after it shifts left.
assert.equal(rowsToKeystrokes([['a', null, 'c']]), 'a\t\tc');
assert.equal(rowsToKeystrokes([[1], [2]]), '1\n2');

// ── the calls it makes, in order ──────────────────────────────────────────────
const run = async (input, over = {}) => {
  const calls = [];
  const ctx = {
    cdp: true,
    script: async () => ({ x: 40, y: 90, sel: '#t-name-box' }),
    click: async (x, y) => calls.push(`click:${x},${y}`),
    type: async (t) => calls.push(`type:${JSON.stringify(t)}`),
    press: async (k) => calls.push(`press:${k}`),
    ...over,
  };
  const res = await sheetsAdapter.execute(SHEETS_TOOL, input, ctx);
  return { res, calls };
};

{
  const { res, calls } = await run({ start: 'A1', rows: [['Multiplier', 'Result'], ['2 x 1', 2]] });
  assert.equal(res.ok, true);
  assert.equal(res.wrote, 4);
  // Navigate by NAME first — the only click is on a real DOM element whose position the
  // page just reported, never a guessed grid coordinate.
  assert.equal(calls[0], 'click:40,90');
  assert.equal(calls[1], 'type:"A1\\n"');
  assert.equal(calls[2], 'type:"Multiplier\\tResult\\n2 x 1\\t2"');
  // The trailing Enter commits the last cell; without it the value sits in edit mode and
  // shows as raw text — the exact spreadsheet failure the guidance warns about.
  assert.equal(calls[3], 'press:Enter');
}

// ── refusals that are actionable, rather than a silent no-op ──────────────────
assert.match((await run({ start: 'nonsense', rows: [[1]] })).res.error, /cell reference/);
assert.match((await run({ start: 'A1', rows: [] })).res.error, /non-empty/);
assert.match((await run({ start: 'A1', rows: [[1]] }, { cdp: false })).res.error, /High-reliability/);
assert.match((await run({ start: 'A1', rows: [[1]] }, { script: async () => null })).res.error, /name box/);

// Nothing is typed when the target could not be found — a half-written sheet is worse than
// an untouched one.
assert.deepEqual((await run({ start: 'A1', rows: [[1]] }, { script: async () => null })).calls, []);

// Lowercase references are accepted and normalised; the name box wants A1, not a1.
assert.equal((await run({ start: 'b2', rows: [[1]] })).calls[1], 'type:"B2\\n"');

// A tool it does not own is passed on, not swallowed.
assert.equal(await sheetsAdapter.execute('click_at', {}, { cdp: true }), null);

console.log('✓ sheets adapter: addressed by cell, refuses rather than pretending');
