// A minimal, dependency-free PDF writer — enough to test text extraction against a REAL
// document rather than against a mock of one.
//
// A fixture .pdf checked into the repo would be an opaque binary nobody could adjust; this
// is 40 lines that produce exactly the layout a test wants to assert on (two columns, a
// hyphenated line break, a page with no text at all).

const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * @param pages  [[{ x, y, size, text }]] — one array of positioned runs per page, in PDF
 *               user space (y grows upward from the bottom of the page).
 */
export function makePdf(pages, { width = 612, height = 792 } = {}) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const catalog = add(null);        // 1, patched below once Pages has an id
  const pagesObj = add(null);       // 2
  const font = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));

  const kids = [];
  for (const runs of pages) {
    const content = ['BT'];
    for (const r of runs) {
      content.push(`/F1 ${r.size || 10} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escape(r.text)}) Tj`);
    }
    content.push('ET');
    const stream = Buffer.from(content.join('\n'));
    const contentId = add(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream'),
    ]));
    kids.push(add(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`,
    )));
  }
  objects[catalog - 1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objects[pagesObj - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
  );

  const chunks = [Buffer.from('%PDF-1.4\n')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets.push(offset);
    offset += buf.length;
    chunks.push(buf);
  });
  const xref = offset;
  const table = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`];
  chunks.push(Buffer.from(table.join('')));
  return new Uint8Array(Buffer.concat(chunks));
}
