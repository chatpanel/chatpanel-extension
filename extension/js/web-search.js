// web-search.js — background web search as context engineering. NO visible tabs.
//
// Given a query, this module:
//   1. hits one or more configured search engines (Chrome-style `%s` templates),
//   2. FETCHES each SERP straight from the side panel (no tab opens) and parses
//      it with DOMParser — engines that server-render results (e.g. DuckDuckGo's
//      html.duckduckgo.com endpoint) yield titles + snippets + links,
//   3. extracts the top-N result links + snippets,
//   4. merges + dedupes links across engines,
//   5. optionally deep-fetches the top result pages for fuller text, falling back
//      to the SERP snippet whenever a page is JS-only / unfetchable,
//   6. re-ranks against the query and returns bundled, length-bounded context.
//
// Why fetch instead of rendering tabs: loading a page in a real tab is the only
// way to execute its client-side JS, but tabs flash in the strip — odd UX. A
// direct fetch is fully invisible. The trade-off (no JS execution on result
// pages) is covered by (a) using server-rendered SERP endpoints and (b) the
// snippet fallback, so a query still returns usable context with zero tabs.
//
// No new permissions: cross-origin fetch from the panel is granted by the
// extension's `<all_urls>` host permission (same as context.js' captureUrl), and
// EVERY url — each SERP and each result link — passes through `assertFetchable`,
// so a poisoned SERP can't make us fetch the local bridge / cloud metadata / LAN.

import { assertFetchable, stripResourceTags, extractReadable } from './context.js';
import { FREE_LIMITS } from './license.js';

// Chrome-style engines: a `%s` (or `{q}`) placeholder for the URL-encoded query.
// Defaults favour engines that return real results to a plain (invisible) fetch:
// Startpage proxies Google-quality results, Mojeek has its own index — both serve
// parseable HTML without a CAPTCHA. DuckDuckGo / Bing / Google serve an anti-bot
// challenge or JS shell to a fetch, so they're off by default and only work via
// the background-tab fallback (a real tab renders with the user's session).
export const DEFAULT_ENGINES = [
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', enabled: true },
  { id: 'mojeek', name: 'Mojeek', url: 'https://www.mojeek.com/search?q=%s', enabled: true },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=%s', enabled: false },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', enabled: false },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', enabled: false },
];

const RESULTS_PER_ENGINE = 5; // top-N links taken from each SERP
const MAX_PAGES = 5; // how many result pages we deep-fetch for fuller text
const FETCH_CONCURRENCY = 4; // parallel fetches (no tabs, so we can do more)
const FETCH_TIMEOUT_MS = 12_000; // give up on a slow fetch
const PER_PAGE_CHARS = 6_000; // readable text kept per result (~1.5k tokens)
const DEFAULT_READER_URL = 'https://r.jina.ai/'; // Jina Reader — returns LLM-ready Markdown
const NAV_TIMEOUT_MS = 15_000; // background-tab load timeout
const RENDER_SETTLE_MS = 500; // let a rendered SERP settle after "complete"

// --------------------------------------------------------------------------
// Engine config validation — a saved template is user input; treat it as such.
// --------------------------------------------------------------------------
export function buildSearchUrl(template, query) {
  const t = String(template || '').trim();
  if (!/^https:\/\//i.test(t)) throw new Error('Search engine URL must start with https://');
  if (!t.includes('%s') && !t.includes('{q}')) {
    throw new Error('Search engine URL must contain a %s (or {q}) query placeholder');
  }
  const url = t.replace(/%s|\{q\}/g, encodeURIComponent(String(query || '').trim()));
  assertFetchable(url); // reject a template that resolves to a private/loopback host
  return url;
}

// --------------------------------------------------------------------------
// Invisible fetch (no tab). Returns { html, finalUrl } or null on any failure.
// --------------------------------------------------------------------------
async function fetchHtml(url) {
  assertFetchable(url); // scheme + private/loopback/metadata guard (pre-redirect)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (res.url) assertFetchable(res.url); // a redirect may have landed on a blocked host
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct && !/html|text|xml/i.test(ct)) return null; // skip binaries/json
    return { html: await res.text(), finalUrl: res.url || url };
  } catch {
    return null; // timeout / network / CORS / SSRF-block — skip, never throw the search
  } finally {
    clearTimeout(timer);
  }
}

// Search engines wrap result links in redirectors. Unwrap the common ones so we
// fetch (and cite) the real destination, not the engine's tracking URL.
function unwrapRedirect(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg'); // DuckDuckGo /l/?uddg=<encoded>
    if (uddg) return decodeURIComponent(uddg);
    const u2 = u.searchParams.get('url') || u.searchParams.get('u'); // generic ?url= / ?u=
    if (u2 && /^https?:/i.test(u2)) return u2;
    return u.href;
  } catch {
    return href;
  }
}

// --------------------------------------------------------------------------
// SERP parsing (on fetched HTML — no executeScript)
// --------------------------------------------------------------------------
// Engine-FAMILY / promo hosts that appear in a SERP's nav, footer or banner but are never
// organic results (e.g. Startpage's StartMail ad, Mojeek's Buttondown newsletter). When the
// specific result selectors miss and we fall back to sweeping links, these leak in as junk.
const SERP_JUNK_HOSTS = /(^|\.)(startpage\.com|startmail\.com|startpage\.dev|mojeek\.com|buttondown\.(com|email)|ecosia\.org|duckduckgo\.com|search\.brave\.com|qwant\.com)$/i;
// Chrome (nav/footer/promo/consent/newsletter) containers whose links are never results.
const SERP_CHROME_SEL = 'header,footer,nav,aside,form,[class*="promo" i],[class*="banner" i],[class*="cookie" i],[class*="consent" i],[class*="newsletter" i],[class*="subscribe" i],[class*="footer" i],[class*="header" i],[id*="nav" i],[id*="footer" i],[id*="header" i]';

function parseSerp(html, engineHost, limit) {
  const doc = new DOMParser().parseFromString(stripResourceTags(html), 'text/html');
  // Prefer explicit result anchors (Startpage, Mojeek, DuckDuckGo, Bing), then fall back to a
  // generic "off-site anchor" sweep for new/changed engines. The fallback is junk-prone (it
  // sees the whole page), so it's filtered harder below.
  const specific = [...doc.querySelectorAll('a.result-title, a.result__a, a.title, h2 > a, h3 > a, [data-testid="result-title-a"], .result a[href^="http"], .w-gl__result-title')];
  const usingFallback = !specific.length;
  const anchors = usingFallback ? [...doc.querySelectorAll('a[href^="http"]')] : specific;

  // Exclude the ENGINE'S OWN domain (its nav/utility links) — NOT a broad denylist, since real
  // results legitimately point at yahoo/youtube/google/etc.
  const engineDomain = String(engineHost || '').split('.').slice(-2).join('.');

  const out = [];
  const seen = new Set();
  for (const a of anchors) {
    const href = unwrapRedirect(a.getAttribute('href') || a.href || '');
    let u;
    try { u = new URL(href); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (engineDomain && (u.hostname === engineDomain || u.hostname.endsWith('.' + engineDomain))) continue;
    if (SERP_JUNK_HOSTS.test(u.hostname)) continue; // engine-family / promo hosts are never results
    if (usingFallback && a.closest(SERP_CHROME_SEL)) continue; // fallback: skip nav/footer/promo links
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (title.length < 6) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);

    // Snippet: the description block near the result anchor.
    let snippet = '';
    let node = a;
    for (let i = 0; i < 5 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const sn = node.querySelector('.description, .result__snippet, p.s, .b_caption p, .VwiC3b, [data-result="snippet"]');
      if (sn && sn.textContent.trim()) { snippet = sn.textContent.replace(/\s+/g, ' ').trim(); break; }
    }

    out.push({ url: href, title, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

// Reduce a fetched result page to readable text (mirrors context.js' captureUrl).
// Local fallback only — used when no reader service is configured / it fails.
function readableFromHtml(html) {
  const doc = new DOMParser().parseFromString(stripResourceTags(html), 'text/html');
  // Strip boilerplate so the model sees article content, not nav/ads/cookie junk.
  doc.querySelectorAll(
    'noscript,svg,template,header,footer,nav,aside,form,button,dialog,' +
    '[role="navigation"],[role="banner"],[role="contentinfo"],[role="search"],[aria-hidden="true"],' +
    '[hidden],[class*="cookie" i],[class*="newsletter" i],[class*="promo" i],[class*="subscribe" i],' +
    '[class*="sidebar" i],[class*="related" i],[class*="recommend" i],[id*="comment" i]',
  ).forEach((el) => el.remove());
  // Prefer a semantic container, but ONLY if it actually holds the content. On
  // SSR/Next.js sites <main> is often present but empty (hydrated by JS later),
  // while the real text sits in <body> — picking the empty <main> would yield ~0
  // chars and wrongly trigger the tab-render fallback. So fall back to <body>
  // whenever the semantic node is sparse.
  const semantic = doc.querySelector('main,article,[role="main"]');
  const body = doc.body || doc.documentElement;
  const main = semantic && (semantic.textContent || '').trim().length > 200 ? semantic : body;
  // Use innerText-like spacing: block elements imply line breaks. textContent jams
  // words together across tags, so insert newlines on common block boundaries.
  main?.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,br,tr').forEach((el) => el.append('\n'));
  const text = (main?.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: doc.title || '', text };
}

// Fetch a URL as plain text (used for reader-service Markdown — no HTML parsing).
async function fetchText(url, headers) {
  try { assertFetchable(url); } catch { return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: headers || {} });
    if (!res.ok) return null; // e.g. Jina now 401s anonymous requests — caller falls back
    const body = await res.text();
    return body && body.trim() ? body.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Final content fallback: open the URL in a background tab so the page's JS runs,
// extract readable text with the same routine the tab-context feature uses, then
// close the tab. This is the real-render path that works when fetch can't — SPA-
// only content or soft blocks. A page's own console noise stays in that tab.
async function fetchRenderedText(url) {
  try { assertFetchable(url); } catch { return null; }
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    const live = await chrome.tabs.get(tabId).catch(() => null);
    if (live?.url) { try { assertFetchable(live.url); } catch { return null; } } // redirected to a blocked host
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: extractReadable });
    const r = inj?.result;
    if (!r?.text) return null;
    return { title: r.title || '', text: r.text.replace(/\n{3,}/g, '\n\n').trim() };
  } catch {
    return null;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Get a result page's CONTENT as clean, LLM-ready text via a fallback CHAIN:
//   1) reader service (opt-in) → Markdown,
//   2) direct fetch + local readable extraction (handles most pages),
//   3) last resort: render the page in a background tab and read it (JS-only or
//      fetch-blocked sites) — gated by tabFallback.
// Returns null only if all fail; the caller then keeps the SERP snippet.
async function fetchContent(url, reader, tabFallback) {
  if (reader?.enabled && reader.url) {
    const headers = reader.key ? { Authorization: `Bearer ${reader.key}` } : {};
    const md = await fetchText(String(reader.url).replace(/\/?$/, '/') + url, headers);
    if (md) return { title: '', text: md };
  }
  const got = await fetchHtml(url);
  const local = got ? readableFromHtml(got.html) : null;
  if (local?.text && local.text.length >= 200) return local; // good enough — no tab needed
  if (tabFallback) {
    const rendered = await fetchRenderedText(url);
    if (rendered?.text && rendered.text.length > (local?.text?.length || 0)) return rendered;
  }
  return local; // may be null → caller falls back to the SERP snippet
}

// Reliability fallback: some engines (DuckDuckGo, Bing, Google) serve an anti-bot
// CAPTCHA to a plain fetch but render normally in a real tab (with the user's
// session). When a fetch yields nothing, load the SERP in a background tab, grab
// its rendered HTML, and parse that with the SAME parseSerp. Used only on miss, so
// the common case (Startpage/Mojeek) stays tab-free.
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
      setTimeout(resolve, RENDER_SETTLE_MS);
    };
    function listener(id, info) { if (id === tabId && info.status === 'complete') finish(); }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, NAV_TIMEOUT_MS);
  });
}

async function fetchHtmlViaTab(url) {
  try { assertFetchable(url); } catch { return null; }
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    const live = await chrome.tabs.get(tabId).catch(() => null);
    if (live?.url) { try { assertFetchable(live.url); } catch { return null; } } // redirected to a blocked host
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return inj?.result ? { html: inj.result, finalUrl: live?.url || url } : null;
  } catch {
    return null;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function searchEngine(engine, query, perEngine, tabFallback) {
  let serpUrl;
  try { serpUrl = buildSearchUrl(engine.url, query); } catch { return []; }
  const host = new URL(serpUrl).hostname;
  let got = await fetchHtml(serpUrl);
  let links = got ? parseSerp(got.html, host, perEngine) : [];
  // Opt-in only: opening a SERP in a real tab makes the engine's speculation rules
  // PRERENDER the top result pages, which floods the extension console with those
  // pages' own CSP/preload warnings. Off by default; fetch-friendly engines
  // (Startpage, Mojeek) never need it.
  if (!links.length && tabFallback) {
    got = await fetchHtmlViaTab(serpUrl);
    links = got ? parseSerp(got.html, host, perEngine) : [];
  }
  return links.map((l) => ({ ...l, engine: engine.id }));
}

// --------------------------------------------------------------------------
// Re-ranking — dependency-free lexical relevance vs the query
// --------------------------------------------------------------------------
function tokens(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
}

function relevance(query, page) {
  const qTerms = new Set(tokens(query));
  if (!qTerms.size) return 0;
  const title = tokens(page.title);
  const body = tokens(page.text);
  const score = (arr, weight) => {
    if (!arr.length) return 0;
    let hits = 0;
    for (const t of arr) if (qTerms.has(t)) hits++;
    return (hits / arr.length) * weight;
  };
  // Title matches count more; body normalized by length so long pages don't win by mass.
  return score(title, 3) + score(body, 1);
}

// --------------------------------------------------------------------------
// Small concurrency limiter
// --------------------------------------------------------------------------
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// --------------------------------------------------------------------------
// Free-tier daily search quota. Persisted per calendar day in chrome.storage.local
// (shared across the side panel, settings page, and background). Pro is unlimited.
// --------------------------------------------------------------------------
const SEARCH_USAGE_KEY = 'chatpanel:webSearchUsage';
const todayStamp = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local-ish, stable per day)

async function readSearchUsage() {
  try {
    const got = await chrome.storage.local.get(SEARCH_USAGE_KEY);
    const u = got[SEARCH_USAGE_KEY];
    if (u && u.date === todayStamp()) return { date: u.date, used: Number(u.used) || 0 };
  } catch { /* storage unavailable — treat as fresh */ }
  return { date: todayStamp(), used: 0 };
}

// Read-only snapshot for the UI ("X / 50 searches today").
export async function webSearchUsage() {
  const u = await readSearchUsage();
  const cap = FREE_LIMITS.webSearchesPerDay;
  return { used: u.used, cap, remaining: Math.max(0, cap - u.used) };
}

// Throw a clear error if a Free user is out of daily searches. No-op for Pro.
async function assertDailySearchQuota(isPro) {
  if (isPro) return;
  const { used } = await readSearchUsage();
  if (used >= FREE_LIMITS.webSearchesPerDay) {
    const e = new Error(`Free web search is limited to ${FREE_LIMITS.webSearchesPerDay} searches per day. Upgrade to Pro for unlimited.`);
    e.code = 'quota';
    throw e;
  }
}

// Count one consumed search (Free only) — called AFTER a search actually ran.
async function recordSearch(isPro) {
  if (isPro) return;
  const u = await readSearchUsage();
  try { await chrome.storage.local.set({ [SEARCH_USAGE_KEY]: { date: u.date, used: u.used + 1 } }); } catch { /* best effort */ }
}

// Public entry point
// --------------------------------------------------------------------------
// Returns { query, engines: [ids], results: [{ rank, title, url, engine, score, text }] }.
export async function webSearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Empty search query.');

  // Free tier: a daily search cap (Pro is unlimited). Checked BEFORE any fetch so a
  // capped user gets a clean error instead of burning bandwidth.
  const isPro = opts.isPro === true;
  await assertDailySearchQuota(isPro);

  const engines = (opts.engines || DEFAULT_ENGINES).filter((e) => e.enabled !== false);
  if (!engines.length) throw new Error('No search engines enabled.');
  const perEngine = opts.perEngine || RESULTS_PER_ENGINE;
  const maxPages = opts.maxPages || MAX_PAGES;
  const perPageChars = opts.perPageChars || PER_PAGE_CHARS;

  // 1) Fetch every SERP (no tabs), collect candidate links + snippets. The
  //    last-resort tab render is gated by opts.tabFallback (OPT-IN, default off) —
  //    only fires when both reader and direct fetch miss. See fetchContent/searchEngine.
  const tabFallback = opts.tabFallback === true;
  const perEngineLinks = await mapLimit(engines, FETCH_CONCURRENCY, (e) =>
    searchEngine(e, q, perEngine, tabFallback),
  );

  // 2) Merge + dedupe across engines; a link several engines agree on (and ranked
  //    high) is more trustworthy, so seed an initial score from appearance + position.
  const merged = new Map(); // origin+path -> link
  perEngineLinks.flat().forEach((l, pos) => {
    let key;
    try { const u = new URL(l.url); key = u.origin + u.pathname; } catch { return; }
    try { assertFetchable(l.url); } catch { return; } // drop blocked hosts before we ever fetch them
    const prior = merged.get(key);
    if (prior) { prior.seed += 1; if (!prior.snippet) prior.snippet = l.snippet; return; }
    merged.set(key, { ...l, seed: 1 - pos * 0.001 });
  });

  // 3) Deep-fetch the most-promising pages for fuller text; fall back to the SERP
  //    snippet when a page is JS-only / blocks fetch, so every result has content.
  const candidates = [...merged.values()].sort((a, b) => b.seed - a.seed).slice(0, maxPages);
  const reader = opts.reader;
  const pages = await mapLimit(candidates, FETCH_CONCURRENCY, async (link) => {
    let title = link.title;
    let text = link.snippet || '';
    const content = await fetchContent(link.url, reader, tabFallback);
    if (content?.text && content.text.length > text.length) text = content.text;
    if (content?.title) title = content.title;
    if (!text) return null; // no snippet and nothing fetched — drop it
    if (text.length > perPageChars) text = text.slice(0, perPageChars) + `\n\n…[truncated ${text.length - perPageChars} chars]`;
    return { title, url: link.url, engine: link.engine, text };
  });

  // 4) Re-rank the gathered pages by lexical relevance to the query.
  const ranked = pages
    .filter(Boolean)
    .map((p) => ({ ...p, score: relevance(q, p) }))
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, ...p }));

  await recordSearch(isPro); // a real search ran → count it against the Free daily cap
  return { query: q, engines: engines.map((e) => e.id), results: ranked };
}

// Flatten a webSearch() result into a single readable context blob (for an
// attachment body). A citation index of markdown links sits at the TOP so it
// survives truncation, and the model is told to cite with markdown links only —
// never HTML/<sup>/bare numbers — so citations render as clickable links.
export function searchResultsToText(res) {
  if (!res?.results?.length) return `No web results for "${res?.query || ''}".`;
  const sources = res.results.map((r) => `[${r.rank}] [${r.title}](${r.url})`).join('\n');
  const example = res.results[0].url;
  const head =
    `Web search results for "${res.query}" (engines: ${res.engines.join(', ')}).\n\n` +
    `Citation rules: when a claim draws on a result below, cite it inline as a markdown ` +
    `link to that result's URL — e.g. ([1](${example})). Cite multiple sources as separate ` +
    `links: ([1](url)) ([3](url)). Do NOT output HTML, <sup>, or bare bracket numbers like ` +
    `[1] — every citation must be a clickable markdown link. Finish with a "Sources" section ` +
    `that repeats, as markdown links, each source you cited.\n\n` +
    `Sources:\n${sources}`;
  const body = res.results
    .map((r) => `### [${r.rank}] ${r.title}\n<${r.url}>\n\n${r.text}`)
    .join('\n\n---\n\n');
  return `${head}\n\n---\nResult details:\n\n${body}`;
}

// Pull the user's web-search config (engines + counts) out of settings, falling
// back to defaults. Lives here so callers don't hard-code the settings shape.
export function webSearchOpts(settings, isPro = false) {
  const cfg = settings?.ui?.webSearch || {};
  let engines = Array.isArray(cfg.engines) && cfg.engines.length ? cfg.engines : DEFAULT_ENGINES;
  // Free tier: at most FREE_LIMITS.webSearchEngines ENABLED engines — any enabled
  // beyond the cap are forced off in the opts (settings are left untouched so they
  // re-enable on upgrade). Pro keeps the full list.
  if (!isPro) {
    let kept = 0;
    engines = engines.map((e) => {
      if (e.enabled === false) return e;
      kept += 1;
      return kept <= FREE_LIMITS.webSearchEngines ? e : { ...e, enabled: false };
    });
  }
  return {
    engines,
    isPro,
    perEngine: cfg.perEngine || RESULTS_PER_ENGINE,
    maxPages: cfg.maxPages || MAX_PAGES,
    tabFallback: cfg.tabFallback === true, // last-resort tab render; OPT-IN (a rendered page's own console warnings can't be silenced)
    reader: {
      // Fetch result CONTENT as clean Markdown via a reader service instead of
      // parsing site HTML. OPT-IN (default off): anonymous Jina is blocked (401),
      // so this needs an API key or a self-hosted reader. Sends each result URL to
      // that third party. Off → reliable local extraction.
      enabled: cfg.reader?.enabled === true,
      url: cfg.reader?.url || DEFAULT_READER_URL,
      key: cfg.reader?.key || '',
    },
  };
}

const ATTACH_MAX_CHARS = 30_000; // match context.js' per-attachment cap

// Run a search and package it as a context attachment (same shape as captureTab /
// captureUrl), so the side panel can push it into state.attachments and feed it to
// any model. This is the adapter the trigger calls.
export async function captureSearch(query, opts = {}) {
  const res = await webSearch(query, opts);
  if (!res.results.length) throw new Error(`No web results for "${res.query}".`);
  let text = searchResultsToText(res);
  if (text.length > ATTACH_MAX_CHARS) {
    text = text.slice(0, ATTACH_MAX_CHARS) + `\n\n…[truncated ${text.length - ATTACH_MAX_CHARS} chars]`;
  }
  return {
    id: `search_${Date.now()}`,
    kind: 'search',
    title: `🔎 ${res.query} · ${res.results.length} result${res.results.length === 1 ? '' : 's'}`,
    url: '', // synthesized context, no single source url
    text,
    chars: text.length,
  };
}

// --------------------------------------------------------------------------
// Tool provider — exposes `web_search` so the MODEL can decide to search on its
// own (agentic), like any MCP tool. Same { specs, execute, system } shape the
// toolset builder consumes, so it works for API agents (in-extension loop), bridge
// CLIs (relayed via the bridge's MCP), and the privacy gateway (OpenCode/Codex).
// --------------------------------------------------------------------------
const WEB_SEARCH_TOOL_SYSTEM =
  'You can call web_search to look up current information from the web — prices, news, recent ' +
  'events, documentation, or anything time-sensitive or that may have changed since your training. ' +
  'Call it whenever the user asks about such things instead of guessing or saying you are unsure. ' +
  'Cite results inline as markdown links — e.g. ([1](https://…)) — never HTML, <sup>, or bare ' +
  'numbers, and finish with a "Sources" list of the links you used.';

export function webSearchToolProvider(opts = {}) {
  return {
    specs: [
      {
        name: 'web_search',
        description:
          'Search the web and return ranked result snippets with their source URLs. Use this for ' +
          'current events, live prices/quotes, news, product/library docs, or any fact you are unsure ' +
          'about or that may have changed since training — prefer it over guessing.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query — a few keywords work best.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ],
    system: WEB_SEARCH_TOOL_SYSTEM,
    async execute(name, input) {
      if (name !== 'web_search') return JSON.stringify({ error: `Unknown tool: ${name}` });
      const q = String(input?.query || '').trim();
      if (!q) return 'No query provided to web_search.';
      try {
        const res = await webSearch(q, opts);
        return searchResultsToText(res);
      } catch (e) {
        return `web_search failed: ${e.message}`;
      }
    },
  };
}
