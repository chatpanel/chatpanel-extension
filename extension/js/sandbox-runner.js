// Runs inside sandbox.html (opaque origin, no chrome.*). The ONLY trusted code in the
// sandbox: it takes artifact HTML from the panel and mounts it in a nested srcdoc iframe.
//
// Two isolation boundaries, on purpose:
//   1. panel → this page: a manifest sandbox page, so nothing here can touch chrome.* or
//      extension storage even if the artifact escapes its own frame.
//   2. this page → the artifact: a nested iframe with sandbox="allow-scripts" and NO
//      allow-same-origin, so the artifact gets its own opaque origin and can't read this
//      wrapper, its parent chain, or any storage.
//
// Protocol (postMessage, both ways):
//   panel  → sandbox : { type:'chatpanel:artifact', id, html }
//   sandbox → panel  : { type:'chatpanel:artifact-ready', id, height }
//                      { type:'chatpanel:artifact-error', id, message }
// The panel resizes its iframe from `height`, so an artifact renders at its natural size.

(function () {
  'use strict';
  var frame = document.getElementById('frame');
  var currentId = null;

  function post(msg) {
    try { parent.postMessage(msg, '*'); } catch (e) { /* parent gone */ }
  }

  // Measure the mounted artifact and tell the panel. The artifact is cross-origin (no
  // allow-same-origin), so we can't read its document — instead the artifact reports its own
  // height via a tiny bootstrap we inject, and we relay it. If it never reports, the panel
  // keeps the default height, which still renders.
  function relayHeight(h) {
    var height = Math.max(60, Math.min(2000, Number(h) || 0));
    frame.style.height = height + 'px';
    post({ type: 'chatpanel:artifact-ready', id: currentId, height: height });
  }

  // Injected into every artifact: reports its content height to this wrapper (and on resize).
  // Kept minimal — it must not fight whatever the artifact itself does.
  var BOOTSTRAP = [
    '<script>(function(){',
    'function h(){try{var d=document,b=d.body,e=d.documentElement;',
    'return Math.max(b?b.scrollHeight:0,b?b.offsetHeight:0,e?e.scrollHeight:0,e?e.offsetHeight:0);}catch(_){return 0;}}',
    'function send(){try{parent.postMessage({__cpHeight:h()},"*");}catch(_){}}',
    'window.addEventListener("load",send);setTimeout(send,50);setTimeout(send,400);',
    'try{new ResizeObserver(send).observe(document.documentElement);}catch(_){setInterval(send,1000);}',
    '})();<\/script>',
  ].join('');

  // A minimal document wrapper so a bare fragment (no <html>) still renders sensibly, and a
  // full document keeps its own <head>. We only append our bootstrap.
  function buildDoc(html) {
    var src = String(html || '');
    var base = /<html[\s>]/i.test(src)
      ? src
      : '<!doctype html><html><head><meta charset="utf-8">'
        + '<style>html,body{margin:0;padding:8px;font:13px/1.45 system-ui,sans-serif;color:#181b20;background:#fff}'
        + 'canvas{max-width:100%}</style></head><body>' + src + '</body></html>';
    return base + BOOTSTRAP;
  }

  window.addEventListener('message', function (ev) {
    // Only the embedding panel may drive this page.
    if (ev.source !== parent) {
      // …except the artifact frame reporting its height.
      if (ev.source === frame.contentWindow && ev.data && typeof ev.data.__cpHeight === 'number') {
        relayHeight(ev.data.__cpHeight);
      }
      return;
    }
    var msg = ev.data;
    if (!msg || msg.type !== 'chatpanel:artifact') return;
    currentId = msg.id;
    try {
      frame.style.height = '160px';           // provisional until the artifact reports
      frame.srcdoc = buildDoc(msg.html);      // mount (cross-origin: allow-scripts only)
      post({ type: 'chatpanel:artifact-ready', id: currentId, height: 160 });
    } catch (e) {
      post({ type: 'chatpanel:artifact-error', id: currentId, message: String((e && e.message) || e) });
    }
  });

  // Tell the panel the wrapper is alive, so it can send the artifact.
  post({ type: 'chatpanel:sandbox-ready' });
})();
