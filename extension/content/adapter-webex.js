// ChatPanel — Webex capture adapter (STUB).
//
// Interface only. Webex renders closed captions in a captions panel; captions-on
// required. To finish: implement isLive()/readCaption() against the Webex caption
// DOM and set `ready` to true.
(function () {
  'use strict';
  const adapter = {
    platform: 'webex',
    ready: false,
    match: (url) => /:\/\/[^/]*\.webex\.com\/(meet|wbxmjs|webappng)/.test(url),
    meetingKey: (url) => {
      const m = /\/(meet|join)\/([^/?#]+)/.exec(url);
      return m ? m[2] : 'meeting';
    },
    title: () => document.title.replace(/\s*[|–—-].*$/, '').trim() || 'Webex meeting',
    isLive: () => false, // TODO: detect captions panel
    readCaption: () => null, // TODO: parse caption rows → {speaker,text}
    participants: () => [],
  };
  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
