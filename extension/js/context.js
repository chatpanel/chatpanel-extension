// Browser context capture. Turns what's in the browser into attachable text:
//   • the active tab, or any/several open tabs (readable content extracted)
//   • a pasted URL (fetched and reduced to readable text)
//
// Attachments have the shape:
//   { id, kind: 'page' | 'url' | 'selection' | 'meeting', title, url, text, chars }

import { meetingPlatform, meetingToText, getMeeting } from './store-meetings.js';

export { meetingPlatform };

const MAX_CHARS = 30_000; // per attachment, before the model ever sees it (~7.5k tokens)

function truncate(text, max = MAX_CHARS) {
  if (!text) return '';
  return text.length > max
    ? text.slice(0, max) + `\n\n…[truncated ${text.length - max} chars]`
    : text;
}

// --------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------
export async function listTabs({ currentWindowOnly = false } = {}) {
  const query = currentWindowOnly ? { currentWindow: true } : {};
  const tabs = await chrome.tabs.query(query);
  return tabs
    .filter((t) => t.url && /^https?:/.test(t.url))
    .map((t) => ({
      id: t.id,
      title: t.title || t.url,
      url: t.url,
      favIconUrl: t.favIconUrl || '',
      active: !!t.active,
      windowId: t.windowId,
    }));
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// Injected into the page to pull readable content. Must be fully self-contained.
export function extractReadable() {
  const clone = document.cloneNode(true);
  clone
    .querySelectorAll('script,style,noscript,svg,iframe,canvas,template')
    .forEach((el) => el.remove());
  // Prefer the most content-ish container if present.
  const main =
    clone.querySelector('main,article,[role="main"]') || clone.body || clone.documentElement;
  const text = (main.innerText || main.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const selection = (window.getSelection && String(window.getSelection())) || '';
  return {
    title: document.title || location.href,
    url: location.href,
    text,
    selection: selection.trim(),
  };
}

// --------------------------------------------------------------------------
// Our own extension pages (notes / meetings / chat history)
// --------------------------------------------------------------------------
// Chrome forbids chrome.scripting.executeScript on chrome-extension:// pages, so
// "read the current tab" can never work on notes.html / meetings.html /
// history.html. We don't need it to: each of those pages carries its record id in
// the URL hash (e.g. notes.html#<id>, written by notes.js), and we own the
// storage — so we read the record straight from chrome.storage.local by id,
// decrypt included. No content script, no host permission.

// Which of our own dashboards is this tab, if any? Returns 'note' | 'meeting' |
// 'chat' | null. Matched against our own extension origin so another extension's
// same-named page can't spoof it.
function ownPageKind(url) {
  let base;
  try {
    base = chrome.runtime.getURL('');
  } catch {
    return null;
  }
  const u = String(url || '');
  if (!base || !u.startsWith(base)) return null;
  const path = u.slice(base.length).replace(/^\/+/, '');
  if (path.startsWith('notes.html')) return 'note';
  if (path.startsWith('meetings.html')) return 'meeting';
  if (path.startsWith('history.html')) return 'chat';
  return null;
}

// True if `url` is one of our own readable dashboard pages. The side panel uses
// this to auto-include the open note/meeting/chat as context WITHOUT arming DOM
// page-action tools on our own UI (those stay gated on http(s) tabs).
export function isOwnDashboardUrl(url) {
  return ownPageKind(url) !== null;
}

function hashId(url) {
  const i = String(url || '').indexOf('#');
  if (i < 0) return '';
  const raw = String(url).slice(i + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function ownAttachment(kind, id, title, url, text) {
  return {
    id: `${kind}_${id}_${Date.now()}`,
    kind: 'page',
    title: title || kind,
    url,
    text: truncate(text),
    chars: (text || '').length,
  };
}

// Turn one of our own dashboard tabs into an attachment by reading its record from
// storage by the tab's hash id. Returns null if `tab` isn't one of our pages (so
// captureTab falls through to normal injection); throws a helpful message if it IS
// our page but nothing is open / the record is missing. The heavy stores are
// dynamic-imported here so they stay off the panel's first-paint graph.
export async function captureOwnPage(tab) {
  const kind = ownPageKind(tab?.url);
  if (!kind) return null;
  const label = kind === 'chat' ? 'chat' : kind;
  const id = hashId(tab.url);
  if (!id) throw new Error(`No ${label} is open in that tab yet — open one, then attach it.`);

  // COLD-tier seam: when a record isn't in local (hot) storage, this is where a
  // gateway/warm fetch by id would go once storage tiering ships. Today every
  // record lives in chrome.storage.local, so a miss means it's genuinely gone.
  if (kind === 'note') {
    const { getNote, noteToMarkdown } = await import('./store-notes.js');
    const rec = await getNote(id);
    if (!rec) throw new Error(`That note isn't in local storage (id ${id}).`);
    return ownAttachment('note', id, rec.title, tab.url, noteToMarkdown(rec));
  }
  if (kind === 'meeting') {
    const rec = await getMeeting(id);
    if (!rec) throw new Error(`That meeting isn't in local storage (id ${id}).`);
    return ownAttachment('meeting', id, `🎙 ${rec.title || 'Meeting'}`, tab.url, meetingToText(rec));
  }
  const { getConversation, conversationToMarkdown } = await import('./store.js');
  const conv = await getConversation(id);
  if (!conv) throw new Error(`That chat isn't in local storage (id ${id}).`);
  return ownAttachment('chat', id, conv.title, tab.url, conversationToMarkdown(conv));
}

export async function captureTab(tabId) {
  // Our own extension pages can't be script-injected — read them from storage by
  // their hash id instead. Any error from captureOwnPage (no record open, etc.)
  // is intentional and surfaces to the caller; a failed chrome.tabs.get just falls
  // through to the normal injection path below.
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    /* tab vanished or unavailable — fall through to injection */
  }
  if (tab) {
    const own = await captureOwnPage(tab);
    if (own) return own;
  }

  let result;
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractReadable,
    });
    result = inj?.result;
  } catch (e) {
    throw new Error(
      `Couldn't read that tab (${e.message}). Chrome blocks reading some pages (chrome://, the Web Store, PDFs).`,
    );
  }
  if (!result) throw new Error('No content extracted from that tab.');
  return {
    id: `att_${tabId}_${Date.now()}`,
    kind: 'page',
    title: result.title,
    url: result.url,
    text: truncate(result.text),
    chars: result.text.length,
  };
}

export async function captureActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab.');
  return captureTab(tab.id);
}

// Just the user's current selection in the active tab (if any).
export async function captureSelection() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab.');
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractReadable,
  });
  const r = inj?.result;
  if (!r?.selection) throw new Error('Nothing is selected on the page.');
  return {
    id: `sel_${tab.id}_${Date.now()}`,
    kind: 'selection',
    title: `Selection — ${r.title}`,
    url: r.url,
    text: truncate(r.selection),
    chars: r.selection.length,
  };
}

// --------------------------------------------------------------------------
// Live meetings (Pro) — talk to the capture content script in a meeting tab.
// The DOM scraping + transcript buffer live in content/meeting-core.js; here we
// just message the tab and turn the buffer into an attachment. Gating is the
// caller's job (see the side panel's liveMeetings check).
// --------------------------------------------------------------------------
// Send a message to a SPECIFIC frame of a tab (frameId omitted → all frames,
// first response wins). The new Zoom client renders the meeting (and captions) in
// an iframe, so we must target that frame, not the empty top-level shell.
function sendToTab(tabId, message, frameId) {
  return new Promise((resolve) => {
    const opts = frameId === undefined ? {} : { frameId };
    try {
      chrome.tabs.sendMessage(tabId, message, opts, (resp) => {
        if (chrome.runtime.lastError) return resolve(null); // no listener in that frame
        resolve(resp || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function getAllFrames(tabId) {
  try {
    return (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {
    return [];
  }
}

// Find the frame actually running our capture with the real meeting UI. We ping
// every frame and pick the responder with the most DOM elements — the meeting
// iframe has thousands; the shell frame has ~150. Cached briefly so Start→Get→Stop
// all hit the same frame. Returns { frameId, ping } or null.
const _frameCache = new Map(); // tabId → { frameId, at }
async function resolveMeetingFrame(tabId) {
  const cached = _frameCache.get(tabId);
  if (cached && Date.now() - cached.at < 4000) {
    const ping = await sendToTab(tabId, { type: 'CP_MEETING_PING' }, cached.frameId);
    // Trust the cache only while it's actively capturing or already in-call; if it
    // reports neither, fall through to a full scan so a stale/empty frame can't
    // mask another frame that holds the meeting toolbar (joined-state detection).
    if (ping?.ok && (ping.capturing || ping.inCall)) return { frameId: cached.frameId, ping };
  }
  const frames = await getAllFrames(tabId);
  const ids = frames.length ? frames.map((f) => f.frameId) : [undefined];
  const pings = await Promise.all(
    ids.map(async (frameId) => ({ frameId, ping: await sendToTab(tabId, { type: 'CP_MEETING_PING' }, frameId) })),
  );
  const ok = pings.filter((x) => x.ping?.ok);
  if (!ok.length) return null;
  ok.sort((a, b) => (b.ping.els || 0) - (a.ping.els || 0));
  const best = ok[0];
  // The meeting UI can be split across frames (e.g. captions in one, the control
  // bar in another). Join/live state is "are we in the call at all", so OR it
  // across every responding frame rather than reading only the chosen one.
  best.ping.inCall = ok.some((x) => x.ping?.inCall) || !!best.ping.inCall;
  best.ping.live = ok.some((x) => x.ping?.live) || !!best.ping.live;
  _frameCache.set(tabId, { frameId: best.frameId, at: Date.now() });
  return best;
}

// Is the capture content script present and on a recognised meeting? Returns the
// meeting frame's ping payload ({platform, live, ready, capturing, els, …}) or null.
export async function probeMeeting(tabId) {
  const f = await resolveMeetingFrame(tabId);
  return f?.ping || null;
}

// Begin / end capture in the meeting frame (the status bar's Start/Stop controls).
export async function startMeeting(tabId) {
  const f = await resolveMeetingFrame(tabId);
  return sendToTab(tabId, { type: 'CP_MEETING_START' }, f?.frameId);
}
export async function stopMeeting(tabId) {
  const f = await resolveMeetingFrame(tabId);
  return sendToTab(tabId, { type: 'CP_MEETING_STOP' }, f?.frameId);
}
// Manually (re)trigger the platform's "turn on captions" automation — the meeting
// bar's fallback button when auto-enable hasn't taken (host menus, late toolbars).
export async function enableMeetingCaptions(tabId) {
  const f = await resolveMeetingFrame(tabId);
  return sendToTab(tabId, { type: 'CP_MEETING_ENABLE_CC' }, f?.frameId);
}

// Fetch the raw meeting record (segments + chat) from the capturing frame, or null
// if nothing is capturing. Used by the live scribe to compute the transcript delta.
export async function getMeetingRecord(tabId) {
  const f = await resolveMeetingFrame(tabId);
  if (!f?.ping?.ok || !f.ping.capturing) return null;
  const res = await sendToTab(tabId, { type: 'CP_MEETING_GET' }, f.frameId);
  return res?.record || null;
}

// Run the in-page caption probe in EVERY frame and return one report per frame, so
// we can see both the shell (with its iframe src) and the meeting frame at once.
export async function diagnoseMeeting(tabId, needle = '') {
  const frames = await getAllFrames(tabId);
  const ids = frames.length ? frames.map((f) => f.frameId) : [undefined];
  const reports = [];
  for (const frameId of ids) {
    const res = await sendToTab(tabId, { type: 'CP_MEETING_DEBUG', needle }, frameId);
    if (res?.report) {
      const meta = frames.find((f) => f.frameId === frameId);
      reports.push({ frameId, frameUrl: meta?.url, ...res.report });
    }
  }
  return reports.length === 1 ? reports[0] : { tabId, frameCount: ids.length, frames: reports };
}

// Capture the current transcript from a meeting tab as an attachment. Starts the
// capture if it isn't already running. `sinceTs` keeps only recent segments (a
// rolling window) so a periodic live-summary stays bounded.
export async function captureMeetingTranscript(tabId, { sinceTs = 0 } = {}) {
  const f = await resolveMeetingFrame(tabId);
  const ping = f?.ping;
  if (!ping?.ok) {
    throw new Error('No meeting detected on this tab. Open the meeting in the browser (web client) and try again.');
  }
  if (ping.ready === false) {
    throw new Error(`Live capture for this platform isn't available yet (${ping.platform}). Zoom web client is supported today.`);
  }
  if (!ping.capturing) await sendToTab(tabId, { type: 'CP_MEETING_START' }, f.frameId);
  const res = await sendToTab(tabId, { type: 'CP_MEETING_GET' }, f.frameId);
  const rec = res?.record;
  if (!rec) throw new Error('Capture started — no transcript yet. Make sure live captions are turned on in the meeting.');
  const text = meetingToText(rec, { sinceTs });
  return {
    id: `mtg_${rec.id}_${Date.now()}`,
    kind: 'meeting',
    meetingId: rec.id,
    platform: rec.platform,
    title: `🎙 ${rec.title || 'Meeting'} (live)`,
    url: rec.url,
    text: truncate(text),
    chars: text.length,
  };
}

// --------------------------------------------------------------------------
// URL fetch (host_permissions grant cross-origin fetch from the panel)
// --------------------------------------------------------------------------

// SSRF guard: the panel fetches with <all_urls> host permission, so a pasted (or
// redirected-to) URL could otherwise reach the local bridge, cloud metadata, or
// the LAN and ship the response to the configured model. Block private/loopback/
// link-local/metadata hosts and non-http(s) schemes — on the initial URL AND on
// the final URL after redirects.
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10)
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;        // this-host / loopback / RFC1918
    if (a === 169 && b === 254) return true;                  // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;         // RFC1918
    if (a === 192 && b === 168) return true;                  // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
  }
  return false;
}

// Strip resource-referencing tags from fetched HTML BEFORE handing it to
// DOMParser. A DOMParser document is inert (no scripts run), BUT Chrome's preload
// scanner still speculatively fetches <link rel=preload/stylesheet>, <img>, etc.
// during parsing — and the panel's strict CSP then logs each as a blocked load,
// flooding the extension console. Removing those tags up front keeps parsing
// truly inert and the console clean, while <title>/<meta>/text are preserved.
export function stripResourceTags(html) {
  return String(html || '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<source\b[^>]*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '');
}

export function assertFetchable(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be fetched (got "${parsed.protocol}")`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Refusing to fetch a private/loopback/metadata address (${parsed.hostname})`);
  }
  return parsed;
}

export async function captureUrl(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  assertFetchable(url); // block obvious private targets up front
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    throw new Error(`Couldn't fetch ${url} — ${e.message}`);
  }
  // A redirect may have landed on an internal host — refuse to surface its body.
  if (res.url) assertFetchable(res.url);
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
  const ct = res.headers.get('content-type') || '';
  const body = await res.text();

  let title = url;
  let text = body;
  if (ct.includes('html')) {
    const doc = new DOMParser().parseFromString(stripResourceTags(body), 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,iframe,header,footer,nav,aside').forEach((el) =>
      el.remove(),
    );
    title = doc.title || url;
    const main = doc.querySelector('main,article,[role="main"]') || doc.body || doc.documentElement;
    text = (main.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  return {
    id: `url_${Date.now()}`,
    kind: 'url',
    title,
    url,
    text: truncate(text),
    chars: text.length,
  };
}
