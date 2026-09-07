// GENERATED — do not edit.
// Source of truth: chatpanel-events/pdf-layout.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A PDF's text items → something a person (or a model) can read.
//
// A PDF does not contain paragraphs. It contains positioned glyph runs: "Introduction" at
// (72, 690), "and this is" at (72, 674), "why" at (140, 674). Every PDF engine — pdf.js in
// a browser, a native renderer on mobile, a CLI extractor on the bridge — hands back that
// same list of runs with the same transform matrix, and every one of them leaves the job of
// turning runs into READING ORDER to the caller. Done naively (join the items with spaces)
// a two-column paper becomes an interleaved ransom note, and every hyphenated line break
// becomes a broken word the model then cannot match against a query.
//
// So the reconstruction lives here — pure, testable, engine-agnostic — and the client
// contributes only the engine that produced the items.
//
// THE ITEM SHAPE (pdf.js `getTextContent().items`, and what other engines are adapted to):
//   { str, transform: [a, b, c, d, x, y], width, height, hasEOL }
// x/y are in PDF user space: y grows UPWARD from the bottom of the page.

/** One text item → the numbers this file reasons about. */
function place(item) {
  const t = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
  return {
    text: String(item?.str ?? ''),
    x: Number(t[4]) || 0,
    y: Number(t[5]) || 0,
    width: Number(item?.width) || 0,
    // The transform's vertical scale is the font size; `height` is often 0 on the items
    // real documents produce, and a zero line height makes every line one paragraph.
    size: Math.abs(Number(t[3])) || Number(item?.height) || 0,
    eol: !!item?.hasEOL,
  };
}

/**
 * Items → lines, by shared baseline.
 *
 * Tolerance is a FRACTION OF THE FONT SIZE, not a fixed number of points: a footnote at 7pt
 * and a heading at 24pt do not agree on what "the same line" means, and a constant that
 * works for body text either splits headings or merges footnotes.
 */
export function linesFromItems(items, { tolerance = 0.5 } = {}) {
  const placed = (Array.isArray(items) ? items : []).map(place).filter((p) => p.text !== '');
  if (!placed.length) return [];
  const lines = [];
  for (const p of placed) {
    const tol = Math.max(1, (p.size || 10) * tolerance);
    // Compare against the most recent line only: items arrive in content-stream order, so a
    // matching baseline further back belongs to an earlier column, not to this line.
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) <= tol) {
      last.items.push(p);
      if (p.size > last.size) last.size = p.size;
    } else {
      lines.push({ y: p.y, size: p.size || 10, items: [p] });
    }
  }
  return lines.map((line) => {
    const sorted = line.items.slice().sort((a, b) => a.x - b.x);
    return {
      y: line.y,
      size: line.size,
      x: sorted[0].x,
      right: Math.max(...sorted.map((i) => i.x + i.width)),
      text: joinRun(sorted, line.size),
    };
  });
}

/**
 * Glyph runs on one line → a string.
 *
 * PDFs encode a space either as a space character or as a horizontal gap with nothing in
 * it, and which one you get depends on the producer. Joining on the character alone loses
 * every word break in documents from the second kind; joining every item with a space puts
 * one inside every kerned pair in documents from the first.
 */
function joinRun(sorted, size) {
  let out = '';
  let prevRight = null;
  for (const item of sorted) {
    if (prevRight !== null) {
      const gap = item.x - prevRight;
      const needsSpace = gap > (size || 10) * 0.2;
      if (needsSpace && !/\s$/.test(out) && !/^\s/.test(item.text)) out += ' ';
    }
    out += item.text;
    prevRight = item.x + item.width;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Lines → columns, in reading order.
 *
 * Two-column layouts are the case that makes naive extraction useless, and they are most of
 * academic and technical PDF reading. A column is detected as a vertical band that lines
 * cluster into; if the page is one column (or the split is not clean) this returns the lines
 * unchanged rather than inventing a split, because a wrong split is worse than none.
 */
export function orderLines(lines, { pageWidth = 0 } = {}) {
  const list = (Array.isArray(lines) ? lines : []).slice();
  if (list.length < 6) return list.sort((a, b) => b.y - a.y);
  const width = pageWidth || Math.max(...list.map((l) => l.right));
  const mid = width / 2;
  const left = list.filter((l) => l.right <= mid * 1.05);
  const right = list.filter((l) => l.x >= mid * 0.95);
  const spanning = list.filter((l) => !left.includes(l) && !right.includes(l));
  // A real two-column page has substantial text on BOTH sides and few lines crossing the
  // gutter. Anything else is a single column with a stray indent or a wide table.
  const twoColumn = left.length >= 3 && right.length >= 3
    && spanning.length <= list.length * 0.2;
  if (!twoColumn) return list.sort((a, b) => b.y - a.y);
  const byY = (a, b) => b.y - a.y;
  // Headers and footers that span the gutter keep their vertical position relative to the
  // column they sit above; sorting them into the left column first is the conventional and
  // least-surprising reading order.
  return [...spanning.filter((l) => l.y > Math.max(...left.map((x) => x.y), 0)).sort(byY),
    ...left.sort(byY), ...right.sort(byY),
    ...spanning.filter((l) => l.y <= Math.max(...left.map((x) => x.y), 0)).sort(byY)];
}

/**
 * Lines → paragraphs.
 *
 * A new paragraph is a bigger-than-usual vertical gap, a first-line indent, or a line that
 * ended well short of the right margin. A word broken across lines with a hyphen is put
 * back together — otherwise "distri-\nbuted" never matches a search for "distributed", and
 * the model reads a word that does not exist.
 *
 * MARGINS ARE MEASURED PER BLOCK, NOT PER PAGE. On a two-column page every line in the left
 * column ends far short of the page's right edge, so a page-wide margin makes every single
 * line "short" and therefore its own paragraph — which is what a first attempt at this did.
 * Lines that share a left edge are one block; a change of block is itself a paragraph break,
 * because it is a change of column or of indentation level.
 */
export function paragraphsFromLines(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter((l) => l && l.text);
  if (!list.length) return [];

  // A block is a run of lines that share a left edge AND a font size. The size half is not
  // cosmetic: a 14pt heading is wider than the 10pt lines under it, so a block containing
  // both takes its right margin from the heading — and then every body line is "short" and
  // every one of them becomes its own paragraph.
  const blocks = [];
  for (const line of list) {
    const cur = blocks[blocks.length - 1];
    const prev = cur?.lines[cur.lines.length - 1];
    const sameEdge = cur && Math.abs(cur.lines[0].x - line.x) <= (line.size || 10) * 1.5;
    const sameSize = prev && Math.abs((prev.size || 10) - (line.size || 10)) <= (prev.size || 10) * 0.15;
    if (sameEdge && sameSize) cur.lines.push(line);
    else blocks.push({ lines: [line] });
  }

  const paras = [];
  for (const block of blocks) {
    const rows = block.lines;
    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push(Math.abs(rows[i - 1].y - rows[i].y));
    // A LOW percentile, not the median: in a three-line block whose second gap IS the
    // paragraph break, the median sits between the line gap and the break and neither is
    // then unusual. The common gap is a line gap, and it lives at the bottom of the range.
    const typical = percentile(gaps, 0.3) || (rows[0].size || 10) * 1.2;
    const rightEdge = Math.max(...rows.map((l) => l.right));
    const leftEdge = Math.min(...rows.map((l) => l.x));

    let cur = '';
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i];
      const prev = rows[i - 1];
      const gap = prev ? Math.abs(prev.y - line.y) : 0;
      const indented = line.x > leftEdge + (line.size || 10) * 0.8;
      const prevShort = prev ? prev.right < rightEdge - (line.size || 10) * 3 : false;
      if (cur && (gap > typical * 1.5 || indented || prevShort)) {
        paras.push(cur);
        cur = line.text;
      } else if (!cur) {
        cur = line.text;
      } else if (/(\w)-$/.test(cur)) {
        cur = cur.replace(/-$/, '') + line.text.replace(/^\s+/, '');
      } else {
        cur += ' ' + line.text;
      }
    }
    if (cur) paras.push(cur);
  }
  return paras.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Nearest-rank percentile of the positive values, 0 when there are none. */
function percentile(nums, q) {
  const list = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.min(list.length - 1, Math.floor(q * (list.length - 1)))];
}

/** One page's items → its text. */
export function pageTextFromItems(items, { pageWidth = 0, ...opts } = {}) {
  const lines = linesFromItems(items, opts);
  return paragraphsFromLines(orderLines(lines, { pageWidth })).join('\n\n');
}

export const PDF_MAX_CHARS = 200_000;

/**
 * Is this PDF a picture of a document rather than a document?
 *
 * A scanned page has a text layer of nothing, and every extractor answers with an empty
 * string. Returning that silently is the worst outcome: the user sees a summary of nothing
 * and no explanation. Detecting it lets the caller say "this needs OCR" — which is an
 * answer, where an empty attachment is a mystery.
 */
export function looksScanned(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return false;
  const chars = list.reduce((n, p) => n + String(p?.text || '').length, 0);
  return chars < list.length * 40;
}

/**
 * Pages → the document a caller attaches.
 *
 * Page markers are kept because a citation into a 90-page PDF is worth nothing without one,
 * and because they are the only thing that tells a model the document has an order at all.
 */
export function buildPdfDocument({ meta = {}, pages = [], maxChars = PDF_MAX_CHARS } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const head = [];
  if (meta.title) head.push(`# ${meta.title}`);
  const facts = [];
  if (meta.author) facts.push(`Author: ${meta.author}`);
  if (list.length) facts.push(`Pages: ${meta.pageCount || list.length}`);
  if (meta.url) facts.push(`URL: ${meta.url}`);
  if (facts.length) head.push(facts.join(' · '));

  const body = list
    .map((p) => {
      const text = String(p?.text || '').trim();
      return text ? `[page ${p.page}]\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  let text = head.length ? `${head.join('\n\n')}\n\n${body}` : body;
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n…[PDF truncated at ${maxChars} characters]`;
    truncated = true;
  }
  return {
    title: meta.title || 'PDF',
    url: meta.url || '',
    pageCount: meta.pageCount || list.length,
    pagesRead: list.length,
    scanned: looksScanned(list),
    truncated,
    text,
    chars: text.length,
  };
}
