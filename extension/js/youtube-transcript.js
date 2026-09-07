// YouTube transcripts — the Chrome half of "summarise this video".
//
// Everything about CHOOSING a caption track and PARSING one lives in
// js/events/media-transcript.js (@chatpanel/events), because a mobile app and the bridge will
// need exactly that and none of this. What lives here is the part that is genuinely bound to
// the browser, and that part is not a detail — it is the whole feature.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS DOES NOT FETCH A CAPTION URL, THOUGH EVERY TRANSCRIPT LIBRARY DOES
//
// The published approach — scrape `ytInitialPlayerResponse` from the watch page, read
// `captionTracks[].baseUrl`, fetch it — no longer returns anything. Measured against real
// YouTube, not assumed:
//
//   scraped baseUrl (+fmt, +Referer, +Origin, +session cookies)  → HTTP 200, ZERO BYTES
//   …on four unrelated videos, including ones with 31 caption tracks
//   /youtubei/v1/player as WEB / ANDROID / IOS / TVHTML5         → UNPLAYABLE, no tracks
//   /youtubei/v1/get_transcript with the page's own INNERTUBE
//     context, its params and its cookies                        → 400 FAILED_PRECONDITION
//
// The empty 200 is the tell: the request is well-formed and accepted, and YouTube declines to
// answer it. Caption delivery is now gated on a proof-of-origin token minted at runtime by the
// player's own attestation code. A token cannot be forged, borrowed, or requested; it can only
// be produced by the real player running in a real page.
//
// So there is no server-shaped route, and there is no "just fetch it" route either — not from
// a Node CLI, not from the gateway, and not from this extension's own origin. Anything
// claiming otherwise is either about to break or is running a headless browser.
//
// WHAT DOES WORK, AND WHY IT KEEPS WORKING. YouTube's own "Show transcript" panel. The player
// mints its token, makes its own request, and renders the result into the DOM — and we read
// what it rendered. There is nothing to forge because we never make the request; we read a
// feature YouTube ships to every visitor. It needs no Premium (captions never did), no
// account, and no sign-in. It breaks only if YouTube removes the transcript panel from its own
// product, and if that happens no approach survives.
//
// The cost is that it needs a real page. When the user is on the video, that is the tab they
// are already looking at. When they paste a URL, this loads it in a MUTED, INACTIVE background
// tab and closes it — the same machinery web search has used since it shipped (js/tab-nav.js),
// muted before the player can reach for the speakers.
// ─────────────────────────────────────────────────────────────────────────────

import {
  parseYouTubeUrl, captionTracksFromPlayerResponse, videoMetaFromPlayerResponse,
  transcriptFromTracks, parseTimedText, buildTranscriptDocument,
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
  if (!parseYouTubeUrl(grabbed.url)) return null; // a channel or search page, not a video

  // THE PANEL FIRST, because it is the only route that returns anything today.
  const scraped = await inject(tabId, readTranscriptPanel, [timeoutMs]).catch(() => null);
  if (scraped?.ok) {
    return buildTranscriptDocument({
      meta: metaFrom(grabbed, scraped), segments: scraped.segments, source: 'youtube:panel', ...opts,
    });
  }

  // Last resort, and today it returns an empty body every time (see the header). It is kept
  // rather than deleted because it costs one request on a path that has already failed, it is
  // the only route that can serve a language the panel is not showing, and it starts working
  // again by itself if YouTube ever relaxes the token requirement. It must never be first: a
  // route that quietly returns nothing would mask the one that works.
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
