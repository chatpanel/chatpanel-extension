// ChatPanel — Google Meet capture adapter (content script, classic).
//
// Meet renders live captions as discrete blocks (speaker + a text span that grows
// in place), so it uses the core's `discrete` caption path. Ported from the Meet
// Caption Capture userscript. Requires captions to be turned ON.
(function () {
  'use strict';

  const BLOCK_SEL = '.nMcdL.bj4p3b';   // one caption block
  const SPEAKER_SEL = '.NWpY1d';        // speaker name within a block
  const TEXT_SEL = '.ygicle.VbkSUe';    // caption text span (updates in place)

  let _idc = 0;
  let _ids = new WeakMap();
  // Accumulated attendees (name → {name,role,initials}) so names survive the roster
  // panel being closed again after we open it once.
  const roster = new Map();
  function idFor(el) {
    let id = _ids.get(el);
    if (!id) { id = 'g' + ++_idc; _ids.set(el, id); }
    return id;
  }

  function myName() {
    // "You" in the roster — resolve to the real name when present.
    const you = document.querySelector('div[role="listitem"].cxdMu .NnTWjc');
    return you?.closest('div[role="listitem"].cxdMu')?.querySelector('span.zWGUib')?.textContent?.trim() || '';
  }

  // Text spans touched by a mutation (new blocks + in-place growth).
  function textElsFrom(m) {
    const out = new Set();
    if (m.type === 'characterData') {
      const el = m.target.parentElement?.closest(TEXT_SEL);
      if (el) out.add(el);
    } else if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(TEXT_SEL)) out.add(node);
        node.querySelectorAll?.(TEXT_SEL).forEach((e) => out.add(e));
        // new block that contains a text span
        if (node.matches?.(BLOCK_SEL)) node.querySelectorAll?.(TEXT_SEL).forEach((e) => out.add(e));
      }
      if (m.target?.nodeType === 1) {
        const el = m.target.closest?.(TEXT_SEL);
        if (el) out.add(el);
      }
    }
    return [...out];
  }

  const adapter = {
    platform: 'meet',
    ready: true,
    captionMode: 'discrete',

    match: (url) => /:\/\/meet\.google\.com\/[a-z]/.test(url),

    meetingKey(url) {
      const m = new URL(url).pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      return m ? m[1] : 'meeting';
    },

    title: () => document.title.replace(/\s*[-–—].*$/, '').replace(/^Meet\s*[—-]\s*/i, '').trim() || 'Google Meet',

    isLive: () => !!document.querySelector(`${BLOCK_SEL}, ${TEXT_SEL}`),

    // Open the People panel once so we capture real names (the roster lists every
    // attendee). Meet labels it "Show everyone" / "People".
    openParticipants(ui) {
      if (document.querySelector('div[role="listitem"].cxdMu')) return 'open';
      const btn = ui.byName(/show everyone|^people$|participants/i);
      if (btn) { ui.click(btn); return 'clicked'; }
      return null;
    },

    // Joined to the call vs. sitting in the green room (which shows "Join now" /
    // "Ask to join" at the same URL). The "Leave call" control exists only once
    // you're in; isLive() is the definitive fallback. Gates auto-start so the
    // green room never spins up an empty meeting record.
    inCall() {
      return !!document.querySelector('button[aria-label*="leave call" i], [aria-label*="leave call" i]')
        || this.isLive();
    },

    onStart() { _idc = 0; _ids = new WeakMap(); },

    // Meet exposes a single labelled toggle in the call controls — "Turn on
    // captions" / "Turn off captions". Reliable and reversible-aware.
    enableCaptions(ui) {
      const btn = ui.byName(/turn (on|off) captions/i) || ui.byName(/captions?/i);
      if (!btn) return null; // toolbar not rendered yet → core retries
      if (/turn off captions/i.test(btn.getAttribute('aria-label') || '')) return 'on';
      ui.click(btn);
      return 'clicked';
    },

    readDiscreteCaptions(m) {
      const els = textElsFrom(m);
      if (!els.length) return null;
      const me = myName();
      return els.map((el) => {
        const block = el.closest(BLOCK_SEL) || el.parentElement;
        let speaker = block?.querySelector(SPEAKER_SEL)?.textContent?.trim() || 'Speaker';
        if (speaker === 'You' && me) speaker = me;
        return { id: idFor(el), speaker, text: (el.textContent || '').trim() };
      });
    },

    readChat(m) {
      if (m.type !== 'childList') return null;
      const out = [];
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const blocks = node.matches?.('div.Ss4fHf')
          ? [node]
          : Array.from(node.querySelectorAll?.('div.Ss4fHf') || []);
        for (const b of blocks) {
          const sender = b.querySelector('.poVWob')?.textContent?.trim() || 'Unknown';
          b.querySelectorAll('div[jsname="dTKtvb"]').forEach((mn) => {
            const text = mn.textContent?.trim();
            if (text) out.push({ t: Date.now(), sender, receiver: 'Everyone', text });
          });
        }
      }
      return out.length ? out : null;
    },

    participants() {
      document.querySelectorAll('div[role="listitem"].cxdMu').forEach((p) => {
        const name = p.querySelector('span.zWGUib')?.textContent?.trim();
        if (!name) return;
        const role = p.querySelector('.d93U2d')?.textContent?.trim() || '';
        const existing = roster.get(name);
        if (!existing) {
          roster.set(name, {
            name,
            role,
            initials: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase(),
          });
        } else if (!existing.role && role) {
          existing.role = role;
        }
      });
      return [...roster.values()];
    },

    debug() {
      return {
        blocks: document.querySelectorAll(BLOCK_SEL).length,
        textSpans: document.querySelectorAll(TEXT_SEL).length,
        sampleCaption: document.querySelector(TEXT_SEL)?.textContent?.trim()?.slice(0, 80) || null,
      };
    },
  };

  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
