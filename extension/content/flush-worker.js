// Un-throttled flush heartbeat for backgrounded meeting tabs.
//
// The meeting content script captures captions from the DOM fine while the tab is in
// the background (a MutationObserver fires on real DOM changes regardless of focus),
// but PERSISTING that buffer to storage relies on main-thread timers — and Chrome
// throttles a hidden tab's setTimeout/setInterval to ~once per minute. A Web Worker's
// timers, however, keep running at full rate in a backgrounded tab, so we use one to
// nudge the content script to flush every couple of seconds no matter the tab state.
//
// It holds no state and touches no APIs — it just ticks. The content script decides
// whether there's anything new to flush (flushIfDirty), so an idle tick costs nothing.
setInterval(() => { postMessage('tick'); }, 2500);
