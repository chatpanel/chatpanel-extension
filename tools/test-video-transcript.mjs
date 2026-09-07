// "SUMMARISE THIS VIDEO" MUST NOT SUMMARISE THE COMMENT SECTION.
//
// A YouTube page is a player, a comment thread and a recommendation rail. Every text
// extractor in this extension — captureTab, captureUrl, read_page — returned exactly that,
// which is the worst possible failure shape: text WAS found, so nothing errored, and the
// model answered the wrong question confidently. This file pins what fixes it: the words come
// from a caption track fetched the one way that still works (see below), a page is used only
// when that route rots, and the layer that does it all stays off first paint.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_AUTOMATION_SYSTEM, PAGE_TOOL_SPECS } from '../extension/js/page-tools.js';
import { looksLikeVideoHost } from '../extension/js/source-kind.js';
import { playerResponseFromHtml } from '../extension/js/youtube-transcript.js';
import { parseYouTubeUrl, parseTimedText, formatTranscript } from '../extension/js/events/media-transcript.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// --------------------------------------------------------------------------
// The gate, and the weight behind it
// --------------------------------------------------------------------------

assert.equal(looksLikeVideoHost('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
assert.equal(looksLikeVideoHost('https://youtu.be/dQw4w9WgXcQ'), true);
assert.equal(looksLikeVideoHost('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), true);
// A lookalike host must not admit the transcript layer, and must never be treated as YouTube.
assert.equal(looksLikeVideoHost('https://youtube.com.evil.example/watch?v=x'), false);
assert.equal(looksLikeVideoHost('https://news.example.com/article'), false);

// THE GATE EXISTS TO KEEP THE LAYER OFF FIRST PAINT. If a caller static-imports the
// transcript modules instead, the gate is pointless and 30 KB lands on every panel open.
for (const file of ['../extension/js/context.js', '../extension/js/page-tools.js']) {
  const src = read(file);
  assert.doesNotMatch(src, /^import[^\n]*from '\.\/youtube-transcript\.js'/m,
    `${file} static-imports the transcript layer — it must be await import()ed at the call site`);
  assert.doesNotMatch(src, /^import[^\n]*media-transcript\.js'/m,
    `${file} static-imports the shared caption parser — it must come in with the layer`);
  assert.match(src, /await import\('\.\/youtube-transcript\.js'\)/,
    `${file} never reaches the transcript layer at all`);
  assert.match(src, /looksLikeVideoHost/, `${file} pays for the layer without gating on the host`);
}

// --------------------------------------------------------------------------
// The tools
// --------------------------------------------------------------------------

const readTranscript = PAGE_TOOL_SPECS.find((s) => s.name === 'read_transcript');
assert.ok(readTranscript, 'there is no way for a model to ask for a transcript');
assert.match(readTranscript.description, /READ A VIDEO'S TRANSCRIPT/);
// A model that cannot ask for a language cannot help a user watching a non-English talk.
assert.ok(readTranscript.parameters.properties.language, 'read_transcript cannot be asked for a language');
assert.ok(readTranscript.parameters.properties.timestamps, 'timestamps cannot be turned off');
assert.deepEqual(readTranscript.parameters.required, [], 'the common case must need no arguments');

// A URL NEEDS NO TAB, AND THE MODEL HAS TO KNOW THAT. Without it the only way to reach a
// video the user was not already on is `navigate` — and one real turn did exactly that:
// read_transcript failed, so it navigated the user's tab to YouTube and read it there. The
// user's page is not scratch space for a fetch that takes 350 ms.
assert.ok(readTranscript.parameters.properties.url, 'read_transcript cannot be given a video to read');
assert.match(readTranscript.description, /PASS A URL/);
assert.match(readTranscript.description, /do NOT need to open or\s+.{0,12}navigate to it/,
  'nothing tells the model to stop navigating');
assert.match(PAGE_AUTOMATION_SYSTEM, /read_transcript \{"url":"…"\} — do NOT navigate to it/,
  'the resident manual still leaves navigating as the way to reach another video');

// And the failure message must point at the way forward, not read as "give up".
const pageToolsSrc = read('../extension/js/page-tools.js');
assert.match(pageToolsSrc, /Pass \{"url":"…"\} to read a specific video — you do NOT need to/,
  'the no-transcript error still tells the model only what it cannot do');
assert.match(pageToolsSrc, /async function urlTranscript/, 'there is no tab-free path behind the tool');


// THE DEFAULT PATH MATTERS MORE THAN THE EXPLICIT ONE. A model asked to summarise reaches
// for read_page; if that returns the comment thread, a correctly-specified read_transcript
// it never called has saved nobody.
const pageTools = read('../extension/js/page-tools.js');
const readPageBody = pageTools.slice(pageTools.indexOf("if (name === 'read_page') {"));
assert.match(readPageBody.slice(0, 1200), /looksLikeVideoHost\(await tabUrl\(tabId\)\)/,
  'read_page on a video tab still reads the DOM');
assert.match(readPageBody.slice(0, 1500), /tabTranscript\(tabId/);
// And it must SAY that it substituted, or the model quotes "the page" for something it did
// not read from the page.
assert.match(readPageBody.slice(0, 1800), /This is a VIDEO page/);

// The resident manual has to carry it too — guidance that arrives with the first `page`
// result cannot prevent a mistake made instead of calling `page`.
assert.match(PAGE_AUTOMATION_SYSTEM, /ON A VIDEO PAGE/);
assert.match(PAGE_AUTOMATION_SYSTEM, /spoken words are NOT in the DOM/);
assert.match(PAGE_AUTOMATION_SYSTEM, /Never summarise a video from its page text or its title/);

// --------------------------------------------------------------------------
// THE ROUTE ORDER IS THE FEATURE
// --------------------------------------------------------------------------
//
// Measured against live YouTube, not assumed:
//
//   baseUrl scraped from the watch page HTML, with every combination of
//     fmt / Referer / Origin / session cookies      -> HTTP 200, ZERO BYTES
//   /youtubei/v1/get_transcript, even from INSIDE the real page with its own
//     INNERTUBE context, its params and its session -> 400 FAILED_PRECONDITION
//   /youtubei/v1/player as ANDROID 20.10.38, caption
//     URL taken from ITS response                   -> 60,441 bytes of captions
//
// So the fetch route exists — it is just not the one the HTML advertises. It needs no tab,
// no player and no sound, which is what makes a pasted link answerable instantly, so it goes
// first everywhere. The transcript panel in a real tab is the fallback for when the pinned
// client version rots, and it cannot be version-locked because the player does the work.
const yt = read('../extension/js/youtube-transcript.js');
const tabRoute = yt.slice(yt.indexOf('export async function transcriptFromTab'), yt.indexOf('async function findVideoTab'));
const innertubeAt = tabRoute.indexOf('transcriptViaInnertube');
const panelAt = tabRoute.indexOf('readTranscriptPanel');
const captionsAt = tabRoute.indexOf('transcriptFromTracks');
assert.ok(innertubeAt > 0 && panelAt > 0 && captionsAt > 0, 'a route is missing from the tab path');
assert.ok(innertubeAt < panelAt,
  'the panel is opened before the fetch route is tried — that puts UI on the screen of a user '
  + 'whose tab we could have left completely alone');
assert.ok(panelAt < captionsAt,
  'the page-HTML caption fetch runs before the panel — it returns an empty body every time, '
  + 'so it would mask a route that works');

// A stale client version returns a player response with `captions` MISSING, which reads
// exactly like "this video has no subtitles". That must fall through, never be reported.
assert.match(yt, /NOT an error, and not "no captions" either/,
  'nothing records that an empty tracklist means a stale client, not a video without captions');

// The transcript fetch carries no identity: it works signed out, so it must not send cookies.
assert.match(yt, /credentials: 'omit'/, "the fetch route sends the user's YouTube cookies");
assert.doesNotMatch(yt.slice(yt.indexOf('export async function transcriptViaInnertube'), yt.indexOf('// Reading a tab')),
  /credentials: 'include'/, 'the fetch route sends credentials');

// The panel is read by driving YouTube's own UI, so it must put the page back.
assert.match(yt, /const weOpenedIt = !panelOpen\(\)/, 'nothing tracks whether we opened the panel');
assert.match(yt, /if \(weOpenedIt\) \{/, 'a panel we opened is never closed again');
// A 90-minute talk must not come back as its first three minutes.
assert.match(yt, /scroller\.scrollTop = scroller\.scrollHeight/, 'the transcript list is never scrolled');

// A plain .click(), a full pointer sequence AND a CDP-trusted click were all tried against a
// real page: none opened the panel while the description was collapsed, because the control
// is then a zero-size element inside a collapsed container.
assert.match(yt, /Synthetic clicks do NOT open that panel/, 'the click finding is not recorded');

// THE ONE UNVERIFIABLE BET, HEDGED. The segment element and its class names cannot be checked
// without a browser, so a rename would turn this into a silent "no transcript".
assert.match(yt, /SHAPE-BASED FALLBACK/, 'the segment selectors are an unhedged bet on YouTube internals');
assert.ok(yt.indexOf('SHAPE-BASED FALLBACK') < yt.indexOf('if (weOpenedIt) {'),
  'the panel is closed before the fallback reads it — the fallback would always find nothing');

// --------------------------------------------------------------------------
// A pasted URL: no audio, no tab in the user's way
// --------------------------------------------------------------------------

const urlRoute = yt.slice(yt.indexOf('export async function transcriptFromUrl'));
// NO TAB AT ALL when the fetch route answers — which is the whole point of pasting a link.
assert.ok(urlRoute.indexOf('transcriptViaInnertube') < urlRoute.indexOf('findVideoTab'),
  'a tab is looked for before the tab-free route is even tried');
assert.ok(urlRoute.indexOf('transcriptViaInnertube') < urlRoute.indexOf('chrome.tabs.create'),
  'a tab is CREATED before the tab-free route is tried — that is a window and a sound the '
  + 'user did not ask for');
// Then, only if that failed: a tab already showing the video, before making a new one.
assert.match(urlRoute, /findVideoTab\(parsed\.videoId\)/, 'a tab already showing the video is ignored');
// A transcript needs a real page, so one is made — but it must never take over the screen…
assert.match(urlRoute, /chrome\.tabs\.create\(\{ url: parsed\.url, active: false \}\)/,
  'the background tab is created active — it would steal the user\'s screen');
// …must never make a sound (a watch page opened in the background starts playing)…
assert.match(urlRoute, /chrome\.tabs\.update\(tabId, \{ muted: true \}\)/,
  'the background tab is not muted — asking for a summary would play the video out loud');
// …and must not be left behind.
assert.match(urlRoute, /finally \{[\s\S]*chrome\.tabs\.remove\(tabId\)/,
  'the background tab is never closed');
// Muting has to happen before anything is awaited on the loaded page, or the player gets a
// head start on the speakers.
assert.ok(urlRoute.indexOf('muted: true') < urlRoute.indexOf('waitForTabComplete'),
  'the tab is muted only after the navigation is awaited — too late to be silent');

// The findings above are recorded where the next person will look, not only in a commit.
assert.match(yt, /HTTP 200, ZERO BYTES/, 'the measured reason for this design is not written down');
assert.match(yt, /FAILED_PRECONDITION/);
assert.match(yt, /no sign-in and no Premium/, 'the entitlement facts are not written down');

// --------------------------------------------------------------------------
// Reading the player response out of watch-page HTML
// --------------------------------------------------------------------------

// The brace matcher is the part that breaks when YouTube reshuffles its bootstrap script,
// so it is pinned against the shape that actually ships: braces inside strings, an escaped
// quote, and a second assignment after it.
const HTML = `<!DOCTYPE html><html><head><title>x</title></head><body>
<script nonce="abc">var meta = {"unrelated":true};</script>
<script nonce="abc">var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"A talk about { braces } and \\"quotes\\"","author":"Example Channel","lengthSeconds":"600","shortDescription":"see }{ this"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=1","languageCode":"en","name":{"simpleText":"English"}}]}}};var other = 1;</script>
<script>window.ytcfg = {"x":1};</script></body></html>`;

const pr = playerResponseFromHtml(HTML);
assert.ok(pr, 'the player response could not be found in a normal watch page');
assert.equal(pr.videoDetails.videoId, 'dQw4w9WgXcQ');
assert.equal(pr.videoDetails.title, 'A talk about { braces } and "quotes"');
assert.equal(pr.captions.playerCaptionsTracklistRenderer.captionTracks.length, 1);

// An earlier mention that is NOT the assignment must not win.
assert.equal(playerResponseFromHtml('ytInitialPlayerResponse{"nope":1}'), null,
  'a blob with no videoDetails and no captions was accepted as the player response');
assert.equal(playerResponseFromHtml('<html><body>Sign in</body></html>'), null);
assert.equal(playerResponseFromHtml(''), null);

// --------------------------------------------------------------------------
// End to end, on the shape a real track has
// --------------------------------------------------------------------------

const JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'we start' }] },
    { tStartMs: 2000, dDurationMs: 2000 },
    { tStartMs: 62_000, dDurationMs: 2000, segs: [{ utf8: 'a minute in' }] },
  ],
});
const segs = parseTimedText(JSON3);
assert.equal(segs.length, 2, 'the empty timing event became a segment');
assert.match(formatTranscript(segs), /\[1:02\] a minute in/, 'a moment cannot be cited');

// The canonical id is what makes a Short and its /watch twin the same video.
assert.equal(parseYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');

// --------------------------------------------------------------------------
// Discoverability: the fallback chips
// --------------------------------------------------------------------------

// Smart suggestions are OFF by default, so the fallbacks are what most users ever see — and
// on a talk they used to invite a summary of the comment thread.
const { fallbacksFor, FALLBACK_SUGGESTIONS, VIDEO_SUGGESTIONS } = await import('../extension/js/suggestions.js');
assert.deepEqual(fallbacksFor({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), VIDEO_SUGGESTIONS);
assert.match(VIDEO_SUGGESTIONS[0], /Summarize this video/);
assert.deepEqual(fallbacksFor({ url: 'https://example.com/article' }), FALLBACK_SUGGESTIONS);
// The panel is interactive before any tab is resolved, so this must survive no tab at all.
assert.deepEqual(fallbacksFor(null), FALLBACK_SUGGESTIONS);
assert.deepEqual(fallbacksFor({}), FALLBACK_SUGGESTIONS);

console.log('✓ video transcripts: fetch route first (no tab, no sound), panel as fallback, layer off first paint');
