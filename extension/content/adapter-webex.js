// ChatPanel — Cisco Webex capture adapter (content script, classic).
//
// Webex renders captions either in a captions panel (`caption-item` rows) or a
// floating overlay (`caption-text-box` with per-line <p>). Both are discrete, so
// this uses the core's `discrete` path. The meeting UI runs in an inner iframe;
// `all_frames` injects us there and the panel picks the frame with the captions.
// Ported from the Webex Caption Capture userscript. Requires captions ON.
(function () {
  'use strict';

  let _idc = 0;
  let _ids = new WeakMap();
  function idFor(el) {
    let id = _ids.get(el);
    if (!id) { id = 'w' + ++_idc; _ids.set(el, id); }
    return id;
  }

  // Collect every current caption line (panel rows + floating paragraphs).
  function gather() {
    const out = [];
    document.querySelectorAll('[class*="caption-item"]').forEach((item) => {
      const text = item.querySelector('[class*="caption-text"]')?.textContent?.trim();
      if (text) {
        out.push({
          id: idFor(item),
          speaker: item.querySelector('[class*="caption-name"]')?.textContent?.trim() || 'Speaker',
          text,
        });
      }
    });
    document
      .querySelectorAll('[class*="caption-text-box"] p, [class*="caption-NGr6E"] p, [class*="full-height"] p')
      .forEach((p) => {
        const speakerEl = p.querySelector('[class*="speaker-name"]');
        let name = 'Speaker';
        let text = (p.textContent || '').trim();
        if (speakerEl) {
          name = speakerEl.textContent.replace(/[:\s ]+$/, '').trim();
          text = text.replace(speakerEl.textContent, '').trim();
        } else if (text.includes(':')) {
          const i = text.indexOf(':');
          if (i > 0 && i < 50) { name = text.slice(0, i).trim(); text = text.slice(i + 1).trim(); }
        }
        if (text) out.push({ id: idFor(p), speaker: name, text });
      });
    return out;
  }

  function involvesCaption(m) {
    const sel = '[class*="caption"]';
    if (m.type === 'characterData') return !!m.target.parentElement?.closest(sel);
    if (m.type === 'childList') {
      if (m.target?.nodeType === 1 && m.target.closest?.(sel)) return true;
      for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.(sel) || n.querySelector?.(sel))) return true;
    }
    return false;
  }

  const adapter = {
    platform: 'webex',
    ready: true,
    captionMode: 'discrete',

    match: (url) => /:\/\/[^/]*\.webex\.com\/(meet|wbxmjs|webappng|meeting|cisco)/.test(url),

    meetingKey(url) {
      const m = /\/(meet|join|wbxmjs)\/([^/?#]+)/.exec(url);
      if (m) return m[2].slice(0, 40);
      const q = new URL(url).searchParams;
      return q.get('MTID') || q.get('confID') || 'meeting';
    },

    title: () => document.title.replace(/\s*[|–—-].*$/, '').trim() || 'Webex meeting',

    isLive: () => !!document.querySelector('[class*="caption-item"], [class*="caption-text-box"]'),

    onStart() { _idc = 0; _ids = new WeakMap(); },

    readDiscreteCaptions(m) {
      // Only scan when the mutation actually touches caption DOM (keeps us cheap).
      return involvesCaption(m) ? gather() : null;
    },

    participants() {
      const out = [];
      document.querySelectorAll('[role="option"][class*="list-item"]').forEach((p) => {
        const name = (p.querySelector('[class*="title-"][class*="ellipsis"], div[title][class*="title"]')?.textContent || '').trim();
        if (name) {
          out.push({
            name,
            role: p.querySelector('[class*="subtitle"]')?.textContent?.trim() || '',
            initials: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase(),
          });
        }
      });
      return out;
    },

    debug() {
      return {
        captionItems: document.querySelectorAll('[class*="caption-item"]').length,
        floatingBoxes: document.querySelectorAll('[class*="caption-text-box"]').length,
        sample: gather()[0]?.text?.slice(0, 80) || null,
      };
    },
  };

  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
