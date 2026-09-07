// Reading a PDF — the browser half.
//
// WHY THIS HAS TO EXIST AT ALL. Chrome renders PDFs in a built-in viewer that is itself an
// extension, and Chrome forbids extensions from scripting other extensions' pages. So every
// text path in this codebase — captureTab, read_page, inspect_page — fails on a PDF tab, and
// has always failed with a message explaining that it cannot be done. It can: what cannot be
// done is READING THE VIEWER. The bytes are fetchable, and the user is looking at a URL we
// are allowed to request.
//
// WHY pdf.js AND NOT SOMETHING SMALLER. A PDF is a compressed object graph with its own font
// encodings; getting text out means inflating streams, tokenising content streams and mapping
// glyph codes back through a font's CMap. There is no small correct version of that. pdf.js is
// the reference implementation, it runs in a browser, it needs no eval (MV3 forbids it), and
// it is what every other browser tool uses. It is vendored — bundled once by
// tools/build-pdf.mjs and committed — because this extension ships no bundler and CI does not
// install.
//
// WHY IT IS NOT ON ANY IMPORT PATH. The engine is well over a megabyte. It is reached through
// `await import()` from here, and this module is itself only reached after
// `looksLikePdfUrl` (js/source-kind.js) or the magic bytes have said the effort is warranted.
//
// The reconstruction — runs to lines to columns to paragraphs — is NOT here. It is
// js/events/pdf-layout.js (@chatpanel/events): pure, engine-agnostic, and the part a mobile
// app with a native PDF renderer would need exactly as much as this one does.

import { pageTextFromItems, buildPdfDocument, PDF_MAX_CHARS } from './events/pdf-layout.js';
import { isBlockedHost as isBlockedNetHost } from './net.js';

/** Pages read from one document, unless a caller says otherwise. */
export const PDF_MAX_PAGES = 80;

/**
 * `%PDF-` at the top, which is what actually decides.
 *
 * The extension is a hint and a bad one in both directions: plenty of PDFs are served from
 * `/download?id=8823` with no extension, and plenty of `.pdf?` links are viewer front-ends
 * that return HTML. The spec allows the header to sit up to 1024 bytes in, and real files
 * produced by real tools do.
 */
export function isPdfBytes(buffer) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer?.buffer || []);
  const window = bytes.subarray(0, 1029);
  for (let i = 0; i + 5 <= window.length; i++) {
    if (window[i] === 0x25 && window[i + 1] === 0x50 && window[i + 2] === 0x44
      && window[i + 3] === 0x46 && window[i + 4] === 0x2d) return true; // %PDF-
  }
  return false;
}

let enginePromise = null;

/**
 * The vendored pdf.js, loaded once.
 *
 * The worker is a same-origin extension file, which is what makes this CSP-legal: MV3 allows
 * `script-src 'self'`, and pdf.js needs no eval. Parsing on a worker rather than the panel's
 * own thread is not an optimisation — a 200-page document parsed inline freezes the UI for
 * seconds, and the panel is the thing the user is waiting in.
 */
async function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const pdfjs = await import('./vendor/pdf.js');
      // Resolved from THIS module's own URL rather than `chrome.runtime.getURL`: inside the
      // extension the two are the same chrome-extension:// path, and outside it — a test
      // harness in Node — only this one resolves at all. pdf.js otherwise guesses at a
      // sibling `pdf.worker.mjs` that the vendored tree does not have.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.js', import.meta.url).href;
      return pdfjs;
    })().catch((e) => {
      enginePromise = null; // a failed load must not poison every later attempt
      throw e;
    });
  }
  return enginePromise;
}

/**
 * PDF bytes → a readable document.
 *
 * `maxPages` is a real limit, not a formality: a 900-page standard costs minutes to parse and
 * cannot fit in a context window anyway, and the honest answer is the first N pages plus a
 * statement of what was left out — not a spinner that never ends.
 */
export async function pdfTextFromBytes(bytes, {
  url = '', maxPages = PDF_MAX_PAGES, maxChars = PDF_MAX_CHARS, password = '',
} = {}) {
  const pdfjs = await engine();
  const task = pdfjs.getDocument({
    // ALWAYS A COPY. pdf.js TRANSFERS this buffer to its worker, which detaches the
    // caller's array — a second read of the same bytes then fails with a DataCloneError
    // from deep inside the library, naming nothing the caller recognises. One copy of the
    // file is a cheap price for the caller keeping what they passed in.
    data: new Uint8Array(bytes),
    password,
    // MV3 forbids eval outright, and no font rendering happens here — we want the text layer
    // and nothing else, so every optional subsystem stays off.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const pageCount = doc.numPages;
    const pages = [];
    for (let n = 1; n <= Math.min(pageCount, maxPages); n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        pages.push({ page: n, text: pageTextFromItems(content.items, { pageWidth: viewport.width }) });
      } finally {
        page.cleanup();
      }
    }
    const info = meta?.info || {};
    const built = buildPdfDocument({
      meta: {
        // A PDF's own Title is frequently the LaTeX job name or "Microsoft Word - draft3.doc",
        // so the URL's filename is a better name than a bad title but a worse one than a good
        // title. Prefer the document's, fall back to the file.
        title: String(info.Title || '').trim() || filenameOf(url),
        author: String(info.Author || '').trim(),
        pageCount,
        url,
      },
      pages,
      maxChars,
    });
    return { ...built, truncatedPages: pageCount > pages.length ? pageCount - pages.length : 0 };
  } finally {
    // The LOADING TASK owns the worker and the document — `doc.destroy` does not exist.
    // Without this the worker holds the whole document for the life of the panel, and reading
    // a dozen PDFs in a session is a dozen documents' worth of memory that never comes back.
    await task.destroy().catch(() => {});
  }
}

function filenameOf(url) {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(name).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Fetch a PDF and read it. Returns null when the URL is not a PDF at all, so a caller can
 * fall through to reading it as a page.
 *
 * The SSRF policy is the same one js/context.js applies to any URL the panel fetches, using
 * the same shared classifier (js/net.js) — the panel holds `<all_urls>`, so an unguarded
 * fetch here would reach the local bridge or the LAN and ship the answer to a model. See
 * docs/secure-data-plane.md.
 */
export async function pdfTextFromUrl(rawUrl, opts = {}) {
  const url = assertFetchablePdfUrl(rawUrl);
  const res = await fetch(url, { redirect: 'follow' });
  if (res.url) assertFetchablePdfUrl(res.url); // a redirect may have landed somewhere internal
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
  const ct = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  // Content-type is advisory (servers send application/octet-stream, and viewer pages send
  // text/html from a .pdf URL); the header bytes are not.
  if (!isPdfBytes(buf) && !/application\/pdf/i.test(ct)) return null;
  return pdfTextFromBytes(new Uint8Array(buf), { url, ...opts });
}

function assertFetchablePdfUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be fetched (got "${parsed.protocol}")`);
  }
  if (isBlockedNetHost(parsed.hostname, { allowLoopback: false, allowPrivate: false })) {
    throw new Error(`Refusing to fetch a private/loopback/metadata address (${parsed.hostname})`);
  }
  return parsed.toString();
}

/**
 * The message a user gets for a PDF that has no text in it.
 *
 * A scan extracts to an empty string, and an empty attachment is the worst possible outcome:
 * the model summarises nothing and nobody is told why. Saying "this is a scan" is an answer.
 */
export function scannedPdfMessage(doc) {
  return `This PDF has no text layer — it looks like a scan or a set of page images `
    + `(${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}, ${doc.chars} characters of text). `
    + `Reading it would need OCR, which ChatPanel does not do yet.`;
}
