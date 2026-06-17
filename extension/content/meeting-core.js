// ChatPanel — live meeting capture core (content script, classic — NOT a module).
//
// This is platform-NEUTRAL. All Zoom/Meet/Teams DOM knowledge lives in the
// adapters (content/adapter-*.js), which self-register on window.__cpMeetingAdapters
// before this file runs (manifest load order). Core picks the adapter whose
// match() fits the current URL, then:
//   • runs ONE MutationObserver on document.body and feeds caption/chat text to
//     the adapter for extraction,
//   • finalizes captions into a deduped, speaker-attributed transcript (the
//     sliding-window logic ported from the Zoom Caption Capture userscript — it's
//     platform-neutral once the adapter yields {speaker, text}),
//   • persists a meeting record to chrome.storage.local on a debounce.
//
// The side panel drives this over runtime messages (see context.js):
//   CP_MEETING_PING  → { ok, platform, meetingKey, title, live, capturing }
//   CP_MEETING_START → begins capture; { ok, meetingId }
//   CP_MEETING_STOP  → final flush + status:'ended'; { ok }
//   CP_MEETING_GET   → { ok, record }  (current buffer, finalized + live tail)
//
// Capture stays DORMANT until CP_MEETING_START — the Pro gate is enforced in the
// side panel, which only sends START for entitled users.
(function () {
  'use strict';
  if (window.__cpMeetingCoreLoaded) return;
  window.__cpMeetingCoreLoaded = true;

  const SCHEMA_VERSION = 1;
  const FLUSH_DEBOUNCE_MS = 4000;

  const adapter = (window.__cpMeetingAdapters || []).find((a) => {
    try { return a.match(location.href); } catch { return false; }
  });
  if (!adapter) {
    // The script injected (URL matched a manifest pattern) but no adapter's
    // match() fit — usually a Zoom URL shape we don't recognise. Logged so this
    // is diagnosable from the page console.
    console.log('[ChatPanel] meeting capture loaded but no adapter matched:', location.href);
    return;
  }

  // ---- capture state -----------------------------------------------------
  let capturing = false;
  let meetingId = null;
  let startedAt = 0;
  let observer = null;
  let flushTimer = null;

  let finalizedTranscript = [];        // [{ t, speaker, text }]
  let currentSpokenEntry = null;       // the in-progress utterance
  const lastUtteranceMap = new Map();  // speaker → last full caption text (stale guard)
  const lastEntryIndexBySpeaker = new Map();
  const chatTranscript = [];           // [{ t, sender, receiver, text }]
  const seenChat = new Set();
  // Discrete-caption platforms (Teams/Meet/Webex): each utterance is its own
  // element that grows in place. We key finalized entries by the adapter's stable
  // caption id and update them, rather than running the sliding-window merge.
  const discreteIndex = new Map();     // caption id -> index in finalizedTranscript

  const RESUME_MERGE_LOOKBACK = 6;
  const RESUME_MIN_OVERLAP = 12;

  // ---- finalization helpers (ported, platform-neutral) -------------------
  function commonPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a[i] === b[i]) i++;
    return i;
  }
  function suffixPrefixOverlap(lastKnown, currentText, minOverlap) {
    if (!lastKnown || !currentText) return 0;
    if (currentText.startsWith(lastKnown)) return lastKnown.length;
    const max = Math.min(lastKnown.length, currentText.length);
    for (let i = max; i >= minOverlap; i--) {
      if (currentText.startsWith(lastKnown.slice(-i))) return i;
    }
    return 0;
  }
  function pushFinalized(entry) {
    finalizedTranscript.push(entry);
    lastEntryIndexBySpeaker.set(entry.speaker, finalizedTranscript.length - 1);
  }

  // Feed one live caption (current full text of the on-screen line for `speaker`).
  // Reconstructs complete utterances from Zoom-style sliding-window captions.
  function feedCaption(speaker, currentText) {
    if (!speaker || !currentText) return;
    const lastKnownText = lastUtteranceMap.get(speaker) || '';

    // Stale: exact duplicate, or an older substring of what we already captured.
    if (currentText === lastKnownText ||
        (lastKnownText.length > currentText.length && lastKnownText.includes(currentText))) {
      return;
    }

    if (currentSpokenEntry && currentSpokenEntry.speaker === speaker) {
      // Case 1: same speaker continuing.
      if (currentText.startsWith(lastKnownText)) {
        currentSpokenEntry.text = currentText;
      } else {
        const prefix = commonPrefixLength(lastKnownText, currentText);
        const isFuzzy = currentText.length >= lastKnownText.length &&
          prefix >= Math.max(8, lastKnownText.length - 10);
        if (isFuzzy) {
          currentSpokenEntry.text = currentText;
        } else {
          let overlapFound = false;
          for (let i = Math.min(lastKnownText.length, currentText.length); i > 0; i--) {
            const suffix = lastKnownText.substring(lastKnownText.length - i);
            if (currentText.startsWith(suffix)) {
              currentSpokenEntry.text += currentText.substring(i);
              overlapFound = true;
              break;
            }
          }
          if (!overlapFound) {
            pushFinalized(currentSpokenEntry);
            currentSpokenEntry = { t: Date.now(), speaker, text: currentText };
          }
        }
      }
      currentSpokenEntry.t = Date.now();
    } else {
      // Case 2: speaker changed / first caption. Try resumed-monologue merge.
      const overlap = suffixPrefixOverlap(lastKnownText, currentText, RESUME_MIN_OVERLAP);
      const priorIdx = lastEntryIndexBySpeaker.get(speaker);
      const priorEntry = priorIdx !== undefined ? finalizedTranscript[priorIdx] : null;
      const canMerge = overlap > 0 && priorEntry && priorEntry.speaker === speaker &&
        priorIdx >= finalizedTranscript.length - RESUME_MERGE_LOOKBACK;
      if (canMerge) {
        const newPart = currentText.substring(overlap);
        if (newPart) { priorEntry.text += newPart; priorEntry.t = Date.now(); }
        lastUtteranceMap.set(speaker, currentText);
        scheduleFlush();
        return;
      }
      if (currentSpokenEntry) pushFinalized(currentSpokenEntry);
      currentSpokenEntry = { t: Date.now(), speaker, text: currentText };
    }
    lastUtteranceMap.set(speaker, currentSpokenEntry.text);
    scheduleFlush();
  }

  // Upsert a discrete caption line keyed by the adapter's stable id. New id →
  // append; known id → update its text in place as the line grows.
  function feedDiscrete(id, speaker, text) {
    if (id == null || !text) return;
    const idx = discreteIndex.get(id);
    if (idx !== undefined) {
      const e = finalizedTranscript[idx];
      if (e && e.text !== text) { e.text = text; e.t = Date.now(); scheduleFlush(); }
      return;
    }
    finalizedTranscript.push({ t: Date.now(), speaker: speaker || 'Speaker', text });
    discreteIndex.set(id, finalizedTranscript.length - 1);
    scheduleFlush();
  }

  function addChat(c) {
    const k = `${c.sender}|${c.text}|${c.t}`;
    if (seenChat.has(k)) return;
    seenChat.add(k);
    chatTranscript.push(c);
    scheduleFlush();
  }

  // ---- record build + persist --------------------------------------------
  function buildRecord(status) {
    const segments = finalizedTranscript.slice();
    if (currentSpokenEntry) segments.push(currentSpokenEntry);
    return {
      id: meetingId,
      schemaVersion: SCHEMA_VERSION,
      platform: adapter.platform,
      meetingKey: safe(() => adapter.meetingKey(location.href)) || 'meeting',
      title: safe(() => adapter.title()) || document.title,
      url: location.href,
      status,
      startedAt,
      endedAt: status === 'ended' ? Date.now() : null,
      participants: safe(() => adapter.participants()) || [],
      segments: segments.map((s) => ({ t: s.t, speaker: s.speaker, text: s.text })),
      chat: chatTranscript.slice(),
    };
  }

  // Persistence is owned by the background worker (the single writer), which caps
  // record size and encrypts at rest. The content script just hands it the buffer.
  // Writing from here would bypass those, and content scripts can't import the
  // crypto module anyway (they're classic scripts).
  async function flush(status = 'live') {
    if (!meetingId) return;
    // On tab refresh / extension reload the context is invalidated; chrome.runtime.id
    // goes undefined and any chrome.* call throws. Skip quietly once detached.
    if (!chrome.runtime?.id) return;
    try {
      await chrome.runtime.sendMessage({ type: 'CP_MEETING_PERSIST', record: buildRecord(status) });
    } catch {
      /* worker asleep or context gone during teardown — nothing actionable */
    }
  }

  // Persist as captions arrive. Triggered by the MutationObserver (a real DOM
  // event, NOT a timer), so it still fires in a backgrounded tab where Chrome
  // throttles setTimeout to ~1/min. We flush IMMEDIATELY once FLUSH_DEBOUNCE_MS has
  // elapsed since the last write (coalescing bursts), so the persisted transcript
  // stays within a few seconds of live and a tab-discard loses almost nothing.
  let lastFlushAt = 0;
  function scheduleFlush() {
    if (!capturing) return;
    const now = Date.now();
    if (now - lastFlushAt >= FLUSH_DEBOUNCE_MS) {
      lastFlushAt = now;
      flush('live'); // timer-free → works while backgrounded
      return;
    }
    // Trailing backstop for the tail of a burst (may be throttled in background,
    // but the next caption's immediate path above usually beats it).
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; lastFlushAt = Date.now(); flush('live'); }, FLUSH_DEBOUNCE_MS);
    }
  }

  // ---- observer ----------------------------------------------------------
  function startObserver() {
    const discrete = adapter.captionMode === 'discrete';
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (discrete) {
          const caps = safe(() => adapter.readDiscreteCaptions(m));
          if (Array.isArray(caps)) {
            for (const c of caps) if (c && c.text) feedDiscrete(c.id, c.speaker, c.text.trim());
          }
        } else {
          const cap = safe(() => adapter.readCaption(m));
          if (cap && cap.speaker && cap.text) feedCaption(cap.speaker, cap.text.trim());
        }
        const chats = adapter.readChat ? safe(() => adapter.readChat(m)) : null;
        if (Array.isArray(chats)) for (const c of chats) addChat(c);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function safe(fn) { try { return fn(); } catch { return null; } }
  function currentMeetingKey() { return safe(() => adapter.meetingKey(location.href)) || 'meeting'; }

  // ---- lifecycle ---------------------------------------------------------
  // The meeting key this capture session belongs to. Zoom's web client is a SPA,
  // so the script survives leaving one meeting and joining another; we track this
  // to (a) refuse to mix two meetings' transcripts and (b) auto-restart on change.
  let activeMeetingKey = null;

  // Wipe all accumulated transcript state — called at the start of every capture
  // session so a new meeting never inherits the previous one's lines.
  function resetBuffers() {
    finalizedTranscript = [];
    currentSpokenEntry = null;
    lastUtteranceMap.clear();
    lastEntryIndexBySpeaker.clear();
    discreteIndex.clear();
    chatTranscript.length = 0;
    seenChat.clear();
  }

  function start() {
    if (capturing) return meetingId;
    resetBuffers(); // fresh session — drop any prior meeting's buffer
    capturing = true;
    startedAt = Date.now();
    activeMeetingKey = currentMeetingKey();
    meetingId = `mtg_${adapter.platform}_${activeMeetingKey}_${startedAt.toString(36)}`;
    if (adapter.onStart) safe(() => adapter.onStart());
    startObserver();
    flush('live');
    return meetingId;
  }

  function stop() {
    if (!capturing) return;
    capturing = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush('ended');
  }

  // No new captions for this long → assume the call ended (the user left but the
  // tab is still open), so we finalize instead of showing "recording" forever.
  const IDLE_END_MS = 8 * 60 * 1000;
  function lastActivityTs() {
    if (currentSpokenEntry) return currentSpokenEntry.t;
    return finalizedTranscript.length ? finalizedTranscript[finalizedTranscript.length - 1].t : startedAt;
  }

  // Lifecycle watch (every 3s while capturing):
  //  • meeting key changed (SPA: left one meeting, joined another) → finalize + restart clean.
  //  • navigated off any meeting page → finalize.
  //  • gone quiet past IDLE_END_MS → finalize (call over, tab left open).
  // Finalizing flips status→'ended', so it stops showing as live and lands in Past Meetings.
  setInterval(() => {
    if (!capturing) return;
    if (currentMeetingKey() !== activeMeetingKey) {
      stop();
      if (safe(() => adapter.match(location.href))) start();
      return;
    }
    if (safe(() => adapter.match(location.href)) === false) { stop(); return; }
    if (Date.now() - lastActivityTs() > IDLE_END_MS) { stop(); return; }
  }, 3000);

  // Heartbeat: persist periodically while capturing (even during silence) so the
  // side panel can tell a live meeting is still alive vs a zombie (tab closed /
  // call left, so this script is gone and the record stops getting fresh writes).
  setInterval(() => { if (capturing) flush('live'); }, 20000);

  // Final flush if the tab is closing mid-meeting. Guarded: during teardown the
  // extension context may already be gone, so swallow anything stop() throws.
  window.addEventListener('pagehide', () => { try { if (capturing) stop(); } catch { /* detached */ } }, { once: true });

  // ---- messaging ---------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CP_MEETING_')) return;
    switch (msg.type) {
      case 'CP_MEETING_PING':
        sendResponse({
          ok: true,
          platform: adapter.platform,
          meetingKey: safe(() => adapter.meetingKey(location.href)),
          title: safe(() => adapter.title()) || document.title,
          live: !!safe(() => adapter.isLive()),
          ready: adapter.ready !== false,
          capturing,
          meetingId,
          // Frame disambiguation: the real meeting iframe has thousands of
          // elements; the top-level shell has ~150. The panel picks the frame with
          // the most elements as the authoritative capture frame.
          isTop: window === window.top,
          els: document.querySelectorAll('*').length,
        });
        return; // sync response
      case 'CP_MEETING_START':
        sendResponse({ ok: true, meetingId: start() });
        return;
      case 'CP_MEETING_STOP':
        stop();
        sendResponse({ ok: true });
        return;
      case 'CP_MEETING_GET':
        sendResponse({ ok: true, record: meetingId ? buildRecord(capturing ? 'live' : 'ended') : null });
        return;
      case 'CP_MEETING_DEBUG':
        // Async: scanStorage awaits IndexedDB. Returning true keeps the message
        // channel open until sendResponse fires.
        runDebug(msg.needle).then((report) => sendResponse({ ok: true, report }));
        return true;
      default:
        return;
    }
  });

  // Diagnostic: dump what the adapter can/can't see in the caption DOM, plus the
  // live capture state. Exposed on window so it's one short call in the page
  // console — `__cpMeetingDebug()` — no hand-typed snippet needed.
  // Read the PAGE's own client storage (we run in app.zoom.us's origin, so its
  // localStorage / sessionStorage / IndexedDB are reachable). The goal: find out
  // whether Zoom buffers the transcript somewhere we could read directly instead
  // of scraping the DOM. Names matching the hint regex are flagged as promising.
  const STORE_HINT = /(caption|transcript|subtitle|cc|live.?note|meeting.?text)/i;
  async function scanStorage() {
    // Summarise, don't dump: page storage (Zoom's) can be megabytes of telemetry.
    // We only need totals, the few biggest keys, and any transcript-shaped hits.
    const out = { localStorage: null, sessionStorage: null, indexedDB: [], hits: [] };
    const summarize = (store, name) => {
      try {
        let total = 0;
        const sizes = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          const v = store.getItem(k) || '';
          total += v.length;
          sizes.push([k, v.length]);
          if (STORE_HINT.test(k) || (v.length > 200 && STORE_HINT.test(v.slice(0, 500)))) {
            out.hits.push({ where: name, key: k, len: v.length });
          }
        }
        sizes.sort((a, b) => b[1] - a[1]);
        return {
          keys: store.length,
          totalChars: total,
          biggest: sizes.slice(0, 5).map(([k, l]) => ({ key: k.slice(0, 60), len: l })),
        };
      } catch (e) {
        return { error: String(e) };
      }
    };
    out.localStorage = summarize(localStorage, 'localStorage');
    out.sessionStorage = summarize(sessionStorage, 'sessionStorage');
    try {
      const dbs = (await indexedDB.databases?.()) || [];
      for (const meta of dbs) {
        const info = { name: meta.name, version: meta.version, stores: [], counts: {} };
        try {
          const db = await new Promise((res, rej) => {
            const r = indexedDB.open(meta.name);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          info.stores = [...db.objectStoreNames];
          for (const sn of info.stores.slice(0, 30)) {
            try {
              const cnt = await new Promise((res) => {
                const c = db.transaction(sn, 'readonly').objectStore(sn).count();
                c.onsuccess = () => res(c.result);
                c.onerror = () => res(-1);
              });
              info.counts[sn] = cnt;
              if (STORE_HINT.test(sn) || STORE_HINT.test(meta.name || '')) {
                out.hits.push({ where: 'indexedDB', db: meta.name, store: sn, count: cnt });
              }
            } catch { /* store unreadable */ }
          }
          db.close();
        } catch (e) { info.error = String(e); }
        out.indexedDB.push(info);
      }
    } catch (e) { out.indexedDBError = String(e); }
    return out;
  }

  async function runDebug(needle) {
    const report = {
      platform: adapter.platform,
      capturing,
      live: safe(() => adapter.isLive()),
      finalizedLines: finalizedTranscript.length,
      liveTail: currentSpokenEntry ? currentSpokenEntry.text.slice(0, 80) : null,
      dom: safe(() => adapter.debug && adapter.debug(needle)),
      storage: await scanStorage().catch((e) => ({ error: String(e) })),
    };
    console.log('[ChatPanel] meeting debug »', report);
    return report;
  }
  window.__cpMeetingDebug = runDebug;

  console.log(`[ChatPanel] meeting capture ready (${adapter.platform}) — run __cpMeetingDebug() to inspect captions`);
})();
