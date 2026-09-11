// GENERATED — do not edit.
// Source of truth: chatpanel-events/cowriter.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The co-writer's two deterministic halves: what is mechanically wrong with a paragraph, and
// what the SMALLEST change is that fixes a sentence.
//
// A co-writer that replaces a paragraph with its own version is a rewriter, and people do not
// want their prose rewritten — they want the doubled word caught. Everything here exists to
// keep a suggestion small enough to accept with one click and small enough to be obviously
// right when you look at it.
//
// THE DETERMINISTIC PASS RUNS FIRST, AND OFTEN ENDS IT. `lintText` catches the mechanical
// mistakes — doubled words, double spaces, a space before a comma, the lone lowercase "i" —
// for free, so a token is spent only on text that is already mechanically clean. That order
// is the difference between a co-writer that idles at zero cost and one that bills for
// noticing "the the".
//
// Both halves were `cowriter-lint.js` and `cowriter-diff.js` in the extension, written pure
// and dependency-free from the start and explicitly noted there as portable. They are here so
// the second and third clients inherit them rather than copy them.

// ── the deterministic pass ──────────────────────────────────────────────────────────────

/**
 * Mechanical mistakes in `text`, as minimal edits.
 *
 * Returns `[{ start, end, before, after }]` — the same shape `wordDiff` produces, so a client
 * renders a lint fix and a model fix with one component — non-overlapping and left-to-right.
 */
export function lintText(text = '') {
  const src = String(text);
  const raw = [];
  const add = (start, end, after) => {
    if (after !== src.slice(start, end)) raw.push({ start, end, before: src.slice(start, end), after });
  };
  let m;

  // 1) doubled word: "the the" → "the" (case-insensitive, same word).
  const dup = /\b(\w+)(\s+)\1\b/gi;
  while ((m = dup.exec(src))) add(m.index, m.index + m[0].length, m[1]);

  // 2) a run of 2+ spaces between visible chars → a single space.
  const runs = /(\S)( {2,})(\S)/g;
  while ((m = runs.exec(src))) { const s = m.index + 1; add(s, s + m[2].length, ' '); runs.lastIndex = s + 1; }

  // 3) whitespace before sentence punctuation: "word ," → "word,".
  const sp = /(\S)(\s+)([,.;:!?])/g;
  while ((m = sp.exec(src))) add(m.index + 1, m.index + m[0].length, m[3]);

  // 4) standalone lowercase "i" → "I" (skipping the "i.e." abbreviation).
  const iRe = /(^|[ \t(])i(?=[ \t.,;:!?)]|$)/g;
  while ((m = iRe.exec(src))) {
    const at = m.index + m[1].length;
    if (src[at + 1] === '.' && /[a-z]/i.test(src[at + 2] || '')) continue; // i.e., i.g.
    add(at, at + 1, 'I');
  }

  // Sort left-to-right and drop any edit overlapping one already kept: two fixes over the
  // same characters cannot both be applied, and applying one invalidates the other's offsets.
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let lastEnd = -1;
  for (const e of raw) {
    if (e.start < lastEnd) continue;
    out.push(e);
    lastEnd = e.end;
  }
  return out;
}

// ── the minimal diff ────────────────────────────────────────────────────────────────────

/** Non-whitespace tokens with their char offsets in the source string. */
function words(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Matched index pairs between two word arrays (longest common subsequence). */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].w === b[j].w ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].w === b[j].w) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Minimal edits turning `original` into `corrected`, with offsets into `original`.
 *
 * Word-run replacements, insertions (start === end, before '') and deletions (after ''). The
 * whitespace handling is the fiddly half and the reason this is one tested function rather
 * than an idea each client implements: an insertion carries a space so the new word is not
 * glued to its neighbour, and a deletion absorbs one adjacent space so it leaves neither a
 * double space nor a leading one.
 */
export function wordDiff(original, corrected) {
  const A = words(original);
  const B = words(corrected);
  const matches = lcsPairs(A, B);
  const edits = [];
  const push = (aFrom, aTo, bFrom, bTo) => {
    if (aFrom === aTo && bFrom === bTo) return;
    const insWords = B.slice(bFrom, bTo).map((x) => x.w);
    let start;
    let end;
    let after;
    if (aFrom === aTo) {
      if (aFrom < A.length) { start = A[aFrom].start; end = start; after = `${insWords.join(' ')} `; }
      else { start = A.length ? A[A.length - 1].end : 0; end = start; after = `${A.length ? ' ' : ''}${insWords.join(' ')}`; }
    } else if (bFrom === bTo) {
      start = A[aFrom].start;
      if (aTo < A.length) end = A[aTo].start;
      else { end = A[aTo - 1].end; if (aFrom > 0) start = A[aFrom - 1].end; }
      after = '';
    } else {
      start = A[aFrom].start;
      end = A[aTo - 1].end;
      after = insWords.join(' ');
    }
    edits.push({ start, end, before: original.slice(start, end), after });
  };
  let ai = 0;
  let bi = 0;
  for (const [am, bm] of matches) {
    if (am > ai || bm > bi) push(ai, am, bi, bm);
    ai = am + 1;
    bi = bm + 1;
  }
  if (ai < A.length || bi < B.length) push(ai, A.length, bi, B.length);
  return edits;
}

/**
 * Keep only SMALL corrections — a typo, a comma, a missing "the".
 *
 * Without this the co-writer restructures prose: ask a model to "fix the mistakes" in a
 * paragraph and it will happily return a better paragraph, which arrives here as one enormous
 * edit and is offered as a one-click "fix". A suggestion nobody can check at a glance is not
 * a suggestion, so anything large is dropped rather than shown.
 */
export function filterTypoEdits(edits, { maxWords = 5, maxLen = 48 } = {}) {
  return (edits || []).filter((e) => {
    if (e.before === e.after) return false;
    if (e.before.length > maxLen || e.after.length > maxLen) return false;
    const bw = e.before ? e.before.split(/\s+/).length : 0;
    const aw = e.after ? e.after.split(/\s+/).length : 0;
    if (Math.max(bw, aw) > maxWords) return false;
    // A pure insertion is only "small" if it is a word or two (a missing "the", a comma).
    if (!e.before && aw > 2) return false;
    return true;
  });
}

/** Stable identity for a suggestion, so a fix the user dismissed is not offered again. */
export function editKey(edit) {
  return `${edit.before}␟${edit.after}`;
}

/** Apply non-overlapping edits right-to-left, so earlier offsets stay valid as it goes. */
export function applyEdits(text, edits) {
  let out = String(text);
  for (const e of [...(edits || [])].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.after + out.slice(e.end);
  }
  return out;
}

/**
 * The instruction a co-writing model is given, and the guardrail inside it.
 *
 * It is told to return the corrected text and NOTHING else, because the answer is diffed
 * against the original rather than read: a preamble becomes a spurious insertion at offset 0,
 * offered to the user as a "fix" that pastes "Sure, here is the corrected text:" into their
 * note.
 */
export const COWRITER_SYSTEM = 'You are a meticulous copy editor. Fix ONLY spelling, grammar, punctuation and obvious word mistakes in the text. Do NOT rewrite, rephrase, restructure, shorten or improve the style, and do not add or remove content. Preserve the markdown exactly. Output ONLY the corrected text.';
export const COWRITER_TEMPERATURE = 0;
