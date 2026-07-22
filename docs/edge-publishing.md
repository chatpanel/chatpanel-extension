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

## Automated publishing (CI/CD)

After the one-time Partner Center setup, every release goes to **both** stores
from the same build — no fork, no separate zip. This is wired into
`.github/workflows/extension-release.yml`:

- A tag push `ext-v*` builds the zip and creates the GitHub Release only.
- A manual **workflow_dispatch** publishes to the store(s) you tick:
  `publish_chrome` and/or `publish_edge`. Each is gated on its own secrets, so
  you can turn Edge on independently of Chrome.

Enable Edge in CI once:

1. In Partner Center → **Microsoft Edge → Publish API**, click **Enable** (the
   v1.1 API-key experience), then **Create API credentials**. Copy the
   **Client ID** and **API key**.
2. Get the **Product ID** from **Microsoft Edge → Overview →** the extension
   (it's the GUID in the dashboard URL).
3. Add three GitHub repo secrets:
   - `EDGE_PRODUCT_ID` — the product GUID
   - `EDGE_CLIENT_ID` — Publish API Client ID
   - `EDGE_API_KEY` — Publish API key (note its expiry; rotate before it lapses)

CI then runs `npm run publish:edge` (`tools/publish-edge.mjs`), which uploads
the zip via the **Edge Add-ons Update REST API v1.1**, waits for validation, and
submits for certification. You can also run it locally with those three env vars
set. Set `EDGE_SKIP_PUBLISH=1` to upload the draft without submitting for review.

> The Edge Update REST API only **updates** an already-published add-on — the
> very first submission must be done by hand in Partner Center. After that, CI
> handles every update.

`npm run verify:edge` runs in CI on every push and again before each release, so
the single package can never drift into something that breaks Edge
certification (e.g. a stray `update_url` or `oauth2` key).

## What is identical across Chrome and Edge

`sidePanel`, `storage`, `unlimitedStorage`, `tabs`, `activeTab`, `scripting`,
`contextMenus`, `alarms`, `downloads`, `webNavigation`, `debugger`, the
`side_panel` UI, `content_scripts`, the module service worker, and every
`chrome.*` call in this codebase. `minimum_chrome_version` is ignored by Edge
(harmless).

## This extension's Edge identifiers

- **CRX ID (runtime extension ID):** `jkmmbleapaognlonbnllpaoeibmfkjmp`
- **Chrome extension ID (for comparison):** `icemacffhbgnfoofclgdbcdmnlkkklem`
- **Store ID (public store link):** `0RDCKFF4BTNH` — appears in the customer-facing
  store URL once the extension is published.
- **Public key** (the key Edge hashed to derive the CRX ID above; there is no `key`
  in the manifest, so this is informational only):
  ```
  MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAio7QmFubE20TxUT7b/nv
  6ixuQBZmDB6lNlL9GIcZKlFaZy73d+Bl7SRT8Qm7YM1VLEi291KOkxQiXnJP5LCL
  S2Xm9JFBvpFp8cGY2SEgyn9DEBo032/8IKBRd2NrDnL2q+NmlvigQi5XhitERlSg
  ahYbPjrWQM7OT7nTHZa1hXPHuNDNhYXUfR9NrdeMI2b3Nb54r/gljqH1uDWKcppG
  EiaP+yitqRcnwvWt1KNJ3TIkFosre7suYiUfG4JEkKcchdmZPuhMLNfT/zjo8huA
  iUTYa6HRByvBtiW22mYNPewfa4ib3hoKmB1s/SfDdEyDNril09aVZvpnHK5yw/F5
  qwIDAQAB
  ```

> The **Product ID** (`30ba8cb0-…`) is the Partner Center account identifier the
> publish API targets. It's kept out of this public tree: locally it lives in the
> gitignored `.env` (`EDGE_PRODUCT_ID`, template in `.env.example`), and in CI it's
> the `EDGE_PRODUCT_ID` GitHub Actions secret. It doesn't appear in any redirect URI.

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
