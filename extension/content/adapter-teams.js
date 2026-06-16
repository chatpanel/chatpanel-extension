// ChatPanel — Microsoft Teams capture adapter (STUB).
//
// Interface only. Teams (web) shows live captions in a captions container with
// per-line author + text spans, captions-on required. To finish: implement
// isLive()/readCaption() against the Teams caption DOM and set `ready` to true.
(function () {
  'use strict';
  const adapter = {
    platform: 'teams',
    ready: false,
    match: (url) => /:\/\/teams\.(microsoft|live)\.com\//.test(url),
    meetingKey: (url) => {
      const m = /19[:_][^/?#]+/.exec(url);
      return m ? m[0].slice(0, 40) : 'meeting';
    },
    title: () => document.title.replace(/\s*[|–—-].*$/, '').trim() || 'Teams meeting',
    isLive: () => false, // TODO: detect captions renderer
    readCaption: () => null, // TODO: parse caption author/text → {speaker,text}
    participants: () => [],
  };
  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
