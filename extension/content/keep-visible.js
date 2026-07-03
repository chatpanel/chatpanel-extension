// Keep meeting pages "visible" so live captions keep flowing when the tab is in the
// BACKGROUND. Meet/Zoom/Teams/Webex pause the captions UI (and other work) when they
// believe the tab is hidden — so a backgrounded meeting stops producing caption DOM and
// our capture has nothing to read. This MUST run in the page's MAIN world at
// document_start, BEFORE the app registers its own visibility handlers or reads
// document.hidden — otherwise the app's listeners are already in place and win.
//
// Trade-off: the meeting app always thinks it's foregrounded (won't down-res video when
// hidden). That's the accepted cost of reliable background transcription — the whole
// point of this file. It does NOT defeat browser-level rAF/render throttling; an app
// that renders captions purely via requestAnimationFrame may still lag in the
// background (the panel's "Sync now" + audio-STT path are the fallbacks there).
(function () {
  if (window.__cpKeepVisible) return;
  window.__cpKeepVisible = true;
  try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); } catch (e) { /* locked down */ }
  try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); } catch (e) { /* locked down */ }
  try { Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false }); } catch (e) { /* not present */ }
  try { Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' }); } catch (e) { /* not present */ }
  try { document.hasFocus = () => true; } catch (e) { /* frozen */ }
  // Swallow the events the app uses to react to being hidden/blurred. Capture phase +
  // document_start means we run before the app's own listeners for these events.
  // NB: only visibility + window-blur — NOT pagehide/freeze, so the app can still leave
  // the call cleanly on a real tab close. (window `blur` doesn't bubble, so this won't
  // interfere with element blur/focus handling.)
  const swallow = (e) => { e.stopImmediatePropagation(); };
  for (const ev of ['visibilitychange', 'webkitvisibilitychange']) document.addEventListener(ev, swallow, true);
  window.addEventListener('blur', swallow, true);
})();
