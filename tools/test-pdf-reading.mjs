// A PDF TAB WAS THE ONE PAGE CHATPANEL COULD NOT READ, AND SAID SO.
//
// Chrome renders PDFs in a built-in viewer that is itself an extension, and Chrome forbids
// extensions from scripting other extensions' pages — so captureTab, read_page and
// inspect_page all failed on a PDF, each with a message naming PDFs as impossible. The
// viewer is impossible. The DOCUMENT is a URL we are allowed to fetch, and this file pins
// that: real bytes, the committed engine, the shared reconstruction, and the wiring that
// reaches them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './fixtures/make-pdf.mjs';
import { isPdfBytes, scannedPdfMessage, pdfTextFromBytes, PDF_MAX_PAGES } from '../extension/js/pdf-text.js';
import { looksLikePdfUrl } from '../extension/js/source-kind.js';
import { PAGE_AUTOMATION_SYSTEM } from '../extension/js/page-tools.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// --------------------------------------------------------------------------
// What is a PDF
// --------------------------------------------------------------------------

assert.equal(looksLikePdfUrl('https://example.com/papers/x.pdf'), true);
assert.equal(looksLikePdfUrl('https://example.com/viewer?file=https://x.test/y.pdf'), true);
assert.equal(looksLikePdfUrl('https://example.com/article'), false);

// THE EXTENSION IS A HINT, THE BYTES DECIDE. Plenty of PDFs come from `/download?id=8823`,
// and plenty of `.pdf` links are viewer front-ends that return HTML.
assert.equal(isPdfBytes(makePdf([[{ x: 60, y: 700, text: 'hi' }]])), true);
assert.equal(isPdfBytes(new TextEncoder().encode('<html><body>not a pdf</body></html>')), false);
assert.equal(isPdfBytes(new Uint8Array(0)), false);
// The header may legally sit up to 1024 bytes in, and files from real tools do.
const offset = new Uint8Array(600 + 8);
offset.set(new TextEncoder().encode('%PDF-1.7'), 600);
assert.equal(isPdfBytes(offset), true);

// --------------------------------------------------------------------------
// A real document, through the engine that actually ships
// --------------------------------------------------------------------------

// Two columns and a word hyphenated across a line break — the two things that make naive
// extraction produce an interleaved ransom note full of words that do not exist.
const PAPER = makePdf([
  [
    { x: 60, y: 720, size: 14, text: 'On Distributed Racks' },
    { x: 60, y: 700, size: 10, text: 'We describe a distri-' },
    { x: 60, y: 686, size: 10, text: 'buted approach that' },
    { x: 60, y: 672, size: 10, text: 'scales well.' },
    { x: 320, y: 700, size: 10, text: 'Prior work has been' },
    { x: 320, y: 686, size: 10, text: 'limited to one node' },
    { x: 320, y: 672, size: 10, text: 'per rack.' },
  ],
  [{ x: 60, y: 700, size: 10, text: 'The second page says this.' }],
]);

const doc = await pdfTextFromBytes(PAPER, { url: 'https://example.com/papers/racks-2026.pdf' });

assert.equal(doc.pageCount, 2);
assert.equal(doc.pagesRead, 2);
assert.equal(doc.scanned, false);
assert.equal(doc.chars, doc.text.length);

// The columns read in order, not interleaved.
assert.match(doc.text, /We describe a distributed approach that scales well\./,
  'the hyphenated line break was not rejoined — a search for "distributed" would miss it');
assert.match(doc.text, /Prior work has been limited to one node per rack\./);
assert.ok(doc.text.indexOf('We describe') < doc.text.indexOf('Prior work'),
  'the two columns were interleaved line by line');

// A citation into a long PDF is worth nothing without a page number.
assert.match(doc.text, /\[page 1\]/);
assert.match(doc.text, /\[page 2\]\nThe second page says this\./);

// This PDF has no Title, so the filename is the name — and it is the filename made readable,
// not the raw slug.
assert.match(doc.text, /^# racks 2026/, `unexpected header: ${doc.text.slice(0, 40)}`);
assert.match(doc.text, /URL: https:\/\/example\.com\/papers\/racks-2026\.pdf/);

// A long document is cut with a statement of what was cut, not silently.
const capped = await pdfTextFromBytes(PAPER, { maxChars: 80 });
assert.equal(capped.truncated, true);
assert.match(capped.text, /PDF truncated at 80 characters/);
// And a 900-page standard is answered with its first pages, not with a spinner.
const onePage = await pdfTextFromBytes(PAPER, { maxPages: 1 });
assert.equal(onePage.pagesRead, 1);
assert.equal(onePage.truncatedPages, 1);
assert.ok(PDF_MAX_PAGES > 1);

// --------------------------------------------------------------------------
// A scan is an answer, not an empty attachment
// --------------------------------------------------------------------------

// The silent failure this whole feature could have shipped with: a scanned PDF has no text
// layer, extracts to nothing, and the model summarises nothing while nobody is told why.
const scan = await pdfTextFromBytes(makePdf([[], []]), { url: 'https://example.com/scan.pdf' });
assert.equal(scan.scanned, true);
assert.match(scannedPdfMessage(scan), /no text layer/);
assert.match(scannedPdfMessage(scan), /OCR/);
assert.match(scannedPdfMessage(scan), /2 pages/);

// --------------------------------------------------------------------------
// The wiring
// --------------------------------------------------------------------------

const context = read('../extension/js/context.js');
const pageTools = read('../extension/js/page-tools.js');

// The engine is well over a megabyte. If it is ever static-imported, every panel open pays.
for (const [name, src] of [['context.js', context], ['page-tools.js', pageTools]]) {
  assert.doesNotMatch(src, /^import[^\n]*from '\.\/pdf-text\.js'/m,
    `${name} static-imports the PDF engine`);
  assert.match(src, /await import\('\.\/pdf-text\.js'\)/, `${name} never reaches the PDF layer`);
}

// A PDF must be caught BEFORE res.text(): decoding binary as UTF-8 is lossy and consumes the
// body, so the bytes cannot be recovered afterwards. Attaching a pasted PDF link used to
// produce 30,000 characters of mojibake labelled as the page.
const captureUrl = context.slice(context.indexOf('export async function captureUrl'));
const pdfBranch = captureUrl.indexOf('application\\/pdf');
const textCall = captureUrl.indexOf('await res.text()');
assert.ok(pdfBranch > 0 && pdfBranch < textCall, 'captureUrl reads the body as text before checking for a PDF');

// read_page on a PDF tab returns the document rather than "this page can't be automated".
const readPage = pageTools.slice(pageTools.indexOf("if (name === 'read_page') {"));
assert.match(readPage.slice(0, 2200), /tabPdf\(tabId/, 'read_page still gives up on a PDF tab');
// And the message that remains must no longer claim a PDF is unreadable — it is only
// un-clickable.
assert.doesNotMatch(pageTools, /it’s a browser page, the Web Store, a PDF/,
  'the blocked-page message still tells the model PDFs cannot be read');
assert.match(pageTools, /A PDF tab cannot be CLICKED, but read_page does read its text/);
assert.match(PAGE_AUTOMATION_SYSTEM, /ON A PDF TAB read_page returns the DOCUMENT/);
assert.match(PAGE_AUTOMATION_SYSTEM, /Cite the page number/);

// --------------------------------------------------------------------------
// The vendored engine
// --------------------------------------------------------------------------

// MV3 forbids eval and new Function; the build script checks, and so does this, because the
// check that only runs on the machine that did the vendoring is the check that gets skipped.
// `new Function(` needs its paren — the worker defines `new FunctionBasedShading(…)`.
for (const file of ['../extension/js/vendor/pdf.js', '../extension/js/vendor/pdf.worker.js']) {
  const src = read(file);
  assert.doesNotMatch(src, /\beval\s*\(/, `${file} contains eval() — MV3 will refuse it`);
  assert.doesNotMatch(src, /new\s+Function\s*\(/, `${file} contains new Function()`);
  assert.match(src, /^\/\* Vendored pdf\.js /, `${file} is missing its generated banner`);
}
const stamped = JSON.parse(read('../extension/js/vendor/pdf.version.json'));
assert.equal(stamped.name, 'pdfjs-dist');
assert.equal(stamped.license, 'Apache-2.0');
assert.match(stamped.version, /^\d+\.\d+\.\d+$/);

const { fallbacksFor, PDF_SUGGESTIONS } = await import('../extension/js/suggestions.js');
assert.deepEqual(fallbacksFor({ url: 'https://example.com/x.pdf' }), PDF_SUGGESTIONS);
assert.match(PDF_SUGGESTIONS[0], /Summarize this PDF/);

console.log(`✓ PDF reading: real bytes through the committed engine (pdf.js ${stamped.version}), columns ordered, scans named`);
