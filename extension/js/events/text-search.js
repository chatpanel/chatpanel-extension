// GENERATED — do not edit.
// Source of truth: chatpanel-events/text-search.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Find, find-all and replace over a plain-text document.
//
// Every editing surface ChatPanel will ever ship needs this same answer: given a document,
// a query and a few toggles, WHERE are the matches and what does the document look like
// after a replace. The Notes editor asks it twice already — once for the `<textarea>` and
// once for the CodeMirror surface — and a mobile notes client would ask it a third time.
// Three implementations of "what counts as a whole word" become three different answers,
// so the rule lives here once and the surfaces only decide how to PAINT the ranges.
//
// Pure over strings: no DOM, no editor, no document object. That is what makes it testable
// without a browser and reusable from a `<textarea>`, a CM6 EditorState, a SwiftUI
// TextEditor, or the gateway rewriting a note server-side.

/** Escape a literal string so it can be embedded in a RegExp verbatim. */
function escapeLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the RegExp for a query, or explain why it can't be built.
 *
 * Returns a RESULT rather than throwing because an invalid regex is a normal thing for a
 * user to type mid-keystroke ("(" on the way to "(a|b)") — the find bar wants to show a
 * quiet hint, not catch an exception on every input event.
 *
 * Whole-word uses lookarounds instead of `\b` because `\b` is defined against word
 * characters: `\bfoo(\b` never matches, since there is no word boundary after `(`. The
 * lookarounds ask the question that was actually meant — "not glued to a word character".
 */
export function compileQuery(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  const q = String(query ?? '');
  if (!q) return { ok: false, error: 'empty' };
  let source = regex ? q : escapeLiteral(q);
  if (wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`;
  try {
    return { ok: true, re: new RegExp(source, caseSensitive ? 'gu' : 'giu') };
  } catch {
    // `u` mode rejects patterns older engines tolerate (e.g. a bare `\d` inside a class is
    // fine, but `\-` is not). Retry without it so a user's plain regex still works.
    try {
      return { ok: true, re: new RegExp(source, caseSensitive ? 'g' : 'gi') };
    } catch (e) {
      return { ok: false, error: e?.message || 'invalid regular expression' };
    }
  }
}

/**
 * Every match of `query` in `text`, in document order.
 *
 * Zero-length matches (a user types `a*`, or `^` in multiline) would spin the loop forever
 * on a global regex, because `lastIndex` never advances on its own. They are skipped and
 * the cursor is nudged, so an empty-matching pattern degrades to "no matches" instead of
 * hanging the editor — a find bar runs this on every keystroke.
 */
export function findMatches(text, query, opts = {}) {
  const compiled = compileQuery(query, opts);
  if (!compiled.ok) return [];
  const doc = String(text ?? '');
  const { re } = compiled;
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1) });
    if (out.length > MAX_MATCHES) break;
  }
  return out;
}

/** A find bar that highlights 100k ranges janks the editor; past this we stop counting. */
export const MAX_MATCHES = 10000;

/**
 * Which match should "Find next / previous" land on, given where the caret is.
 *
 * Next takes the first match STARTING at or after the caret; previous takes the last one
 * ENDING at or before it. The asymmetry is deliberate: with the caret sitting inside the
 * current match — which is exactly where "find next" just left it — a `start < cursor`
 * rule for previous selects that same match again and the button appears dead.
 *
 * Both wrap, because a find bar that dead-ends at the last match makes the user scroll back
 * to the top by hand. Returns -1 only when there is nothing to land on at all.
 */
export function matchIndexFor(matches, cursor = 0, dir = 1) {
  if (!matches?.length) return -1;
  if (dir >= 0) {
    const i = matches.findIndex((m) => m.start >= cursor);
    return i === -1 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) if (matches[i].end <= cursor) return i;
  return matches.length - 1;
}

/**
 * Expand `$1` / `$&` / `$$` in a replacement against one match.
 *
 * Only in regex mode. In literal mode a `$` the user typed is a dollar sign they want in
 * the document — silently eating it as a group reference would corrupt the text and there
 * would be no way to type a literal `$` at all.
 */
export function expandReplacement(replacement, match, regex = false) {
  const r = String(replacement ?? '');
  if (!regex) return r;
  return r.replace(/\$(\$|&|\d{1,2})/g, (whole, token) => {
    if (token === '$') return '$';
    if (token === '&') return match.text;
    const g = match.groups?.[Number(token) - 1];
    return g === undefined ? whole : g; // an unmatched group stays literal, like String.replace
  });
}

/** Replace one already-located match. Returns the new text and the caret to leave behind. */
export function replaceMatch(text, match, replacement, { regex = false } = {}) {
  const doc = String(text ?? '');
  if (!match) return { text: doc, cursor: 0, changed: false };
  const insert = expandReplacement(replacement, match, regex);
  return {
    text: doc.slice(0, match.start) + insert + doc.slice(match.end),
    cursor: match.start + insert.length,
    changed: true,
  };
}

/**
 * Replace every match in one pass.
 *
 * Applied right-to-left so each splice leaves the offsets of the matches still to come
 * untouched — replacing left-to-right would shift every subsequent range by the length
 * delta and quietly corrupt the document whenever the replacement is a different length
 * from the match.
 */
export function replaceAll(text, query, replacement, opts = {}) {
  const matches = findMatches(text, query, opts);
  let doc = String(text ?? '');
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i];
    doc = doc.slice(0, m.start) + expandReplacement(replacement, m, opts.regex) + doc.slice(m.end);
  }
  return { text: doc, count: matches.length };
}

/**
 * Replace only inside a selected range — "Replace All in selection".
 *
 * The range is searched as a substring and the offsets are rebased, so the same matching
 * rules apply; a caller must not have to reason about anchoring the pattern.
 */
export function replaceAllInRange(text, query, replacement, from, to, opts = {}) {
  const doc = String(text ?? '');
  const a = Math.max(0, Math.min(from, to, doc.length));
  const b = Math.min(doc.length, Math.max(from, to, 0));
  const { text: replaced, count } = replaceAll(doc.slice(a, b), query, replacement, opts);
  return { text: doc.slice(0, a) + replaced + doc.slice(b), count };
}
