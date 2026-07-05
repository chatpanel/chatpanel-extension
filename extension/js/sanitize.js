// Unicode de-steganography for text that flows through the privacy boundary.
//
// Invisible and format-control characters are a single vector with three abuses,
// all relevant to a redaction product:
//
//   1. Redaction bypass - splitting a value with zero-width chars (j<ZWSP>o<ZWSP>hn@x.com)
//      hides it from the regex/NER detector, then the model reassembles the real
//      value. The deterministic engine works on text, so the smuggled PII leaks.
//   2. Hidden prompt injection - Unicode Tag characters (U+E0000-E007F) render as
//      nothing but encode a full ASCII instruction the model reads ("ASCII smuggling").
//   3. Fingerprinting / watermarking - steganographic markers injected into a prompt
//      (e.g. a client classifying a custom gateway and encoding a bit into invisible
//      punctuation). A privacy proxy should scrub these - and never emit its own.
//
// We strip the channels that have no legitimate place in plain prompt text, while
// PRESERVING the few legitimate uses (emoji ZWJ/variation sequences, normal accents).
//
// The patterns are BUILT FROM NUMERIC CODE POINTS below - there are deliberately no
// literal invisible characters anywhere in this source (auditable, and fitting for a
// de-steg module). Pure + dependency-free ESM. Call it BEFORE detection so obfuscated
// PII becomes matchable, and on model output before restoration so a token can't be
// split/spoofed with invisibles.

// Code-point ranges (inclusive) per category, by their abuse.
const RANGES = {
  // Unicode Tag block - the ASCII-smuggling channel.
  tags: [[0xE0000, 0xE007F]],
  // Bidi controls - reorder/override visible text to hide reversed instructions.
  bidi: [[0x061C, 0x061C], [0x200E, 0x200F], [0x202A, 0x202E], [0x2066, 0x2069]],
  // Zero-width & assorted invisible format chars: soft hyphen, Hangul/Mongolian
  // fillers, ZWSP, word/invisible joiners, deprecated format controls, BOM/ZWNBSP,
  // interlinear annotation, object replacement.
  zeroWidth: [
    [0x00AD, 0x00AD], [0x115F, 0x1160], [0x180E, 0x180E], [0x200B, 0x200B],
    [0x2060, 0x2064], [0x206A, 0x206F], [0x3164, 0x3164], [0xFEFF, 0xFEFF],
    [0xFFA0, 0xFFA0], [0xFFF9, 0xFFFB], [0xFFFC, 0xFFFC],
  ],
  // Supplementary variation selectors - the byte-smuggling range. Never legit in text.
  supVS: [[0xE0100, 0xE01EF]],
  // Line/paragraph separators - converted to '\n' (kill parser tricks, keep the break).
  lineSep: [[0x2028, 0x2029]],
  // ZWJ/ZWNJ + BMP variation selectors - legit ONLY next to an emoji base, so these
  // are stripped contextually (see ANOMALOUS_JOIN_VS), not unconditionally.
  joinVS: [[0x200C, 0x200D], [0xFE00, 0xFE0F]],
};

const u = (cp) => `\\u{${cp.toString(16).toUpperCase()}}`;
const cls = (ranges) => ranges.map(([a, b]) => (a === b ? u(a) : `${u(a)}-${u(b)}`)).join('');

const TAGS = new RegExp(`[${cls(RANGES.tags)}]`, 'gu');
const BIDI = new RegExp(`[${cls(RANGES.bidi)}]`, 'gu');
const ZERO_WIDTH = new RegExp(`[${cls(RANGES.zeroWidth)}]`, 'gu');
const SUP_VS = new RegExp(`[${cls(RANGES.supVS)}]`, 'gu');
const LINE_SEP = new RegExp(`[${cls(RANGES.lineSep)}]`, 'gu');
// Strip ZWJ/ZWNJ/VS only when NOT preceded by an emoji base (so emoji sequences and
// regional-indicator flags survive); supplementary VS are always stripped.
const ANOMALOUS_JOIN_VS = new RegExp(
  `(?<![\\p{Extended_Pictographic}${u(0x1F1E6)}-${u(0x1F1FF)}])[${cls(RANGES.joinVS)}]|[${cls(RANGES.supVS)}]`,
  'gu',
);
// Runs of combining marks (Zalgo / bit-stuffing). A real stacked diacritic is 1-3
// marks; anything past the cap is signalling, not language.
const COMBINING_RUN = /\p{M}+/gu;

// Cheap boolean for hot paths / UI ("does this contain anything hidden?"). Excludes
// the context-dependent joinVS so legitimate emoji aren't flagged - sanitizeUnicode()
// stays the source of truth for those.
const ANY_HIDDEN = new RegExp(
  `[${cls(RANGES.bidi)}${cls(RANGES.zeroWidth)}]|[${cls(RANGES.tags)}]|[${cls(RANGES.supVS)}]`,
  'u',
);

export function hasHiddenChars(text) {
  return typeof text === 'string' && ANY_HIDDEN.test(text);
}

// sanitizeUnicode(text, opts) -> { clean, removed, findings }
//   clean    - text with the smuggling channels stripped/normalized
//   removed  - total count of stripped/collapsed characters (0 = nothing hidden)
//   findings - per-category counts (only non-zero keys), for transparent reporting
//
// opts.normalize: 'NFC' (default, appearance-preserving) | 'NFKC' (also folds
//   fullwidth/homoglyph compatibility forms - stronger for detection, but rewrites
//   some visible glyphs) | 'none'.
// opts.collapseCombiningOver: max combining marks kept per run (default 4).
export function sanitizeUnicode(text, { normalize = 'NFC', collapseCombiningOver = 4 } = {}) {
  if (typeof text !== 'string' || text === '') return { clean: text ?? '', removed: 0, findings: {} };
  let s = text;
  const findings = {};

  // Strip one category, counting by code point (spread iterates code points, so a
  // supplementary char like a Tag counts as 1, not 2 UTF-16 units).
  const strip = (re, key) => {
    let n = 0;
    s = s.replace(re, (m) => { n += [...m].length; return ''; });
    if (n) findings[key] = n;
  };

  let lineSep = 0;
  s = s.replace(LINE_SEP, () => { lineSep++; return '\n'; });
  if (lineSep) findings.lineSep = lineSep;

  strip(TAGS, 'tags');
  strip(BIDI, 'bidi');
  strip(ZERO_WIDTH, 'zeroWidth');
  strip(ANOMALOUS_JOIN_VS, 'joinersVS');

  // Compose canonically so split/decomposed forms can't dodge the detector.
  if (normalize && normalize !== 'none') {
    try { s = s.normalize(normalize); } catch { /* invalid form name -> skip */ }
  }

  let combining = 0;
  s = s.replace(COMBINING_RUN, (run) => {
    const marks = [...run];
    if (marks.length <= collapseCombiningOver) return run;
    combining += marks.length - collapseCombiningOver;
    return marks.slice(0, collapseCombiningOver).join('');
  });
  if (combining) findings.combining = combining;

  const removed = (findings.tags || 0) + (findings.bidi || 0) + (findings.zeroWidth || 0)
    + (findings.joinersVS || 0) + (findings.combining || 0);
  return { clean: s, removed, findings };
}

// Convenience for the common "just give me clean text" caller.
export function stripHidden(text, opts) {
  return sanitizeUnicode(text, opts).clean;
}

// ── Confusables skeleton ─────────────────────────────────────────────────────
// Fold single-code-point Latin LOOK-ALIKES (Cyrillic / Greek / fullwidth) to their
// ASCII skeleton so a homoglyph-obfuscated value (jоhn@x.com with a Cyrillic 'о')
// becomes matchable by the ASCII regexes. STRICTLY 1:1 per code point — every mapping
// is one char → one char — so a match's indices in the skeleton line up exactly with
// the original text. Use it for DETECTION only and redact the ORIGINAL span, so
// legitimate Cyrillic/Greek/CJK text is never rewritten (only deceptively-Latin
// values that actually match a detector get touched). Built from numeric code points
// (no literal confusables in source, like the rest of this module).
const CONFUSABLE = new Map([
  // Cyrillic lowercase → Latin
  [0x0430, 'a'], [0x0435, 'e'], [0x043E, 'o'], [0x0440, 'p'], [0x0441, 'c'],
  [0x0443, 'y'], [0x0445, 'x'], [0x0455, 's'], [0x0456, 'i'], [0x0458, 'j'],
  [0x04BB, 'h'], [0x043C, 'm'], [0x043D, 'h'], [0x0442, 't'], [0x043A, 'k'],
  // Cyrillic uppercase → Latin
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041A, 'K'], [0x041C, 'M'],
  [0x041D, 'H'], [0x041E, 'O'], [0x0420, 'P'], [0x0421, 'C'], [0x0422, 'T'],
  [0x0425, 'X'], [0x0406, 'I'], [0x0408, 'J'], [0x0405, 'S'],
  // Greek → Latin
  [0x03BF, 'o'], [0x03C1, 'p'], [0x03B1, 'a'], [0x03BD, 'v'], [0x03B9, 'i'],
  [0x0391, 'A'], [0x0392, 'B'], [0x0395, 'E'], [0x0396, 'Z'], [0x0397, 'H'],
  [0x0399, 'I'], [0x039A, 'K'], [0x039C, 'M'], [0x039D, 'N'], [0x039F, 'O'],
  [0x03A1, 'P'], [0x03A4, 'T'], [0x03A5, 'Y'], [0x03A7, 'X'],
]);

export function confusablesSkeleton(text) {
  if (typeof text !== 'string' || text === '') return text ?? '';
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xFF01 && cp <= 0xFF5E) { out += String.fromCharCode(cp - 0xFEE0); continue; } // fullwidth ASCII
    const mapped = CONFUSABLE.get(cp);
    out += mapped != null ? mapped : ch;
  }
  return out;
}

// Exposed for tests / external auditing.
export const SANITIZE_RANGES = RANGES;
export const CONFUSABLE_MAP = CONFUSABLE;
