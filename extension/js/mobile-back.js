// The Android Back gesture, wired to the panel's overlays.
//
// On a phone the panel is a full TAB (see js/side-panel.js), and Back is the system-wide
// "go up one level". In a tab with no handler it does the one thing a user never means
// while a drawer is open: leaves ChatPanel entirely, taking the conversation off screen.
// Every native app on the platform closes the sheet instead — so this does too.
//
// Mechanism: push one throwaway history entry per open overlay, and spend one on each
// Back. When nothing is open there is nothing pushed, so Back falls through to the
// browser and leaves the tab — which is the correct top-level behavior for an app.
//
// Deliberately NOT a general "dismiss layer" for the panel: it reads what is on screen
// and clicks the close control that is already there, so an overlay that changes how it
// closes cannot go out of sync with a second copy of that knowledge here.

// Bottom-of-stack first. The LAST open one is the topmost — drawers are siblings that
// cover each other in DOM order, and a nested view (a meeting inside the meetings
// drawer) closes back to its list before the drawer itself does.
const OVERLAYS = [
  { id: 'history', close: 'history-close' },
  { id: 'widgets-drawer', close: 'widgets-close' },
  { id: 'meetings-drawer', close: 'meetings-close', inner: { id: 'meeting-view', close: 'meeting-vclose' } },
  { id: 'live-notes-drawer', close: 'live-notes-close' },
  { id: 'watch-menu', close: null }, // a menu, not a drawer: it has no close button
];

const shown = (id) => {
  const el = document.getElementById(id);
  return el && !el.classList.contains('hidden') ? el : null;
};

// What Back should close right now, or null when the panel is at its top level.
function topmost() {
  for (let i = OVERLAYS.length - 1; i >= 0; i--) {
    const o = OVERLAYS[i];
    if (!shown(o.id)) continue;
    if (o.inner && shown(o.inner.id)) return o.inner;
    return o;
  }
  return null;
}

function dismiss(target) {
  const btn = target.close && document.getElementById(target.close);
  // Click the real control so the overlay runs its own teardown (timers, pane state).
  if (btn) { btn.click(); return true; }
  const el = shown(target.id);
  if (el) { el.classList.add('hidden'); return true; }
  return false;
}

export function armBackButton() {
  if (armBackButton.armed) return false;
  armBackButton.armed = true;

  // One pushed entry per overlay currently open, kept in step with the DOM rather than
  // with our own idea of what should be open — so a drawer closed by ANY path (its own X,
  // a rail toggle, code) is accounted for, and Back never has to be pressed twice to get
  // back the one it already spent.
  let pushed = 0;
  // Entries we are giving back ourselves. The popstate they cause is bookkeeping, not the
  // user pressing Back, and must not close anything.
  let spending = 0;

  const sync = () => {
    const want = OVERLAYS.reduce((n, o) => n + (shown(o.id) ? 1 : 0), 0);
    if (want > pushed) {
      while (pushed < want) history.pushState({ cpOverlay: ++pushed }, '');
    } else if (want < pushed) {
      // Closed by the UI, not by Back: hand the now-meaningless entries back.
      const give = pushed - want;
      pushed = want;
      spending += give;
      history.go(-give);
    }
  };

  // Watch the overlays themselves. `hidden` is a class toggle on a known set of elements,
  // so this costs one observer and no polling.
  const observer = new MutationObserver(sync);
  for (const o of OVERLAYS) {
    const el = document.getElementById(o.id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  window.addEventListener('popstate', () => {
    if (spending > 0) { spending--; return; }
    const target = topmost();
    if (!target) return; // nothing open — let Back mean Back, and leave the panel
    pushed = Math.max(0, pushed - 1); // the entry the browser just popped was this one's
    dismiss(target);                  // the observer sees the close and finds us already square
  });

  sync();
  return true;
}
