// What KIND of thing is at this URL — answered cheaply, before paying to find out.
//
// Reading a video and reading a PDF each need a heavy layer (caption parsing; a PDF engine)
// that must not land on the panel's first paint or on an ordinary page read. Something has
// to decide whether to `await import()` that layer, and that decision cannot itself be
// deferred — so it lives here, in the one module small enough to be free.
//
// Its own file because several call sites need the answer before they are allowed to pay
// for it (js/context.js, js/page-tools.js, and the layers themselves, which want the test
// without importing either). Written inline at each, the patterns would be copied three
// times and the next host we support would be added to one of them.
//
// These are GATES, not authorities. `looksLikeVideoHost` says yes to a YouTube channel page;
// js/events/media-transcript.js `parseYouTubeUrl` is what decides there is actually a video.
// `looksLikePdfUrl` says yes on the extension alone; the magic bytes decide (see
// js/pdf-text.js `isPdfBytes`), because plenty of PDFs are served from URLs with no
// extension at all and plenty of `?file=x.pdf` links are viewer pages.

const VIDEO_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;

export function looksLikeVideoHost(url) {
  try {
    return VIDEO_HOST_RE.test(new URL(String(url || '')).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// A URL that is PROBABLY a PDF: the path ends in .pdf, or a query parameter points at one
// (viewer front-ends of the form `/viewer?file=…pdf` are common enough to be worth catching).
export function looksLikePdfUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (/\.pdf$/i.test(u.pathname)) return true;
    for (const v of u.searchParams.values()) if (/\.pdf(\?|#|$)/i.test(v)) return true;
    return false;
  } catch {
    return false;
  }
}
