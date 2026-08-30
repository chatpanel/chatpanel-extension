// Provider OAuth 2.0 Authorization Code + PKCE support for model endpoints.
//
// This is for providers that explicitly support public/browser-extension OAuth
// clients and return access tokens accepted by their model API. It is not a
// ChatGPT/Claude.ai web-session bridge.

import { sealJSON, openJSON } from './secret-crypto.js';

const K_OAUTH = 'chatpanel:oauthTokens';
const EXPIRY_SKEW_MS = 60_000;
const OAUTH_MODES = new Set(['openrouter', 'huggingface', 'gemini']);
const HUGGINGFACE_CIMD_CLIENT_ID = 'https://chatpanel.net/.well-known/oauth-cimd';

// SIGN IN WITH YOUR OWN ACCOUNT, WITHOUT REGISTERING AN APP.
//
// Hugging Face refuses any redirect_uri not registered on the OAuth app, and an extension's
// redirect URI is not ours to choose: every store assigns a different extension id, and an
// unpacked build's id changes with the folder it was loaded from. Asking each user to create
// their own HF OAuth app put a developer task between them and their first message — and it
// broke again the next time the id moved, reported by the browser as the useless
// "Authorization page could not be loaded."
//
// The broker holds the confidential client and registers ONE callback with HF, exactly as the
// Google Drive broker already does. What the user sees is an ordinary Hugging Face sign-in
// page; what they connect is their own account. A pasted Client ID still wins over this, for
// anyone who wants their own app.
const HUGGINGFACE_BROKER = 'https://api.chatpanel.net/oauth/huggingface';
const BROKER_TRANSPORT = 'broker-v1';

// Extension IDs whose chromiumapp.org redirect URI is registered with the hosted
// Hugging Face CIMD client (the redirect_uris in
// https://chatpanel.net/.well-known/oauth-cimd). Every store assigns its own extension
// ID, so hosted HF sign-in works only from a build whose redirect URI appears in BOTH
// this list AND that CIMD document. To enable a new Chromium store (e.g. Microsoft Edge):
//   1. Install the published build, open the browser's extensions page with Developer
//      mode on, and copy the 32-char extension ID. This is NOT the Partner Center
//      Product ID or Store ID — it is the id shown next to the extension at runtime.
//   2. Add that id below, and add its redirect URI to the CIMD document's redirect_uris.
const HUGGINGFACE_PRODUCTION_EXTENSION_IDS = [
  'icemacffhbgnfoofclgdbcdmnlkkklem', // Chrome Web Store
  'jkmmbleapaognlonbnllpaoeibmfkjmp', // Microsoft Edge Add-ons
];
// Firefox does NOT use chromiumapp.org: identity.getRedirectURL() there returns
// https://<hash-of-gecko-id>.extensions.allizom.org/…, derived from
// browser_specific_settings.gecko.id — so it is stable for a signed build but is a
// completely different URI that must be registered separately. It is not knowable
// until the first signed build exists, hence the empty list rather than a guess:
// add the exact string that Settings → the endpoint's "Redirect URI" field shows on
// Firefox, and add it to the CIMD document too. Until then, Firefox users sign in to
// Hugging Face with their own Client ID, exactly like an unpacked build.
// tools/verify-firefox.mjs warns while this is empty.
const HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS = [
  // addons.mozilla.org. Unlike a Chromium extension ID, this is not assigned by a store:
  // Firefox derives it as sha1(browser_specific_settings.gecko.id) in lowercase hex
  // (Gecko's child/ext-identity.js computeHash), so it is fixed by our add-on ID alone
  // and identical on every install. tools/test-oauth.mjs re-derives it, so changing the
  // gecko id fails the build here rather than silently breaking hosted sign-in.
  'https://1c26285aee992c6ff936cce00a1f742449074ca5.extensions.allizom.org/oauth/huggingface',
];
const HUGGINGFACE_PRODUCTION_REDIRECT_URIS = [
  ...HUGGINGFACE_PRODUCTION_EXTENSION_IDS.map(
    (id) => `https://${id}.chromiumapp.org/oauth/huggingface`,
  ),
  ...HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS,
];

const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    authorizationUrl: 'https://huggingface.co/oauth/authorize',
    tokenUrl: 'https://huggingface.co/oauth/token',
    // NO defaultClientId. It used to be the hosted CIMD client, which only works from a build
    // whose redirect URI is registered — so the default silently failed on every unpacked
    // build and every store whose id had not been added yet. An empty client id now means
    // "use the broker", which works from all of them.
    broker: HUGGINGFACE_BROKER,
    scope: 'inference-api',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini API',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  },
};

function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function randomBase64Url(cryptoImpl, byteCount = 32) {
  const bytes = new Uint8Array(byteCount);
  cryptoImpl.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(cryptoImpl, text) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', textToBytes(text));
  return bytesToBase64Url(new Uint8Array(digest));
}

function withQuery(url, params) {
  const out = new URL(url);
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && value !== '') out.searchParams.set(key, String(value));
  }
  return out.toString();
}

function tokenStoreKey(endpoint) {
  return endpoint?.id || endpoint?.oauth?.providerId || endpoint?.name || 'default';
}

// Tokens are encrypted at rest (secret-crypto.js): on disk each entry is an AES-GCM
// envelope; load opens them so every caller (incl. exportOAuthTokens → the portable
// backup) sees plaintext, save seals them. Reads tolerate legacy plaintext entries,
// so the migration is transparent (old plaintext → sealed on the next save).
async function loadTokenStore() {
  const got = await chrome.storage.local.get(K_OAUTH);
  const store = got[K_OAUTH] && typeof got[K_OAUTH] === 'object' ? got[K_OAUTH] : {};
  const out = {};
  for (const [k, v] of Object.entries(store)) {
    const opened = await openJSON(v);
    if (opened !== undefined) out[k] = opened; // a decrypt failure drops that entry (re-auth), not the whole store
  }
  return out;
}

async function saveTokenStore(tokens) {
  const sealed = {};
  for (const [k, v] of Object.entries(tokens || {})) sealed[k] = await sealJSON(v);
  await chrome.storage.local.set({ [K_OAUTH]: sealed });
}

// Backup hooks — the whole OAuth token store travels in the portable backup so a
// restore on a fresh install (or after a reinstall that orphaned chrome.storage)
// keeps you signed in to OAuth endpoints instead of forcing a re-auth of each.
export async function exportOAuthTokens() {
  return await loadTokenStore();
}
export async function importOAuthTokens(tokens, { mode = 'merge' } = {}) {
  if (!tokens || typeof tokens !== 'object') return 0;
  const base = mode === 'replace' ? {} : await loadTokenStore();
  await saveTokenStore({ ...base, ...tokens });
  return Object.keys(tokens).length;
}

function normalizeTokenResponse(json) {
  const now = Date.now();
  const expiresIn = Number(json.expires_in || json.expiresIn || 0);
  return {
    access_token: json.access_token || json.accessToken || '',
    refresh_token: json.refresh_token || json.refreshToken || '',
    token_type: json.token_type || json.tokenType || 'Bearer',
    scope: json.scope || '',
    expires_at: expiresIn > 0 ? now + expiresIn * 1000 : 0,
  };
}

export async function createOAuthState({ crypto: cryptoImpl = globalThis.crypto, verifier } = {}) {
  const codeVerifier = verifier || randomBase64Url(cryptoImpl, 48);
  return {
    verifier: codeVerifier,
    challenge: await sha256Base64Url(cryptoImpl, codeVerifier),
    state: randomBase64Url(cryptoImpl, 24),
  };
}

// The browser-issued callback URL for hosted sign-in. Both engines implement
// identity.getRedirectURL(), but they mint different domains — chromiumapp.org on
// Chromium, extensions.allizom.org on Firefox — so this value is read from the
// browser and shown to the user rather than ever being constructed here.
export function oauthRedirectUri(providerId) {
  if (!globalThis.chrome?.identity?.getRedirectURL) {
    throw new Error('This browser does not expose the extension identity API.');
  }
  return chrome.identity.getRedirectURL(`oauth/${providerId || 'provider'}`);
}

export function isOAuthMode(mode) {
  return OAUTH_MODES.has(mode);
}

export function oauthProvider(endpoint) {
  return PROVIDERS[endpoint?.authMode] || null;
}

export function oauthSetupHelp(endpointOrMode) {
  const mode = typeof endpointOrMode === 'string' ? endpointOrMode : endpointOrMode?.authMode;
  if (mode === 'openrouter') {
    return 'No client ID required. If OpenRouter returns HTTP 402 about credits or max tokens, lower Max tokens below the number in the error, or add credits in OpenRouter.';
  }
  if (mode === 'huggingface') {
    return 'Click Connect and sign in with your Hugging Face account — nothing to register, on any build. ChatPanel asks only for inference-api scope, which can call the router and read nothing else; your account, repos and billing stay out of reach. Prefer your own OAuth app? Paste its Client ID above and it is used instead of ours.';
  }
  if (mode === 'gemini') {
    return 'Create a Google Cloud OAuth client, add this Redirect URI, enable the Gemini API, paste the Client ID, and enter the quota project ID.';
  }
  return '';
}

export function applyOAuthPreset(endpoint) {
  const provider = oauthProvider(endpoint);
  if (!provider) return endpoint;
  return {
    ...endpoint,
    kind: 'openai',
    baseUrl: provider.baseUrl,
    apiKey: '',
    oauth: {
      providerId: provider.id,
      clientId: provider.id === 'openrouter' ? '' : endpoint.oauth?.clientId || provider.defaultClientId || '',
      projectId: provider.id === 'gemini' ? endpoint.oauth?.projectId || '' : '',
      authorizationUrl: provider.authorizationUrl || '',
      tokenUrl: provider.tokenUrl || '',
      scope: provider.scope || '',
    },
  };
}

export function buildAuthorizationUrl({
  authorizationUrl,
  clientId,
  redirectUri,
  scope,
  scopes,
  state,
  codeChallenge,
  extraParams,
}) {
  const url = new URL(authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const scopeText = Array.isArray(scopes) ? scopes.join(' ') : scope;
  if (scopeText) url.searchParams.set('scope', scopeText);
  for (const [key, value] of Object.entries(extraParams || {})) {
    if (key && value != null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function extractAuthorizationResult(redirectUrl, expectedState) {
  const url = new URL(redirectUrl);
  const params = new URLSearchParams(url.search);
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);
  for (const [key, value] of hashParams) {
    if (!params.has(key)) params.set(key, value);
  }
  const state = params.get('state');
  if (!state || state !== expectedState) throw new Error('OAuth state mismatch. Try connecting again.');
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    throw new Error(description ? `${error}: ${description}` : error);
  }
  const code = params.get('code');
  if (!code) throw new Error('OAuth provider did not return an authorization code.');
  return { code };
}

export function hasOAuthConfig(endpoint) {
  if (!isOAuthMode(endpoint?.authMode)) return false;
  if (endpoint.authMode === 'openrouter') return true;
  const withPreset = applyOAuthPreset(endpoint);
  const oauth = withPreset?.oauth || {};
  if (endpoint.authMode === 'gemini' && !oauth.projectId) return false;
  // A broker supplies the client, so there is nothing left for the user to configure — which
  // is the whole point of it. Requiring a client id here would keep the Connect button
  // disabled for exactly the people the broker exists to serve.
  if (usesBroker(withPreset)) return true;
  return !!(oauth.authorizationUrl && oauth.tokenUrl && oauth.clientId);
}

/** Sign-in goes through ChatPanel's broker unless the user brought their own OAuth app. */
export function usesBroker(endpoint) {
  const provider = oauthProvider(endpoint);
  if (!provider?.broker) return false;
  return !(endpoint?.oauth?.clientId || '').trim();
}

export function oauthConfigMessage(endpoint) {
  if (!isOAuthMode(endpoint?.authMode)) return '';
  if (endpoint.authMode === 'openrouter') return '';
  const withPreset = applyOAuthPreset(endpoint);
  const oauth = withPreset?.oauth || {};
  // Nothing to say for Hugging Face any more: with no client id it uses the broker, and with
  // one it uses that. The old message told every user to go and create an OAuth app.

  if (endpoint.authMode === 'gemini') {
    const missing = [];
    if (!oauth.clientId) missing.push('Google OAuth Client ID');
    if (!oauth.projectId) missing.push('Google Cloud project ID');
    if (missing.length) {
      return `Paste the ${missing.join(' and ')} first. Create a Google Cloud OAuth client, add the Redirect URI above, and enable the Gemini API.`;
    }
  }
  return '';
}

export function oauthRedirectPreflightMessage(endpoint, redirectUri) {
  const withPreset = applyOAuthPreset(endpoint);
  // Only for someone who has deliberately pasted the hosted CIMD client id back in. It is no
  // longer the default — the broker is — so this is now an escape hatch's guard rather than
  // the wall every unpacked build hit.
  if (
    withPreset?.authMode === 'huggingface' &&
    withPreset.oauth?.clientId === HUGGINGFACE_CIMD_CLIENT_ID &&
    !HUGGINGFACE_PRODUCTION_REDIRECT_URIS.includes(redirectUri)
  ) {
    return `Hosted Hugging Face sign-in only works from a published build whose redirect URI is registered with the ChatPanel client. This build is using ${redirectUri}, which isn't registered, so the provider would reject sign-in. This happens on a local unpacked build, or on a store build (a first Edge or Firefox release) before its redirect URI is added — Firefox issues an extensions.allizom.org URI rather than a chromiumapp.org one, so it needs its own registration. To sign in here, create a Hugging Face public OAuth app with this exact Redirect URI and paste its Client ID above.`;
  }
  return '';
}

export function oauthProviderId(endpoint) {
  const provider = oauthProvider(endpoint);
  return (provider?.id || endpoint?.authMode || 'provider').replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function oauthStatusLabel(endpoint, token) {
  if (!hasOAuthConfig(endpoint)) return 'OAuth is not configured';
  if (!token?.access_token) return 'Not connected';
  if (token.expires_at && Date.now() > token.expires_at - EXPIRY_SKEW_MS) return 'Connected; token needs refresh';
  return 'Connected';
}

async function exchangeToken(endpoint, body) {
  const oauth = endpoint.oauth || {};
  const params = new URLSearchParams(body);
  params.set('client_id', oauth.clientId || '');
  const res = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Keep raw text in the error below.
  }
  if (!res.ok) throw new Error(`OAuth token exchange failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  const token = normalizeTokenResponse(json);
  if (!token.access_token) throw new Error('OAuth token response did not include an access_token.');
  return token;
}

export function buildOpenRouterAuthorizationUrl({ redirectUri, state, codeChallenge }) {
  const callbackUrl = withQuery(redirectUri, { state });
  return withQuery('https://openrouter.ai/auth', {
    callback_url: callbackUrl,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
}

export async function exchangeOpenRouterCode({ code, codeVerifier, fetchImpl = fetch }) {
  const res = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Keep raw text in the error below.
  }
  if (!res.ok) throw new Error(`OpenRouter key exchange failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  if (!json.key) throw new Error('OpenRouter did not return a user API key.');
  return {
    access_token: json.key,
    refresh_token: '',
    token_type: 'Bearer',
    scope: '',
    expires_at: 0,
    provider: 'openrouter',
  };
}

/**
 * Turn the browser's opaque auth-flow failure into something the user can act on.
 *
 * chrome.identity.launchWebAuthFlow reports ANY non-2xx from the authorization endpoint as
 * the single sentence "Authorization page could not be loaded." — and a 4xx HTML page is
 * exactly how an OAuth provider answers the two mistakes people actually make: a redirect
 * URI that is not registered on the app, and a client ID that does not exist. So the most
 * likely failure arrives with its cause stripped off, and the field reads as "the provider
 * is down" when the provider is answering precisely.
 *
 * Hugging Face, asked with an unregistered callback, returns 400 with
 * `x-error-message: Invalid redirect_uri, must be one of the registered redirect_uris for
 * this client_id`. The browser never surfaces that header, so this says what it would have
 * said — and names the exact string to paste, because the redirect URI moves on its own:
 * an unpacked build's extension ID is derived from where it was loaded from, so reloading it
 * from another folder silently invalidates a registration that was correct yesterday.
 */
export function oauthLaunchFailureMessage(error, { providerLabel, redirectUri, clientId, brokered } = {}) {
  const raw = String(error?.message || error || '');
  if (!/could not be loaded|Authorization page/i.test(raw)) return raw;
  const who = providerLabel || 'The provider';
  // NOTHING FOR THE USER TO FIX ON A BROKERED FLOW. Telling them to go and register a
  // redirect URI would send them after a setting they do not own — the whole reason the
  // broker exists is that this build's identity is ours to handle, not theirs.
  if (brokered) {
    return `${who} sign-in could not be opened ("${raw}"). This build's callback (${redirectUri || 'unknown'})`
      + ' may not be registered with the ChatPanel sign-in service yet, or the network blocked'
      + ' api.chatpanel.net. Check the connection and try again; if it persists, use an API key'
      + ' on this endpoint instead — it needs no sign-in.';
  }
  return `${who} refused to show its sign-in page, which almost always means one of two things.`
    + ` (1) This build's Redirect URI is not registered on the OAuth app — it must be listed`
    + ` there character for character as: ${redirectUri || '(unknown)'}.`
    + ` An unpacked extension's ID changes when it is loaded from a different folder, so a URI`
    + ` that worked before can stop matching without anything being edited.`
    + ` (2) The Client ID ${clientId ? `(${clientId}) ` : ''}does not exist, or the app was deleted.`
    + ` The browser reports both as "${raw}" and hides the provider's own explanation.`;
}

/** The broker's authorize leg: our client, the caller's callback, the caller's PKCE. */
export function buildBrokerAuthorizationUrl(broker, { redirectUri, state, codeChallenge }) {
  return withQuery(`${broker}/authorize`, {
    return_uri: redirectUri, state, code_challenge: codeChallenge,
  });
}

/**
 * Spend a broker ticket, or refresh against one.
 *
 * The ticket is opaque and useless without the PKCE verifier that never left this extension,
 * so intercepting the callback URL buys nothing. Deliberately the same shape as the Drive
 * transport — one broker protocol, not one per provider.
 */
async function exchangeBroker(broker, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${broker}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* raw text in the error below */ }
  if (!res.ok) {
    throw new Error(`Sign-in failed: HTTP ${res.status}${payload.error ? ` — ${payload.error}` : ` — ${text.slice(0, 200)}`}`);
  }
  const token = normalizeTokenResponse(payload);
  if (!token.access_token) throw new Error('Sign-in did not return an access token.');
  return { ...token, transport: BROKER_TRANSPORT };
}

async function connectViaBroker(endpoint, provider, redirectUri) {
  const pkce = await createOAuthState();
  const url = buildBrokerAuthorizationUrl(provider.broker, {
    redirectUri, state: pkce.state, codeChallenge: pkce.challenge,
  });
  let redirected;
  try {
    redirected = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    throw new Error(oauthLaunchFailureMessage(e, { providerLabel: provider.label, redirectUri, brokered: true }));
  }
  const result = new URL(redirected);
  if (result.searchParams.get('state') !== pkce.state) throw new Error(`${provider.label} sign-in state mismatch. Try again.`);
  if (result.searchParams.get('error')) throw new Error(`${provider.label} sign-in was cancelled or denied.`);
  const ticket = result.searchParams.get('broker_ticket');
  if (!ticket) throw new Error(`${provider.label} sign-in did not return a secure exchange ticket.`);
  return exchangeBroker(provider.broker, 'token', { ticket, code_verifier: pkce.verifier });
}

export async function connectOAuthEndpoint(endpoint) {
  endpoint = applyOAuthPreset(endpoint);
  if (!hasOAuthConfig(endpoint)) throw new Error('Fill OAuth client settings first.');
  if (!globalThis.chrome?.identity?.launchWebAuthFlow) {
    throw new Error('Chrome identity API is not available.');
  }
  if (usesBroker(endpoint)) {
    const provider = oauthProvider(endpoint);
    const token = await connectViaBroker(endpoint, provider, oauthRedirectUri(oauthProviderId(endpoint)));
    const store = await loadTokenStore();
    store[tokenStoreKey(endpoint)] = token;
    await saveTokenStore(store);
    return token;
  }
  const oauth = endpoint.oauth || {};
  const providerId = oauthProviderId(endpoint);
  const redirectUri = oauthRedirectUri(providerId);
  const preflightMessage = oauthRedirectPreflightMessage(endpoint, redirectUri);
  if (preflightMessage) throw new Error(preflightMessage);
  const pkce = await createOAuthState();
  const authUrl = endpoint.authMode === 'openrouter'
    ? buildOpenRouterAuthorizationUrl({ redirectUri, state: pkce.state, codeChallenge: pkce.challenge })
    : buildAuthorizationUrl({
        authorizationUrl: oauth.authorizationUrl,
        clientId: oauth.clientId,
        redirectUri,
        scope: oauth.scope,
        state: pkce.state,
        codeChallenge: pkce.challenge,
        extraParams: {
          ...(endpoint.authMode === 'gemini' ? { access_type: 'offline', prompt: 'consent' } : {}),
        },
      });
  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (e) {
    throw new Error(oauthLaunchFailureMessage(e, {
      providerLabel: PROVIDERS[endpoint.authMode]?.label || 'The provider',
      redirectUri,
      clientId: oauth.clientId,
    }));
  }
  const { code } = extractAuthorizationResult(redirectUrl, pkce.state);
  const token = endpoint.authMode === 'openrouter'
    ? await exchangeOpenRouterCode({ code, codeVerifier: pkce.verifier })
    : await exchangeToken(endpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      });
  const tokens = await loadTokenStore();
  tokens[tokenStoreKey(endpoint)] = token;
  await saveTokenStore(tokens);
  return token;
}

export async function getOAuthToken(endpoint) {
  const tokens = await loadTokenStore();
  return tokens[tokenStoreKey(endpoint)] || null;
}

export async function disconnectOAuthEndpoint(endpoint) {
  const tokens = await loadTokenStore();
  delete tokens[tokenStoreKey(endpoint)];
  await saveTokenStore(tokens);
}

export async function getOAuthAccessToken(endpoint) {
  endpoint = applyOAuthPreset(endpoint);
  if (!hasOAuthConfig(endpoint)) return '';
  let token = await getOAuthToken(endpoint);
  if (!token?.access_token) {
    throw new Error(`${endpoint.name || 'Endpoint'} is not connected. Open Settings and connect OAuth.`);
  }
  if (!token.expires_at || Date.now() < token.expires_at - EXPIRY_SKEW_MS) return token.access_token;
  if (!token.refresh_token) {
    throw new Error(`${endpoint.name || 'Endpoint'} OAuth token expired. Open Settings and connect again.`);
  }
  // REFRESH THE WAY IT WAS ISSUED. A brokered token was minted by a confidential client whose
  // secret this extension does not have, so refreshing it directly against the provider would
  // fail with an auth error that reads like a revoked login.
  const refreshed = token.transport === BROKER_TRANSPORT
    ? await exchangeBroker(oauthProvider(endpoint).broker, 'refresh', { refresh_token: token.refresh_token })
    : await exchangeToken(endpoint, {
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    });
  token = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token };
  const tokens = await loadTokenStore();
  tokens[tokenStoreKey(endpoint)] = token;
  await saveTokenStore(tokens);
  return token.access_token;
}

export async function authHeadersForEndpoint(endpoint) {
  endpoint = applyOAuthPreset(endpoint);
  if (!hasOAuthConfig(endpoint)) return {};
  const headers = { Authorization: `Bearer ${await getOAuthAccessToken(endpoint)}` };
  if (endpoint.authMode === 'gemini' && endpoint.oauth?.projectId) {
    headers['x-goog-user-project'] = endpoint.oauth.projectId;
  }
  return headers;
}
