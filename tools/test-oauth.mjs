import assert from 'node:assert/strict';

import {
  createOAuthState,
  applyOAuthPreset,
  buildAuthorizationUrl,
  extractAuthorizationResult,
  hasOAuthConfig,
  oauthConfigMessage,
  oauthRedirectPreflightMessage,
  oauthProvider,
  oauthSetupHelp,
  buildOpenRouterAuthorizationUrl,
  exchangeOpenRouterCode,
} from '../extension/js/oauth.js';

const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const state = await createOAuthState({ crypto: globalThis.crypto, verifier });

assert.equal(state.verifier, verifier);
assert.equal(
  state.challenge,
  'ImpiCd8pp4MveCNnbIS7-GXEtB0xF5HMIDoWqvGA5ig',
  'PKCE challenge should be base64url(SHA256(verifier))',
);

const url = buildAuthorizationUrl({
  authorizationUrl: 'https://provider.example/oauth/authorize',
  clientId: 'client_123',
  redirectUri: 'https://abcdef.chromiumapp.org/oauth/example',
  scope: 'models chat',
  state: 'state_123',
  codeChallenge: state.challenge,
  extraParams: { prompt: 'consent' },
});
const parsed = new URL(url);
assert.equal(parsed.origin + parsed.pathname, 'https://provider.example/oauth/authorize');
assert.equal(parsed.searchParams.get('response_type'), 'code');
assert.equal(parsed.searchParams.get('client_id'), 'client_123');
assert.equal(parsed.searchParams.get('redirect_uri'), 'https://abcdef.chromiumapp.org/oauth/example');
assert.equal(parsed.searchParams.get('scope'), 'models chat');
assert.equal(parsed.searchParams.get('state'), 'state_123');
assert.equal(parsed.searchParams.get('code_challenge'), state.challenge);
assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
assert.equal(parsed.searchParams.get('prompt'), 'consent');

const result = extractAuthorizationResult(
  'https://abcdef.chromiumapp.org/oauth/example?code=abc&state=state_123',
  'state_123',
);
assert.deepEqual(result, { code: 'abc' });

const fragmentResult = extractAuthorizationResult(
  'https://abcdef.chromiumapp.org/oauth/example#code=abc&state=state_123',
  'state_123',
);
assert.deepEqual(fragmentResult, { code: 'abc' });

assert.throws(
  () => extractAuthorizationResult(
    'https://abcdef.chromiumapp.org/oauth/example?error=access_denied&error_description=Nope&state=state_123',
    'state_123',
  ),
  /access_denied: Nope/,
);
assert.throws(
  () => extractAuthorizationResult('https://abcdef.chromiumapp.org/oauth/example?code=abc&state=wrong', 'state_123'),
  /OAuth state mismatch/,
);

const openRouterUrl = buildOpenRouterAuthorizationUrl({
  redirectUri: 'https://abcdef.chromiumapp.org/oauth/openrouter',
  state: 'state_456',
  codeChallenge: state.challenge,
});
const openRouterParsed = new URL(openRouterUrl);
assert.equal(openRouterParsed.origin + openRouterParsed.pathname, 'https://openrouter.ai/auth');
assert.equal(openRouterParsed.searchParams.get('code_challenge'), state.challenge);
assert.equal(openRouterParsed.searchParams.get('code_challenge_method'), 'S256');
const openRouterCallback = new URL(openRouterParsed.searchParams.get('callback_url'));
assert.equal(openRouterCallback.origin + openRouterCallback.pathname, 'https://abcdef.chromiumapp.org/oauth/openrouter');
assert.equal(openRouterCallback.searchParams.get('state'), 'state_456');

const key = await exchangeOpenRouterCode({
  code: 'code_123',
  codeVerifier: verifier,
  fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/auth/keys');
    assert.equal(opts.method, 'POST');
    assert.deepEqual(JSON.parse(opts.body), {
      code: 'code_123',
      code_verifier: verifier,
      code_challenge_method: 'S256',
    });
    return new Response(JSON.stringify({ key: 'or_user_key' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
assert.equal(key.access_token, 'or_user_key');
assert.equal(key.provider, 'openrouter');

assert.equal(
  hasOAuthConfig({
    authMode: 'oauth',
    oauth: {
      authorizationUrl: 'https://provider.example/authorize',
      tokenUrl: 'https://provider.example/token',
      clientId: 'client_123',
    },
  }),
  false,
  'hand-edited generic OAuth configs should not be accepted',
);
assert.equal(oauthProvider({ authMode: 'oauth' }), null);

const hf = applyOAuthPreset({
  authMode: 'huggingface',
  baseUrl: 'https://wrong.example/v1',
  apiKey: 'should_not_survive',
  oauth: {
    clientId: 'hf_client',
    authorizationUrl: 'https://wrong.example/authorize',
    tokenUrl: 'https://wrong.example/token',
    tokenParams: 'extra=not-allowed',
  },
});
assert.equal(hf.kind, 'openai');
assert.equal(hf.baseUrl, 'https://router.huggingface.co/v1');
assert.equal(hf.apiKey, '');
assert.equal(hf.oauth.providerId, 'huggingface');
assert.equal(hf.oauth.clientId, 'hf_client');
assert.equal(hf.oauth.authorizationUrl, 'https://huggingface.co/oauth/authorize');
assert.equal(hf.oauth.tokenUrl, 'https://huggingface.co/oauth/token');
assert.equal(hf.oauth.scope, 'inference-api');
assert.equal(hf.oauth.tokenParams, undefined);
assert.equal(hasOAuthConfig(hf), true);

const hfDefault = applyOAuthPreset({
  authMode: 'huggingface',
  oauth: {},
});
assert.equal(hfDefault.oauth.clientId, 'https://chatpanel.net/.well-known/oauth-cimd');
assert.equal(hasOAuthConfig(hfDefault), true);
assert.equal(oauthConfigMessage(hfDefault), '');

assert.equal(
  hasOAuthConfig({
    authMode: 'gemini',
    oauth: { clientId: 'google_client' },
  }),
  false,
  'Gemini OAuth should require a Google Cloud quota project id',
);

assert.match(oauthSetupHelp('openrouter'), /Max tokens/);
assert.match(oauthSetupHelp('openrouter'), /credits/);
assert.match(oauthSetupHelp('huggingface'), /No Hugging Face setup/);
assert.match(oauthSetupHelp('huggingface'), /chatpanel\.net\/\.well-known\/oauth-cimd/);
assert.match(oauthSetupHelp('huggingface'), /local unpacked extension/);
assert.match(oauthSetupHelp('huggingface'), /inference-api/);
assert.match(oauthSetupHelp('gemini'), /Google Cloud OAuth client/);
assert.match(oauthSetupHelp('gemini'), /quota project/);

assert.match(
  oauthConfigMessage({ authMode: 'huggingface', oauth: {} }),
  /^$/,
);
assert.match(
  oauthConfigMessage({ authMode: 'gemini', oauth: { clientId: 'google_client' } }),
  /Google Cloud project ID/,
);
assert.equal(
  oauthConfigMessage({ authMode: 'openrouter', oauth: {} }),
  '',
);
assert.match(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: {} },
    'https://abcdef.chromiumapp.org/oauth/huggingface',
  ),
  /hosted Hugging Face sign-in only supports the production extension redirect URI/,
);
assert.equal(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: {} },
    'https://icemacffhbgnfoofclgdbcdmnlkkklem.chromiumapp.org/oauth/huggingface',
  ),
  '',
);
assert.equal(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: { clientId: 'custom_client' } },
    'https://abcdef.chromiumapp.org/oauth/huggingface',
  ),
  '',
);

console.log('oauth helper tests passed');
