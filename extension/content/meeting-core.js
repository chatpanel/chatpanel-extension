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
//   CP_MEETING_PING  → { ok, platform, meetingKey, title, live, inCall, capturing }
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
  let limitHit = false; // Free lifetime meeting cap reached — stop capturing, don't restart
  let meetingId = null;
  let startedAt = 0;
  let observer = null;
  let flushTimer = null;
  let pollTimer = null;
  let flushWorker = null; // un-throttled background flush heartbeat (content/flush-worker.js)

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
  function buildRecord(status, endReason) {
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
      // Why the session ended — drives resume eligibility. 'unload' (a tab reload)
      // is the ONLY end we resume across; a real end ('left'/'idle'/'user') must
      // start a fresh record even when the same meeting URL/key comes back (e.g.
      // reusing a Google Meet code for a new call).
      endReason: status === 'ended' ? (endReason || 'ended') : null,
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
  async function flush(status = 'live', endReason) {
    if (!meetingId) return;
    // On tab refresh / extension reload the context is invalidated; chrome.runtime.id
    // goes undefined and any chrome.* call throws. Skip quietly once detached.
    if (!chrome.runtime?.id) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CP_MEETING_PERSIST', record: buildRecord(status, endReason) });
      // Free lifetime cap: the worker refused to store this NEW meeting. Tear down so we
      // don't persist into the void, and don't auto-restart (meetings are Free up to the
      // cap; the user upgrades from the panel). Existing meetings are never blocked.
      if (res && res.limit && !limitHit) onCaptureLimit();
    } catch {
      /* worker asleep or context gone during teardown — nothing actionable */
    }
  }

  // Stop capturing cleanly WITHOUT a final flush (the flush is exactly what's blocked),
  // so a Free user at the cap doesn't spin trying to persist a meeting that won't save.
  function onCaptureLimit() {
    limitHit = true;
    capturing = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (flushWorker) { try { flushWorker.terminate(); } catch { /* already gone */ } flushWorker = null; }
    meetingId = null;
  }

  // Persist as captions arrive. Triggered by the MutationObserver (a real DOM
  // event, NOT a timer), so it still fires in a backgrounded tab where Chrome
  // throttles setTimeout to ~1/min. We flush IMMEDIATELY once FLUSH_DEBOUNCE_MS has
  // elapsed since the last write (coalescing bursts), so the persisted transcript
  // stays within a few seconds of live and a tab-discard loses almost nothing.
  let lastFlushAt = 0;
  let lastBufferedAt = 0; // time of the most recent caption/chat fed into the buffer
  function scheduleFlush() {
    if (!capturing) return;
    const now = Date.now();
    lastBufferedAt = now; // mark the buffer dirty for the worker/SW flush backstops
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

  // Flush ONLY if new content was buffered since the last write. This is what the
  // un-throttled Web Worker heartbeat (and the SW tick) call, so a BACKGROUNDED tab —
  // where Chrome throttles main-thread setTimeout to ~1/min — still persists captured
  // captions promptly. No new content → no write (no churn, no behaviour change).
  function flushIfDirty() {
    if (!capturing || lastBufferedAt <= lastFlushAt) return;
    lastFlushAt = Date.now();
    flush('live');
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

  // Poll path — for adapters whose captions render in a SAME-ORIGIN CHILD IFRAME
  // (Webex) that this frame's single observer can't watch. The adapter's
  // scanCaptions() walks all reachable docs and returns the current caption rows;
  // we feed them on a short interval (deduped/grown by stable id, exactly like the
  // observer path). Foreground-reliable; setInterval throttles in a backgrounded
  // tab, but the observer path covers same-frame captions there.
  const CAPTION_POLL_MS = 2000;
  // One scan of the adapter's poll-based captions (Webex). Reused by the poll timer
  // AND the SW-driven CP_MEETING_TICK, so a backgrounded tab (where the poll timer is
  // throttled) still gathers captions when the un-throttled service-worker alarm pings.
  function scanOnce() {
    if (!capturing || typeof adapter.scanCaptions !== 'function') return;
    const caps = safe(() => adapter.scanCaptions());
    if (Array.isArray(caps)) {
      for (const c of caps) if (c && c.text) feedDiscrete(c.id, c.speaker, c.text.trim());
    }
  }
  function startCaptionPoll() {
    if (typeof adapter.scanCaptions !== 'function') return;
    pollTimer = setInterval(scanOnce, CAPTION_POLL_MS);
    scanOnce();
  }

  function safe(fn) { try { return fn(); } catch { return null; } }
  function currentMeetingKey() { return safe(() => adapter.meetingKey(location.href)) || 'meeting'; }

  // ---- auto-enable captions ----------------------------------------------
  // Users forget to turn captions on, and we only capture rendered caption text —
  // no captions, no transcript. So on capture start we try to flip the platform's
  // captions toggle for them. This is best-effort UI automation: captions render
  // LOCALLY (nothing is broadcast to other participants), and on failure we just
  // leave the meeting bar's "turn on captions" hint in place — no toast, no retry
  // storm. Each adapter supplies enableCaptions(ui); the ui below pierces open
  // shadow roots (the modern Zoom/Meet clients nest controls in shadow DOM) so the
  // adapters stay short. enableCaptions returns:
  //   'on'      → captions already enabled (nothing to do)
  //   'clicked' → we clicked the toggle (done — never click twice, that toggles off)
  //   'pending' → opened a menu; call again next tick to click the revealed item
  //   null      → control not found yet (controls still rendering → retry)
  const captionUI = (() => {
    function deepEls(root, acc, depth) {
      if (depth > 15 || !root || !root.querySelectorAll) return;
      let els;
      try { els = root.querySelectorAll('*'); } catch { return; }
      for (const el of els) { acc.push(el); if (el.shadowRoot) deepEls(el.shadowRoot, acc, depth + 1); }
    }
    function name(el) {
      return (el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.textContent || '')
        .replace(/\s+/g, ' ').trim();
    }
    function visible(el) {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect?.();
      if (!r) return true;
      return !(r.width === 0 && r.height === 0);
    }
    const CLICKABLE = new Set(['button', 'a']);
    const CLICKABLE_ROLES = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'switch']);
    function clickable(el) {
      const tag = el.tagName?.toLowerCase();
      const role = el.getAttribute?.('role');
      return CLICKABLE.has(tag) || (role && CLICKABLE_ROLES.has(role));
    }
    return {
      // First control whose accessible name matches `re`. Prefers visible ones.
      byName(re, { all = false } = {}) {
        const acc = [];
        deepEls(document, acc, 0);
        const hits = acc.filter((el) => clickable(el) && re.test(name(el)));
        if (all) return hits;
        return hits.find(visible) || hits[0] || null;
      },
      // Does this toggle read as already-on? (pressed/checked, or an "off/hide" label)
      isOn(el) {
        if (!el) return false;
        if (el.getAttribute?.('aria-pressed') === 'true') return true;
        if (el.getAttribute?.('aria-checked') === 'true') return true;
        return /\b(turn off|hide|disable|stop|off)\b/i.test(name(el));
      },
      click(el) {
        if (!el) return false;
        try { el.click(); return true; } catch { /* fall through to synthetic */ }
        try {
          for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        } catch { return false; }
      },
      name,
      visible,
    };
  })();

  // Best-effort UI automation to turn the platform's live captions ON (we only
  // capture rendered caption text — no captions, no transcript). Re-entrancy-guarded
  // so the start-time burst and the periodic watchdog (see the captions watcher
  // below) never run overlapping click loops. Returns nothing; success is observed
  // via adapter.isLive() going true.
  let enablingCaptions = false;
  async function tryEnableCaptions() {
    if (typeof adapter.enableCaptions !== 'function') return;
    if (enablingCaptions) return;
    enablingCaptions = true;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      // ~12s of attempts: meeting toolbars/menus can take several seconds to render,
      // and nested-menu platforms (Teams/Zoom) need a tick per menu level.
      for (let i = 0; i < 8; i++) {
        if (!capturing) return;
        if (safe(() => adapter.isLive())) return; // captions already showing
        let status = null;
        try { status = await adapter.enableCaptions(captionUI); } catch { status = null; }
        if (status === 'on' || status === 'clicked') return; // done — don't toggle back off
        await sleep(1400); // 'pending' (advance a menu) or null (controls not ready) → retry
      }
    } finally {
      enablingCaptions = false;
    }
  }

  // One-shot: open the participants/roster panel so the adapter can read real
  // attendee NAMES (captions often carry only avatars/initials until the roster is
  // visible). Best-effort UI automation like captions; stops as soon as we have at
  // least one named participant. Adapters accumulate names, so the panel can be
  // closed again afterwards without losing them.
  async function tryOpenParticipants() {
    if (typeof adapter.openParticipants !== 'function') return;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) {
      if (!capturing) return;
      const named = safe(() => adapter.participants()) || [];
      if (named.some((p) => p && p.name)) return; // already have names
      let status = null;
      try { status = await adapter.openParticipants(captionUI); } catch { status = null; }
      await sleep(1500); // 'open'/'clicked'/null → let the panel render, then re-check
    }
  }

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

  // Resume a recent session for the same meeting within this window, so an
  // interrupted-but-not-ended capture (SPA hop / auto-restart) continues ONE record
  // instead of forking fragments.
  const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000; // 3h
  // A reload comes back in seconds, so only adopt an 'unload'-ended record very
  // briefly. This is what stops a reused meeting code (Meet/Zoom PMI) from inheriting
  // an earlier, already-ended call's transcript.
  const RELOAD_RESUME_MS = 90 * 1000; // 90s
  async function start() {
    if (limitHit) return null; // Free cap reached this page-session — don't re-attempt a capture
    if (capturing) return meetingId;
    capturing = true; // claim synchronously so a re-entrant tick can't double-start
    const key = currentMeetingKey();
    activeMeetingKey = key;
    resetBuffers();
    startedAt = Date.now();
    meetingId = `mtg_${adapter.platform}_${key}_${startedAt.toString(36)}`;
    // Ask the worker for the latest record for this meeting and adopt it ONLY if
    // this start is a continuation of that same session — not a brand-new call that
    // happens to share the URL/key (e.g. a reused Google Meet code). Two cases
    // resume: a record still 'live' (interrupted mid-call, no clean end), or one
    // that ended via a tab reload ('unload', brief window — reloads come back in
    // seconds). A record that ended because the user left / went idle / hit Stop
    // is finished: we keep the fresh meetingId + empty transcript already set above.
    try {
      const r = await chrome.runtime.sendMessage({ type: 'CP_MEETING_LATEST', platform: adapter.platform, meetingKey: key });
      const age = r ? Date.now() - (r.persistedAt || r.startedAt || 0) : Infinity;
      const resumable = !!r && !!r.id && (
        (r.status !== 'ended' && age < RESUME_WINDOW_MS) ||
        (r.endReason === 'unload' && age < RELOAD_RESUME_MS)
      );
      if (capturing && resumable) {
        meetingId = r.id;
        startedAt = r.startedAt || startedAt;
        finalizedTranscript = Array.isArray(r.segments) ? r.segments.slice() : [];
      }
    } catch { /* worker asleep — keep the fresh session */ }
    if (!capturing) return meetingId; // stopped during the await
    if (adapter.onStart) safe(() => adapter.onStart());
    startObserver();
    startCaptionPoll(); // for cross-iframe captions (Webex); no-op for other platforms
    startFlushWorker();  // un-throttled background flush (best-effort; safe fallback if blocked)
    flush('live');
    tryEnableCaptions(); // fire-and-forget: turn captions on if the user left them off
    tryOpenParticipants(); // fire-and-forget: reveal the roster so we capture real names
    return meetingId;
  }

  // reason: 'left' | 'idle' | 'switch' | 'user' | 'unload' (see buildRecord.endReason).
  function stop(reason) {
    if (!capturing) return;
    capturing = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (flushWorker) { try { flushWorker.terminate(); } catch { /* already gone */ } flushWorker = null; }
    flush('ended', reason);
  }

  // Spin up the un-throttled flush heartbeat. Best-effort: if the page's CSP blocks a
  // worker from an extension URL, we quietly fall back to the observer's immediate flush
  // + the service-worker tick (existing behaviour) — nothing breaks.
  function startFlushWorker() {
    if (flushWorker || !chrome.runtime?.id) return;
    try {
      flushWorker = new Worker(chrome.runtime.getURL('content/flush-worker.js'));
      flushWorker.onmessage = () => { scanOnce(); flushIfDirty(); };
      flushWorker.onerror = () => { try { flushWorker.terminate(); } catch { /* noop */ } flushWorker = null; };
    } catch { flushWorker = null; /* CSP / unsupported — fall back to existing flush paths */ }
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
  //  • left/ended the call but the tab stays on a meeting URL (e.g. Meet's "You've
  //    ended the meeting" screen keeps meet.google.com/<id>) → finalize promptly.
  //  • gone quiet past IDLE_END_MS → finalize (fallback when end can't be detected).
  // Finalizing flips status→'ended', so it stops showing as live and lands in Past Meetings.
  let outOfCallTicks = 0;
  setInterval(() => {
    if (!capturing) { outOfCallTicks = 0; return; }
    if (currentMeetingKey() !== activeMeetingKey) {
      stop('switch');
      if (safe(() => adapter.match(location.href))) start();
      return;
    }
    if (safe(() => adapter.match(location.href)) === false) { stop('left'); return; }
    // Out of the call (no leave control, no captions) for 2 consecutive ticks (~6s)
    // → the call ended; finalize now instead of waiting out the idle timeout. The
    // brief hysteresis avoids stopping on a transient DOM flap mid-meeting. Only
    // adapters that implement inCall() participate; others rely on idle/navigation.
    if (typeof adapter.inCall === 'function') {
      if (!safe(() => adapter.inCall())) {
        if (++outOfCallTicks >= 2) { stop('left'); return; }
      } else {
        outOfCallTicks = 0;
      }
    }
    // Caption SILENCE is NOT an end signal while we can still see the call is joined
    // (inCall() above already ends a real leave). A muted/quiet-but-live call must keep
    // recording, so only fall back to the idle timeout for adapters WITHOUT inCall().
    if (typeof adapter.inCall !== 'function' && Date.now() - lastActivityTs() > IDLE_END_MS) { stop('idle'); return; }
  }, 3000);

  // Heartbeat: persist periodically while capturing (even during silence) so the
  // side panel can tell a live meeting is still alive vs a zombie (tab closed /
  // call left, so this script is gone and the record stops getting fresh writes).
  setInterval(() => { if (capturing) flush('live'); }, 20000);

  // Captions watcher (every 3s while capturing): (a) keep trying to auto-enable
  // captions — toolbars load late and some platforms reset them — and (b) notify
  // the side panel whenever caption state flips, so its meeting bar can WARN the
  // user when captions are off (no captions → no transcript) and clear the warning
  // the moment they come on, without the user having to switch tabs.
  let lastCaptionsLive = null;
  let captionsWatchTicks = 0;
  setInterval(() => {
    if (!capturing) { lastCaptionsLive = null; captionsWatchTicks = 0; return; }
    const live = !!safe(() => adapter.isLive());
    if (live !== lastCaptionsLive) {
      lastCaptionsLive = live;
      try { chrome.runtime.sendMessage({ type: 'CP_MEETING_CAPTIONS', live }); } catch { /* panel closed */ }
    }
    // Re-attempt auto-enable ~every 15s while still no captions (idempotent + guarded).
    if (!live && ++captionsWatchTicks % 5 === 0) tryEnableCaptions();
  }, 3000);

  // Pre-capture join watcher: while NOT yet capturing on a matched meeting page,
  // watch for the user actually JOINING the call and nudge an open side panel to
  // re-evaluate auto-start. Joining usually doesn't change the URL (green room →
  // call, pre-join → call are same-page), so the panel — which only re-checks on
  // tab switches — would otherwise miss it and capture would start late. We fire
  // once per join transition; the panel still owns the Pro/suppression gate, so
  // this is just a "now's the time to look" hint, never a capture trigger itself.
  let announcedJoin = false;
  setInterval(() => {
    if (capturing) { announcedJoin = false; return; }
    if (!safe(() => adapter.match(location.href))) { announcedJoin = false; return; }
    const joined = !!safe(() => (adapter.inCall ? adapter.inCall() : adapter.isLive()));
    if (joined && !announcedJoin) {
      announcedJoin = true;
      try { chrome.runtime.sendMessage({ type: 'CP_MEETING_JOINED', platform: adapter.platform }); } catch { /* no receiver (panel closed) */ }
    } else if (!joined) {
      announcedJoin = false;
    }
  }, 3000);

  // Final flush if the tab is closing mid-meeting. Guarded: during teardown the
  // extension context may already be gone, so swallow anything stop() throws.
  window.addEventListener('pagehide', () => { try { if (capturing) stop('unload'); } catch { /* detached */ } }, { once: true });

  // When the tab goes to the BACKGROUND, flush immediately so buffered captions land
  // before Chrome throttles our timers (otherwise the transcript sits until the tab is
  // foregrounded — the "had to open the tab to flush" complaint).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && capturing) { try { scanOnce(); flush('live'); } catch { /* detached */ } }
  });

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
          // Joined to the call (not the landing/lobby/preview page). The panel
          // gates auto-start on this so we never open an empty record on a
          // non-meeting page that merely matched the URL pattern.
          inCall: !!safe(() => (adapter.inCall ? adapter.inCall() : adapter.isLive())),
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
        start().then((id) => sendResponse({ ok: true, meetingId: id })).catch(() => sendResponse({ ok: true, meetingId }));
        return true; // async response
      case 'CP_MEETING_STOP':
        stop('user');
        sendResponse({ ok: true });
        return;
      case 'CP_MEETING_TICK':
        // Un-throttled heartbeat from the service-worker alarm: scan poll-based
        // captions, flush the buffer (refreshes persistedAt so the panel/SW know the
        // meeting is still alive even while backgrounded/silent), and report whether
        // we're still in the call. Ending stays with the watchdog / SW tab events.
        if (capturing) { scanOnce(); flush('live'); }
        sendResponse({
          ok: true,
          capturing,
          inCall: !!safe(() => (adapter.inCall ? adapter.inCall() : adapter.isLive())),
          meetingId,
        });
        return;
      case 'CP_MEETING_ENABLE_CC':
        // Manual nudge from the meeting bar's "Turn on captions" button.
        tryEnableCaptions();
        sendResponse({ ok: true, live: !!safe(() => adapter.isLive()) });
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
