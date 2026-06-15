// Generates ChatPanel's PNG icons (16/48/128) with no external dependencies.
// A rounded indigo→violet gradient tile with a white speech bubble.
//
//   node tools/make-icons.mjs
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'assets');
mkdirSync(OUT, { recursive: true });

// --- minimal PNG encoder (RGBA, 8-bit) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- drawing ---
const lerp = (a, b, t) => a + (b - a) * t;
function roundedAlpha(x, y, w, h, r, aa = 1.2) {
  // signed coverage of a rounded rect at pixel (x,y)
  const dx = Math.max(r - x, x - (w - 1 - r), 0);
  const dy = Math.max(r - y, y - (h - 1 - r), 0);
  const d = Math.hypot(dx, dy) - r;
  if (d <= -aa) return 1;
  if (d >= aa) return 0;
  return 1 - (d + aa) / (2 * aa);
}

function render(size) {
  const w = size, h = size;
  const buf = Buffer.alloc(w * h * 4);
  const r = size * 0.22;
  const top = [99, 102, 241]; // indigo
  const bot = [139, 92, 246]; // violet

  // bubble geometry
  const bx = size * 0.2, by = size * 0.22, bw = size * 0.6, bh = size * 0.44, br = size * 0.12;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const tileA = roundedAlpha(x, y, w, h, r);
      const ty = y / (h - 1);
      let R = lerp(top[0], bot[0], ty);
      let G = lerp(top[1], bot[1], ty);
      let B = lerp(top[2], bot[2], ty);

      // white speech bubble
      let bubA = roundedAlpha(x - bx, y - by, bw, bh, br);
      // little tail (triangle) at bottom-left of bubble
      const tailX = bx + bw * 0.28, tailY = by + bh;
      if (y >= tailY - 1 && y < tailY + size * 0.12) {
        const prog = (y - tailY) / (size * 0.12);
        const left = tailX, right = tailX + size * 0.16 * (1 - prog);
        if (x >= left && x <= right) bubA = Math.max(bubA, 1);
      }
      if (bubA > 0) {
        R = lerp(R, 255, bubA);
        G = lerp(G, 255, bubA);
        B = lerp(B, 255, bubA);
      }

      // three dots inside bubble
      if (bubA > 0.9 && size >= 32) {
        const cy = by + bh * 0.42;
        for (let k = -1; k <= 1; k++) {
          const cx = bx + bw * 0.5 + k * bw * 0.22;
          if (Math.hypot(x - cx, y - cy) < size * 0.035) {
            R = lerp(top[0], bot[0], ty); G = lerp(top[1], bot[1], ty); B = lerp(top[2], bot[2], ty);
          }
        }
      }

      buf[i] = R | 0;
      buf[i + 1] = G | 0;
      buf[i + 2] = B | 0;
      buf[i + 3] = Math.round(255 * tileA);
    }
  }
  return buf;
}

// Toolbar / manifest icons: art fills the frame edge-to-edge.
for (const size of [16, 48, 128]) {
  const png = encodePNG(size, size, render(size));
  writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}

// Chrome Web Store listing icon: the store recommends the art occupy ~96x96
// centered in a 128x128 canvas (≈16px transparent padding) so it sits
// consistently in the store grid. This is NOT bundled in the extension zip —
// it's uploaded separately on the Developer Dashboard.
function paddedStoreIcon(canvas, art) {
  const inner = render(art);
  const out = Buffer.alloc(canvas * canvas * 4); // transparent by default
  const off = Math.round((canvas - art) / 2);
  for (let y = 0; y < art; y++) {
    const src = y * art * 4;
    const dst = ((y + off) * canvas + off) * 4;
    inner.copy(out, dst, src, src + art * 4);
  }
  return encodePNG(canvas, canvas, out);
}

const WEBSTORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webstore');
mkdirSync(WEBSTORE, { recursive: true });
const storePng = paddedStoreIcon(128, 96);
writeFileSync(path.join(WEBSTORE, 'icon-128.png'), storePng);
console.log(`wrote webstore/icon-128.png (${storePng.length} bytes)`);
