// GENERATED — do not edit.
// Source of truth: chatpanel-events/markdown-authoring.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The editing gestures that make writing markdown feel like writing, not like typing syntax.
//
// Outline, list continuation, format toggles and document stats are all the same shape of
// problem: given the document text and where the caret is, what should the text and the
// caret become. None of them needs a DOM — which is precisely why they do not belong in a
// `<textarea>` keydown handler, where Notes would have had to write them twice (once for
// the classic surface, once for CodeMirror) and a mobile client a third time.
//
// Every function here is pure and returns an EDIT ({ text, selStart, selEnd }) rather than
// mutating a surface, so the caller only has to apply a range and set a selection.

/** ``` or ~~~ opening/closing a fenced block. Headings inside a fence are code, not structure. */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * The heading structure of a markdown document.
 *
 * Fenced code is skipped: a `# comment` inside a shell example is not a section, and an
 * outline that jumps into code is worse than no outline. Setext headings (`===` / `---`
 * underlines) are recognised too, because notes pasted from other tools use them.
 */
export function outlineOf(markdown) {
  const doc = String(markdown ?? '');
  const lines = doc.split('\n');
  const out = [];
  let offset = 0;
  let fence = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceHit = line.match(FENCE_RE);
    if (fenceHit) {
      if (!fence) fence = fenceHit[1][0];
      else if (fenceHit[1][0] === fence) fence = '';
      offset += line.length + 1;
      continue;
    }
    if (!fence) {
      const atx = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      const next = lines[i + 1];
      const setext = !atx && line.trim() && next && next.match(/^\s{0,3}(=+|-+)\s*$/);
      if (atx) {
        out.push({ level: atx[1].length, text: atx[2].trim(), line: i, start: offset, end: offset + line.length });
      } else if (setext) {
        out.push({ level: setext[1][0] === '=' ? 1 : 2, text: line.trim(), line: i, start: offset, end: offset + line.length });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** `  - [ ] item` → its indent, marker, checkbox and content. Null when the line is not a list item. */
export function parseListItem(line) {
  const m = String(line ?? '').match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
  if (!m) return null;
  return {
    indent: m[1],
    marker: m[2],
    ordered: /\d/.test(m[2]),
    checkbox: m[3] ? m[3].trimEnd() : '',
    content: m[4],
  };
}

function lineBoundsAt(doc, pos) {
  const start = doc.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const nl = doc.indexOf('\n', pos);
  return { start, end: nl === -1 ? doc.length : nl };
}

/**
 * What Enter should do inside a list.
 *
 * Continues the list with the same indent and marker (incrementing an ordered one), and
 * ENDS it when the item is empty — pressing Enter twice is how everyone expects to leave a
 * list, and without that rule the user is left deleting a bullet they did not ask for.
 *
 * Returns null when the caret is not in a list item, so the caller can let the key fall
 * through to the surface's own newline handling.
 */
export function continueList(text, cursor) {
  const doc = String(text ?? '');
  const pos = Math.max(0, Math.min(cursor, doc.length));
  const { start, end } = lineBoundsAt(doc, pos);
  const item = parseListItem(doc.slice(start, end));
  if (!item) return null;

  // Empty item → the user is done with the list. Clear the marker instead of adding another.
  if (!item.content.trim()) {
    return { text: `${doc.slice(0, start)}\n${doc.slice(end)}`, selStart: start + 1, selEnd: start + 1 };
  }

  const marker = item.ordered
    ? `${(parseInt(item.marker, 10) || 0) + 1}${item.marker.slice(-1)}`
    : item.marker;
  // A checked box never continues as checked — the next item is new work, not done work.
  const box = item.checkbox ? '[ ] ' : '';
  const insert = `\n${item.indent}${marker} ${box}`;
  const caret = pos + insert.length;
  return { text: doc.slice(0, pos) + insert + doc.slice(pos), selStart: caret, selEnd: caret };
}

/**
 * Indent or outdent every list item the selection touches.
 *
 * Whole lines, not the caret's line alone, so Tab on a multi-line selection does the
 * obvious thing. Outdent removes at most one level and never eats non-space characters.
 */
export function indentSelection(text, selStart, selEnd, dir = 1, unit = '  ') {
  const doc = String(text ?? '');
  const from = lineBoundsAt(doc, Math.min(selStart, selEnd)).start;
  const to = lineBoundsAt(doc, Math.max(selStart, selEnd)).end;
  const lines = doc.slice(from, to).split('\n');
  let firstDelta = 0;
  let total = 0;
  const shifted = lines.map((line, i) => {
    let next = line;
    if (dir >= 0) {
      if (line.trim()) next = unit + line;
    } else {
      const m = line.match(new RegExp(`^(${unit}|\\t|\\s{1,${unit.length}})`));
      if (m) next = line.slice(m[0].length);
    }
    const delta = next.length - line.length;
    if (i === 0) firstDelta = delta;
    total += delta;
    return next;
  });
  return {
    text: doc.slice(0, from) + shifted.join('\n') + doc.slice(to),
    selStart: Math.max(from, Math.min(selStart, selEnd) + firstDelta),
    selEnd: Math.max(from, Math.max(selStart, selEnd) + total),
  };
}

/** Inline formats, as the pair of markers that wrap the selection. */
const WRAPS = {
  bold: '**',
  italic: '*',
  code: '`',
  strike: '~~',
  highlight: '==',
};

/**
 * Toggle an inline format around the selection.
 *
 * Toggle, not apply: selecting already-bold text and pressing ⌘B must UNbold it, both when
 * the markers are inside the selection and when they sit just outside it (which is what a
 * double-click on the word gives you). Getting only the first case right is the usual bug,
 * and it leaves users with `****text****`.
 */
export function toggleWrap(text, selStart, selEnd, kind) {
  const doc = String(text ?? '');
  const mark = WRAPS[kind];
  if (!mark) return null;
  let a = Math.min(selStart, selEnd);
  let b = Math.max(selStart, selEnd);

  // Nothing selected: grow to the word under the caret so ⌘B on a word just works.
  if (a === b) {
    const { start, end } = lineBoundsAt(doc, a);
    const line = doc.slice(start, end);
    let ws = a - start;
    let we = a - start;
    while (ws > 0 && /\w/.test(line[ws - 1])) ws -= 1;
    while (we < line.length && /\w/.test(line[we])) we += 1;
    if (we > ws) { a = start + ws; b = start + we; }
  }

  const inner = doc.slice(a, b);
  // Markers inside the selection.
  if (inner.length >= mark.length * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
    const stripped = inner.slice(mark.length, -mark.length);
    return { text: doc.slice(0, a) + stripped + doc.slice(b), selStart: a, selEnd: a + stripped.length };
  }
  // Markers hugging the selection.
  if (doc.slice(a - mark.length, a) === mark && doc.slice(b, b + mark.length) === mark) {
    return {
      text: doc.slice(0, a - mark.length) + inner + doc.slice(b + mark.length),
      selStart: a - mark.length,
      selEnd: b - mark.length,
    };
  }
  return {
    text: doc.slice(0, a) + mark + inner + mark + doc.slice(b),
    selStart: a + mark.length,
    selEnd: b + mark.length,
  };
}

/**
 * Toggle a line-level prefix (quote, bullet, number, checkbox) over the selected lines.
 *
 * Uniformly: if EVERY touched line already has the prefix the gesture removes it, otherwise
 * it adds it to all of them. A per-line toggle on a mixed selection scrambles the block.
 */
export function toggleLinePrefix(text, selStart, selEnd, kind) {
  const doc = String(text ?? '');
  const from = lineBoundsAt(doc, Math.min(selStart, selEnd)).start;
  const to = lineBoundsAt(doc, Math.max(selStart, selEnd)).end;
  const lines = doc.slice(from, to).split('\n');
  const RE = {
    quote: /^(\s*)>\s?/,
    bullet: /^(\s*)[-*+]\s+/,
    number: /^(\s*)\d{1,9}[.)]\s+/,
    task: /^(\s*)[-*+]\s+\[[ xX]\]\s+/,
  }[kind];
  if (!RE) return null;
  const on = lines.every((l) => !l.trim() || RE.test(l));
  let n = 0;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    if (on) return line.replace(RE, '$1');
    const indent = line.match(/^\s*/)[0];
    const body = line.slice(indent.length).replace(/^(>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/, '');
    n += 1;
    const prefix = { quote: '> ', bullet: '- ', number: `${n}. `, task: '- [ ] ' }[kind];
    return indent + prefix + body;
  });
  const body = next.join('\n');
  return { text: doc.slice(0, from) + body + doc.slice(to), selStart: from, selEnd: from + body.length };
}

/** Toggle `- [ ]` ⇄ `- [x]` on the line at `cursor`. Null when that line has no checkbox. */
export function toggleTask(text, cursor) {
  const doc = String(text ?? '');
  const { start, end } = lineBoundsAt(doc, Math.max(0, Math.min(cursor, doc.length)));
  const line = doc.slice(start, end);
  const m = line.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s*)/);
  if (!m) return null;
  const flipped = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}${line.slice(m[0].length)}`;
  return { text: doc.slice(0, start) + flipped + doc.slice(end), selStart: cursor, selEnd: cursor };
}

/**
 * Wrap the selection as a markdown link.
 *
 * When the selection already looks like a URL it becomes the TARGET with an empty label,
 * otherwise it becomes the label — which is what the user meant in each case, and saves
 * retyping the half they already have. The caret lands on the empty half.
 */
export function toggleLink(text, selStart, selEnd, url = '') {
  const doc = String(text ?? '');
  const a = Math.min(selStart, selEnd);
  const b = Math.max(selStart, selEnd);
  const inner = doc.slice(a, b);
  const looksUrl = /^(https?:\/\/|mailto:)\S+$/i.test(inner.trim());
  const label = looksUrl ? '' : inner;
  const target = url || (looksUrl ? inner.trim() : '');
  const out = `[${label}](${target})`;
  const caret = looksUrl ? a + 1 : a + out.length - 1;
  return { text: doc.slice(0, a) + out + doc.slice(b), selStart: caret, selEnd: caret + (looksUrl ? 0 : 0) };
}

/** Words in a string, counting a run of any non-whitespace as one word. */
function countWords(s) {
  const t = String(s ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Word / character counts and a reading estimate.
 *
 * 200 wpm is the usual prose figure. Reading time is reported in whole minutes with a floor
 * of one, because "0 min read" is noise and a sub-minute note does not need a number at all.
 */
export function docStats(text, { wpm = 200 } = {}) {
  const doc = String(text ?? '');
  const words = countWords(doc);
  return {
    words,
    chars: doc.length,
    charsNoSpaces: doc.replace(/\s/g, '').length,
    lines: doc ? doc.split('\n').length : 0,
    readingMinutes: words ? Math.max(1, Math.round(words / wpm)) : 0,
  };
}

/** Stats for the selection when there is one, otherwise for the whole document. */
export function selectionStats(text, selStart, selEnd, opts) {
  const doc = String(text ?? '');
  const a = Math.min(selStart, selEnd);
  const b = Math.max(selStart, selEnd);
  return a === b
    ? { ...docStats(doc, opts), selection: false }
    : { ...docStats(doc.slice(a, b), opts), selection: true };
}
