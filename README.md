# ChatPanel — browser extension

A **side-panel chatbot** for Chrome / Edge / Brave / Arc that lets you chat with
**multiple AI agents from any tab** — the coding agents already on your machine
(**Claude Code**, **Codex**, **Gemini CLI**) *and* **any model or API you bring**
(local Ollama / LM Studio, or a hosted OpenAI-/Anthropic-compatible endpoint).
Full chat history, tab/URL context, custom agents & skills — all local-first.

This repo is the **extension** source. The optional local **Bridge** (for Claude
Code / Codex / Gemini CLI) lives at
[`chatpanel/chatpanel-bridge`](https://github.com/chatpanel/chatpanel-bridge).

## Install

**→ [chatpanel.net/#install](https://chatpanel.net/#install)** — simple, up-to-date
steps for every browser (and the one-line bridge install for local agents).

In short: download **[chatpanel-extension.zip](https://dl.chatpanel.net/extension.zip)**,
unzip it, then in `chrome://extensions` (Edge: `edge://extensions`) turn on
**Developer mode** → **Load unpacked** and pick the unzipped folder. All you need is
a Chromium browser plus an API key (or a local model like Ollama) — no developer
tools required.

## Build from source

Plain MV3 — no bundler, no dependencies:

```bash
node tools/package-extension.mjs   # -> dist/chatpanel-extension.zip
```

For development, **Load unpacked** the [`extension/`](extension/) folder directly.

## What's in here

| Path | What it is |
|------|------------|
| [`extension/`](extension/) | The MV3 extension (side-panel UI) |
| [`tools/`](tools/) | Build scripts |

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
