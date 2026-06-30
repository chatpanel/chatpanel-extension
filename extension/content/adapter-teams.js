// ChatPanel — Microsoft Teams capture adapter (content script, classic).
//
// Teams renders live captions as discrete lines (one element per utterance that
// grows in place), so it uses the core's `discrete` caption path. Ported from the
// Teams Caption Capture userscript. Requires live captions to be ON in the meeting.
(function () {
  'use strict';

  const CAPTION_SEL = '[data-tid="closed-caption-text"]';

  let _idc = 0;
  let _ids = new WeakMap(); // caption element -> stable id for this session
  // Accumulated attendees so names survive the roster panel being closed again.
  const roster = new Map();
  function idFor(el) {
    let id = _ids.get(el);
    if (!id) { id = 't' + ++_idc; _ids.set(el, id); }
    return id;
  }

  // Caption elements touched by a mutation (added lines + in-place text growth).
  function captionElsFrom(m) {
    const out = new Set();
    if (m.type === 'characterData') {
      const el = m.target.parentElement?.closest(CAPTION_SEL);
      if (el) out.add(el);
    } else if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(CAPTION_SEL)) out.add(node);
        node.querySelectorAll?.(CAPTION_SEL).forEach((e) => out.add(e));
      }
      if (m.target?.nodeType === 1) {
        const el = m.target.closest?.(CAPTION_SEL);
        if (el) out.add(el);
      }
    }
    return [...out];
  }

  const adapter = {
    platform: 'teams',
    ready: true,
    captionMode: 'discrete',

    match: (url) => /:\/\/([^/]*\.)?teams\.(microsoft|live)\.com\//.test(url),

    meetingKey(url) {
      const m = /19[:%][^/?#]+/.exec(url);
      if (m) return decodeURIComponent(m[0]).slice(0, 48).replace(/[^\w:-]/g, '');
      const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
      return seg ? seg.slice(0, 40) : 'meeting';
    },

    title: () => document.title.replace(/\s*[|–—-].*$/, '').trim() || 'Teams meeting',

    isLive: () => !!document.querySelector(CAPTION_SEL),

    // Joined to the call vs. anywhere else in the Teams web app (our content script
    // matches all of teams.microsoft.com, not just meetings — so the signal must be
    // meeting-SPECIFIC, never a generic "Leave" label that also means leave-a-team).
    // The hang-up control only renders inside an active call; isLive() is the
    // definitive fallback. Gates auto-start so non-meeting Teams pages and the
    // pre-join lobby never open an empty record.
    inCall() {
      return !!document.querySelector(
        '[data-tid="hangup-button"], [data-tid="call-end"], #hangup-button, [data-tid="call-roster-button"]',
      ) || this.isLive();
    },

    onStart() { _idc = 0; _ids = new WeakMap(); },

    // Open the People/roster panel once so captions resolve to real names. Teams
    // labels it "People" / "Show participants"; the roster button has a stable tid.
    openParticipants(ui) {
      if (document.querySelector('li[data-cid="roster-participant"]')) return 'open';
      const btn = document.querySelector('[data-tid="call-roster-button"], [data-tid="roster-button"]')
        || ui.byName(/^people$|show participants|participants|roster/i);
      if (btn) { ui.click(btn); return 'clicked'; }
      return null;
    },

    // Best-effort: Teams buries captions under More → Language and speech → Turn on
    // live captions. We walk one menu level per core tick — click the deepest item
    // we can currently see, else open its parent menu and return 'pending'. Names
    // are accessible-name based but unverified across all Teams builds.
    enableCaptions(ui) {
      const toggle = ui.byName(/turn (on|off) live captions/i);
      if (toggle) {
        if (/turn off/i.test(ui.name(toggle))) return 'on';
        ui.click(toggle);
        return 'clicked';
      }
      const lang = ui.byName(/language and speech/i);
      if (lang) { ui.click(lang); return 'pending'; }
      const more = ui.byName(/more actions|more options|^more$/i);
      if (more) { ui.click(more); return 'pending'; }
      return null;
    },

    readDiscreteCaptions(m) {
      const els = captionElsFrom(m);
      if (!els.length) return null;
      return els.map((el) => {
        const speaker =
          el.closest('.fui-ChatMessageCompact')?.querySelector('[data-tid="author"]')?.textContent?.trim() ||
          'Unknown';
        return { id: idFor(el), speaker, text: (el.textContent || '').trim() };
      });
    },

    readChat(m) {
      if (m.type !== 'childList') return null;
      const out = [];
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const items = node.matches?.('div[data-tid="chat-pane-item"]')
          ? [node]
          : Array.from(node.querySelectorAll?.('div[data-tid="chat-pane-item"]') || []);
        for (const it of items) {
          const text = it.querySelector('div[data-tid="message-body"], div[id^="content-"]')?.textContent?.trim();
          if (!text) continue;
          out.push({
            t: Date.now(),
            sender: it.querySelector('span[data-tid="message-author-name"]')?.textContent?.trim() || 'Unknown',
            receiver: 'Everyone',
            text,
          });
        }
      }
      return out.length ? out : null;
    },

    participants() {
      document.querySelectorAll('li[data-cid="roster-participant"] span[title]').forEach((n) => {
        const name = (n.getAttribute('title') || n.textContent || '').trim();
        if (name && !roster.has(name)) {
          roster.set(name, { name, role: '', initials: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() });
        }
      });
      return [...roster.values()];
    },

    debug() {
      return {
        captionEls: document.querySelectorAll(CAPTION_SEL).length,
        sampleSpeaker: document.querySelector('[data-tid="author"]')?.textContent?.trim() || null,
        sampleCaption: document.querySelector(CAPTION_SEL)?.textContent?.trim()?.slice(0, 80) || null,
      };
    },
  };

  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
