// GENERATED — do not edit.
// Source of truth: chatpanel-events/media-transcript.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Video transcripts, as a contract rather than as a scraper.
//
// "Summarise this video" is the same question as "summarise this page" — the only
// difference is where the words live. On a video page the words are NOT in the DOM: the
// article body a reader would summarise is a caption track, fetched separately, published
// in four different serialisations, and duplicated once per language plus once more for
// the machine-generated version.
//
// So the CHOOSING and the PARSING live here, not in a client:
//   • which of eleven caption tracks is the one the user meant (manual over ASR, their
//     language over the uploader's, an explicit ask over both);
//   • json3 / srv3 / srv1 XML / WebVTT / SRT → one segment list;
//   • segments → readable paragraphs with timestamps you can cite and click.
//
// None of that needs a browser, and every client will need all of it: the extension reads
// the tab, the bridge may be handed a URL by a CLI agent, the gateway may be asked to
// summarise one server-side, and a mobile app has no DOM to scrape at all. Written inside
// the extension it would be copied three times and would disagree three ways about which
// track is "the" transcript.
//
// WHAT IS NOT HERE: fetching. Every platform gates caption URLs on the session that asked
// (cookies, origin, a consent cookie, a per-load token), so the FETCH has to happen where
// that session is — in the page for the extension, behind the user's own credentials for a
// CLI. Callers pass a `fetchText` in; this module never reaches the network, which is also
// what keeps it testable and dependency-free.

/** Hostnames that serve YouTube watch pages. */
export const YOUTUBE_HOSTS = Object.freeze([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** `1h2m3s`, `90s`, `90` → seconds. Returns 0 for anything unparseable. */
function parseTimeParam(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/**
 * Recognise a YouTube video URL in any of the shapes people actually paste.
 *
 * Every surface has its own: /watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/, and the
 * mobile and music hosts on top. Matching only /watch?v= — the one everybody writes first —
 * silently drops Shorts, which is most of what gets pasted into a chat.
 *
 * @returns {{videoId: string, start: number, url: string} | null}
 */
export function parseYouTubeUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const known = YOUTUBE_HOSTS.some((h) => host === h.replace(/^www\./, ''));
  if (!known) return null;

  let id = '';
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] || '';
  } else {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = u.searchParams.get('v') || '';
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
  }
  if (!VIDEO_ID_RE.test(id)) return null;
  const start = parseTimeParam(u.searchParams.get('t') || u.searchParams.get('start'));
  return { videoId: id, start, url: `https://www.youtube.com/watch?v=${id}` };
}

export function isYouTubeUrl(input) {
  return parseYouTubeUrl(input) !== null;
}

// --------------------------------------------------------------------------
// Track selection
// --------------------------------------------------------------------------

/** Normalise one YouTube captionTracks entry into the shape the rest of this file uses. */
function normalizeTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const baseUrl = String(t.baseUrl || t.url || '');
  if (!baseUrl) return null;
  const name = t.name?.simpleText
    || t.name?.runs?.map((r) => r.text).join('')
    || String(t.label || '');
  return {
    baseUrl,
    lang: String(t.languageCode || t.lang || '').toLowerCase(),
    name: name || '',
    // `asr` is YouTube's marker for the machine-generated track. It is usually the ONLY
    // track on a video, so it must never be filtered out — only ranked below a human one.
    generated: String(t.kind || '') === 'asr' || /auto-generated/i.test(name),
    translatable: t.isTranslatable !== false,
  };
}

/**
 * Pull the caption tracks (and the video's own metadata) out of a YouTube player response.
 *
 * The player response is the JSON blob the watch page hands its player. Reading captions
 * from it is what every open-source transcript library does, because it is the only place
 * the *signed* caption URLs exist — they carry an expiring signature, so a URL guessed
 * from the video id is rejected, and one copied from a previous load has expired.
 */
export function captionTracksFromPlayerResponse(pr) {
  const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeTrack).filter(Boolean);
}

export function videoMetaFromPlayerResponse(pr) {
  const d = pr?.videoDetails || {};
  const videoId = String(d.videoId || '');
  const seconds = Number(d.lengthSeconds || 0) || 0;
  return {
    videoId,
    title: String(d.title || ''),
    author: String(d.author || ''),
    durationSec: seconds,
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
    // The uploader's own description is frequently where the links, chapters and
    // corrections live — a summary that ignores it misses what the video points at.
    description: String(d.shortDescription || ''),
    live: !!d.isLiveContent,
  };
}

/** `en-GB` and `en_gb` both mean the `en` family. */
function langFamily(code) {
  return String(code || '').toLowerCase().replace('_', '-').split('-')[0];
}

/**
 * Choose the track to read.
 *
 * Ranked, not filtered: a video with only an auto-generated Hindi track must still return
 * that track for an English-preferring user, because the alternative is telling them there
 * is no transcript when there plainly is one. Preference order:
 *
 *   1. an explicitly requested language (exact code beats family)
 *   2. one of the user's preferred languages
 *   3. a human-written track over the machine one
 *   4. the order YouTube itself listed them (its own default is first)
 */
export function pickCaptionTrack(tracks, { language = '', languages = ['en'] } = {}) {
  const list = (Array.isArray(tracks) ? tracks : []).map(normalizeTrack).filter(Boolean);
  if (!list.length) return null;
  const wanted = String(language || '').toLowerCase();
  const prefs = (wanted ? [wanted] : languages || []).map((l) => String(l).toLowerCase());
  const score = (t, i) => {
    let s = 0;
    const exact = prefs.indexOf(t.lang);
    const family = prefs.findIndex((p) => langFamily(p) === langFamily(t.lang));
    if (exact >= 0) s += 1000 - exact * 10;
    else if (family >= 0) s += 800 - family * 10;
    if (!t.generated) s += 100;
    return s - i; // stable: YouTube's own ordering breaks every remaining tie
  };
  return list
    .map((t, i) => ({ t, s: score(t, i) }))
    .sort((a, b) => b.s - a.s)[0].t;
}

// --------------------------------------------------------------------------
// The InnerTube player request — how a caption URL that WORKS is obtained
// --------------------------------------------------------------------------
//
// The caption URLs printed into the watch page's HTML answer HTTP 200 with an EMPTY BODY —
// measured on every video tried, with and without session cookies, Referer and Origin. The
// ones returned by the InnerTube player endpoint for the ANDROID client do not.
//
// AND THE CLIENT VERSION IS THE WHOLE DIFFERENCE, which is worth stating because it is
// invisible and it will go stale:
//
//   clientVersion 20.10.38  -> 1 track,  60,441 bytes of captions
//   clientVersion 19.09.37  -> no captionTracks at all
//   clientVersion 17.31.35  -> no captionTracks at all
//
// A stale version does not error. It returns a well-formed player response with the
// `captions` block missing, which reads exactly like "this video has no subtitles" — so the
// failure mode of letting this rot is a feature that quietly claims videos have no captions.
// tests/media-transcript.test.js pins the shape; a live check is the client's job.

/** The InnerTube client whose player response carries usable caption URLs. */
export const INNERTUBE_ANDROID = Object.freeze({ clientName: 'ANDROID', clientVersion: '20.10.38' });

/** The public InnerTube key is printed into every watch page; it is not a secret. */
export function innertubeApiKeyFromHtml(html) {
  const m = /"INNERTUBE_API_KEY":\s*"([^"]+)"/.exec(String(html || ''))
    || /INNERTUBE_API_KEY\\":\\"([^\\"]+)/.exec(String(html || ''));
  return m ? m[1] : '';
}

/**
 * The request to make, as data — so the caller performs it wherever its network is.
 *
 * Returned rather than sent for the same reason nothing else here fetches: the extension, the
 * bridge and a mobile client each have their own idea of what "fetch" means, and this file
 * has to run in all three.
 */
export function innertubePlayerRequest(videoId, { apiKey = '', client = INNERTUBE_ANDROID } = {}) {
  if (!videoId) return null;
  const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
  return {
    url: `https://www.youtube.com/youtubei/v1/player${query}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: { ...client } }, videoId }),
  };
}

/**
 * Ask a caption URL for a specific serialisation.
 *
 * json3 is the one to want: it is the only format that reports per-segment durations
 * reliably, and it needs no XML parser — which matters because a DOMParser does not exist
 * in a service worker, in Node, or in a mobile JS runtime.
 */
export function timedTextUrl(baseUrl, { fmt = 'json3', language = '' } = {}) {
  let u;
  try {
    u = new URL(String(baseUrl || ''));
  } catch {
    return '';
  }
  if (fmt) u.searchParams.set('fmt', fmt);
  // Ask YouTube to translate only when the track we found is not already the language
  // asked for; `tlang` on a matching track returns a machine round-trip of itself.
  if (language) u.searchParams.set('tlang', language);
  return u.toString();
}

// --------------------------------------------------------------------------
// Parsing — four serialisations, one segment list
// --------------------------------------------------------------------------

const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};

/** Caption text is double-escaped on the XML endpoints (`&amp;#39;` for an apostrophe). */
function decodeEntities(s) {
  let out = String(s || '');
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      }
      const hit = XML_ENTITIES[name.toLowerCase()];
      return hit === undefined ? m : hit;
    });
    if (!/&[a-zA-Z#]/.test(out)) break;
  }
  return out;
}

// Only the tags a caption track actually carries. A blanket `<[^>]*>` strip would also
// eat `<tag>` where the speaker said "angle bracket tag" and the track escaped it.
const CAPTION_MARKUP_RE = /<\/?(?:i|b|u|s|br|font|v|c|ruby|rt|rp)\b[^>]*>/gi;

/**
 * Caption text, as text.
 *
 * ORDER MATTERS TWICE. Literal markup is stripped BEFORE decoding, because srv3 wraps every
 * word in an `<s>` span for karaoke timing. Then entities are decoded — twice, since the XML
 * endpoints double-escape (`&amp;#39;` for an apostrophe) — and markup is stripped once more,
 * because `<i>` reaches us escaped rather than literal on some tracks. Decoding first would
 * turn an escaped `&lt;tag&gt;` the speaker actually said into markup and delete it.
 */
function cleanText(s) {
  return decodeEntities(String(s || '').replace(CAPTION_MARKUP_RE, ''))
    .replace(CAPTION_MARKUP_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `00:01:02.500` / `01:02,500` / `62.5` → milliseconds. */
function parseClock(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.round(sec * 1000);
}

function parseJson3(body) {
  let doc;
  try {
    doc = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.events)) return null;
  const out = [];
  for (const ev of doc.events) {
    const text = cleanText((ev?.segs || []).map((s) => s?.utf8 || '').join(''));
    if (!text) continue; // json3 emits empty timing-only events between cues
    out.push({
      start: Number(ev.tStartMs) || 0,
      dur: Number(ev.dDurationMs) || 0,
      text,
    });
  }
  return out;
}

function parseTimedTextXml(body) {
  const src = String(body || '');
  if (!/<(transcript|timedtext|text|p)\b/i.test(src)) return null;
  const out = [];
  // srv1 uses <text start dur>, srv3 uses <p t d>. One regex over both beats requiring a
  // DOMParser that half our runtimes do not have.
  const re = /<(?:text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    const num = (name) => {
      const a = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs);
      return a ? Number(a[1]) : NaN;
    };
    const startSec = num('start');
    const startMs = Number.isFinite(startSec) ? startSec * 1000 : num('t');
    const durSec = num('dur');
    const durMs = Number.isFinite(durSec) ? durSec * 1000 : num('d');
    const text = cleanText(m[2]);
    if (!text) continue;
    out.push({
      start: Math.round(Number.isFinite(startMs) ? startMs : 0),
      dur: Math.round(Number.isFinite(durMs) ? durMs : 0),
      text,
    });
  }
  return out.length ? out : null;
}

function parseCueList(body, sepRe) {
  const blocks = String(body || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    const timeIdx = lines.findIndex((l) => sepRe.test(l));
    if (timeIdx < 0) continue;
    const [rawStart, rawEnd] = lines[timeIdx].split(sepRe);
    const start = parseClock(rawStart);
    const end = parseClock(String(rawEnd || '').split(/\s+/)[0]);
    const text = cleanText(lines.slice(timeIdx + 1).join(' '));
    if (!text || !Number.isFinite(start)) continue;
    out.push({ start, dur: Number.isFinite(end) ? Math.max(0, end - start) : 0, text });
  }
  return out.length ? out : null;
}

const parseVtt = (body) => parseCueList(body, /\s*-->\s*/);

/**
 * Any caption serialisation → `[{ start, dur, text }]` (milliseconds), sniffed by content.
 *
 * Sniffing rather than trusting a declared format: the same `fmt=json3` URL answers with
 * XML when the parameter is dropped by a proxy or the track predates json3, and a parser
 * chosen from the request instead of the response fails on exactly those.
 */
export function parseTimedText(body) {
  const src = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (!src.trim()) return [];
  return parseJson3(src) || parseTimedTextXml(src) || parseVtt(src) || [];
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/** ms → `m:ss`, or `h:mm:ss` once it earns the hour. */
export function formatTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Caption cues → paragraphs.
 *
 * Cues are 2-6 words long and arrive several per second; handed over raw, a 40-minute talk
 * is 8,000 lines of fragments in which nothing is a sentence. The model then spends its
 * attention on reassembly rather than on the content, and every quote it produces is a
 * fragment. Grouping by a time budget (and by a real pause) restores paragraphs and cuts
 * the token count roughly in half by removing the line breaks alone.
 */
export function groupSegments(segments, { windowMs = 30000, gapMs = 2500 } = {}) {
  const list = (Array.isArray(segments) ? segments : []).filter((s) => s && s.text);
  const out = [];
  let cur = null;
  let prevEnd = 0;
  for (const seg of list) {
    const start = Number(seg.start) || 0;
    const gap = start - prevEnd;
    const tooLong = cur && start - cur.start >= windowMs;
    const paused = cur && prevEnd > 0 && gap >= gapMs;
    if (!cur || tooLong || paused) {
      cur = { start, text: seg.text };
      out.push(cur);
    } else {
      cur.text += ' ' + seg.text;
    }
    prevEnd = start + (Number(seg.dur) || 0);
  }
  // Auto-generated tracks repeat the tail of each cue as the head of the next (a rolling
  // two-line caption). Left in, roughly a third of the transcript is duplicated text.
  for (const p of out) p.text = dedupeOverlap(p.text);
  return out;
}

/**
 * Collapse an immediately-repeated run of words: `a b c b c d` → `a b c d`.
 *
 * The rolling two-line caption an auto-generated track emits means each cue re-states the
 * tail of the one before it, so a naive join duplicates roughly a third of the transcript.
 * Longest run first, so `b c b c` collapses as one four-word repeat rather than twice.
 */
function dedupeOverlap(text) {
  const words = String(text || '').split(' ');
  for (let k = Math.min(12, words.length >> 1); k >= 3; k--) {
    for (let i = 0; i + 2 * k <= words.length; i++) {
      let same = true;
      for (let j = 0; j < k && same; j++) same = words[i + j] === words[i + k + j];
      if (same) { words.splice(i + k, k); i--; }
    }
  }
  return words.join(' ');
}

export const TRANSCRIPT_MAX_CHARS = 120_000;

/**
 * Segments → the text a model reads.
 *
 * Timestamps are kept by default and are not decoration: they are what lets an answer say
 * "at 12:04 they say…", and what lets the panel turn that into a link that seeks the video.
 */
export function formatTranscript(segments, {
  timestamps = true, windowMs = 30000, gapMs = 2500, maxChars = TRANSCRIPT_MAX_CHARS,
} = {}) {
  const groups = groupSegments(segments, { windowMs, gapMs });
  const lines = groups.map((g) => (timestamps ? `[${formatTimestamp(g.start)}] ${g.text}` : g.text));
  const text = lines.join('\n\n');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…[transcript truncated at ${maxChars} characters]`;
}

/**
 * The whole thing a caller attaches or hands a model: metadata header + transcript body.
 *
 * The header exists because a transcript alone is anonymous. "Summarise this" over bare
 * caption text produces a summary that cannot say what it summarised, and a model that
 * cannot see the duration guesses at the shape of what it is reading.
 */
export function buildTranscriptDocument({
  meta = {}, segments = [], language = '', generated = false, source = '', ...opts
} = {}) {
  const head = [];
  if (meta.title) head.push(`# ${meta.title}`);
  const facts = [];
  if (meta.author) facts.push(`Channel: ${meta.author}`);
  if (meta.durationSec) facts.push(`Duration: ${formatTimestamp(meta.durationSec * 1000)}`);
  if (language) facts.push(`Captions: ${language}${generated ? ' (auto-generated)' : ''}`);
  if (meta.url) facts.push(`URL: ${meta.url}`);
  if (facts.length) head.push(facts.join(' · '));
  const desc = String(meta.description || '').trim();
  if (desc) head.push(`## Description\n${desc.slice(0, 2000)}`);
  head.push('## Transcript');
  const body = formatTranscript(segments, opts);
  const text = `${head.join('\n\n')}\n\n${body}`;
  return {
    title: meta.title || 'Video transcript',
    url: meta.url || '',
    language,
    generated,
    source,
    segments: segments.length,
    durationSec: meta.durationSec || 0,
    text,
    chars: text.length,
  };
}

/**
 * The one orchestration worth sharing: tracks → chosen track → fetched body → document.
 *
 * `fetchText(url)` is injected, because WHERE the fetch runs is the entire reliability
 * story and it differs per client (see the header). Everything either side of it is
 * identical everywhere, so it lives here and gets tested with a fake fetch.
 */
export async function transcriptFromTracks({
  tracks, meta = {}, fetchText, language = '', languages = ['en'], source = '', ...opts
} = {}) {
  const track = pickCaptionTrack(tracks, { language, languages });
  if (!track) return null;
  // Only ask for a translation when the track genuinely is not the language wanted.
  const wantTranslation = !!language && langFamily(track.lang) !== langFamily(language);
  const attempts = [
    timedTextUrl(track.baseUrl, { fmt: 'json3', language: wantTranslation ? language : '' }),
    timedTextUrl(track.baseUrl, { fmt: 'srv1', language: wantTranslation ? language : '' }),
    track.baseUrl,
  ].filter(Boolean);
  for (const url of attempts) {
    let body;
    try {
      body = await fetchText(url);
    } catch {
      continue; // a format the endpoint refuses is a reason to try the next, not to fail
    }
    const segments = parseTimedText(body);
    if (segments.length) {
      return buildTranscriptDocument({
        meta, segments, language: track.lang, generated: track.generated, source, ...opts,
      });
    }
  }
  return null;
}
