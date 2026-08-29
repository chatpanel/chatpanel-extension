# ChatPanel — browser extension

[<img src="https://chatpanel.net/assets/chrome-web-store-badge.png" alt="Available in the Chrome Web Store" height="56">](https://chromewebstore.google.com/detail/icemacffhbgnfoofclgdbcdmnlkkklem)
[<img src="https://chatpanel.net/assets/edge-badge.svg" alt="Get it from Microsoft Edge Add-ons" height="56">](https://microsoftedge.microsoft.com/addons/detail/jkmmbleapaognlonbnllpaoeibmfkjmp)
[<img src="https://chatpanel.net/assets/firefox-badge.svg" alt="Get the add-on for Firefox" height="56">](https://addons.mozilla.org/en-US/firefox/addon/chatpanel-privacy-first-ai/)

A **side-panel chatbot** for Firefox / Chrome / Edge / Brave / Arc that lets you chat with
**multiple AI agents from any tab** — the coding agents already on your machine
(**Claude Code**, **Codex**, **Antigravity CLI** — Google's successor to Gemini CLI,
which remains available for business/enterprise) *and* **any model or API you bring**
(local Ollama / LM Studio, or a hosted OpenAI-/Anthropic-compatible endpoint).
Full chat history, tab/URL context, custom agents & skills — all local-first.

This repo is the **extension** source. The optional local **Bridge** (for Claude
Code / Codex / Antigravity CLI) lives at
[`chatpanel/chatpanel-bridge`](https://github.com/chatpanel/chatpanel-bridge).

## Install

| Browser | Install |
|---|---|
| **Firefox** | [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/chatpanel-privacy-first-ai/) |
| **Chrome**, Brave, Arc | [Chrome Web Store](https://chromewebstore.google.com/detail/icemacffhbgnfoofclgdbcdmnlkkklem) |
| **Edge** | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/jkmmbleapaognlonbnllpaoeibmfkjmp) |

**→ [chatpanel.net/#install](https://chatpanel.net/#install)** — simple, up-to-date
steps for every browser (and the one-line bridge install for local agents).

Prefer to sideload on a Chromium browser? Download
**[chatpanel-extension.zip](https://dl.chatpanel.net/extension.zip)**, unzip it, then in
`chrome://extensions` (Edge: `edge://extensions`) turn on **Developer mode** →
**Load unpacked** and pick the unzipped folder. Firefox only installs add-ons signed by
Mozilla, so there install from the listing above. All you need is a browser plus an API
key (or a local model like Ollama) — no developer tools required.

## Build from source

Plain MV3 — the extension itself ships no bundler and imports raw ES modules:

```bash
npm run package          # both packages, from the same source tree
#   dist/chatpanel-extension.zip   Chrome / Edge / Brave / Arc
#   dist/chatpanel-firefox.xpi     Firefox (+ -sources.zip for AMO review)
```

All three stores build from one `extension/` directory and one tag, so the listings
always carry the same version. The Firefox manifest is **derived** by
`tools/firefox-manifest.mjs` (event page instead of a service worker, `sidebar_action`
instead of `side_panel`) — there is no separate Firefox source tree.

For development, **Load unpacked** the [`extension/`](extension/) folder directly
(Firefox: `about:debugging` → *This Firefox* → *Load Temporary Add-on*).

## What's in here

| Path | What it is |
|------|------------|
| [`extension/`](extension/) | The MV3 extension (side-panel UI) |
| [`tools/`](tools/) | Build scripts, the Chrome→Firefox manifest transform, and the test suite |

## License

**Source-available**, under the [**PolyForm Shield License 1.0.0**](LICENSE).
You may read, audit, run, and modify the code for your own use — you just may not
use it to provide a product or service that **competes** with ChatPanel. The
[local bridge](https://github.com/chatpanel/chatpanel-bridge) is under the same
license. This is *not* an OSI "open source" license; the source is published for
transparency and trust, not for re-packaging or resale.

## Trademarks & brand

The name **“ChatPanel”**, the logo, and the icons/brand assets are **trademarks of
ChatPanel and are not licensed** under the terms above. The Shield license covers
the code only. Don't ship a fork (modified or not) under the ChatPanel name or
marks, or upload it to the Chrome Web Store / any extension marketplace using our
brand — that's trademark infringement and we'll enforce it.
