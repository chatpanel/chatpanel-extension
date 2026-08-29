# Publishing to Firefox (addons.mozilla.org)

Firefox is **not** a fork. The add-on is built from the same `extension/` source
tree as the Chrome/Edge zip, from the same tag, with the same version number.
There is no `firefox/` folder and there must never be one — the only differences
are a **derived manifest** (`tools/firefox-manifest.mjs`) and two Chromium-only
files that get left out of the package.

```
npm run verify:firefox    # preflight — fails on anything Gecko/AMO would reject
npm run package:firefox   # → dist/chatpanel-firefox.{zip,xpi} + -sources.zip
npm run package           # builds BOTH stores' packages (Chromium zip + Firefox)
```

## What actually differs, and why

| Chrome / Edge | Firefox | Reason |
|---|---|---|
| `background.service_worker` | `background.scripts` + `type: "module"` | Firefox has no background service workers. Its MV3 equivalent is a non-persistent **event page** with the same wake-on-listener lifecycle the code already assumes (state in `storage.session`, every listener registered at top level). |
| `side_panel` + `chrome.sidePanel` | `sidebar_action` + `sidebarAction` | Different API, same surface. Only `extension/js/side-panel.js` knows which one it got. |
| `options_page` | `options_ui` (`open_in_tab: true`) | Firefox accepts `options_page` only as an alias that implicitly opens in a new tab; `options_ui` states it explicitly. |
| `commands._execute_action` | `commands._execute_sidebar_action` | On Chromium the shortcut activates the toolbar action, which opens the panel via `setPanelBehavior`. Firefox has a reserved command that opens the sidebar directly. |
| `minimum_chrome_version` | `browser_specific_settings.gecko.strict_min_version` | — |
| permissions `sidePanel`, `offscreen`, `debugger` | dropped | None exist in Firefox. Each is feature-detected at runtime, so dropping the permission degrades the feature rather than breaking it. |
| ships `offscreen.html`, `js/offscreen-webllm.js` | dropped | They exist only to serve `chrome.offscreen`. |
| ships `js/vendor/web-llm.js` (6.3 MB) | dropped | Its runtime can never initialise on Firefox (below), and AMO **rejects** the submission for it: *"This file is not binary and is too large to parse"* — the linter skips non-binary files over 5 MB. Excluding it also takes the package from 3.3 MB to 1.2 MB. `tools/build-firefox.mjs` fails the build if any packaged file crosses that ceiling, so this cannot recur. |
| — | `browser_specific_settings.gecko_android` | Opts into Firefox for Android; without the key an add-on is desktop-only. See **Mobile** below. |

Everything else — content scripts, matches, host permissions, CSP, icons,
version, description — is carried over **verbatim**, and
`tools/test-firefox-manifest.mjs` fails the build if a newly-added manifest key
is neither carried nor consciously dropped.

## The two real feature gaps

Be honest about these in the listing; they cannot be closed from our side.

1. **Trusted-events page control (CDP).** Firefox has no extension debugger
   protocol ([bug 1316741](https://bugzil.la/1316741)), so "High-reliability page
   control" cannot exist there. Acting on a page falls back to the synthetic-event
   path, which works on ordinary forms and links but not on canvas apps,
   coordinate-driven controls, or widgets that reject untrusted events. The
   settings toggle (and the developer-JS switch it gates) is **hidden** on Firefox
   rather than shown-but-dead.
2. **The in-browser (WebLLM) model does not run on Firefox at all.** This is the
   bigger one, and it is not about GPU horsepower. WebLLM's runtime (tvmjs) requires
   `maxStorageBuffersPerShaderStage >= 10` and refuses to start below it; the WebGPU
   **spec default is 8**, and Firefox does not raise it. So a perfectly capable GPU
   still gets:

   > Cannot initialize runtime because of requested maxStorageBuffersPerShaderStage
   > exceeds limit. requested=10, limit=8.

   `js/webgpu-support.js` probes the adapter's real limits *before* any download and
   turns this into a message that names the cause and points at a working alternative.
   It also distinguishes two different 8s: a genuine cap, versus **every** limit
   clamped to its spec default, which is what `privacy.resistFingerprinting` does
   (Firefox's default fingerprinting-protection set does *not* include WebGPU limits,
   so that means full RFP, Tor Browser, or a hardening `user.js`). In the clamped case
   the model can be made to work by relaxing that setting; in the plain case it cannot.
   Checking the limits rather than `navigator.gpu` is what stops a fresh install
   spending a ~700 MB download to reach the error.

   Consequence for onboarding: **the zero-setup default target is dead on Firefox.**
   The empty state and the endpoint picker say so, and adding any API endpoint claims
   the Free slot automatically (`settings.js`, `freeEndpointId`), so the path out is
   one step — but it *is* a step Chromium users don't take. Revisit if Firefox ever
   raises the limit; the probe will start passing on its own, no code change.

   The related "keep the in-browser model warm" opt-in uses an offscreen document and
   is moot on Firefox for the same reason. Because the model can never run, the 6.3 MB
   `js/vendor/web-llm.js` bundle is left out of the Firefox package entirely — which is
   also what clears AMO's 5 MB parse error. `js/webllm.js` loads it through a guarded
   dynamic `import()` and reports `WEBLLM_NOT_BUNDLED` if it is ever reached in a build
   that doesn't carry it.

## Mobile

**No mobile browser has a side panel** — not Firefox for Android (no `sidebar_action`)
and not the Chromium-based Android browsers (no `chrome.sidePanel`). Before the tab
fallback the extension installed on those and the toolbar entry did *nothing*: there was
no surface for the UI. `js/side-panel.js` now resolves to one of three surfaces
(`panelSurface`): Chromium's side panel, Firefox's sidebar, or — where neither exists —
the panel page opened as a **tab**, reusing an already-open one rather than stacking a
tab per tap. The page marks itself `html.surface-tab` before first paint and caps its
width so a conversation doesn't stretch across a tablet.

That fallback ships in the Chromium package too, which is what fixes ChatPanel in Kiwi
and other Android Chromium browsers.

Degraded on Android, all feature-detected rather than fatal:

| Missing | Effect |
|---|---|
| `commands` | No keyboard shortcut (no keyboard). |
| `menus` / `contextMenus` | No "Ask ChatPanel about this page" item. **Guarded in `background.js`** — an unguarded top-level `chrome.contextMenus.onClicked` throws while the background script is still evaluating and takes the alarms, licence re-check and meeting heartbeat down with it, silently. |
| `identity` | No hosted OAuth sign-in; paste an API key instead. |
| `windows` | No window focus/lookup; the tab fallback needs none. |

Everything the product is for — chat, notes, page context, storage, downloads, alarms,
content scripts including `world: "MAIN"` — is supported on Android.

> **Not yet verified on a physical device.** The API support above is from
> browser-compat-data and the code paths are covered by `test-firefox-parity.mjs`, but
> install the `.xpi` on a real Android Firefox before submitting with `gecko_android`
> set. If it disappoints, removing that one key returns the listing to desktop-only.

## Floor versions: Firefox 140 desktop / 142 Android

Two constraints, and the higher one wins:

- **`data_collection_permissions` → Firefox 140, Android 142.** This is the binding
  one. AMO *requires* the key on new submissions, and its linter warns on every
  upload if the floor predates support for it ("released before version 140
  introduced support for…"). Android got the key two releases later than desktop,
  so `gecko_android` carries its own, higher floor.
- **`content_scripts` `world: "MAIN"` → Firefox 128.** What keeps live captions
  flowing in a **backgrounded** meeting tab; below it meeting capture silently
  degrades.

140 is an ESR (128 ESR is end-of-life), so managed/enterprise installs still reach
it. `npm run verify:firefox` fails the build if either floor slips below what the
keys in the manifest actually need.

## One-time setup

1. **Create the AMO account** and an API key at
   [addons.mozilla.org → Tools → Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/).
   Copy the **JWT issuer** and **JWT secret**.
2. **Create the listing once, by hand**, at
   [Submit a New Add-on](https://addons.mozilla.org/developers/addon/submit/distribution)
   — upload `dist/chatpanel-firefox.zip`, choose **On this site (listed)**, and
   attach `dist/chatpanel-firefox-sources.zip` when asked for source. The API
   cannot create the *first* version of an add-on; after that, CI owns every
   release.
3. **Add the GitHub secrets:** `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`, and optionally
   `AMO_ADDON_ID` (defaults to the `gecko.id`, `chatpanel@chatpanel.net`).

### Source code is mandatory

AMO requires the original source whenever a submission contains minified,
concatenated or machine-generated code. Two files qualify:
`js/vendor/codemirror.js` (built by `tools/build-editor.mjs`) and
`js/vendor/web-llm.js` (the published `@mlc-ai/web-llm` dist bundle).
`tools/build-firefox.mjs` emits `dist/chatpanel-firefox-sources.zip` with a
`BUILD-INSTRUCTIONS.txt` a reviewer can follow, and `tools/publish-amo.mjs`
uploads it **with the version** rather than as a follow-up someone forgets.

## Releasing

Identical to the other two stores, and deliberately decoupled:

- Push a tag `ext-v*` → builds the Chromium zip **and** the Firefox `.xpi` +
  sources, attaches all of them to the GitHub Release. **Nothing is published.**
- Run **Release extension** manually (`workflow_dispatch`) and tick the stores you
  want: `publish_chrome`, `publish_edge`, `publish_firefox`. Each is gated on both
  its input and its own secrets, so a store can be enabled independently.

`dl.chatpanel.net/firefox.xpi` proxies the release's `.xpi` and serves it as
`application/x-xpinstall` with **no** attachment disposition, so Firefox shows its
install prompt instead of dropping a file in Downloads. Note that Firefox release
builds refuse **unsigned** add-ons: that URL only works once AMO has signed a
version. Before that, test with `about:debugging` → *This Firefox* → *Load
Temporary Add-on* → pick `dist/firefox/manifest.json`.

## After the first signed build: three things to register

`identity.getRedirectURL()` returns a **different** URL on Firefox
(`https://<hash>.extensions.allizom.org/…`, derived from `gecko.id`) than on
Chromium (`…chromiumapp.org`). Nothing pins the Chrome ID in our code, but every
provider allow-list is per-URI, so hosted sign-in stays off on Firefox until each
is updated. Read the exact URI from **Settings → the endpoint's Redirect URI**
field while running on Firefox, then:

1. **Hugging Face** — add it to `HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS` in
   `extension/js/oauth.js` **and** to `redirect_uris` in
   `https://chatpanel.net/.well-known/oauth-cimd`. Until then, Firefox users sign
   in with their own HF Client ID (the preflight warns while the list is empty).
2. **Google Drive backup** — add it to the license Worker's
   `GOOGLE_OAUTH_REDIRECT_URIS` (comma-separated). Until then the broker fails
   closed with *"Invalid OAuth authorization request."*, which is correct
   behavior for an unrecognized redirect and the first thing to check.
3. **The landing page** — uncomment the Firefox store badge in `site/index.html`
   (search `FIREFOX:`) and add Firefox to the "Works in…" line.

## Review notes to paste into the AMO submission

> ChatPanel is a local-first AI side panel. It does not collect or transmit any
> data to ChatPanel or to any third party of our choosing — hence
> `data_collection_permissions: { required: ["none"] }`. The default target is an
> in-browser model (WebLLM) that never leaves the device. If the user configures
> an API endpoint, traffic goes from their browser directly to the service **they**
> chose, with client-side redaction applied first; there is no ChatPanel server in
> the path.
>
> `<all_urls>` is required because the user can ask the panel about, or act on,
> whatever page they are currently viewing — the page is only read on an explicit
> user action, never in the background.
>
> The meeting content scripts are limited to the four listed conferencing hosts
> and read the caption DOM those apps already render, storing transcripts locally
> (encrypted at rest).
>
> Build instructions for the two generated bundles are in the attached source
> archive (`BUILD-INSTRUCTIONS.txt`).
>
> **To test it:** ChatPanel's default target is an in-browser model that cannot start
> on Firefox (its WebGPU runtime requires `maxStorageBuffersPerShaderStage` = 10;
> Firefox reports the spec default of 8, and the panel tells the user so). To try the
> extension, open Settings and add any OpenAI-compatible endpoint — a free provider
> key, or a local Ollama at `http://127.0.0.1:11434/v1` — and the panel works fully.

See also `docs/web-store-permissions.md` for the per-permission justifications
shared with the Chrome and Edge listings.
