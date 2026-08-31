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
//
// A WIDGET additionally gets a way to ask the panel for something (its own saved state, or a
// capability the user granted it). The wrapper only RELAYS — it adds no authority of its own,
// and stamps nothing the panel could mistake for identity: the panel knows which widget this
// frame is because it mounted it, so a widget naming another id gains nothing.
//   sandbox → panel  : { type:'chatpanel:widget-call', id, call }
//   panel  → sandbox : { type:'chatpanel:widget-result', id, callId, ok, value, error }
// The panel resizes its iframe from `height`, so an artifact renders at its natural size.

(function () {
  'use strict';
  var frame = document.getElementById('frame');
  var currentId = null;
  var fill = false; // top-level ("Open ↗") → fill the viewport instead of hugging content

  // Who is driving this page? Embedded in the panel it is the parent frame; opened as a tab
  // it is the opener. Only that window may hand us an artifact.
  var host = (window.parent && window.parent !== window) ? window.parent : window.opener;

  function post(msg) {
    try { if (host) host.postMessage(msg, '*'); } catch (e) { /* host gone */ }
  }

  // Measure the mounted artifact and tell the panel. The artifact is cross-origin (no
  // allow-same-origin), so we can't read its document — instead the artifact reports its own
  // height via a tiny bootstrap we inject, and we relay it. If it never reports, the panel
  // keeps the default height, which still renders.
  function relayHeight(h) {
    if (fill) return; // a full tab already fills the viewport; content height is irrelevant
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

  // The widget client, injected only for widgets. Deliberately tiny and promise-shaped:
  //   chatpanel.getState() / setState(v) / invoke(capability, args)
  // It cannot reach the panel directly — every call goes to this wrapper, which relays.
  var WIDGET_API = [
    '<script>(function(){var n=0,waiting={};',
    'function call(op,extra){var id="w"+(++n);var m={op:op,callId:id};',
    'for(var k in extra)m[k]=extra[k];',
    'return new Promise(function(res,rej){waiting[id]={res:res,rej:rej};',
    'try{parent.postMessage({__cpWidgetCall:m},"*");}catch(e){rej(e);}});}',
    'window.addEventListener("message",function(ev){var d=ev.data;',
    'if(!d||!d.__cpWidgetResult)return;var r=d.__cpWidgetResult,w=waiting[r.callId];',
    'if(!w)return;delete waiting[r.callId];',
    'if(r.ok)w.res(r.value);else w.rej(new Error(r.error||"refused"));});',
    'window.chatpanel={getState:function(){return call("state.get",{});},',
    'setState:function(v){return call("state.set",{state:v});},',
    'invoke:function(c,a){return call("invoke",{capability:c,args:a||{}});}};',
    '})();<\/script>',
  ].join('');

  // A minimal document wrapper so a bare fragment (no <html>) still renders sensibly, and a
  // full document keeps its own <head>. We only append our bootstrap.
  function buildDoc(html, widget) {
    var src = String(html || '');
    var base = /<html[\s>]/i.test(src)
      ? src
      : '<!doctype html><html><head><meta charset="utf-8">'
        + '<style>html,body{margin:0;padding:8px;font:13px/1.45 system-ui,sans-serif;color:#181b20;background:#fff}'
        + 'canvas{max-width:100%}</style></head><body>' + src + '</body></html>';
    return base + BOOTSTRAP + (widget ? WIDGET_API : '');
  }

  window.addEventListener('message', function (ev) {
    // Only the window that embedded/opened this page may drive it.
    if (ev.source !== host) {
      // …except the artifact frame reporting its own height.
      if (ev.source === frame.contentWindow && ev.data && typeof ev.data.__cpHeight === 'number') {
        relayHeight(ev.data.__cpHeight);
      } else if (ev.source === frame.contentWindow && ev.data && ev.data.__cpWidgetCall) {
        // Relay only. The panel decides what is allowed; we deliberately don't inspect or
        // enrich the call, so there is nothing here to get wrong.
        post({ type: 'chatpanel:widget-call', id: currentId, call: ev.data.__cpWidgetCall });
      }
      return;
    }
    var msg = ev.data;
    // A result for something the widget asked for: hand it straight down to the frame.
    if (msg && msg.type === 'chatpanel:widget-result') {
      try { frame.contentWindow.postMessage({ __cpWidgetResult: msg }, '*'); } catch (e) { /* frame gone */ }
      return;
    }
    if (!msg || msg.type !== 'chatpanel:artifact') return;
    if (currentId === msg.id) return;         // the opener nudges twice; mount once
    currentId = msg.id;
    fill = !!msg.fill;
    try {
      if (fill) {
        // Full tab: give the artifact the whole viewport, the way a standalone file gets it —
        // a canvas sized from window.innerHeight needs real room, not a 160px strip.
        document.documentElement.style.height = '100%';
        document.body.style.height = '100%';
        frame.style.height = '100vh';
      } else {
        // A generous provisional height: artifacts commonly size a canvas from
        // window.innerHeight, and a 160px strip would bake in a tiny drawing surface
        // before the content ever reports back.
        frame.style.height = '360px';
      }
      frame.srcdoc = buildDoc(msg.html, msg.widget);      // mount (cross-origin: allow-scripts only)
      post({ type: 'chatpanel:artifact-ready', id: currentId, height: fill ? 0 : 360 });
    } catch (e) {
      post({ type: 'chatpanel:artifact-error', id: currentId, message: String((e && e.message) || e) });
    }
  });

  // Tell the panel the wrapper is alive, so it can send the artifact.
  post({ type: 'chatpanel:sandbox-ready' });
})();
