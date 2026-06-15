# ChatPanel — browser extension

A Chrome / Edge **side-panel chatbot** that lets you talk to **multiple AI agents
from any tab** — the coding agents already running on your computer (**Claude
Code**, **Codex**, **Gemini CLI**) *and* **any model or API you bring yourself**
(local Ollama / LM Studio, or a hosted OpenAI-/Anthropic-compatible endpoint).

It keeps a full **history of chats**, pulls in **context from the current tab,
several tabs at once, or a pasted URL**, and is fully **configurable** — you
define your own *agents* and reusable *skills* in Settings.

> This is the **extension** source. The optional local **Bridge** (needed only
> for Claude Code / Codex / Gemini CLI) lives at
> [`chatpanel/chatpanel-bridge`](https://github.com/chatpanel/chatpanel-bridge)
> and on npm as [`@chatpanel/bridge`](https://www.npmjs.com/package/@chatpanel/bridge).

---

## What you need

There are two ways to use ChatPanel. **Most people only need the first**, which
requires **no developer tools at all**:

| | What it needs | Who it's for |
|---|---|---|
| **Extension + your own model** | Just a Chromium browser (**Chrome 116+, Edge, Brave, or Arc**) and an **API key** (OpenAI / Anthropic / OpenRouter…) **or** a local app like [Ollama](https://ollama.com) / [LM Studio](https://lmstudio.ai). | Everyone — executives, writers, anyone. No coding, no terminal. |
| **+ Local coding agents** (Claude Code, Codex, Gemini CLI) | The optional **Bridge**, which needs **Node.js 18+** and the agent CLI(s) installed & logged in. | Developers who already run these tools. |

### Installing Node.js (only for the optional Bridge)

You **don't** need this for the extension itself. Only if you want to use Claude
Code / Codex / Gemini through the Bridge:

| Platform | Easiest way |
|---|---|
| **Windows** | Download the installer from [nodejs.org](https://nodejs.org) (pick **LTS**), or run `winget install OpenJS.NodeJS.LTS` in PowerShell. |
| **macOS** | Download the installer from [nodejs.org](https://nodejs.org) (**LTS**), or `brew install node` if you use [Homebrew](https://brew.sh). |
| **Linux** | Install from your package manager, [nodejs.org](https://nodejs.org), or [`nvm`](https://github.com/nvm-sh/nvm). |

Verify it worked by opening a terminal / PowerShell and running `node --version`
(it should print `v18` or higher). Then you also need the agent itself —
[Claude Code](https://docs.anthropic.com/en/docs/claude-code), the
[Codex CLI](https://github.com/openai/codex), or the
[Gemini CLI](https://github.com/google-gemini/gemini-cli) — installed and signed in.

---

## Install

### Option A — Chrome Web Store (recommended once live)

The Web Store listing is **pending review**. When it's live this will be the
one-click option; until then, use Option B.

<!-- Once approved, the Web Store link goes here:
     https://chromewebstore.google.com/detail/icemacffhbgnfoofclgdbcdmnlkkklem -->

### Option B — Download & load it yourself (works today)

Chrome and Edge can both run an extension you load manually. It takes ~1 minute.

1. **Download the latest build:**
   **[⬇ chatpanel-extension.zip](https://dl.chatpanel.net/extension.zip)**
   *(always points at the newest release — see [all releases](https://github.com/chatpanel/chatpanel-extension/releases))*
2. **Unzip it** to a folder you'll keep (e.g. `~/chatpanel-extension`). The
   browser loads it from this folder, so don't delete it afterward.
3. **Open the extensions page:**
   - **Chrome / Brave / Arc:** go to `chrome://extensions`
   - **Edge:** go to `edge://extensions`
4. Turn on **Developer mode** (toggle, top-right on Chrome; left sidebar on Edge).
5. Click **Load unpacked** and select the **unzipped folder** (the one that
   contains `manifest.json`).
6. Pin the **ChatPanel** icon and click it to open the side panel.

> **Updating:** loaded-from-folder extensions don't auto-update. To update,
> download the latest zip, unzip it over the same folder (replace files), and
> click the **↻ reload** icon on the ChatPanel card in `chrome://extensions`.

> **Why the "Developer mode" prompt?** Browsers show a note for any extension not
> installed from their store. That's expected for a manual install and goes away
> once you install the Web Store version (Option A).

### Then: pick a model

Open **Settings** (gear icon) and add an agent — point it at a local Ollama
(`http://localhost:11434/v1`) or paste an OpenAI / OpenRouter / Anthropic key.
The extension is fully usable on its own with bring-your-own models.

### Optional: run the Bridge for Claude Code, Codex & Gemini CLI

Requires **Node.js 18+** (see [What you need](#what-you-need) above). No clone or
install of the Bridge itself — one command in a terminal / PowerShell fetches and
runs it:

```bash
npx @chatpanel/bridge   # serves http://127.0.0.1:4319
```

Make sure you're signed in locally (`claude`, `codex login`, or `gemini`). The
extension auto-detects the Bridge and lists your local agents in the picker.

---

## Build from source

The extension is plain MV3 — no bundler, no dependencies. To produce the same
zip the releases ship:

```bash
node tools/package-extension.mjs   # → dist/chatpanel-extension.zip
```

To load it during development, just **Load unpacked** the [`extension/`](extension/)
folder directly (no build step needed).

## What's in here

| Path | What it is |
|------|------------|
| [`extension/`](extension/) | The MV3 Chrome/Edge extension (side-panel UI) |
| [`tools/`](tools/) | Build scripts (`package-extension.mjs`, `make-icons.mjs`) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces fit together |

## License

Source-available under the **Functional Source License (FSL-1.1-MIT)** — see
[`LICENSE`](LICENSE). In short: read it, fork it, run it, and contribute back
freely; you just can't repackage or resell ChatPanel (or a derivative) as a
competing product or service. Two years after each release, that version becomes
MIT. The Bridge is MIT today.
