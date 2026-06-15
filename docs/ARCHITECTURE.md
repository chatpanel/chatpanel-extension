# Architecture

ChatPanel is two cooperating pieces: a **Chrome MV3 extension** (the product) and
an **optional local Bridge** (only needed for Claude Code, Codex & Gemini CLI).

## Why a Bridge at all?

A Chrome extension runs in the browser sandbox — it cannot spawn processes, so it
can't talk to `claude` or `codex` directly. "Bring your own model" endpoints
(Ollama, LM Studio, OpenAI, OpenRouter, Anthropic API) *are* reachable over HTTP,
so those are called **straight from the side panel**. The two local coding agents
go through the Bridge.

```
                       ┌─────────────────────────── Chrome ───────────────────────────┐
                       │                                                               │
   toolbar click ──▶  background.js ──opens──▶  Side Panel (sidepanel.html/js)         │
                       │   service worker                  │                            │
                       │                                   │ imports                    │
                       │        ┌──────────────────────────┼───────────────────────┐   │
                       │        │ store.js   providers.js   context.js   license.js │   │
                       │        │ (history)  (3 backends)   (tabs/url)   (Pro gate)  │   │
                       │        └──────────────────────────┼───────────────────────┘   │
                       └────────────────────────────────────┼──────────────────────────┘
                                                            │
                  direct HTTPS (OpenAI/Anthropic compatible)│        localhost SSE
                    ┌───────────────────────────────────────┴──────┐  ┌──────────────┐
                    ▼                                               ▼  ▼              │
            Ollama · LM Studio · OpenAI · OpenRouter · Anthropic   ChatPanel Bridge   │
                                                                   (bridge/src)       │
                                                                    ├─ engines/claude │ Agent SDK
                                                                    └─ engines/codex  │ codex exec
```

## Extension modules

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 config: `sidePanel`, `storage`, `tabs`, `scripting`, host perms |
| `background.js` | Opens the panel on icon click; right-click "Ask ChatPanel" menu |
| `sidepanel.{html,css,js}` | The chat UI: messages, streaming, history drawer, composer |
| `settings.{html,css,js}` | Configure agents, skills, bridge URL, prefs, license |
| `js/store.js` | Settings + per-conversation persistence in `chrome.storage.local` |
| `js/providers.js` | One `streamChat()` over three backends (bridge / openai / anthropic) |
| `js/context.js` | Capture tab(s), selection, or a pasted URL → attachable text |
| `js/markdown.js` | Dependency-free, XSS-safe Markdown → HTML |
| `js/license.js` | Free/Pro feature gate; pluggable license verification |

## Data model (storage)

```
chatpanel:settings        → { bridgeUrl, agents[], skills[], ui, activeAgentId }
chatpanel:convIndex       → [{ id, title, agentId, updatedAt, msgs }]   (lightweight)
chatpanel:conv:<id>       → { id, title, agentId, messages[], createdAt, updatedAt }
chatpanel:license         → { plan, status }
```

Splitting the index from per-conversation blobs keeps a long history cheap to
list without loading every message.

## Plans

ChatPanel is free to use, with optional **Pro** features you can unlock from
**Settings → License**. Pro activates right in the app and follows your purchase
email across your devices. See
[chatpanel.net](https://chatpanel.net) for what each plan includes.

## Message flow (one turn)

1. User types / attaches context → `send()` builds a `user` message with
   `attachments[]` (extracted tab/url text).
2. URLs in the text are auto-fetched and attached (`context.captureUrl`).
3. An empty `assistant` message is appended and persisted.
4. `providers.streamChat()` routes by `agent.kind`:
   - `bridge` → `POST {bridgeUrl}/chat` (SSE) → Claude Code / Codex / Gemini CLI
   - `openai` → `POST {baseUrl}/chat/completions` (SSE)
   - `anthropic` → `POST {baseUrl}/v1/messages` (SSE)
5. `onDelta` appends tokens (rendered through `markdown.js`, `requestAnimationFrame`
   throttled); `onEvent` drives the activity strip (tool use / status).
6. On completion the conversation is saved and the history index updated.

## Bridge engines

Both implement `available()` and `chat({messages, system, options}, emit)` and
push the same event shapes (`delta`/`tool`/`status`/`done`/`error`) so the
extension treats them identically.

- **claude** — `@anthropic-ai/claude-agent-sdk` `query()` with
  `includePartialMessages` for token streaming; read-only tools allowed by
  default, writes gated behind permission mode.
- **codex** — `codex exec --json`; progress events forwarded as status, the
  authoritative final message read from `--output-last-message`.

## Security posture

- Bridge binds `127.0.0.1` only; CORS allows the extension origin + localhost.
- Coding agents are read-only unless you opt into `acceptEdits` /
  `bypassPermissions` per agent.
- All chat history and keys live in the user's local browser storage; nothing is
  sent anywhere except the endpoint the active agent is configured for.
