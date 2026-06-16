// ChatPanel — Google Meet capture adapter (STUB).
//
// Interface is in place so the manifest + core treat Meet as a known platform;
// the DOM scraping is not implemented yet. Meet renders captions in a live region
// (roughly `[role="region"][aria-label*="Captions" i]` with per-speaker rows) and,
// like Zoom, only when the user has turned captions ON. To finish: fill in
// isLive()/readCaption() against the live Meet DOM and flip `ready` to true.
(function () {
  'use strict';
  const adapter = {
    platform: 'meet',
    ready: false,
    match: (url) => /:\/\/meet\.google\.com\/[a-z]/.test(url),
    meetingKey: (url) => new URL(url).pathname.replace(/\//g, '') || 'meeting',
    title: () => document.title.replace(/\s*[-—].*$/, '').trim() || 'Google Meet',
    isLive: () => false, // TODO: detect captions container
    readCaption: () => null, // TODO: parse [role="region"] caption rows → {speaker,text}
    participants: () => [],
  };
  (window.__cpMeetingAdapters = window.__cpMeetingAdapters || []).push(adapter);
})();
