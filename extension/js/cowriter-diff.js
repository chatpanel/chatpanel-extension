// Co-writer diff — the testable heart of the Editor co-writer (and any future
// suggest-a-minimal-fix agent). Given the user's ORIGINAL text and a copy-editor's
// CORRECTED text, it produces MINIMAL, precise edits with character offsets — so the
// UI can offer one-click "teh → the" fixes instead of replacing whole paragraphs.
//
// Pure + dependency-free on purpose: no DOM, no model, no imports. That makes it
// portable (extension / gateway / bridge can all reuse it) and fully unit-testable.

// Non-whitespace tokens with their char offsets in the source string.
function words(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// Matched index pairs between two word arrays (longest common subsequence).
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

// [{ start, end, before, after }] — contiguous word-run replacements/insertions/
// deletions, offsets into `original`. An insertion has start===end (before ''); a
// deletion has after ''.
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
      // Pure insertion — attach the whitespace so the new word isn't glued to its neighbour.
      if (aFrom < A.length) { start = end = A[aFrom].start; after = `${insWords.join(' ')} `; }
      else { start = end = A.length ? A[A.length - 1].end : 0; after = `${A.length ? ' ' : ''}${insWords.join(' ')}`; }
    } else if (bFrom === bTo) {
      // Pure deletion — absorb one adjacent whitespace so no double/leading space remains.
      start = A[aFrom].start;
      if (aTo < A.length) end = A[aTo].start;
      else { end = A[aTo - 1].end; if (aFrom > 0) start = A[aFrom - 1].end; }
      after = '';
    } else {
      // Replacement — swap the word run, surrounding whitespace preserved.
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

// Keep only SMALL corrections (typo / grammar / punctuation): drop big rewrites and
// large content insertions so the Editor never restructures the user's prose.
export function filterTypoEdits(edits, { maxWords = 5, maxLen = 48 } = {}) {
  return (edits || []).filter((e) => {
    if (e.before === e.after) return false;
    if (e.before.length > maxLen || e.after.length > maxLen) return false;
    const bw = e.before ? e.before.split(/\s+/).length : 0;
    const aw = e.after ? e.after.split(/\s+/).length : 0;
    if (Math.max(bw, aw) > maxWords) return false;
    // A pure insertion is only "small" if it's a word or two (a missing "the", a comma).
    if (!e.before && aw > 2) return false;
    return true;
  });
}

// Stable identity for a suggestion, so a dismissed fix isn't re-offered.
export function editKey(edit) {
  return `${edit.before}␟${edit.after}`;
}

// Apply non-overlapping edits to text (right-to-left, so earlier offsets stay valid).
export function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.after + out.slice(e.end);
  }
  return out;
}
