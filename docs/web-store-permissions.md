# Chrome Web Store — permission justifications

Paste these into the Web Store dashboard (Privacy practices → Permission
justifications) at submission time. Keep them in sync with `manifest.json`.

## Single purpose

ChatPanel is a browser side-panel AI assistant. It lets you chat with your chosen
AI agents and models using the context of the tabs you're looking at, and —
when you explicitly turn it on — fill in forms and click elements on the current
page on your behalf. Everything runs locally; chat content goes only to the model
endpoint you configure.

## Permission justifications

- **`debugger`** — Powers the optional **“High-reliability page control”** setting.
  When enabled, ChatPanel uses the Chrome DevTools Protocol Input domain to perform
  form-filling and clicking as genuine (trusted) browser input, so page actions work
  reliably on complex web apps where synthetic DOM events fail. It attaches **only to
  the tab the user is actively acting on, only while a user-initiated task runs**, and
  auto-detaches shortly after. It is **off by default**, never used for remote
  debugging, and sends no data anywhere. Chrome's standard "debugging this browser"
  banner is shown the entire time it is attached.
- **`scripting`** — Inject, on demand, the code that extracts readable page content
  for context and (when the user enables “Act on page”) fills fields / clicks elements
  in the active tab. Never runs in the background.
- **host access (`<all_urls>`)** — The user can ask about, or act on, whatever site
  they happen to be on, so content access can't be restricted to a fixed list. Used
  only in response to an explicit user action.
- **`tabs` / `activeTab`** — Identify and target the active tab the user is working in
  (title/URL) to attach context and direct page actions.
- **`webNavigation`** — Detect frames within a page so content extraction can reach
  content in sub-frames.
- **`sidePanel`** — The extension's entire UI is a side panel.
- **`contextMenus`** — The right-click “Ask ChatPanel about this page” entry point.
- **`alarms`** — A periodic local check that re-validates Pro/Team entitlement.
- **`storage` / `unlimitedStorage`** — Save chats, settings, and meeting transcripts
  locally in the browser (transcripts can be large, hence unlimited).

## Data usage

ChatPanel does not send your conversations or page content to ChatPanel servers.
Chat content goes only to the AI endpoint you configure (local bridge or your own
API). The only server call is a license check that confirms an active subscription
and carries no chat content. The `debugger`-based page control runs entirely on the
user's machine. No remotely-hosted code is executed.
