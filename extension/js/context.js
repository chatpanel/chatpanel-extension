// Browser context capture. Turns what's in the browser into attachable text:
//   • the active tab, or any/several open tabs (readable content extracted)
//   • a pasted URL (fetched and reduced to readable text)
//
// Attachments have the shape:
//   { id, kind: 'page' | 'url' | 'selection' | 'meeting', title, url, text, chars }

import { meetingPlatform, meetingToText } from './store-meetings.js';

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
function extractReadable() {
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

export async function captureTab(tabId) {
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
    if (ping?.ok) return { frameId: cached.frameId, ping };
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
export async function captureUrl(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    throw new Error(`Couldn't fetch ${url} — ${e.message}`);
  }
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
  const ct = res.headers.get('content-type') || '';
  const body = await res.text();

  let title = url;
  let text = body;
  if (ct.includes('html')) {
    const doc = new DOMParser().parseFromString(body, 'text/html');
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
