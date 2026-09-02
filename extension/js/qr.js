// QR encoding, byte mode, versions 1–10 — enough for a pairing link and nothing more.
//
// WHY THIS IS HERE RATHER THAN A DEPENDENCY. The pairing link is the one step of channel
// setup that happens on a DIFFERENT device: you read it on a laptop and you have to get it
// into a phone. A link you cannot click is a link you retype, and a 6-digit code that expires
// in ten minutes is exactly the wrong thing to retype. So the panel draws it as a QR.
//
// It cannot come from a CDN: the extension's CSP forbids remote script, and a QR of a pairing
// code is precisely the payload you do not want a third-party script near. It is ~200 lines of
// well-specified arithmetic, so it is written out rather than pulled in.
//
// Scope is deliberately small. Byte mode only (a URL is not alphanumeric-mode text), versions
// 1–10 (a t.me link with a six-digit code is version 3–4 at EC M), all four EC levels. Anything
// larger throws rather than silently producing a code no scanner will read.
//
// Output is a boolean matrix, and an SVG built from it. No canvas: an <svg> scales to any card
// width, prints, and survives a theme change, where a bitmap has to pick a size and a colour.

// ── GF(256), primitive polynomial 0x11D ─────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords: ∏(x − α^i). */
function generator(degree) {
  let poly = [1];
  for (let d = 0; d < degree; d += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i += 1) {
      next[i] ^= poly[i];
      next[i + 1] ^= mul(poly[i], EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder — the EC codewords appended to one block. */
function ecCodewords(data, ecLen) {
  const gen = generator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i += 1) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ── Version tables (1–10) ───────────────────────────────────────────────────────
// Total codewords, then per EC level: [ecPerBlock, blocks1, data1, blocks2, data2].
// Every row satisfies blocks1*data1 + blocks2*data2 + ecPerBlock*(blocks1+blocks2) === total,
// which assertTables() below checks at module load — a typo here produces an unreadable code.
const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const BLOCKS = {
  L: [0, [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
  M: [0, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
  Q: [0, [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
  H: [0, [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
};
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const VERSION_BITS = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

(function assertTables() {
  for (const level of Object.keys(BLOCKS)) {
    for (let v = 1; v <= MAX_VERSION; v += 1) {
      const [ec, b1, d1, b2, d2] = BLOCKS[level][v];
      const sum = b1 * d1 + b2 * d2 + ec * (b1 + b2);
      if (sum !== TOTAL[v]) throw new Error(`QR table wrong at ${level}${v}: ${sum} ≠ ${TOTAL[v]}`);
    }
  }
}());

const dataCapacity = (v, level) => {
  const [, b1, d1, b2, d2] = BLOCKS[level][v];
  return b1 * d1 + b2 * d2;
};
// v1 has no remainder bits, v2–v6 have 7, v7–v13 none again.
const remainderBits = (v) => (v >= 2 && v <= 6 ? 7 : 0);

// ── Bit stream ──────────────────────────────────────────────────────────────────
function bitWriter() {
  const bits = [];
  return {
    push(value, len) { for (let i = len - 1; i >= 0; i -= 1) bits.push((value >> i) & 1); },
    get length() { return bits.length; },
    bytes() {
      const out = new Uint8Array(Math.ceil(bits.length / 8));
      bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
      return out;
    },
  };
}

/** Smallest version that fits `byteLen` at this EC level, or 0 when it does not fit at all. */
function pickVersion(byteLen, level) {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + byteLen * 8 <= dataCapacity(v, level) * 8) return v;
  }
  return 0;
}

function encodeData(bytes, version, level) {
  const capacity = dataCapacity(version, level);
  const w = bitWriter();
  w.push(0b0100, 4);                               // byte mode
  w.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) w.push(b, 8);
  w.push(0, Math.min(4, capacity * 8 - w.length)); // terminator
  while (w.length % 8) w.push(0, 1);
  const out = Array.from(w.bytes());
  for (let i = 0; out.length < capacity; i += 1) out.push(i % 2 ? 0x11 : 0xec);
  return out;
}

/** Split into blocks, error-correct each, then interleave — the order a scanner expects. */
function interleave(data, version, level) {
  const [ecLen, b1, d1, b2, d2] = BLOCKS[level][version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1 + b2; i += 1) {
    const size = i < b1 ? d1 : d2;
    const chunk = data.slice(at, at + size);
    at += size;
    blocks.push({ data: chunk, ec: ecCodewords(chunk, ecLen) });
  }
  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ── Matrix ──────────────────────────────────────────────────────────────────────
const FUNCTION = 2; // a third state while building: "reserved, not data"

function blankMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const on = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6
          || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        m[rr][cc] = on ? 1 : 0;
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {           // timing
    const bit = i % 2 === 0 ? 1 : 0;
    m[6][i] = bit;
    m[i][6] = bit;
  }
  // Alignment patterns sit at every pair of centre coordinates EXCEPT the three that would
  // land on a finder. Skipping by "is this cell already taken?" looks equivalent and is not:
  // from version 7 there is a middle centre (22, 24, 26, 28) that falls ON the timing line, so
  // that test skipped a pattern the spec requires and every v7+ code came out unscannable.
  // Alignment legitimately overwrites timing where the two cross.
  const centres = ALIGN[version];
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const r = centres[i];
      const c = centres[j];
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
        }
      }
    }
  }
  m[size - 8][8] = 1;                               // the always-dark module

  for (let i = 0; i < 9; i += 1) {                  // reserve format areas
    if (m[8][i] === null) m[8][i] = FUNCTION;
    if (m[i][8] === null) m[i][8] = FUNCTION;
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = FUNCTION;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = FUNCTION;
  }
  if (version >= 7) {                               // reserve version areas
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        m[size - 11 + j][i] = FUNCTION;
        m[i][size - 11 + j] = FUNCTION;
      }
    }
  }
  return m;
}

/** Zigzag placement, two columns at a time from the right, skipping the vertical timing line. */
function placeData(m, codewords, version) {
  const size = m.length;
  const bits = [];
  for (const b of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((b >> i) & 1);
  for (let i = 0; i < remainderBits(version); i += 1) bits.push(0);

  let at = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;                    // column 6 is timing
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m[row][col] !== null) continue;
        m[row][col] = at < bits.length ? bits[at] : 0;
        at += 1;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH(15,5) format information, XOR-masked with 0x5412 as the spec requires. */
function formatBits(level, mask) {
  const data = (EC_BITS[level] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

// The 15 format bits appear twice, and the two copies are NOT transposes of each other —
// copy 1 runs DOWN column 8 then LEFT along row 8 around the top-left finder, while copy 2
// runs RIGHT along row 8 and DOWN column 8 by the other two. Getting that backwards produces
// a code that looks right to a human and is unreadable to every scanner, which is exactly
// what the round-trip test in tools/test-qr.mjs exists to catch.
function applyFormat(m, level, mask) {
  const size = m.length;
  const bits = formatBits(level, mask);
  const bit = (i) => (bits >> i) & 1;
  // Copy 1 — around the top-left finder.
  for (let i = 0; i <= 5; i += 1) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i <= 14; i += 1) m[8][14 - i] = bit(i);
  // Copy 2 — split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i += 1) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = 1; // the always-dark module, restated after the bits land
}

function applyVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = VERSION_BITS[version];
  for (let i = 0; i < 18; i += 1) {
    const b = (bits >> i) & 1;
    m[Math.floor(i / 3)][size - 11 + (i % 3)] = b;
    m[size - 11 + (i % 3)][Math.floor(i / 3)] = b;
  }
}

/** The four penalty rules. Lower is better; the spec picks the mask that scores lowest. */
function penalty(m) {
  const size = m.length;
  let score = 0;
  const run = (get) => {
    for (let a = 0; a < size; a += 1) {
      let last = -1;
      let len = 0;
      for (let b = 0; b < size; b += 1) {
        const v = get(a, b);
        if (v === last) { len += 1; } else { last = v; len = 1; }
        if (len === 5) score += 3; else if (len > 5) score += 1;
      }
    }
  };
  run((r, c) => m[r][c]);
  run((c, r) => m[r][c]);

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  const bad = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const badRev = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const looks = (get, a, b) => bad.every((x, i) => get(a, b + i) === x) || badRev.every((x, i) => get(a, b + i) === x);
  for (let a = 0; a < size; a += 1) {
    for (let b = 0; b + 10 < size; b += 1) {
      if (looks((r, c) => m[r][c], a, b)) score += 40;
      if (looks((c, r) => m[r][c], a, b)) score += 40;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark += 1;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix of booleans (true = dark), including the quiet zone only if
 * asked. Throws when the text does not fit version 10 — a caller must not render a code that
 * no scanner will read.
 */
export function qrMatrix(text, { level = 'M', quiet = 4 } = {}) {
  if (!BLOCKS[level]) throw new Error(`unknown EC level ${level}`);
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const version = pickVersion(bytes.length, level);
  if (!version) throw new Error(`too long for a version-${MAX_VERSION} QR (${bytes.length} bytes at EC ${level})`);

  const codewords = interleave(encodeData(bytes, version, level), version, level);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = blankMatrix(version);
    const reserved = m.map((row) => row.map((v) => v !== null));
    placeData(m, codewords, version);
    for (let r = 0; r < m.length; r += 1) {
      for (let c = 0; c < m.length; c += 1) {
        if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
      }
    }
    applyVersion(m, version);
    applyFormat(m, level, mask);
    const grid = m.map((row) => row.map((v) => v === 1));
    const score = penalty(grid.map((row) => row.map((v) => (v ? 1 : 0))));
    if (!best || score < best.score) best = { score, grid, mask, version };
  }

  if (!quiet) return best.grid;
  const size = best.grid.length + quiet * 2;
  const padded = Array.from({ length: size }, () => new Array(size).fill(false));
  best.grid.forEach((row, r) => row.forEach((v, c) => { padded[r + quiet][c + quiet] = v; }));
  return padded;
}

/**
 * The same thing as an <svg> string. `currentColor` so it inherits the card's text colour and
 * stays legible when the theme flips; a white plate underneath because a scanner needs the
 * contrast and a dark-mode card would otherwise invert it.
 */
export function qrSvg(text, { level = 'M', quiet = 4, size = 180, label = 'QR code' } = {}) {
  const m = qrMatrix(text, { level, quiet });
  const n = m.length;
  let path = '';
  m.forEach((row, r) => row.forEach((v, c) => { if (v) path += `M${c} ${r}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" `
    + `role="img" aria-label="${String(label).replace(/[<>&"]/g, '')}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
