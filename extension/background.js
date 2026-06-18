// ChatPanel service worker.
//
// Responsibilities are deliberately small: open the side panel when the toolbar
// icon is clicked, wire up a right-click "Ask ChatPanel about this" menu, and
// relay the occasional one-off message. All real work (chat, context capture,
// provider calls) happens in the side panel page itself, which has full DOM +
// fetch + streaming and is where the user is looking. The one background job is
// re-validating a paid license daily so a lapsed subscription downgrades itself.

import { revalidate } from './js/license.js';
import { persistMeeting, pruneMeetings, getLatestSessionRecord } from './js/store-meetings.js';

const REVALIDATE_ALARM = 'chatpanel-revalidate-license';

// Let the toolbar icon toggle the side panel open. (Requires Chrome 116+.)
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[chatpanel] setPanelBehavior', e));

  // onInstalled fires on install AND on every update/reload; the context menu
  // persists across those, so create() would throw "duplicate id". Clear first.
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError; // ignore "nothing to remove" on first install
    chrome.contextMenus.create(
      {
        id: 'chatpanel-ask',
        title: 'Ask ChatPanel about this page',
        contexts: ['page', 'selection', 'link'],
      },
      () => void chrome.runtime.lastError, // consume any benign duplicate on reload races
    );
  });

  // Daily license re-check (period is in minutes; 720 = 12h, so we catch a lapse
  // within ~half a day even if the browser is rarely restarted).
  chrome.alarms.create(REVALIDATE_ALARM, { periodInMinutes: 720 });
  revalidate({ force: true }).catch(() => {});
});

// Re-check on browser start and on the alarm. revalidate() self-throttles and
// fails open, so calling it liberally is safe.
chrome.runtime.onStartup.addListener(() => revalidate().catch(() => {}));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REVALIDATE_ALARM) revalidate().catch(() => {});
});

// Open the panel and hand it the click target. The panel listens for
// `chrome.runtime.onMessage` and seeds a new message with the selection / link.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'chatpanel-ask') return;
  try {
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn('[chatpanel] sidePanel.open', e);
  }
  // The panel may still be booting; a tiny delay then broadcast. The panel also
  // re-requests any pending seed on load, so this is best-effort.
  const seed = {
    type: 'context-seed',
    selection: info.selectionText || '',
    url: info.linkUrl || info.pageUrl || tab?.url || '',
    title: tab?.title || '',
    tabId: tab?.id ?? null,
  };
  setTimeout(() => chrome.runtime.sendMessage(seed).catch(() => {}), 350);
  // Stash it too so a freshly-opened panel can pull it.
  chrome.storage.session.set({ pendingSeed: seed }).catch(() => {});
});

// Keyboard / programmatic open requests from the panel (e.g. "open settings").
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse?.({ ok: true });
    return false;
  }
  // Single persist path for meeting capture: the content script (any frame) hands
  // us its buffer; we cap size + encrypt at rest here so it's done once, correctly.
  if (msg?.type === 'CP_MEETING_PERSIST' && msg.record) {
    persistMeeting(msg.record)
      .then(() => sendResponse?.({ ok: true }))
      .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
    return true; // async response
  }
  // A capture is (re)starting — hand back the latest record for this meeting so it
  // can RESUME the same session instead of forking a new fragment.
  if (msg?.type === 'CP_MEETING_LATEST' && msg.meetingKey) {
    getLatestSessionRecord(msg.platform, msg.meetingKey)
      .then((rec) => sendResponse?.(rec || null))
      .catch(() => sendResponse?.(null));
    return true; // async response
  }
  return false;
});

// Tidy old meetings opportunistically so transcript history can't grow unbounded.
chrome.runtime.onStartup.addListener(() => pruneMeetings().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => pruneMeetings().catch(() => {}));
