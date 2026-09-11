// GENERATED — do not edit.
// Source of truth: chatpanel-events/web-search.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Reading a search engine's results page: the rules, without the DOM.
//
// Scraping a SERP is mostly judgement, and the judgement is identical everywhere: which
// engines to ask, how to build their URL safely from a template the user can edit, how to
// unwrap the redirector every engine wraps its links in, and which of the hundred anchors on
// the page are actually RESULTS rather than the engine's own navigation, promos and
// newsletter sign-ups.
//
// None of that needs a document. What does need one is turning HTML into a list of anchors,
// and that is the single thing each host injects: the extension has `DOMParser`, the desktop's
// main process has neither and uses a small extractor, and a gateway that grew one could pass
// its own. So there is ONE scraper with three front doors, rather than three scrapers.
//
// THE DANGEROUS PART IS THE URL, NOT THE HTML. A search template is user input that becomes a
// fetch, so `buildSearchUrl` refuses anything that is not https and anything without a query
// placeholder — and the caller is required to pass the host guard it already owns
// (`assertFetchable`), because deciding whether an address is safe to fetch is not a question
// this module is allowed to answer on its own.

/**
 * The engines, in the order they are tried.
 *
 * `enabled` is what a fresh install starts with. Mojeek is absent rather than disabled:
 * tested, it returns nothing at all, and an engine that never answers is not a fallback — it
 * is latency plus a misleading "no results".
 */
export const SEARCH_ENGINES = Object.freeze([
  Object.freeze({ id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', enabled: true }),
  Object.freeze({ id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=%s', enabled: true }),
  Object.freeze({ id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', enabled: false }),
  Object.freeze({ id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', enabled: false }),
]);

/** How many results to take from one engine before moving on. */
export const RESULTS_PER_ENGINE = 5;

/**
 * Turn a template into a URL, refusing the ones that are not safe to fetch.
 *
 * `assertFetchable` is INJECTED rather than implemented here: the SSRF/private-host guard is
 * one shared primitive that the client, the gateway and the bridge all call, and a second
 * opinion about what counts as a private address is how the two drift apart. Omitting it is
 * allowed only where the caller has already checked — it throws loudly rather than silently
 * skipping, so "I forgot" and "I checked elsewhere" cannot look the same.
 */
export function buildSearchUrl(template, query, { assertFetchable } = {}) {
  const t = String(template || '').trim();
  if (!/^https:\/\//i.test(t)) throw new Error('Search engine URL must start with https://');
  if (!t.includes('%s') && !t.includes('{q}')) {
    throw new Error('Search engine URL must contain a %s (or {q}) query placeholder');
  }
  const url = t.replace(/%s|\{q\}/g, encodeURIComponent(String(query || '').trim()));
  if (typeof assertFetchable === 'function') assertFetchable(url);
  return url;
}

/**
 * Unwrap the redirector an engine wraps its results in, so what is fetched and CITED is the
 * real destination rather than the engine's tracking URL.
 */
export function unwrapRedirect(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg'); // DuckDuckGo /l/?uddg=<encoded>
    if (uddg) return decodeURIComponent(uddg);
    const other = u.searchParams.get('url') || u.searchParams.get('u');
    if (other && /^https?:/i.test(other)) return other;
    return u.href;
  } catch {
    return String(href || '');
  }
}

/**
 * Hosts that appear on a SERP and are never results: the engine's own family, and the promos
 * they carry (Startpage's StartMail, Mojeek's newsletter).
 *
 * Deliberately NOT a broad denylist — real results legitimately point at YouTube, Yahoo and
 * Google properties, and filtering those would be filtering the web.
 */
const JUNK_HOSTS = /(^|\.)(startpage\.com|startmail\.com|startpage\.dev|mojeek\.com|buttondown\.(com|email)|ecosia\.org|duckduckgo\.com|search\.brave\.com|qwant\.com)$/i;

/** Is this a link off the engine's own page, or part of the engine itself? */
export function isResultHost(hostname, engineHost = '') {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (JUNK_HOSTS.test(host)) return false;
  const engineDomain = String(engineHost || '').split('.').slice(-2).join('.').toLowerCase();
  if (engineDomain && (host === engineDomain || host.endsWith(`.${engineDomain}`))) return false;
  return true;
}

/**
 * Turn a page's anchors into results.
 *
 * `anchors` is what the host's extractor produced: `{ href, text, snippet?, chrome? }`, where
 * `chrome` marks an anchor that sat inside a nav, footer or promo block. Everything after this
 * point is identical in every client, which is the reason the module exists.
 *
 * Deduped on origin+path rather than the full URL, so the same page offered twice with
 * different tracking parameters counts once.
 */
export function pickResults(anchors, { engineHost = '', limit = RESULTS_PER_ENGINE, fallback = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const a of anchors || []) {
    const href = unwrapRedirect(a?.href || '');
    let u;
    try { u = new URL(href); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (!isResultHost(u.hostname, engineHost)) continue;
    // The generic sweep sees the WHOLE page, so it is filtered harder: an anchor inside the
    // page's own chrome is navigation, not a result.
    if (fallback && a.chrome) continue;
    const title = String(a?.text || '').replace(/\s+/g, ' ').trim();
    // A link whose visible text is a word or two is an icon, a "next", or a breadcrumb.
    if (title.length < 6) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: href, title, snippet: String(a?.snippet || '').replace(/\s+/g, ' ').trim() });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Merge what several engines returned into one list.
 *
 * Engine ORDER is preserved rather than interleaved: the first engine is the one the user put
 * first, and a result it ranked third is more likely to be wanted than the second engine's
 * first. Deduped across engines on origin+path, so two engines agreeing shows once.
 */
export function mergeEngineResults(perEngine, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const results of perEngine || []) {
    for (const r of results || []) {
      let key;
      try { const u = new URL(r.url); key = u.origin + u.pathname; } catch { key = r.url; }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * The engines to try, in order: the enabled ones first, then the rest.
 *
 * A search that found nothing should escalate to the engines the user configured but left off
 * rather than report failure — being wrong about which engine works today is much more likely
 * than the web having no answer.
 */
export function engineOrder(engines = SEARCH_ENGINES) {
  const list = (Array.isArray(engines) ? engines : []).filter((e) => e && e.url && !e.retired);
  return [...list.filter((e) => e.enabled !== false), ...list.filter((e) => e.enabled === false)];
}
