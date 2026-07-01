// Deterministic, model-free copy-edit pass for the Editor co-writer. It catches common
// MECHANICAL mistakes — doubled words, runs of spaces, space-before-punctuation, the
// lone lowercase "i" — so the Editor can offer those fixes for FREE. The model is only
// called when this pass finds nothing (the "deterministic pass before spending a token"
// guardrail). Pure, dependency-free, unit-tested, portable across modules.
//
// Returns minimal edits [{ start, end, before, after }] over `text`, same shape as the
// word-diff edits, non-overlapping and left-to-right.

export function lintText(text = '') {
  const src = String(text);
  const raw = [];
  const add = (start, end, after) => { if (after !== src.slice(start, end)) raw.push({ start, end, before: src.slice(start, end), after }); };
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

  // 4) standalone lowercase "i" → "I" (skip the "i.e."/"i.g." abbreviation).
  const iRe = /(^|[ \t(])i(?=[ \t.,;:!?)]|$)/g;
  while ((m = iRe.exec(src))) {
    const at = m.index + m[1].length;
    if (src[at + 1] === '.' && /[a-z]/i.test(src[at + 2] || '')) continue; // i.e., i.g.
    add(at, at + 1, 'I');
  }

  // Sort left-to-right and drop any edit that overlaps one already kept.
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
