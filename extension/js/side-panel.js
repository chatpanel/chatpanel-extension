// One way to open ChatPanel's panel, on every engine AND on mobile.
//
// Three different browsers give the same UI three different homes:
//   • Chromium desktop — `side_panel` manifest key + chrome.sidePanel.{open,
//     setPanelBehavior}. open() takes a windowId, and the toolbar action can be wired
//     to auto-open declaratively.
//   • Firefox desktop  — `sidebar_action` manifest key + browser.sidebarAction.{open,
//     toggle}. open() takes NO arguments (it targets the active window) and there is no
//     "open on action click" behavior; you toggle it from an onClicked listener.
//   • MOBILE (Kiwi, Edge/Android, Firefox for Android, …) — neither API exists. There is
//     no side panel on a phone. Without a fallback the extension installs and the user
//     has NO way to open it: the toolbar entry does nothing at all. That is exactly the
//     "it didn't load" report from Chromium-based Android browsers. So the panel page
//     opens as a normal TAB, which every one of them supports.
//
// A tab fallback is only half of it, though: something has to RUN it. Chromium on
// Android surfaces the extension as a ⋮-menu row that opens the action's popup, and
// nothing else — a popup-less action's row is inert there, and the click never reaches
// the onClicked listener below (on some forks the service worker is not even woken for
// it). So the manifest declares action.default_popup = panel-launcher.html, which the
// browser opens with no background script involved, and releaseActionPopup() takes that
// popup back off on every engine that has a real panel to open instead.
//
// Callers should never branch on that. They call openSidePanel() and get the panel.
//
// USER-GESTURE RULE (the reason this module looks the way it does): the panel APIs
// require these calls to happen inside a user-input handler, and Firefox's check is
// strict — it is only satisfied during the SYNCHRONOUS run of the handler, so a single
// `await` before the call loses the gesture and open() rejects. So:
//   • openSidePanel() performs the engine call FIRST and does any lookup after,
//   • callers must START it inside the handler (not await something else first) —
//     `const opening = openSidePanel(...); await …; await opening;`
//   • and this module is STATICALLY imported by its callers, deliberately: a dynamic
//     import() at the call site is itself an await and would break the gesture on
//     Firefox. It is ~2 KB, so first-paint cost is nil.
import { api, hasSidePanelApi, hasSidebarAction } from './browser-api.js';

export { hasSidePanelApi, hasSidebarAction };

// The panel page, and the marker that tells it to lay itself out for a full tab rather
// than a narrow docked panel. Kept here so the opener and the page agree on one string.
export const PANEL_PAGE = 'sidepanel.html';
export const TAB_SURFACE_QUERY = 'surface=tab';

// Where this browser can actually put the panel. 'tab' is not a degraded mode so much as
// the only surface a phone has.
export const panelSurface = hasSidePanelApi ? 'sidePanel' : hasSidebarAction ? 'sidebar' : 'tab';

// True when this build can open its panel programmatically. Now always true: the tab
// fallback works anywhere `tabs` does. Kept for callers that used to feature-test.
export const canOpenSidePanel = true;

function panelUrl() {
  return api.runtime.getURL(`${PANEL_PAGE}?${TAB_SURFACE_QUERY}`);
}

// Mobile / no-panel-API fallback: focus the panel tab if one is already open, otherwise
// make one. Reusing it matters on a phone, where stacking a new tab per tap buries the
// conversation the user was already in.
async function openPanelTab() {
  const url = panelUrl();
  try {
    // tabs.query takes a MATCH PATTERN, not a URL: its path component is matched against
    // everything after the host, query string included. An exact `…?surface=tab` would
    // therefore miss a panel tab carrying any other param (or a hash), so match the page
    // and let anything follow.
    const open = await api.tabs.query({ url: `${api.runtime.getURL(PANEL_PAGE)}*` });
    if (open?.length) {
      const tab = open[0];
      await api.tabs.update(tab.id, { active: true });
      // Bring its window forward too, where windows exist (not on Android).
      if (tab.windowId != null && api.windows?.update) {
        await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      return tab;
    }
  } catch { /* query refused (no tabs permission for extension URLs) — just open one */ }
  return api.tabs.create({ url });
}

// Open the panel. `windowId` is honoured on Chromium desktop, ignored on Firefox (whose
// sidebar always opens in the active window) and on the tab fallback. Rejects only if
// even a tab can't be opened — callers already treat that as "tell the user to open it
// from the toolbar".
export async function openSidePanel({ windowId } = {}) {
  // Firefox first and un-awaited: this must run in the same synchronous turn as the
  // click, and sidebarAction.open() needs no lookup to do it.
  if (hasSidebarAction) return api.sidebarAction.open();
  if (hasSidePanelApi) {
    const id = windowId ?? (await api.windows.getCurrent()).id;
    return api.sidePanel.open({ windowId: id });
  }
  return openPanelTab();
}

// Toolbar-button behavior. Chromium desktop can be told once, declaratively, to open the
// panel whenever the action is clicked. Nothing else can, so everywhere else the click is
// handled by the listener wireActionToPanel() registers. Safe to call on every engine.
export async function setPanelOpensOnActionClick() {
  if (!hasSidePanelApi || !api.sidePanel.setPanelBehavior) return false;
  await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  return true;
}

// The manifest's action.default_popup is there for ONE case: a browser whose only way to
// invoke an extension is to open its popup (Chromium on Android). Everywhere else the
// popup would be a pointless extra window in front of the panel — and worse, a declared
// popup SUPPRESSES both the openPanelOnActionClick behavior and the onClicked event, so
// leaving it in place would replace one dead toolbar button with another.
//
// So: hand the popup back wherever a real panel surface exists. Empty string, not null —
// null means "reset to the manifest default" on Firefox, which is the opposite of this.
// Called from wireActionToPanel(), i.e. on every service-worker wake, because Chromium
// drops runtime action state on browser restart and reverts to the manifest.
export function releaseActionPopup() {
  if (panelSurface === 'tab') return false; // mobile: the popup IS the entry point
  if (!api.action?.setPopup) return false;
  try { api.action.setPopup({ popup: '' })?.catch?.(() => {}); } catch { /* older engine */ }
  return true;
}

// The counterpart to setPanelOpensOnActionClick() for every browser that has no such
// switch: Firefox (toggle the sidebar) and mobile (open the panel tab).
//
// MUST be called at the top level of the background script — an event page, like an MV3
// service worker, only wakes for listeners registered synchronously on load. On Chromium
// desktop it only releases the popup: the declarative behavior covers the rest and
// onClicked never fires there.
export function wireActionToPanel() {
  // First, unconditionally — a popup left in place on a desktop engine would swallow the
  // click before either branch below could ever see it.
  releaseActionPopup();
  if (hasSidePanelApi && api.sidePanel.setPanelBehavior) return false;
  if (!api.action?.onClicked) return false;
  api.action.onClicked.addListener(() => {
    // Inside the click handler, so the gesture is intact.
    try {
      if (hasSidebarAction) {
        // toggle() is Firefox 73+; open() is the floor-version fallback.
        if (api.sidebarAction.toggle) api.sidebarAction.toggle();
        else api.sidebarAction.open();
        return;
      }
      openPanelTab().catch(() => { /* no tabs API — nothing more we can do */ });
    } catch { /* user closed the window mid-click */ }
  });
  return true;
}
