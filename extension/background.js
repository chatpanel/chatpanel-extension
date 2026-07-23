// ChatPanel service worker.
//
// Responsibilities are deliberately small: open the side panel when the toolbar
// icon is clicked, wire up a right-click "Ask ChatPanel about this" menu, and
// relay the occasional one-off message. All real work (chat, context capture,
// provider calls) happens in the side panel page itself, which has full DOM +
// fetch + streaming and is where the user is looking. The one background job is
// re-validating a paid license daily so a lapsed subscription downgrades itself.

import { revalidate } from './js/license.js';
import { persistMeeting, getLatestSessionRecord, markMeetingEnded, getMeetingIndex, meetingPlatform } from './js/store-meetings.js';
import { captureToInbox } from './js/store-notes.js';
import { runAutoBackup, syncBackupAlarm, BACKUP_ALARM } from './js/auto-backup.js';

const REVALIDATE_ALARM = 'chatpanel-revalidate-license';
const MEETING_HB_ALARM = 'chatpanel-meeting-hb'; // un-throttled heartbeat that keeps backgrounded meeting tabs flushing
const LIVE_TABS_KEY = 'cpLiveMeetingTabs';       // session-scoped map: tabId → { meetingId, platform }

// --------------------------------------------------------------------------
// Live meeting liveness (SW-owned). Capture runs in the content script, but the
// SW is the only place with authoritative TAB info + an un-throttled alarm, so it
// owns "is the meeting still alive": it pings each capturing tab to flush (even when
// backgrounded/silent), and ends a meeting only when its tab actually closes or
// navigates away — never on silence. State lives in storage.session because the MV3
// worker is ephemeral; it self-heals from the next content-script heartbeat.
// --------------------------------------------------------------------------
async function getLiveTabs() {
  try { const g = await chrome.storage.session.get(LIVE_TABS_KEY); return g[LIVE_TABS_KEY] || {}; }
  catch { return {}; }
}
async function setLiveTabs(map) {
  try { await chrome.storage.session.set({ [LIVE_TABS_KEY]: map }); } catch { /* ignore */ }
}
function syncMeetingAlarm(map) {
  if (map && Object.keys(map).length) chrome.alarms.create(MEETING_HB_ALARM, { periodInMinutes: 0.5 });
  else chrome.alarms.clear(MEETING_HB_ALARM);
}
async function trackMeetingTab(tabId, frameId, record) {
  const map = await getLiveTabs();
  if (record.status === 'ended') { if (tabId != null) delete map[tabId]; }
  else if (tabId != null) {
    const fresh = !map[tabId];
    map[tabId] = { meetingId: record.id, platform: record.platform, frameId: frameId ?? 0, misses: map[tabId]?.misses || 0 };
    if (fresh) {
      // First sight of this capturing tab: keep it "visible" (fallback for tabs already
      // open before our document_start shim ran) and stop Chrome discarding it mid-call.
      injectKeepVisible(tabId);
      chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    }
  }
  await setLiveTabs(map);
  syncMeetingAlarm(map);
}
// End the meeting(s) captured on a tab that closed / navigated away. Falls back to the
// index when the session map was lost (SW restart), so a tab-close still ends cleanly.
async function endMeetingForTab(tabId) {
  const map = await getLiveTabs();
  const entry = map[tabId];
  const ids = new Set();
  if (entry) ids.add(entry.meetingId);
  try {
    const idx = await getMeetingIndex();
    for (const e of idx) if (e.tabId === tabId && e.status !== 'ended') ids.add(e.id);
  } catch { /* index unreadable — best effort */ }
  for (const id of ids) await markMeetingEnded(id).catch(() => {});
  if (entry) { delete map[tabId]; await setLiveTabs(map); syncMeetingAlarm(map); }
}

// Runs in the meeting page's MAIN world: make the tab report itself as VISIBLE/FOCUSED
// so Meet/Zoom/Teams keep rendering live captions while the tab is backgrounded (they
// pause the captions UI when they think they're hidden). Idempotent per page.
function cpKeepMeetingVisible() {
  if (window.__cpKeepVisible) return;
  window.__cpKeepVisible = true;
  try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); } catch (e) { /* locked down */ }
  try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); } catch (e) { /* locked down */ }
  try { document.hasFocus = () => true; } catch (e) { /* frozen */ }
  const swallow = (e) => { e.stopImmediatePropagation(); };
  document.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('webkitvisibilitychange', swallow, true);
  window.addEventListener('blur', swallow, true);
}
function injectKeepVisible(tabId) {
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: cpKeepMeetingVisible })
    .catch(() => { /* tab gone / not injectable — best effort */ });
}

// Alarm tick: ping the CAPTURING frame of each meeting tab so it scans + flushes
// (un-throttled) AND tells us whether it's still in the call. inCall() going false for
// 2 consecutive ticks (~1 min — brief hysteresis for a transient reconnect) → the user
// left, so finalize even though the tab is still open on the meeting URL. A tab that no
// longer exists → its meeting ended.
async function meetingHeartbeat() {
  const map = await getLiveTabs();
  const tabIds = Object.keys(map);
  if (!tabIds.length) { chrome.alarms.clear(MEETING_HB_ALARM); return; }
  let dirty = false;
  for (const tid of tabIds) {
    const tabId = Number(tid);
    const info = map[tid];
    const opts = info.frameId != null ? { frameId: info.frameId } : undefined;
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'CP_MEETING_TICK' }, opts);
      if (resp && resp.inCall === false) {
        info.misses = (info.misses || 0) + 1;
        dirty = true;
        if (info.misses >= 2) {
          // Left the call (leave/hangup control gone) — finalize now.
          try { await chrome.tabs.sendMessage(tabId, { type: 'CP_MEETING_STOP' }, opts); } catch { /* unreachable */ }
          await markMeetingEnded(info.meetingId).catch(() => {});
          delete map[tid];
        }
      } else if (info.misses) { info.misses = 0; dirty = true; }
    } catch {
      let gone = false;
      try { await chrome.tabs.get(tabId); } catch { gone = true; }
      if (gone) { await endMeetingForTab(tabId); delete map[tid]; dirty = true; }
    }
  }
  if (dirty) { await setLiveTabs(map); syncMeetingAlarm(map); }
}

// URL patterns that carry the meeting content scripts (keep in sync with manifest
// content_scripts[0].matches).
const MEETING_MATCHES = [
  'https://*.zoom.us/wc/*', 'https://meet.google.com/*',
  'https://teams.microsoft.com/*', 'https://*.teams.microsoft.com/*',
  'https://teams.live.com/*', 'https://*.teams.live.com/*', 'https://*.webex.com/*',
];

// Reloading/updating the extension ORPHANS the content scripts in already-open tabs:
// chrome.runtime.id goes undefined there, so meeting-core's flush() returns early and the
// capture records into NOTHING — silently, forever, until that tab happens to be reloaded.
// Chrome does not re-inject automatically, and we can't safely inject over a still-running
// orphan (its observers/adapters would double up). So detect it and SAY so — the missing
// piece that let capture sit dead across every platform at once after a reload.
const MEETING_JS = [
  'content/adapter-zoom.js', 'content/adapter-meet.js',
  'content/adapter-teams.js', 'content/adapter-webex.js', 'content/meeting-core.js',
];

async function warnOrphanedMeetingTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: MEETING_MATCHES }); } catch { return; }
  for (const t of tabs) {
    if (t.id == null) continue;
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'CP_MEETING_PING' });
      continue; // answered → a LIVE script owns this tab; leave it alone
    } catch { /* nothing answered → orphaned (or never injected) → re-inject below */ }
    // Re-inject so the tab heals itself instead of demanding a manual reload. Safe now
    // that meeting-core's guard is runtime-id aware: the fresh copy supersedes the dead
    // one (which retires via superseded()), and a still-live script never reaches here.
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: MEETING_JS });
      await chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: true }, world: 'MAIN', files: ['content/keep-visible.js'],
      }).catch(() => {});
    } catch {
      // Not injectable (tab discarded, pre-render, permissions) — fall back to telling the
      // user, since a reload is then the only way to resume recording.
      chrome.runtime.sendMessage({ type: 'CP_MEETING_ORPHANED', tabId: t.id, title: t.title || 'Meeting' })
        .catch(() => { /* no panel open */ });
    }
  }
}

// A capturing tab closed → its meeting is over.
chrome.tabs.onRemoved.addListener((tabId) => { endMeetingForTab(tabId).catch(() => {}); });
// A capturing tab navigated OFF its meeting platform → over. (Same-platform URL tweaks,
// and Meet/Zoom keeping the URL, do NOT end — silence never ends a meeting.)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  getLiveTabs().then((map) => {
    const entry = map[tabId];
    if (entry && meetingPlatform(changeInfo.url) !== entry.platform) endMeetingForTab(tabId).catch(() => {});
  }).catch(() => {});
});

// Let the toolbar icon toggle the side panel open. (Requires Chrome 116+.)
// Keyboard shortcut: the manifest binds Cmd+I (mac) / Ctrl+I to the reserved
// `_execute_action` command — Chrome's "Activate the extension" — which activates the
// toolbar action. Because setPanelBehavior({ openPanelOnActionClick: true }) is set
// (below), activating the action opens the side panel. No onCommand handler needed:
// _execute_action drives the action directly. If the combo is taken, Chrome drops the
// suggestion and the user can rebind it at chrome://extensions/shortcuts.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[chatpanel] setPanelBehavior', e));

  // This same event is what orphaned the content scripts in any open meeting tab —
  // flag those tabs so recording can't die quietly (see warnOrphanedMeetingTabs).
  warnOrphanedMeetingTabs().catch(() => {});

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
    chrome.contextMenus.create(
      {
        id: 'chatpanel-clip',
        title: 'Save selection to ChatPanel note',
        contexts: ['selection'],
      },
      () => void chrome.runtime.lastError,
    );
  });

  // Daily license re-check (period is in minutes; 720 = 12h, so we catch a lapse
  // within ~half a day even if the browser is rarely restarted).
  chrome.alarms.create(REVALIDATE_ALARM, { periodInMinutes: 720 });
  revalidate({ force: true }).catch(() => {});

  // Re-arm the daily auto-backup alarm if the user had it enabled (alarms can be
  // dropped on update). syncBackupAlarm() is a no-op when the feature is off.
  syncBackupAlarm().catch(() => {});
});

// Re-check on browser start and on the alarm. revalidate() self-throttles and
// fails open, so calling it liberally is safe.
chrome.runtime.onStartup.addListener(() => {
  revalidate().catch(() => {});
  // Catch up a backup the device missed while it was off — runAutoBackup
  // self-gates on Pro and skips when nothing changed, so this is cheap.
  runAutoBackup().catch(() => {});
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REVALIDATE_ALARM) revalidate().catch(() => {});
  else if (a.name === BACKUP_ALARM) runAutoBackup().catch(() => {});
  else if (a.name === MEETING_HB_ALARM) meetingHeartbeat().catch(() => {});
});

// Open the panel and hand it the click target. The panel listens for
// `chrome.runtime.onMessage` and seeds a new message with the selection / link.
// Brief toolbar-badge confirmation (no notifications permission needed).
function flashBadge(text, color = '#5b5bf0') {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 1500);
  } catch {
    /* no toolbar action — ignore */
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Highlight → Inbox note. Captures the quote + a scroll-to-text source link.
  if (info.menuItemId === 'chatpanel-clip') {
    try {
      await captureToInbox({ text: info.selectionText || '', sourceUrl: info.pageUrl || tab?.url || '', sourceTitle: tab?.title || '' });
      flashBadge('✓', '#15a34a');
    } catch (e) {
      console.warn('[chatpanel] clip capture failed', e);
      flashBadge('!', '#dc2626');
    }
    return;
  }
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse?.({ ok: true });
    return false;
  }
  // Single persist path for meeting capture: the content script (any frame) hands
  // us its buffer; we cap size + encrypt at rest here so it's done once, correctly.
  // We also stamp the CAPTURING TAB (content scripts don't know their own tab id) so
  // liveness can be tied to that tab still being open, and track it for the heartbeat.
  if (msg?.type === 'CP_MEETING_PERSIST' && msg.record) {
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId ?? 0;
    if (tabId != null) msg.record.tabId = tabId;
    persistMeeting(msg.record)
      .then((r) => {
        // Free lifetime cap hit: the new meeting was NOT stored. Don't track its tab;
        // tell the content script so it can stop capturing + show the upgrade prompt.
        // Also BROADCAST it: the content script tears down silently, so without this the
        // user sees a confident "Live 12m" bar while nothing is ever saved (exactly how
        // this went unnoticed for weeks). Best-effort — no panel open is fine.
        if (r?.blocked) {
          chrome.runtime.sendMessage({ type: 'CP_MEETING_BLOCKED', reason: 'limit' }).catch(() => {});
          return sendResponse?.({ ok: false, limit: true });
        }
        // persistMeeting also returns {ok:false} WITHOUT throwing (e.g. a record with no
        // id). Reporting {ok:true} regardless made a failed write indistinguishable from a
        // real one — the capture looks healthy while nothing reaches the index.
        if (r?.ok === false) return sendResponse?.({ ok: false, error: r.error || 'persist refused (no record id?)' });
        return trackMeetingTab(tabId, frameId, msg.record)
          .catch(() => {})
          .then(() => sendResponse?.({ ok: true, id: r?.id }));
      })
      .catch((e) => sendResponse?.({ ok: false, error: String(e) }));
    return true; // async response
  }
  // Panel-driven "sync transcript now": ping the live meeting tab(s) to scan + flush
  // immediately so the panel sees the latest transcript without switching to that tab.
  if (msg?.type === 'CP_MEETING_SYNC_NOW') {
    (async () => {
      const map = await getLiveTabs();
      for (const [tid, info] of Object.entries(map)) {
        try { await chrome.tabs.sendMessage(Number(tid), { type: 'CP_MEETING_TICK' }, info.frameId != null ? { frameId: info.frameId } : undefined); } catch { /* unreachable */ }
      }
      sendResponse?.({ ok: true });
    })();
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
