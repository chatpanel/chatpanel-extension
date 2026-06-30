// ChatPanel — Cisco Webex capture adapter (content script, classic).
//
// Webex is the odd one out: the meeting UI (toolbar, captions panel, floating
// captions, participants, chat) renders in a SAME-ORIGIN iframe nested inside the
// /wbxmjs/ "join" wrapper page. A single-document observer in the wrapper frame
// never sees those captions. So — mirroring the proven WebEx Caption Capture
// userscript — this adapter walks all same-origin documents (top + child iframes)
// for both detection and capture, and exposes scanCaptions() so the core drives a
// short POLL loop instead of relying only on a per-frame MutationObserver. Requires
// captions (the "Webex Assistant" closed-captions toggle) to be ON; we try to flip
// it on automatically. Selectors ported from the userscript's observed Webex DOM.
(function () {
  'use strict';

  let _idc = 0;
  let _ids = new WeakMap();
  // Accumulated attendees so names survive the participants panel being closed.
  const roster = new Map();
  function idFor(el) {
    let id = _ids.get(el);
    if (!id) { id = 'w' + ++_idc; _ids.set(el, id); }
    return id;
  }

  // All reachable documents: this frame's document plus any SAME-ORIGIN child
  // iframes (cross-origin frames throw on access and are skipped). This is what
  // lets the wrapper frame reach the meeting iframe's captions/toolbar.
  function getAllDocs() {
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { const d = f.contentDocument; if (d) docs.push(d); } catch { /* cross-origin */ }
    }
    return docs;
  }
  function anyDoc(selector) {
    for (const d of getAllDocs()) {
      try { if (d.querySelector(selector)) return true; } catch { /* detached/cross-origin */ }
    }
    return false;
  }

  // Caption containers across Webex builds (floating overlay + captions panel).
  const CAPTION_SEL =
    '[class*="closed-captions-container"], [class*="caption-text-box"], [class*="caption-NGr6E"], ' +
    '[class*="caption-item"], [class*="caption"][class*="full-height"]';

  // Collect every current caption line across all same-origin docs. Handles both
  // the modern <mdc-text><span>Speaker</span><span>text</span></mdc-text> rows and
  // older <p dir="auto"> / panel `caption-item` rows. Stable per-element ids let the
  // core update a growing caption in place instead of appending duplicates.
  function gather() {
    const out = [];
    for (const doc of getAllDocs()) {
      let containers;
      try { containers = doc.querySelectorAll(CAPTION_SEL); } catch { continue; }
      for (const container of containers) {
        // Panel rows: explicit caption-item with name/text children.
        if (/caption-item/.test(typeof container.className === 'string' ? container.className : '')) {
          const text = container.querySelector('[class*="caption-text"]')?.textContent?.trim();
          if (text) {
            out.push({
              id: idFor(container),
              speaker: container.querySelector('[class*="caption-name"]')?.textContent?.trim() || 'Speaker',
              text,
            });
          }
          continue;
        }
        // Floating overlay: prefer mdc-text rows, else <p>.
        let rows = container.querySelectorAll('mdc-text');
        if (!rows.length) rows = container.querySelectorAll('p[dir="auto"], p[class*="ltr-text"], p');
        for (const row of rows) {
          let speaker = 'Speaker';
          let text = (row.textContent || '').trim();
          const spans = row.querySelectorAll(':scope > span');
          if (spans.length >= 2) {
            speaker = spans[0].textContent.replace(/[:\s ]+$/, '').trim() || 'Speaker';
            text = Array.from(spans).slice(1).map((s) => s.textContent).join(' ').trim();
          } else {
            const speakerEl = row.querySelector('[class*="speaker-name"]');
            if (speakerEl) {
              speaker = speakerEl.textContent.replace(/[:\s ]+$/, '').trim() || 'Speaker';
              text = text.replace(speakerEl.textContent, '').trim();
            } else if (text.includes(':')) {
              const i = text.indexOf(':');
              if (i > 0 && i < 50) { speaker = text.slice(0, i).trim(); text = text.slice(i + 1).trim(); }
            }
          }
          if (text) out.push({ id: idFor(row), speaker, text });
        }
      }
    }
    return out;
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

    // Captions live anywhere in the same-origin frame tree.
    isLive: () => anyDoc(CAPTION_SEL),

    // Joined to the meeting vs. on the Webex landing / preview page. Webex tags its
    // control-bar buttons with data-doi (the most reliable signal) — LEAVE_MEETING /
    // PARTICIPANT / ROSTER / CHAT / REACTION only exist once you're in the call. We
    // also accept in-call-only control names (Leave / Participants / Reactions /
    // Raise hand / Record) and live captions, searching across same-origin iframes.
    inCall() {
      if (this.isLive()) return true;
      if (anyDoc(
        '[data-doi*="LEAVE_MEETING" i], [data-doi*="PARTICIPANT" i], [data-doi*="ROSTER" i], ' +
        '[data-doi*="CHAT" i], [data-doi*="REACTION" i], [data-doi*="RAISE_HAND" i]',
      )) return true;
      const NAMES = /\b(leave|end meeting|participants?|reactions?|raise hand|record|breakout)\b/i;
      for (const d of getAllDocs()) {
        let ctrls;
        try { ctrls = d.querySelectorAll('button, [role="button"], [aria-label]'); } catch { continue; }
        for (const b of ctrls) {
          const n = (b.getAttribute('aria-label') || b.textContent || '').trim();
          if (n && n.length < 40 && NAMES.test(n)) return true;
        }
      }
      return false;
    },

    onStart() { _idc = 0; _ids = new WeakMap(); },

    // Webex hides captions behind the "Webex Assistant" / Closed-captions toggle,
    // often inside the meeting iframe. We can't rely on the core's shadow-DOM ui
    // (it doesn't cross iframes), so we walk same-origin docs ourselves and click
    // the toggle (matched by aria-label or data-doi, from the userscript). If the
    // host disabled captions for the meeting there's no toggle and we give up.
    enableCaptions() {
      const ON = [
        'button[aria-label*="Webex Assistant is turned on" i]',
        'button[aria-label*="Closed captions"][aria-pressed="true"]',
      ];
      const OFF = [
        'button[aria-label*="Webex Assistant is turned off" i]',
        'button[aria-label*="Webex Assistant" i]',
        'button[aria-label="Closed captions"]',
        'button[aria-label*="closed captions" i]',
        'button[data-doi*="CLOSED_CAPTION" i]',
        'button[data-doi*="WEBEX_ASSISTANT" i]',
        '[class*="cc-button"]',
      ];
      for (const d of getAllDocs()) {
        for (const sel of ON) { try { if (d.querySelector(sel)) return 'on'; } catch { /* skip */ } }
      }
      for (const d of getAllDocs()) {
        for (const sel of OFF) {
          try { const b = d.querySelector(sel); if (b) { b.click(); return 'clicked'; } } catch { /* skip */ }
        }
      }
      return null;
    },

    // Observer path (same-frame captions). The cross-iframe case is covered by the
    // poll path below, which the core runs because scanCaptions() exists.
    readDiscreteCaptions(m) {
      const sel = '[class*="caption"]';
      let touches = false;
      if (m.type === 'characterData') touches = !!m.target.parentElement?.closest?.(sel);
      else if (m.type === 'childList') {
        if (m.target?.nodeType === 1 && m.target.closest?.(sel)) touches = true;
        else for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.(sel) || n.querySelector?.(sel))) { touches = true; break; }
      }
      return touches ? gather() : null;
    },

    // Poll path: the core calls this every couple of seconds while capturing, so we
    // catch captions rendered in a child iframe that no single-frame observer sees.
    scanCaptions() {
      return gather();
    },

    // Open the Participants panel once so we capture real names. Webex tags the
    // button with data-doi=PARTICIPANT (or aria-label "Participants panel"); walk
    // same-origin docs since it usually lives in the meeting iframe.
    openParticipants() {
      const PANEL = '[role="option"][class*="list-item"], #plist, [class*="participants-list-wrapper"], [class*="plist-wrapper"]';
      for (const d of getAllDocs()) { try { if (d.querySelector(PANEL)) return 'open'; } catch { /* skip */ } }
      const BTN = 'button[aria-label*="Participants panel" i], button[data-doi*="PARTICIPANT" i], button[aria-label*="participants" i]';
      for (const d of getAllDocs()) {
        try { const b = d.querySelector(BTN); if (b) { b.click(); return 'clicked'; } } catch { /* skip */ }
      }
      return null;
    },

    participants() {
      for (const d of getAllDocs()) {
        let items;
        try { items = d.querySelectorAll('[role="option"][class*="list-item"], [class*="roster-cell"], li[class*="participant"]'); } catch { continue; }
        for (const p of items) {
          const name = (p.querySelector('[class*="title-"][class*="ellipsis"], div[title][class*="title"], [class*="display"]')?.textContent
            || p.querySelector('span, div')?.textContent || '').trim();
          if (!name || roster.has(name)) continue;
          roster.set(name, {
            name,
            role: p.querySelector('[class*="subtitle"], [class*="role"]')?.textContent?.trim() || '',
            initials: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase(),
          });
        }
      }
      return [...roster.values()];
    },

    debug() {
      const docs = getAllDocs();
      return {
        docs: docs.length,
        captionContainers: docs.reduce((n, d) => { try { return n + d.querySelectorAll(CAPTION_SEL).length; } catch { return n; } }, 0),
        sample: gather()[0]?.text?.slice(0, 80) || null,
      };
    },
  };

  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
