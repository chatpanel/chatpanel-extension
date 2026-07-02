// link-title.js — resolve a bare URL to its page <title> so the editor can show a readable
// [Title](url) link instead of a raw address. LOCAL / private by design: no third-party title
// service ever sees the URL. Provider order (behind a clean contract so the gateway/bridge can
// offer the same capability later): the local bridge's fetch endpoint when present, else the
// extension's own SSRF-guarded captureUrl. Lazy-loaded at the call site — off the first-paint
// graph (it pulls in context.js only when a link actually needs a title).

// Once a bare http(s) URL, and nothing else — the shape we auto-upgrade. Anchored + no inner
// whitespace/brackets so it never matches a URL that's already part of [text](url) syntax.
const BARE_URL = /^https?:\/\/[^\s<>()[\]]+$/i;
export function looksLikeBareUrl(s) { return BARE_URL.test(String(s || '').trim()); }

// Tidy a raw <title>: collapse whitespace, cap length, and never hand back something that's just
// the URL again (captureUrl falls back to the URL as "title" when a page has none).
export function cleanTitle(raw, url) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  try { if (t === url || t === new URL(url).href || t === String(url).replace(/\/$/, '')) return ''; } catch { /* not a URL */ }
  return t.slice(0, 120);
}

const cache = new Map();          // url → title | null (don't refetch the same link twice)
let bridgeTitleUnsupported = false; // set once a bridge answers "no such endpoint" — then skip it

// Resolve `url` to a display title, or null if it can't be fetched (offline / blocked / no title)
// — callers keep the bare URL in that case. Never throws.
export async function resolveLinkTitle(url, { bridgeUrl, signal } = {}) {
  const key = String(url || '').trim();
  if (!looksLikeBareUrl(key)) return null;
  if (cache.has(key)) return cache.get(key);

  let title = '';
  // Provider 1 — the local bridge, if configured and it exposes a page-fetch endpoint. Fails
  // soft: a bridge without the endpoint (older build) returns 404, which we remember and skip.
  if (bridgeUrl && !bridgeTitleUnsupported) {
    try {
      const r = await fetch(`${String(bridgeUrl).replace(/\/$/, '')}/fetch-title`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: key }), signal,
      });
      if (r.status === 404) bridgeTitleUnsupported = true;
      else if (r.ok) { const j = await r.json().catch(() => null); title = cleanTitle(j?.title, key); }
    } catch { /* bridge down / not this endpoint → fall through to direct */ }
  }
  // Provider 2 — the extension's own fetch (has <all_urls> host access, so no CORS wall), reusing
  // captureUrl's SSRF + redirect guards and <title> extraction. This is the working default.
  if (!title) {
    try {
      const { captureUrl } = await import('./context.js');
      const cap = await captureUrl(key);
      title = cleanTitle(cap?.title, cap?.url || key);
    } catch { /* keep the bare URL */ }
  }

  const result = title || null;
  cache.set(key, result);
  return result;
}
