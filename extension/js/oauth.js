// Provider OAuth 2.0 Authorization Code + PKCE support for model endpoints.
//
// This is for providers that explicitly support public/browser-extension OAuth
// clients and return access tokens accepted by their model API. It is not a
// ChatGPT/Claude.ai web-session bridge.

const K_OAUTH = 'chatpanel:oauthTokens';
const EXPIRY_SKEW_MS = 60_000;
const OAUTH_MODES = new Set(['openrouter', 'huggingface', 'gemini']);
const HUGGINGFACE_CIMD_CLIENT_ID = 'https://chatpanel.net/.well-known/oauth-cimd';
const HUGGINGFACE_PRODUCTION_REDIRECT_URI = 'https://icemacffhbgnfoofclgdbcdmnlkkklem.chromiumapp.org/oauth/huggingface';

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
    defaultClientId: HUGGINGFACE_CIMD_CLIENT_ID,
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

async function loadTokenStore() {
  const got = await chrome.storage.local.get(K_OAUTH);
  return got[K_OAUTH] && typeof got[K_OAUTH] === 'object' ? got[K_OAUTH] : {};
}

async function saveTokenStore(tokens) {
  await chrome.storage.local.set({ [K_OAUTH]: tokens });
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

export function oauthRedirectUri(providerId) {
  if (!globalThis.chrome?.identity?.getRedirectURL) {
    throw new Error('Chrome identity API is not available.');
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
    return `No Hugging Face setup needed for the production ChatPanel extension. It uses ${HUGGINGFACE_CIMD_CLIENT_ID} with PKCE and inference-api scope. For a local unpacked extension, create a public HF OAuth app with the shown Redirect URI and paste its Client ID here.`;
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
  return !!(oauth.authorizationUrl && oauth.tokenUrl && oauth.clientId);
}

export function oauthConfigMessage(endpoint) {
  if (!isOAuthMode(endpoint?.authMode)) return '';
  if (endpoint.authMode === 'openrouter') return '';
  const withPreset = applyOAuthPreset(endpoint);
  const oauth = withPreset?.oauth || {};
  if (endpoint.authMode === 'huggingface' && !oauth.clientId) {
    return 'Paste the Hugging Face Client ID first. Create a public OAuth app with no secret, add the Redirect URI above, and request inference-api scope.';
  }
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
  if (
    withPreset?.authMode === 'huggingface' &&
    withPreset.oauth?.clientId === HUGGINGFACE_CIMD_CLIENT_ID &&
    redirectUri !== HUGGINGFACE_PRODUCTION_REDIRECT_URI
  ) {
    return `The hosted Hugging Face sign-in only supports the production extension redirect URI: ${HUGGINGFACE_PRODUCTION_REDIRECT_URI}. This extension is using ${redirectUri}. For local unpacked testing, create a Hugging Face public OAuth app with this Redirect URI and paste its Client ID here.`;
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

export async function connectOAuthEndpoint(endpoint) {
  endpoint = applyOAuthPreset(endpoint);
  if (!hasOAuthConfig(endpoint)) throw new Error('Fill OAuth client settings first.');
  if (!globalThis.chrome?.identity?.launchWebAuthFlow) {
    throw new Error('Chrome identity API is not available.');
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
  const redirectUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
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
  const refreshed = await exchangeToken(endpoint, {
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
