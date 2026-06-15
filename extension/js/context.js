// Browser context capture. Turns what's in the browser into attachable text:
//   • the active tab, or any/several open tabs (readable content extracted)
//   • a pasted URL (fetched and reduced to readable text)
//
// Attachments have the shape:
//   { id, kind: 'page' | 'url' | 'selection', title, url, text, chars }

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
