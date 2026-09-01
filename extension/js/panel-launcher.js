// The toolbar popup — the ONE entry point every browser agrees on.
//
// WHY THIS EXISTS. Chromium on Android (Kiwi, Edge, and the other forks that load Web
// Store extensions) surfaces an extension as a row in the ⋮ menu, and tapping that row
// opens the action's `default_popup`. That is the whole integration: those browsers do
// not dispatch action.onClicked for a popup-less action, and some do not even wake the
// service worker for it. So an extension with no popup has a menu entry that does
// NOTHING when tapped — which is exactly what ChatPanel did on Edge and Kiwi while it
// worked on Quetta, whose extension UI does dispatch the click.
//
// A popup needs no service worker and no event listener: the browser opens the page
// straight from the manifest. That makes it the only entry point that cannot be broken
// by a background script that never started.
//
// Everywhere a real panel surface exists (Chromium desktop's side panel, Firefox
// desktop's sidebar) this page is NOT the entry point — js/side-panel.js clears the
// popup at runtime so the click opens the panel directly, and this file is dead code.
// It still handles that case, because clearing the popup happens from the service
// worker and there is a small window after a browser restart where it has not run yet.
import { openSidePanel } from './side-panel.js';

const status = document.getElementById('status');
const button = document.getElementById('open');

// Route through the shared opener, which knows what this engine actually has: the side
// panel, the sidebar, or a reused tab. Nothing here branches on the browser.
async function open() {
  await openSidePanel();
  // The panel now lives somewhere else — the dock, the sidebar, or a tab. This popup
  // has done its job; leaving it up would cover the thing the user just asked for.
  window.close();
}

// Opening the popup IS the user's tap, but some engines do not carry that activation
// into the page's first script, and sidePanel.open() rejects without it. So try
// immediately (one tap, the common path) and fall back to a button whose click is
// unambiguously a gesture (two taps, but it works) rather than failing silently — the
// silent failure is the bug this whole file exists to fix.
open().catch((e) => {
  console.debug('[chatpanel] launcher', e?.message || e);
  document.body.classList.add('needs-tap');
  status.textContent = '';
});

button.addEventListener('click', () => {
  open().catch((e) => { status.textContent = `Could not open ChatPanel: ${e?.message || e}`; });
});
