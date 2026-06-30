// ChatPanel — Zoom capture adapter (content script, classic — NOT a module).
//
// Owns all Zoom-web-client DOM knowledge. Self-registers on the shared registry;
// meeting-core.js selects it by match() and calls its hooks. DOM scraping ported
// from the "Zoom Caption Capture" userscript. REQUIRES live captioning/transcription
// to be ON in the meeting — this reads rendered caption DOM, not audio. Selectors
// are Zoom-version-specific and may need maintenance when Zoom ships UI changes.
(function () {
  'use strict';

  // speaker-icon (avatar src or initials) → resolved full name, built from the
  // participants list so captions get real names instead of initials.
  const attendees = new Map();

  function refreshParticipants() {
    const items = document.querySelectorAll('div[id^="participants-list-"]');
    items.forEach((item) => {
      const nameNode = item.querySelector('.participants-item__display-name');
      const role = item.querySelector('.participants-item__name-label')?.textContent.trim() || '';
      const avatarNode = item.querySelector('.participants-item__avatar');
      if (!avatarNode) return;
      let avatarSrc = null;
      let initials = null;
      if (avatarNode.tagName === 'IMG') {
        avatarSrc = avatarNode.src;
        initials = nameNode ? nameNode.textContent.trim().split(' ').map((n) => n[0]).join('').toUpperCase() : null;
      } else {
        initials = avatarNode.textContent.trim();
      }
      const fullName = nameNode ? nameNode.textContent.trim() : '';
      const key = avatarSrc || item.id;
      const existing = attendees.get(key);
      if (!existing) {
        attendees.set(key, { fullName, initials, avatarSrc, role });
      } else {
        if (!existing.fullName && fullName) existing.fullName = fullName;
        if (!existing.role && role) existing.role = role;
      }
    });
  }

  function resolveSpeaker(identifier) {
    for (const a of attendees.values()) {
      if (a.avatarSrc && identifier === a.avatarSrc) return a.fullName || 'Unknown Speaker';
    }
    if (attendees.has(identifier)) return attendees.get(identifier).fullName || 'Unknown Speaker';
    for (const a of attendees.values()) {
      if (a.initials && a.initials === identifier) return a.fullName || 'Unknown Speaker';
    }
    return identifier || 'Unknown Speaker';
  }

  // Known container for the classic web client, plus broad fallbacks so newer
  // Zoom builds (app.zoom.us) that renamed the caption DOM still get captured.
  const CAPTION_SEL =
    '#live-transcription-subtitle, .live-transcription-subtitle, [class*="live-transcription"], ' +
    '[class*="caption" i], [class*="subtitle" i], [class*="lt-sub" i], [aria-label*="caption" i]';
  // Things that look caption-ish by selector but aren't transcript text — skip them.
  const CAPTION_DENY = /(button|btn|icon|setting|menu|tooltip|toggle|control)/i;

  function isCaptionish(el) {
    if (!el || el.nodeType !== 1) return false;
    const sig = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
    return CAPTION_SEL && el.matches?.(CAPTION_SEL) && !CAPTION_DENY.test(sig);
  }

  function captionContainerFrom(mutation) {
    if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('#live-transcription-subtitle')) return node;
        const found = node.querySelector?.('#live-transcription-subtitle');
        if (found) return found;
        // Fallback: an added node that is (or contains) a caption-ish container.
        if (isCaptionish(node)) return node;
        const inner = node.querySelector?.(CAPTION_SEL);
        if (inner && !CAPTION_DENY.test(`${inner.id} ${inner.className}`)) return inner;
      }
    } else if (mutation.type === 'characterData') {
      const host = mutation.target.parentElement;
      return (
        host?.closest('#live-transcription-subtitle') ||
        host?.closest(CAPTION_SEL) ||
        null
      );
    }
    return null;
  }

  const adapter = {
    platform: 'zoom',
    ready: true,

    match(url) {
      return /:\/\/[^/]*\.zoom\.us\/wc\//.test(url);
    },

    meetingKey(url) {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const wc = parts.indexOf('wc');
      if (wc >= 0) {
        for (let i = wc + 1; i < parts.length; i++) {
          if (/^\d{5,}$/.test(parts[i])) return parts[i];
        }
      }
      return 'meeting';
    },

    title() {
      return document.title.replace(/\s*[-—]\s*Zoom.*$/i, '').trim() || 'Zoom meeting';
    },

    // Captions only appear once live transcription is enabled in the meeting.
    isLive() {
      return !!(document.querySelector('#live-transcription-subtitle') ||
        [...document.querySelectorAll(CAPTION_SEL)].some(
          (e) => !CAPTION_DENY.test(`${e.id} ${e.className}`) && (e.textContent || '').trim().length > 1,
        ));
    },

    // Are we actually JOINED to the call (vs. on the web client's landing / join /
    // audio-video preview page, which all live under /wc/ too)? The in-meeting
    // bottom control bar only exists once joined, so we use it as the join signal.
    // Detection has to be tolerant: the app.zoom.us PWA varies its markup, the HOST
    // sees "End" while a guest sees "Leave", and buttons expose their name via
    // aria-label OR visible text. isLive() is OR'd in as a definitive fallback —
    // captions can't appear outside a live meeting. This gates auto-start so we
    // never open an (empty) record on a non-meeting Zoom page.
    inCall() {
      if (this.isLive()) return true;
      // Unambiguous in-meeting controls — present only once joined, anywhere in the DOM.
      if (document.querySelector(
        '#wc-footer, [class*="footer__leave"], .footer__leave-btn, ' +
        '[aria-label*="leave" i], [aria-label*="end meeting" i], [aria-label*="more meeting controls" i]',
      )) return true;
      // Fallback: scan the control bar for a meeting-control name (aria-label OR
      // text), since the PWA sometimes labels footer buttons by text only.
      const NAMES = /\b(leave|end|participants?|reactions?|react|share|chat|mute|unmute|start video|stop video|host tools|more)\b/i;
      const ctrls = document.querySelectorAll(
        '#wc-footer button, footer button, [class*="footer"] button, [class*="meeting-control"] button, [class*="controls"] button',
      );
      for (const b of ctrls) {
        const n = (b.getAttribute('aria-label') || b.textContent || '').trim();
        if (n && NAMES.test(n)) return true;
      }
      return false;
    },

    // One-shot DOM probe so capture problems are diagnosable from the console
    // without a hand-written snippet. Deep-walks open shadow roots (the new
    // app.zoom.us client nests UI in shadow DOM), reports which caption selectors
    // match, and — given a word you can see on screen — locates the exact element
    // holding the caption text plus its ancestor chain and whether it's in shadow
    // DOM. Usage: __cpMeetingDebug('myself')  (a word visible in the caption).
    debug(needle) {
      const all = [];
      (function walk(root, depth) {
        if (depth > 12 || !root.querySelectorAll) return;
        for (const el of root.querySelectorAll('*')) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
      })(document, 0);

      const sels = [
        '#live-transcription-subtitle',
        '[class*="live-transcription"]',
        '[class*="caption" i]',
        '[class*="subtitle" i]',
        '[class*="lt-sub" i]',
        '[aria-label*="caption" i]',
      ];
      const selectorCounts = {};
      for (const s of sels) {
        selectorCounts[s] = all.filter((e) => { try { return e.matches?.(s); } catch { return false; } }).length;
      }

      const result = {
        url: location.href,
        isTopFrame: window === window.top,
        totalEls: all.length,
        shadowHosts: all.filter((e) => e.shadowRoot).length,
        iframes: document.querySelectorAll('iframe').length,
        iframeSrcs: [...document.querySelectorAll('iframe')]
          .map((f) => f.src || f.getAttribute('src') || '(no src)')
          .slice(0, 6),
        selectorCounts,
      };

      const chainOf = (e) => {
        const chain = [];
        let x = e;
        for (let d = 0; x && x.nodeType === 1 && d < 11; d++) {
          const cls = typeof x.className === 'string' && x.className.trim()
            ? '.' + x.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
          chain.push((x.tagName || '').toLowerCase() + (x.id ? '#' + x.id : '') + cls);
          x = x.parentElement || (x.getRootNode && x.getRootNode().host) || null;
        }
        return chain.join('  >  ');
      };

      if (needle) {
        // Targeted: find the element holding a word you can see in the caption.
        const n = String(needle).toLowerCase();
        const leaves = all.filter(
          (e) => e.children.length === 0 && (e.textContent || '').toLowerCase().includes(n),
        );
        result.needle = needle;
        result.matchCount = leaves.length;
        result.matches = leaves.slice(0, 4).map((e) => ({
          text: (e.textContent || '').trim().slice(0, 80),
          inShadow: !!(e.getRootNode && e.getRootNode().host),
          chain: chainOf(e),
        }));
      } else {
        // Untargeted: surface sentence-like leaf text (likely captions/chat) so we
        // can spot where transcript text lives without needing a known word. Skips
        // obvious chrome (nav/buttons/menus) and very short labels.
        const SKIP = /(button|btn|icon|menu|nav|tab|tooltip|toggle|aria|label|control|footer|header)/i;
        const cands = all
          .filter((e) => e.children.length === 0)
          .map((e) => ({ e, t: (e.textContent || '').replace(/\s+/g, ' ').trim() }))
          .filter(({ e, t }) =>
            t.length >= 12 && t.length <= 220 && t.includes(' ') &&
            !SKIP.test(`${e.id} ${typeof e.className === 'string' ? e.className : ''}`))
          .sort((a, b) => b.t.length - a.t.length)
          .slice(0, 6);
        result.textCandidates = cands.map(({ e, t }) => ({
          text: t.slice(0, 80),
          inShadow: !!(e.getRootNode && e.getRootNode().host),
          chain: chainOf(e),
        }));
      }
      return result;
    },

    // Refresh the name map when capture starts (the participants panel may be open).
    onStart() {
      refreshParticipants();
    },

    // Open the Participants panel once so caption avatars/initials resolve to real
    // names. Host sees "Manage participants"; guests see "Participants" / "Open the
    // participants list panel". Returns 'open' if already showing.
    openParticipants(ui) {
      if (document.querySelector('div[id^="participants-list-"], [class*="participants-section-container"]')) {
        refreshParticipants();
        return 'open';
      }
      const btn = ui.byName(/^participants$|participants list|manage participants|open the participants/i);
      if (btn) { ui.click(btn); return 'clicked'; }
      return null;
    },

    // Best-effort, and the least reliable of the four: Zoom buries captions under
    // More → Captions → Show Captions (the modern app.zoom.us client nests these in
    // shadow DOM — the core's ui pierces it). Crucially, if the HOST disabled
    // captions/transcription for the meeting, no toggle exists and nothing here can
    // force it on — we just give up and the bar keeps hinting "turn on captions".
    enableCaptions(ui) {
      const show = ui.byName(/show captions|show subtitle/i);
      if (show) { ui.click(show); return 'clicked'; }
      // "Captions" / "Live Transcript" is usually a submenu opener, not the toggle.
      const capMenu = ui.byName(/^captions$|live transcript|closed caption/i);
      if (capMenu && !ui.isOn(capMenu)) { ui.click(capMenu); return 'pending'; }
      const more = ui.byName(/more meeting controls|more options|^more$/i);
      if (more) { ui.click(more); return 'pending'; }
      return null;
    },

    // Return { speaker, text } for the current on-screen caption, or null.
    readCaption(mutation) {
      const container = captionContainerFrom(mutation);
      if (!container) return null;
      // Classic structure: explicit text + speaker-icon nodes.
      const textNode = container.querySelector('.live-transcription-subtitle__item');
      const iconNode = container.querySelector('.zmu-data-selector-item__icon');
      if (textNode && iconNode) {
        const identifier = iconNode.tagName === 'IMG' ? iconNode.src : iconNode.textContent.trim();
        const text = textNode.textContent.trim();
        if (!text) return null;
        if (!attendees.size) refreshParticipants();
        return { speaker: resolveSpeaker(identifier), text };
      }
      // Fallback (newer/renamed DOM): take the container's own text. Many builds
      // render "<Speaker>: <text>" or put the name in a child; try to split it.
      const raw = (container.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length < 2) return null;
      const m = /^([^:]{1,40}):\s*(.+)$/.exec(raw);
      if (m) return { speaker: m[1].trim(), text: m[2].trim() };
      return { speaker: 'Speaker', text: raw };
    },

    // Return any new chat messages contained in this mutation.
    readChat(mutation) {
      if (mutation.type !== 'childList') return null;
      const out = [];
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const containers = node.matches?.('.chat-item-container')
          ? [node]
          : Array.from(node.querySelectorAll?.('.chat-item-container') || []);
        for (const c of containers) {
          const sender = c.querySelector('.chat-item__sender')?.textContent?.trim();
          const text = c.querySelector('.new-chat-message__text-box')?.textContent?.trim();
          if (!text) continue;
          out.push({
            t: Date.now(),
            sender: sender || 'Unknown',
            receiver: c.querySelector('.chat-item__receiver')?.textContent?.trim() || 'Everyone',
            text,
          });
        }
      }
      return out.length ? out : null;
    },

    participants() {
      refreshParticipants();
      return Array.from(attendees.values())
        .filter((a) => a.fullName)
        .map((a) => ({ name: a.fullName, role: a.role || '', initials: a.initials || '' }));
    },
  };

  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
