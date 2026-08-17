// Google Sheets, addressed by CELL instead of by pixel.
//
// A spreadsheet is a canvas: no DOM for the grid, no accessibility tree, and cell A1 has
// no stable coordinate. Three runs tried to fill one by clicking — (20,40), then (10,10),
// then a hand-built sequence — and each time hit the menu bar, typed into nothing, and
// reported success. The model was not guessing badly; it was being asked the wrong
// question. "Where is A1 on screen" has no reliable answer. "Put this value in A1" does.
//
// Sheets already exposes the answer: the NAME BOX is real DOM, and typing a reference into
// it jumps the selection to that cell exactly. From there a tab is the next column and a
// newline is the next row — so an entire block is one navigation plus one typed string,
// which is precisely how a person would paste it.
//
// A PLUGIN, not another entry in a hardcoded list (P15). It declares what it recognises and
// what it offers; the registry does the rest.

import { defineAdapter } from '../events/adapters.js';

export const SHEETS_TOOL = 'sheet_write';

/** A1-style reference — the thing the name box understands. */
const REF_RE = /^[A-Za-z]{1,3}[1-9]\d{0,6}$/;

const spec = {
  name: SHEETS_TOOL,
  description:
    'Write a block of cells into the active Google Sheet by CELL REFERENCE. Give `start` '
    + '(e.g. "A1") and `rows` as a 2-D array; values are written left-to-right, top-to-bottom '
    + 'from that cell. Formulas work — start them with "=". This is EXACT: never click or '
    + 'type coordinates to fill a spreadsheet, because a cell has no reliable pixel position. '
    + 'Example: {"start":"A1","rows":[["Multiplier","Result"],["2 x 1",2],["2 x 2",4]]}.',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Top-left cell to write from, e.g. "A1".' },
      rows: {
        type: 'array',
        description: 'Rows of values; each row is an array of cell values (numbers, text, or "=FORMULA").',
        items: { type: 'array', items: {} },
      },
    },
    required: ['start', 'rows'],
  },
};

/**
 * Find the name box and report where to click it.
 *
 * Runs in the page because only the page knows; returns coordinates because only CDP can
 * deliver a trusted click, which Sheets requires — synthetic events are ignored by it.
 */
function locateNameBox() {
  const candidates = [
    '#t-name-box',
    'input.waffle-name-box',
    '[aria-label="Name box (Ctrl + J)"]',
    '[aria-label^="Name box"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    const r = el?.getBoundingClientRect?.();
    if (r && r.width > 0 && r.height > 0) {
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sel };
    }
  }
  return null;
}

/** `[["a","b"],[1,2]]` → "a\tb\n1\t2" — tabs move a column, newlines move a row. */
export function rowsToKeystrokes(rows) {
  return (rows || [])
    .map((row) => (Array.isArray(row) ? row : [row])
      .map((v) => (v == null ? '' : String(v)))
      .join('\t'))
    .join('\n');
}

export const sheetsAdapter = defineAdapter({
  id: 'google-sheets',
  label: 'Google Sheets',
  priority: 10,
  matches: (url) => /^https:\/\/docs\.google\.com\/spreadsheets\//.test(String(url || '')),
  toolSpecs: () => [spec],
  guidance: () => (
    'This page is Google Sheets. Write values with `sheet_write` by CELL REFERENCE — one '
    + 'call for the whole block. Do NOT click_at or type_text to fill cells: a cell has no '
    + 'reliable pixel position, and clicking the toolbar by mistake looks identical to '
    + 'success. Formulas are allowed as values (start with "=").'
  ),

  /**
   * @param ctx  { tabId, cdp } — the platform pieces, injected rather than imported, so the
   *             contract stays runnable outside a browser extension.
   */
  async execute(name, input, ctx) {
    if (name !== SHEETS_TOOL) return null;
    const start = String(input?.start || '').trim().toUpperCase();
    const rows = input?.rows;
    if (!REF_RE.test(start)) {
      return { ok: false, error: `start must be a cell reference like "A1" (got "${input?.start}").` };
    }
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, error: 'rows must be a non-empty array of arrays, e.g. [["Header"],[1],[2]].' };
    }
    if (!ctx?.cdp) {
      // Sheets ignores synthetic events, so saying so plainly beats appearing to work.
      return { ok: false, error: 'Writing to Google Sheets needs High-reliability page control (trusted events) — turn it on in Settings → page control.' };
    }

    const box = await ctx.script(locateNameBox);
    if (!box) {
      return { ok: false, error: 'Could not find the Sheets name box — is the spreadsheet fully loaded?' };
    }

    // Navigate by NAME, not by pixel: the only click here is on a real DOM element whose
    // position the page just told us.
    await ctx.click(box.x, box.y);
    await ctx.type(`${start}\n`);
    await ctx.type(rowsToKeystrokes(rows));
    // A trailing Enter commits the final cell. Without it the last value sits in edit mode
    // and shows as raw text — the exact failure the spreadsheet guidance warns about.
    await ctx.press('Enter');

    const cells = rows.reduce((n, r) => n + (Array.isArray(r) ? r.length : 1), 0);
    return { ok: true, wrote: cells, rows: rows.length, from: start };
  },
});
