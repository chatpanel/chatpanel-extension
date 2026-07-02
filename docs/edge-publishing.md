# Publishing to Microsoft Edge Add-ons

Edge is Chromium-based and uses the exact same Manifest V3 format as Chrome.
**There is no conversion step and no Microsoft migration tool.** "Porting" here
means re-publishing the *same package* to a second store. Keep one codebase, one
build output — do not fork an `edge/` folder.

## The one-time setup

1. **Register** on [Microsoft Partner Center → Edge program](https://partner.microsoft.com/dashboard/microsoftedge).
   Registration is **free** (Chrome charges a one-time $5).
2. **Build the same zip** you ship to Chrome:
   ```
   npm run package        # → dist/chatpanel-extension.zip
   ```
3. **Upload** that zip, fill out the listing (description, screenshots, privacy
   policy — reuse the Chrome listing), and submit for certification. Review is
   usually a few business days.

Run the preflight before packaging:
```
npm run verify:edge      # node tools/verify-manifest.mjs
```

## What is identical across Chrome and Edge

`sidePanel`, `storage`, `unlimitedStorage`, `tabs`, `activeTab`, `scripting`,
`contextMenus`, `alarms`, `downloads`, `webNavigation`, `debugger`, the
`side_panel` UI, `content_scripts`, the module service worker, and every
`chrome.*` call in this codebase. `minimum_chrome_version` is ignored by Edge
(harmless).

## This extension's Edge identifiers

- **CRX ID (runtime extension ID):** `jkmmbleapaognlonbnllpaoeibmfkjmp`
- **Chrome extension ID (for comparison):** `icemacffhbgnfoofclgdbcdmnlkkklem`

> The **Product ID** and **Store ID** are Partner Center account identifiers — look
> them up in the dashboard rather than committing them to this public repo. Neither
> appears in any redirect URI, so neither is needed here.

⚠️ **Only the CRX ID drives OAuth redirects.** The CRX ID is the 32-char `[a-p]`
string Edge assigns at install time; it's what `chrome.identity.getRedirectURL()`
embeds, so the Edge redirect URI is
`https://jkmmbleapaognlonbnllpaoeibmfkjmp.chromiumapp.org/...`. You can read it from
`edge://extensions` (Developer mode on) or the Partner Center package page. There is
no `key` in the manifest, so this Edge ID differs from the Chrome ID above — which is
exactly why the redirect allow-list below needs both.

## Edge-specific action items

### 1. OAuth redirect URIs change ⚠️ (the real work)

Edge assigns this extension a **different extension ID** than Chrome, so
`chrome.identity.getRedirectURL()` returns a different
`https://<edge-id>.chromiumapp.org/...` URL. Sign-in with each provider only
works if that Edge URL is allow-listed at the provider. Get the Edge extension ID
from `edge://extensions` (Developer mode) after your first install — **not** the
Partner Center Product/Store ID — then:

- **Gemini** — add the Edge redirect URI to the Authorized redirect URIs of your
  Google Cloud OAuth client. Users who bring their own client must do the same.
- **OpenRouter** — uses PKCE with no pre-registered redirect, so it should work
  on Edge with no change. Verify after first install.
- **Hugging Face (hosted sign-in)** — the code is now **allow-list based** (was
  Chrome-only). `js/oauth.js` holds `HUGGINGFACE_PRODUCTION_EXTENSION_IDS`, and
  `oauthRedirectPreflightMessage()` accepts any redirect URI built from an ID in
  that list. Two steps enable Edge — the client one is **done**, the server one is
  **still required**:
  1. **Client — ✅ done.** The Edge CRX ID `jkmmbleapaognlonbnllpaoeibmfkjmp` is in
     `HUGGINGFACE_PRODUCTION_EXTENSION_IDS`, so the preflight no longer blocks
     hosted sign-in on Edge.
  2. **Server — ⚠️ still to do (on chatpanel.net, not in this repo).** Add
     ```
     https://jkmmbleapaognlonbnllpaoeibmfkjmp.chromiumapp.org/oauth/huggingface
     ```
     to the `redirect_uris` in the CIMD document
     (`https://chatpanel.net/.well-known/oauth-cimd`). Hugging Face validates the
     redirect against this document, so hosted sign-in is rejected on Edge with a
     `redirect_uri` mismatch until it's listed — the client change alone is not
     enough.

  Until the server step ships, Edge users can still use Hugging Face by bringing
  their own HF public OAuth app + Client ID (the code already supports this, and the
  in-app message now says so on Edge instead of claiming Chrome-only).
  `npm run verify:edge` now reports the allow-list covers both stores.

### 2. Certification review will probe broad permissions

`debugger` + `<all_urls>` are the two Edge reviewers most often question. Reuse
the justifications already written in `docs/web-store-permissions.md` — paste the
`debugger`, `scripting`, and `<all_urls>` entries into the Edge submission notes.
`debugger` is off by default (the "High-reliability page control" setting), never
used for remote debugging, and sends no data — say so explicitly.

## Bottom line

Same zip, same folder, no tool. The only recurring maintenance is registering the
Edge extension's OAuth redirect URIs with each identity provider once you read the
Edge extension ID from `edge://extensions` — for Gemini (your Google client), and,
if you want hosted Hugging Face sign-in on Edge, both the `oauth.js` allow-list and
the CIMD document. OpenRouter needs nothing.
