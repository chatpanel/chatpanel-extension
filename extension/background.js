// ChatPanel service worker.
//
// Responsibilities are deliberately small: open the side panel when the toolbar
// icon is clicked, wire up a right-click "Ask ChatPanel about this" menu, and
// relay the occasional one-off message. All real work (chat, context capture,
// provider calls) happens in the side panel page itself, which has full DOM +
// fetch + streaming and is where the user is looking. The one background job is
// re-validating a paid license daily so a lapsed subscription downgrades itself.

import { revalidate } from './js/license.js';
import { openSidePanel, setPanelOpensOnActionClick, wireActionToPanel } from './js/side-panel.js';
import { meetingMatches } from './js/meeting-platforms.js';
import { persistMeeting, getLatestSessionRecord, markMeetingEnded, getMeetingIndex, meetingPlatform } from './js/store-meetings.js';
import { captureToInbox } from './js/store-notes.js';
import { runScheduledBackupIfDue, syncBackupAlarm, BACKUP_ALARM } from './js/auto-backup.js';
import { getSettings } from './js/store.js';
// STATIC, all three, and not by preference: this is a service worker, and `import()` inside
// one throws
//   TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification
// The scheduler and warm sync were both lazy here for cold-start reasons that were real but
// unattainable — a module a worker can only reach through import() is a module it cannot
// reach at all, so the alarms fired into a rejected promise and nothing ran. The cost is
// paid at worker startup instead; the side panel's first paint is untouched, because none
// of this is on its graph. Anything added here must be static for the same reason.
import * as jobs from './js/jobs.js';
import { syncHistoryToGateway, syncMemoryWithGateway } from './js/warm-sync.js';
import * as memoryStore from './js/store-memory.js';
// The backup's late stores. auto-backup.js takes them as an argument rather than importing
// them, because it is also on the settings page's first paint — see js/backup-payload.js.
import { backupExtras } from './js/backup-payload.js';

const REVALIDATE_ALARM = 'chatpanel-revalidate-license';
const WARM_SYNC_ALARM = 'chatpanel-warm-sync';   // coalesced background push of history → local gateway
const MEETING_HB_ALARM = 'chatpanel-meeting-hb'; // un-throttled heartbeat that keeps backgrounded meeting tabs flushing
const JOBS_ALARM = 'chatpanel-jobs';             // ONE alarm for every scheduled job — see js/jobs.js
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

// URL patterns that carry the meeting content scripts.
//
// Derived from the platform declaration rather than copied. The comment here used to say
// "keep in sync with manifest content_scripts[0].matches", which is an instruction to a
// human to do a computer's job — and when it is not followed, capture silently stops
// working on one platform while everything else looks fine. A test now asserts the manifest
// and the declaration agree.
const MEETING_MATCHES = meetingMatches();

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
//
// Firefox has no "open the panel when the action is clicked" switch, so the same
// behavior is a listener — and an event page only wakes for listeners registered at
// TOP LEVEL, not inside onInstalled. No-op on Chromium.
wireActionToPanel();

// Keyboard shortcut: the manifest binds Cmd+I (mac) / Ctrl+I to the reserved
// `_execute_action` command — Chrome's "Activate the extension" — which activates the
// toolbar action. Because setPanelBehavior({ openPanelOnActionClick: true }) is set
// (below), activating the action opens the side panel. No onCommand handler needed:
// _execute_action drives the action directly. If the combo is taken, Chrome drops the
// suggestion and the user can rebind it at chrome://extensions/shortcuts.
chrome.runtime.onInstalled.addListener(() => {
  setPanelOpensOnActionClick().catch((e) => console.warn('[chatpanel] setPanelBehavior', e));

  // This same event is what orphaned the content scripts in any open meeting tab —
  // flag those tabs so recording can't die quietly (see warnOrphanedMeetingTabs).
  warnOrphanedMeetingTabs().catch(() => {});

  // onInstalled fires on install AND on every update/reload; the context menu
  // persists across those, so create() would throw "duplicate id". Clear first.
  //
  // The whole block is optional: Firefox for Android implements no menus API at all.
  // A right-click menu is meaningless on a phone anyway, so its absence is a no-op,
  // not an error — but an unguarded call here would abort the REST of onInstalled
  // (alarms, the license re-check, the backup schedule).
  if (chrome.contextMenus) chrome.contextMenus.removeAll(() => {
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
  syncBackupAlarm().then(() => runScheduledBackupIfDue({ extras: backupExtras })).catch(() => {});
});

// --------------------------------------------------------------------------
// Background warm sync (SW-owned). The side panel already pushes history to the
// local gateway while it's OPEN — but a meeting captured, or a note written, with
// the panel CLOSED never reached the gateway, so an agent (Codex/Claude Code) that
// queries the gateway got a stale index and confidently denied a real record. The
// SW closes that gap: it owns storage change events with no page open, decrypt
// (chrome.storage.local key) and fetch, so it can sync unattended.
//
// Debounced through a single coalescing alarm: a burst of writes (a live meeting
// transcript lands row by row) schedules ONE sync ~30s later, not one per row. The
// alarm also survives the ephemeral SW being torn down mid-burst. warm-sync itself
// is opt-in (off unless the user enabled the gateway) and fails closed on a
// non-loopback URL, so this never sends anything off-box.
async function runWarmSyncIfEnabled() {
  let ws;
  try { ws = (await getSettings())?.ui?.warmSearch; } catch { return; }
  if (!ws?.enabled || !ws.url) return; // gateway off — nothing to do
  try {
    await syncHistoryToGateway(ws.url);
    // Memory rides the same pass, but it is a two-way merge, not a push: an agent that called
    // `remember` over MCP wrote to the gateway, and that has to come home or the panel does
    // not know what the terminal was told.
    await syncMemoryWithGateway(ws.url, { store: memoryStore });
  } catch (e) { console.debug('[chatpanel] bg warm sync', e?.message || e); }
}

// A history write with no panel open still needs to reach the gateway. Coalesce
// via the alarm (min granularity ~30s) so a transcript burst is one sync, not N.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => /^chatpanel:(conv|chat|meeting|note|memory)/i.test(k))) {
    chrome.alarms.create(WARM_SYNC_ALARM, { delayInMinutes: 0.5 });
  }
});

// Re-check on browser start and on the alarm. revalidate() self-throttles and
// fails open, so calling it liberally is safe.
chrome.runtime.onStartup.addListener(() => {
  revalidate().catch(() => {});
  syncBackupAlarm().then(() => runScheduledBackupIfDue({ extras: backupExtras })).catch(() => {});
  runWarmSyncIfEnabled().catch(() => {}); // catch up anything written while the browser was closed
  // A laptop that was shut at 8pm missed this morning's brief. Run what the job's own
  // onMissed policy says to run, and re-arm — an alarm does not survive a browser restart.
  runDueJobs().catch(() => {});
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REVALIDATE_ALARM) revalidate().catch(() => {});
  else if (a.name === BACKUP_ALARM) {
    runScheduledBackupIfDue({ extras: backupExtras }).finally(() => syncBackupAlarm()).catch(() => {});
  }
  else if (a.name === MEETING_HB_ALARM) meetingHeartbeat().catch(() => {});
  else if (a.name === WARM_SYNC_ALARM) runWarmSyncIfEnabled().catch(() => {});
  else if (a.name === JOBS_ALARM) runDueJobs().catch(() => {});
});

// --------------------------------------------------------------------------
// Scheduled jobs — the half that can run with no window open.
//
// A `notify` action (a timer, a reminder) is finished here: it costs nothing, needs no
// model, and a reminder that only arrives when the panel happens to be open is not a
// reminder. Anything that needs a model is left PENDING for the panel — a turn needs
// settings, a licence, redaction and often a tool loop, none of which belong in a worker
// that can be killed mid-sentence.
//
// The scheduler is imported statically (see the note at the top of this file): a worker
// cannot lazily reach a module, so a browser where nobody has created a job pays the
// scheduler's parse on cold start. jobs.js is self-contained and small; a job that never
// fires is not.
// --------------------------------------------------------------------------
const jobsPort = {
  schedule(atMs) {
    // chrome.alarms refuses anything under a minute and rounds; `when` is what keeps a
    // 10-minute timer landing at 10 minutes rather than on the next periodic tick.
    chrome.alarms.create(JOBS_ALARM, { when: Math.max(atMs, Date.now() + 1000) });
  },
  cancel() { chrome.alarms.clear(JOBS_ALARM); },
};

async function runDueJobs() {
  const due = await jobs.dueNow();
  for (const entry of due) {
    if (entry.skipped) {
      await jobs.recordRun(entry.job.id, entry.at);
      await jobs.logSkip(entry.job.id, jobs.SKIP_REASONS.missed);
      continue;
    }
    if (!(await jobs.claimOccurrence(entry.key))) continue; // the panel got there first
    await jobs.recordRun(entry.job.id, entry.at);
    // The ceiling every job has whether or not its author set one — a misconfigured
    // schedule must cost a day's worth of runs, not a month's.
    if (!(await jobs.withinLimits(entry.job))) { await jobs.logSkip(entry.job.id, jobs.SKIP_REASONS.limit); continue; }
    await jobs.countRun(entry.job.id);
    if (jobs.needsWindow(entry.job)) {
      await jobs.addPending({ key: entry.key, jobId: entry.job.id, at: entry.at });
      // Queued, not run. Saying so is the difference between "it is late" and "it is broken":
      // a model turn needs a window, and the panel may not be open for hours.
      await jobs.logSkip(entry.job.id, jobs.SKIP_REASONS.window);
      flashBadge('•', '#5b5bf0');
      chrome.runtime.sendMessage({ type: 'CP_JOBS_DUE' }).catch(() => { /* no panel open */ });
      continue;
    }
    await deliverNotify(entry.job, entry.at);
  }
  await jobs.armWake(jobsPort); // always re-arm: a recurring job's next slot is now knowable
}

// Still feature-detected even though `notifications` is now in the manifest: Firefox for
// Android and the Chromium Android builds do not all expose the namespace, and an undefined
// namespace called bare at top level takes the whole worker down. Without it a job still
// runs and is still recorded — the user sees it on the badge and in the panel instead.
async function deliverNotify(job, at) {
  const title = job.action.title || job.name || 'ChatPanel';
  const body = job.action.body || '';
  try {
    if (chrome.notifications?.create) {
      await chrome.notifications.create(`cp-job-${job.id}-${at}`, {
        type: 'basic', iconUrl: chrome.runtime.getURL('assets/icon128.png'), title, message: body,
        // Reminders are the one notification that must not disappear while you are looking
        // away from the screen — that is the entire job.
        requireInteraction: job.action.kind === 'notify' && !!job.action.sticky,
      });
      return;
    }
  } catch { /* fall through to the badge */ }
  flashBadge('⏰', '#dc2626');
  chrome.runtime.sendMessage({ type: 'CP_JOB_FIRED', title, body }).catch(() => {});
}

// A reminder you cannot act on is half a reminder: clicking it opens the panel, where the
// job list and the chat are. Guarded because a click is only SOMETIMES a user gesture as far
// as sidePanel.open is concerned, and a refusal here must not throw inside a listener.
chrome.notifications?.onClicked?.addListener?.((id) => {
  if (!String(id).startsWith('cp-job-')) return;
  chrome.notifications.clear(id).catch(() => {});
  chrome.windows?.getCurrent?.()
    .then((w) => (w?.id != null ? openSidePanel({ windowId: w.id }) : null))
    .catch(() => { /* no gesture, or no windows API (Android) — the badge still carries it */ });
});

// Jobs are created in the panel; the worker owns the alarm, so it re-arms when they change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes['chatpanel:jobs']) return;
  jobs.armWake(jobsPort).catch(() => {});
});

// Open the panel and hand it the click target. The panel listens for
// `chrome.runtime.onMessage` and seeds a new message with the selection / link.
// Brief toolbar-badge confirmation (no notifications permission needed).
function flashBadge(text, color = '#5b5bf0') {
  try {
    // Not every mobile build exposes the badge; a missing confirmation flash is a
    // cosmetic loss, never a reason to fail the capture that just succeeded.
    if (!chrome.action?.setBadgeText) return;
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 1500);
  } catch {
    /* no toolbar action — ignore */
  }
}

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
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
    if (tab?.windowId != null) await openSidePanel({ windowId: tab.windowId });
  } catch (e) {
    console.warn('[chatpanel] openSidePanel', e);
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
        // Push the new speech to whoever is listening (the panel) the moment it is
        // durable. Best-effort and unawaited: no panel open is the normal case, and a
        // capture must never wait on a UI.
        if (Array.isArray(msg.delta) && msg.delta.length) {
          chrome.runtime.sendMessage({
            type: 'CP_MEETING_DELTA', meetingId: r?.id || msg.record.id, segments: msg.delta,
          }).catch(() => { /* no receiver */ });
        }
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
