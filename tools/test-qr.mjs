// The QR encoder, checked against a real scanner rather than against itself.
//
// A wrong QR is worse than no QR: it looks finished, and it fails silently on someone else's
// phone at the exact moment they are trying to pair. Two bugs in this file's first draft were
// invisible to inspection and to any self-consistency check —
//   1. the two copies of the format information were placed transposed;
//   2. alignment patterns were skipped when their centre landed on the timing line, which
//      first happens at version 7, so v1–v6 were perfect and everything above was unreadable.
// Both were found by decoding the output. So: golden matrices captured from output that Apple
// Vision decoded, plus a live round-trip whenever a decoder is available.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { qrMatrix, qrSvg } from '../extension/js/qr.js';

const fingerprint = (m) => createHash('sha256')
  .update(m.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('')).digest('hex').slice(0, 16);

// ── golden matrices — every one of these was decoded by Vision before being pinned ──
const GOLDEN = [
  ['https://t.me/TheChatPanel_bot?start=999916', 'M', 29, '05ea636c6156828a'],
  ['ChatPanel', 'L', 21, '33c327066201e158'],
  ['https://t.me/a_bot?start=000001', 'H', 33, '5f02418528792fc6'],
  ['A'.repeat(145), 'L', 45, '50ad56667abc7078'],
];
for (const [text, level, size, hash] of GOLDEN) {
  const m = qrMatrix(text, { level, quiet: 0 });
  assert.equal(m.length, size, `${level} "${text.slice(0, 16)}" should be ${size}×${size}`);
  assert.equal(fingerprint(m), hash,
    `the matrix for ${level} "${text.slice(0, 16)}" changed — re-verify with a scanner before repinning`);
}

// ── structure the spec fixes, whatever the payload ──
{
  const m = qrMatrix('https://t.me/TheChatPanel_bot?start=999916', { level: 'M', quiet: 0 });
  const n = m.length;
  const finderAt = (r0, c0) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(m[r0 + r][c0 + c], ring || core, `finder at ${r0},${c0} wrong at ${r},${c}`);
      }
    }
  };
  finderAt(0, 0); finderAt(0, n - 7); finderAt(n - 7, 0);
  for (let i = 8; i < n - 8; i += 1) {
    assert.equal(m[6][i], i % 2 === 0, `horizontal timing wrong at ${i}`);
    assert.equal(m[i][6], i % 2 === 0, `vertical timing wrong at ${i}`);
  }
  assert.equal(m[n - 8][8], true, 'the always-dark module must be dark');
}

// ── the quiet zone is real space, not decoration: a scanner needs it ──
{
  const bare = qrMatrix('ChatPanel', { level: 'L', quiet: 0 });
  const padded = qrMatrix('ChatPanel', { level: 'L', quiet: 4 });
  assert.equal(padded.length, bare.length + 8);
  for (let i = 0; i < padded.length; i += 1) {
    assert.equal(padded[0][i], false, 'the top quiet row must be clear');
    assert.equal(padded[i][0], false, 'the left quiet column must be clear');
  }
}

// ── refuse rather than render something unscannable ──
assert.throws(() => qrMatrix('x'.repeat(300), { level: 'H' }), /too long/,
  'a payload past version 10 must throw, not silently truncate');
assert.throws(() => qrMatrix('x', { level: 'Z' }), /unknown EC level/);

// ── the SVG a settings page actually embeds ──
{
  const svg = qrSvg('https://t.me/TheChatPanel_bot?start=999916', { size: 180, label: 'Pair this phone' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /shape-rendering="crispEdges"/, 'a QR must not be antialiased into mush');
  assert.match(svg, /<rect [^>]*fill="#fff"/, 'a white plate — a dark-mode card would otherwise invert it');
  assert.match(svg, /aria-label="Pair this phone"/);
  assert.ok(!svg.includes('<script'), 'no script in generated markup');
}

// ── live round-trip, when a decoder exists (macOS/Vision). CI just skips it. ──
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(matrix, scale = 8) {
  const n = matrix.length * scale;
  const raw = Buffer.alloc((n + 1) * n);
  for (let y = 0; y < n; y += 1) {
    raw[y * (n + 1)] = 0;
    for (let x = 0; x < n; x += 1) raw[y * (n + 1) + 1 + x] = matrix[(y / scale) | 0][(x / scale) | 0] ? 0 : 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const decoder = process.env.CHATPANEL_QR_DECODER;
if (decoder && existsSync(decoder)) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-qr-'));
  let checked = 0;
  for (const level of ['L', 'M', 'Q', 'H']) {
    for (const len of [15, 50, 90, 145]) {
      const text = `https://t.me/TheChatPanel_bot?start=${'A'.repeat(len)}`;
      let m;
      try { m = qrMatrix(text, { level }); } catch { continue; } // past version 10 at this level
      const file = join(dir, `q-${level}-${len}.png`);
      writeFileSync(file, png(m));
      const got = execFileSync(decoder, [file], { encoding: 'utf8' }).trim().split('\n')[0];
      assert.equal(got, text, `EC ${level}, ${len} chars: the scanner read something else`);
      checked += 1;
    }
  }
  console.log(`qr tests passed (${GOLDEN.length} golden, ${checked} scanner round-trips)`);
} else {
  console.log(`qr tests passed (${GOLDEN.length} golden matrices; set CHATPANEL_QR_DECODER to also round-trip through a real scanner)`);
}
