// YouTube transcripts — the Chrome half of "summarise this video".
//
// Everything about CHOOSING a caption track and PARSING one lives in
// js/events/media-transcript.js (@chatpanel/events), because a mobile app and the bridge will
// need exactly that and none of this. What lives here is the part that is genuinely bound to
// the browser, and that part is not a detail — it is the whole feature.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH CAPTION URL WORKS, AND WHY THAT IS THE WHOLE FEATURE
//
// Measured against live YouTube, not assumed:
//
//   baseUrl scraped from the watch page HTML (+fmt/+Referer/+Origin/+cookies)
//                                                     -> HTTP 200, ZERO BYTES
//   /youtubei/v1/get_transcript, even from inside the real page with its own
//     INNERTUBE context, its params and its session   -> 400 FAILED_PRECONDITION
//   /youtubei/v1/player as ANDROID, clientVersion 20.10.38, caption URL fetched
//     from ITS response                               -> 60,441 bytes of captions
//
// So there IS a fetch route — it just is not the one every blog post describes. The player
// endpoint's URLs work where the HTML's do not, and the ANDROID CLIENT VERSION is the entire
// difference: 20.10.38 returns caption tracks, 19.09.37 and 17.31.35 return a well-formed
// player response with the `captions` block missing. A stale version therefore does not
// error — it reads exactly like "this video has no subtitles". See INNERTUBE_ANDROID in
// js/events/media-transcript.js.
//
// That route needs no tab, no player, no sign-in and no Premium, which is what makes
// "summarise this video" answerable from a pasted URL with nothing on screen and no sound.
//
// WHEN IT ROTS — and it will, because the client version is a moving target — the fallback is
// YouTube's own transcript panel in a real tab: the player has already attested, requested
// and rendered, and we read the render. Slower and it needs a page, but it cannot be
// version-locked. Two routes, because one route is an outage.
//
// (Synthetic clicks do NOT open that panel: a plain .click(), a full pointer sequence and a
// CDP-trusted click were all tried against a real page and none of them opened it. The
// description has to be EXPANDED first, or the control is a zero-size element inside a
// collapsed container and every click lands on nothing.)
// ─────────────────────────────────────────────────────────────────────────────

import {
  parseYouTubeUrl, captionTracksFromPlayerResponse, videoMetaFromPlayerResponse,
  transcriptFromTracks, parseTimedText, buildTranscriptDocument,
  innertubeApiKeyFromHtml, innertubePlayerRequest,
} from './events/media-transcript.js';
import { waitForTabComplete } from './tab-nav.js';

/** How long to wait for the transcript panel to render before giving up. */
const PANEL_TIMEOUT_MS = 12_000;

// --------------------------------------------------------------------------
// Injected — must be fully self-contained (no imports, no closure)
// --------------------------------------------------------------------------

/**
 * Video metadata, read out of the page.
 *
 * `window.ytInitialPlayerResponse` lives in the page's MAIN world, which an isolated content
 * script cannot see — so this reads it from the inline <script> that DEFINED it instead. That
 * works in every world and in both engines. Its caption URLs are no longer usable (see the
 * header), but its title, channel and duration are, and a transcript with no idea what it is a
 * transcript OF is a document a model cannot cite.
 */
function grabPlayerResponse() {
  const readFromScripts = () => {
    for (const s of document.querySelectorAll('script')) {
      const src = s.textContent || '';
      const at = src.indexOf('ytInitialPlayerResponse');
      if (at < 0) continue;
      const open = src.indexOf('{', at);
      if (open < 0) continue;
      // Brace-match rather than regex to the end: the blob contains braces inside strings, and
      // a greedy match swallows the rest of the script (or stops at the first `}`).
      let depth = 0, inStr = false, quote = '', esc = false;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
          if (c === '\\') esc = true;
          else if (c === quote) inStr = false;
          continue;
        }
        if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { return JSON.parse(src.slice(open, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  };
  const pr = readFromScripts();
  return pr
    ? { ok: true, playerResponse: pr, url: location.href, title: document.title }
    : { ok: false, url: location.href, title: document.title };
}

/**
 * Open YouTube's transcript panel, read it, and put the page back as it was.
 *
 * THE PANEL IS THE PRODUCT'S OWN FEATURE, which is exactly why this is the durable route: the
 * player has already done the attestation, made the request and rendered the answer. We read
 * the render.
 *
 * LEAVE NO TRACE. On the user's own tab this is running in the window they are looking at, so
 * a panel we opened is a panel we close. A panel they had already opened is left alone.
 */
async function readTranscriptPanel(timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  const segmentsNow = () => Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));
  const panel = () => document.querySelector(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
  );
  const panelOpen = () => panel()?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';

  const weOpenedIt = !panelOpen();

  // Three ways in, because YouTube moves this control between layouts: a labelled button
  // anywhere, the description's own "Show transcript" section (which needs the description
  // expanded first), and the overflow menu.
  const clickTranscriptControl = () => {
    const labelled = document.querySelector(
      'button[aria-label*="ranscript" i], ytd-video-description-transcript-section-renderer button',
    );
    if (labelled) { labelled.click(); return true; }
    for (const el of document.querySelectorAll('button, tp-yt-paper-item, ytd-menu-service-item-renderer, yt-formatted-string')) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
      if (label.includes('show transcript')) {
        (el.closest('button, tp-yt-paper-item, ytd-menu-service-item-renderer') || el).click();
        return true;
      }
    }
    return false;
  };

  if (!segmentsNow().length) {
    if (!clickTranscriptControl()) {
      document.querySelector('tp-yt-paper-button#expand, #description #expand, #expand')?.click();
      await sleep(500);
      clickTranscriptControl();
    }
    while (!segmentsNow().length && Date.now() < deadline) await sleep(250);
  }

  // The list is long and lazily filled. Scroll it until the count stops growing, so a
  // 90-minute talk does not come back as its first three minutes.
  let rows = segmentsNow();
  const scroller = rows[0]?.closest('#segments-container, ytd-transcript-segment-list-renderer')
    || panel()?.querySelector('#content');
  if (scroller) {
    let previous = -1;
    while (rows.length !== previous && Date.now() < deadline) {
      previous = rows.length;
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(220);
      rows = segmentsNow();
    }
    scroller.scrollTop = 0;
  }

  const toMs = (raw) => {
    const parts = String(raw || '').trim().split(':').map(Number);
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  };

  let segments = rows.map((row) => ({
    start: toMs(row.querySelector('.segment-timestamp')?.textContent),
    dur: 0,
    text: (row.querySelector('.segment-text')?.textContent || '').replace(/\s+/g, ' ').trim(),
  })).filter((s) => s.text);

  // SHAPE-BASED FALLBACK, because the element name and those two class names are the one part
  // of this that is a bet on YouTube's internals — and a rename would turn a working feature
  // into a silent "no transcript". A transcript is visually unmistakable whatever it is built
  // from: lines that begin with a timestamp. So if the specific selectors come back empty
  // while the panel is plainly showing something, read the panel's text and parse the shape.
  if (!segments.length) {
    const text = (panel()?.innerText || '').trim();
    const seen = new Set();
    for (const line of text.split('\n')) {
      const m = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+(.*\S)\s*$/.exec(line);
      if (!m) continue;
      const key = `${m[1]}|${m[2]}`;
      if (seen.has(key)) continue; // the panel header repeats the video's own duration
      seen.add(key);
      segments.push({ start: toMs(m[1]), dur: 0, text: m[2].replace(/\s+/g, ' ') });
    }
  }

  if (weOpenedIt) {
    // Closed only now: the shape-based fallback above reads the panel's own text, so closing
    // it first would empty the very thing it falls back to. Close it the way the user would,
    // so their page is where they left it.
    const close = panel()?.querySelector('#visibility-button button, button[aria-label*="lose" i]');
    close?.click();
  }

  if (!segments.length) return { ok: false, url: location.href, title: document.title };
  return { ok: true, segments, url: location.href, title: document.title };
}

/** Fetch a caption URL as the page. Kept as a last resort — see `transcriptFromTab`. */
async function fetchInPage(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.text() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// --------------------------------------------------------------------------
// Route 1 — the fetch route. No tab, no player, no sound.
// --------------------------------------------------------------------------

/**
 * Transcript for a video id, using nothing but two fetches.
 *
 * This is the route that makes a pasted link answerable instantly. The panel holds
 * `<all_urls>`, so both requests are ordinary cross-origin fetches; neither needs the user's
 * cookies, so neither sends them — `credentials: 'omit'` is deliberate. A transcript request
 * should not carry someone's YouTube identity, and it does not have to: this works signed
 * out.
 */
export async function transcriptViaInnertube(videoId, { language = '', languages = ['en'], ...opts } = {}) {
  const get = async (url, init) => {
    const res = await fetch(url, { credentials: 'omit', ...init });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  let apiKey = '';
  try {
    apiKey = innertubeApiKeyFromHtml(await (await get(`https://www.youtube.com/watch?v=${videoId}`)).text());
  } catch {
    return null;
  }
  const req = innertubePlayerRequest(videoId, { apiKey });
  if (!req) return null;

  let player;
  try {
    player = await (await get(req.url, { method: req.method, headers: req.headers, body: req.body })).json();
  } catch {
    return null;
  }
  const tracks = captionTracksFromPlayerResponse(player);
  // NOT an error, and not "no captions" either: a stale client version returns exactly this.
  // The caller falls through to the panel route rather than telling the user there are none.
  if (!tracks.length) return null;

  return transcriptFromTracks({
    tracks,
    meta: videoMetaFromPlayerResponse(player),
    language, languages, source: 'youtube:innertube',
    fetchText: async (url) => (await get(url)).text(),
    ...opts,
  });
}

// --------------------------------------------------------------------------
// Reading a tab
// --------------------------------------------------------------------------

async function inject(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result ?? null;
}

function metaFrom(grabbed, scraped) {
  if (grabbed?.ok) return videoMetaFromPlayerResponse(grabbed.playerResponse);
  const url = scraped?.url || grabbed?.url || '';
  return {
    title: String(scraped?.title || grabbed?.title || '').replace(/\s*-\s*YouTube$/, ''),
    url: parseYouTubeUrl(url)?.url || url,
  };
}

/**
 * Transcript for a YouTube tab. Returns a transcript document, or null when this tab is not a
 * YouTube video / the video has no transcript at all.
 */
export async function transcriptFromTab(tabId, { language = '', languages = ['en'], timeoutMs = PANEL_TIMEOUT_MS, ...opts } = {}) {
  const grabbed = await inject(tabId, grabPlayerResponse).catch(() => null);
  if (!grabbed) return null;
  const parsedUrl = parseYouTubeUrl(grabbed.url);
  if (!parsedUrl) return null; // a channel or search page, not a video

  // THE FETCH ROUTE FIRST, even on a tab. It touches nothing the user can see — no panel
  // opening and closing in the window they are looking at — and it is the faster of the two.
  const fetched = await transcriptViaInnertube(parsedUrl.videoId, { language, languages, ...opts }).catch(() => null);
  if (fetched) return fetched;

  // THE PANEL, when the fetch route has gone stale.
  const scraped = await inject(tabId, readTranscriptPanel, [timeoutMs]).catch(() => null);
  if (scraped?.ok) {
    return buildTranscriptDocument({
      meta: metaFrom(grabbed, scraped), segments: scraped.segments, source: 'youtube:panel', ...opts,
    });
  }

  // Last resort: the caption URLs printed into the page's own HTML. They answer with an empty
  // body today (see the header), so this cannot be first — a route that quietly returns
  // nothing would mask the two that work. It is kept because it costs one request on a path
  // that has already failed twice, and it revives by itself if YouTube relaxes.
  if (grabbed.ok) {
    const tracks = captionTracksFromPlayerResponse(grabbed.playerResponse);
    if (tracks.length) {
      return transcriptFromTracks({
        tracks, meta: metaFrom(grabbed, scraped), language, languages, source: 'youtube:captions',
        fetchText: async (url) => {
          const r = await inject(tabId, fetchInPage, [url]);
          if (!r?.ok) throw new Error(r?.status ? `HTTP ${r.status}` : (r?.error || 'fetch failed'));
          return r.body;
        },
        ...opts,
      });
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Reading a URL with no tab behind it
// --------------------------------------------------------------------------

/** An already-open tab showing this video, if the user has one. Cheapest possible answer. */
async function findVideoTab(videoId) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtu.be/*'] });
  } catch {
    return null;
  }
  return tabs.find((t) => t.url && parseYouTubeUrl(t.url)?.videoId === videoId) || null;
}

/**
 * Transcript for a pasted URL.
 *
 * A transcript needs a real page (see the header), so if the user does not already have one
 * open we make one — INACTIVE and MUTED, and closed again when we are done. Muting is not
 * politeness: a watch page opened in the background starts playing, and a summary request
 * should never make noise.
 *
 * The tab is muted before the navigation is awaited, which is the earliest point at which we
 * hold a tab id; the player needs seconds of setup before it could produce a sound.
 */
export async function transcriptFromUrl(rawUrl, opts = {}) {
  const parsed = parseYouTubeUrl(rawUrl);
  if (!parsed) return null;

  // NO TAB IF WE DO NOT NEED ONE. This is the whole point of a pasted link: an answer with
  // nothing appearing on screen and nothing coming out of the speakers.
  const fetched = await transcriptViaInnertube(parsed.videoId, opts).catch(() => null);
  if (fetched) return fetched;

  const existing = await findVideoTab(parsed.videoId);
  if (existing?.id) {
    const doc = await transcriptFromTab(existing.id, opts).catch(() => null);
    if (doc) return { ...doc, source: 'youtube:open-tab' };
  }

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: parsed.url, active: false });
    tabId = tab.id;
    await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    await waitForTabComplete(tabId);
    const doc = await transcriptFromTab(tabId, opts);
    return doc ? { ...doc, source: 'youtube:background-tab' } : null;
  } catch {
    return null;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * `ytInitialPlayerResponse = {...};` out of watch-page HTML.
 *
 * Exported because the brace matcher is the piece most likely to break when YouTube reshuffles
 * its bootstrap script, and it is the one piece testable without a browser.
 */
export function playerResponseFromHtml(html) {
  const src = String(html || '');
  for (const marker of ['ytInitialPlayerResponse', '"playerResponse":']) {
    let at = src.indexOf(marker);
    while (at >= 0) {
      const open = src.indexOf('{', at + marker.length);
      if (open < 0) break;
      const json = matchBraces(src, open);
      if (json) {
        try {
          const parsed = JSON.parse(json);
          if (parsed?.videoDetails || parsed?.captions) return parsed;
        } catch { /* keep looking — an earlier mention may not be the assignment */ }
      }
      at = src.indexOf(marker, at + marker.length);
    }
  }
  return null;
}

function matchBraces(src, open) {
  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** Re-exported so callers need one import, not two. */
export { parseYouTubeUrl, parseTimedText };
export { looksLikeVideoHost } from './source-kind.js';
