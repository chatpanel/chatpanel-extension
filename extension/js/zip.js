// Minimal, dependency-free ZIP writer + single-entry reader.
//
// The extension's CSP (`script-src 'self'`) forbids pulling a zip library from a
// CDN, so we hand-roll the format. Compression uses the browser-native
// CompressionStream/DecompressionStream('deflate-raw') (Chrome 80+), so there's
// no bundled deflate either. Enough of the spec to round-trip our own archives:
// store/deflate entries, a central directory, and an end-of-central-directory
// record. Not a general-purpose unzip (no zip64, no encryption, no multi-disk).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// files: [{ name: string, data: string | Uint8Array }] → Blob (application/zip).
export async function makeZip(files) {
  const enc = new TextEncoder();
  const local = []; // Uint8Array chunks for the local-header section
  const central = []; // central-directory records
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(raw);
    const comp = await deflateRaw(raw);

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header sig
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0x0800, true); // flags: bit 11 = filename is UTF-8
    ldv.setUint16(8, 8, true); // method: deflate
    ldv.setUint16(10, 0, true); // mod time
    ldv.setUint16(12, 0x21, true); // mod date (1980-01-01)
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, comp.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true); // extra len
    lh.set(nameBytes, 30);
    local.push(lh, comp);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central dir header sig
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0x0800, true); // flags: bit 11 = filename is UTF-8
    cdv.setUint16(10, 8, true); // method
    cdv.setUint16(12, 0, true); // time
    cdv.setUint16(14, 0x21, true); // date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, comp.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += lh.length + comp.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); // EOCD sig
  edv.setUint16(8, files.length, true); // entries on this disk
  edv.setUint16(10, files.length, true); // total entries
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true); // central dir offset
  return new Blob([...local, ...central, eocd], { type: 'application/zip' });
}

// Extract one entry by exact name from a zip ArrayBuffer → string, or null if
// absent. Reads the central directory (located via the EOCD record) so it works
// regardless of entry order.
export async function readZipEntry(arrayBuffer, wantName) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central dir offset
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wantName) continue;
    // The local header repeats name/extra lengths (may differ from central).
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(start, start + compSize);
    const raw = method === 0 ? comp : await inflateRaw(comp);
    return dec.decode(raw);
  }
  return null;
}
