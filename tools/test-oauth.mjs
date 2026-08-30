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
  usesBroker,
  buildBrokerAuthorizationUrl,
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

// NO CLIENT ID MEANS THE BROKER, and the broker is the default.
//
// It used to mean the hosted CIMD client, which only works from a build whose redirect URI is
// registered with it — so the default failed on every unpacked build and on every store whose
// id had not been added yet, and told the user to go and create their own OAuth app. That is a
// developer task standing between someone and their first message.
const hfDefault = applyOAuthPreset({
  authMode: 'huggingface',
  oauth: {},
});
assert.equal(hfDefault.oauth.clientId, '', 'the default must be empty — that is what selects the broker');
assert.equal(usesBroker(hfDefault), true);
assert.equal(hasOAuthConfig(hfDefault), true, 'Connect must be enabled with nothing configured');
assert.equal(oauthConfigMessage(hfDefault), '');

// A pasted client id is still honoured, and takes the direct path rather than ours.
assert.equal(usesBroker(applyOAuthPreset({ authMode: 'huggingface', oauth: { clientId: 'hf_client' } })), false);
assert.equal(usesBroker(applyOAuthPreset({ authMode: 'gemini', oauth: { clientId: 'g', projectId: 'p' } })), false,
  'only a provider that declares a broker may use one');

// The authorize leg carries the caller's callback and PKCE, never a client id — the broker
// holds that, which is the entire reason a user has nothing to register.
{
  const url = new URL(buildBrokerAuthorizationUrl('https://api.chatpanel.net/oauth/huggingface', {
    redirectUri: 'https://abc.chromiumapp.org/oauth/huggingface',
    state: 'state-value',
    codeChallenge: 'challenge-value',
  }));
  assert.equal(url.pathname, '/oauth/huggingface/authorize');
  assert.equal(url.searchParams.get('return_uri'), 'https://abc.chromiumapp.org/oauth/huggingface');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(url.searchParams.get('client_id'), null, 'the extension must not carry a client id');
}

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
// The help text must describe the one step there now is, and still name the scope — "what
// does this get access to" is the question a sign-in button owes an answer to.
assert.match(oauthSetupHelp('huggingface'), /Connect and sign in/);
assert.match(oauthSetupHelp('huggingface'), /nothing to register/);
assert.match(oauthSetupHelp('huggingface'), /inference-api/);
assert.doesNotMatch(oauthSetupHelp('huggingface'), /create a public HF OAuth app/i,
  'the help still tells users to register an app they no longer need');
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
// THE DEFAULT NO LONGER HAS A REDIRECT PROBLEM TO WARN ABOUT.
//
// This preflight existed because the hosted CIMD client was the default, and it refuses any
// callback it does not already know — so an unpacked build was stopped before it started. The
// broker accepts every allowlisted extension identity, so the default path on an unrecognised
// URI must now say NOTHING and simply work.
assert.equal(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: {} },
    'https://abcdef.chromiumapp.org/oauth/huggingface',
  ),
  '',
  'the broker default must not be gated on a registered redirect URI',
);
// The guard is still right for someone who deliberately pastes the hosted CIMD client back in.
assert.match(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: { clientId: 'https://chatpanel.net/.well-known/oauth-cimd' } },
    'https://abcdef.chromiumapp.org/oauth/huggingface',
  ),
  /Hosted Hugging Face sign-in only works from a published build/,
);
assert.equal(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: { clientId: 'https://chatpanel.net/.well-known/oauth-cimd' } },
    'https://icemacffhbgnfoofclgdbcdmnlkkklem.chromiumapp.org/oauth/huggingface',
  ),
  '',
  'Chrome production redirect URI should be accepted for hosted HF sign-in',
);
assert.equal(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: { clientId: 'https://chatpanel.net/.well-known/oauth-cimd' } },
    'https://jkmmbleapaognlonbnllpaoeibmfkjmp.chromiumapp.org/oauth/huggingface',
  ),
  '',
  'Edge production redirect URI should be accepted for hosted HF sign-in',
);
assert.equal(
  oauthRedirectPreflightMessage(
    { authMode: 'huggingface', oauth: { clientId: 'custom_client' } },
    'https://abcdef.chromiumapp.org/oauth/huggingface',
  ),
  '',
);

console.log('oauth helper tests passed');

// ── the Firefox redirect URI must stay derivable from the add-on ID ────────
// THE BUG THIS PREVENTS. Firefox does not let a store assign the redirect host: it
// computes sha1(browser_specific_settings.gecko.id) in lowercase hex and uses that as
// the subdomain (Gecko child/ext-identity.js computeHash). So the URI we register with
// Hugging Face is a pure function of our add-on ID — and changing that ID would
// silently invalidate every registration, with the only symptom being hosted sign-in
// failing on Firefox for everyone.
{
  const { createHash } = await import('node:crypto');
  const { readFileSync, existsSync } = await import('node:fs');
  const { GECKO_ID } = await import('./firefox-manifest.mjs');

  const expected = `https://${createHash('sha1').update(GECKO_ID).digest('hex')}`
    + '.extensions.allizom.org/oauth/huggingface';

  const src = readFileSync(new URL('../extension/js/oauth.js', import.meta.url), 'utf8');
  const block = /HUGGINGFACE_PRODUCTION_GECKO_REDIRECT_URIS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(block, 'the Firefox redirect allow-list is gone from js/oauth.js');
  const listed = [...block[1].split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n').matchAll(/'(https:[^']+)'/g)].map((m) => m[1]);
  assert.ok(
    listed.includes(expected),
    `js/oauth.js must list ${expected} — it is sha1("${GECKO_ID}") and cannot be chosen freely`,
  );

  // …and the hosted client document has to agree, or the provider rejects the callback.
  //
  // THAT DOCUMENT LIVES IN THE PRIVATE REPO, and this one is public. Reading it
  // unconditionally turned every CI run on chatpanel-extension red with an ENOENT for a
  // sibling checkout that only exists on a maintainer's machine — a test that cannot pass
  // where it runs is not a guard, it is a broken signal that hides the real ones behind it.
  // Same shape as the vendored-contracts drift check: assert where the file exists, skip
  // loudly where it cannot.
  const cimdPath = new URL('../../chatpanel/site/.well-known/oauth-cimd', import.meta.url);
  if (!existsSync(cimdPath)) {
    console.log('  (skipped the CIMD cross-check — the private site repo is not checked out here)');
  } else {
    const cimd = JSON.parse(readFileSync(cimdPath, 'utf8'));
    assert.ok(
      cimd.redirect_uris.includes(expected),
      'the CIMD document at chatpanel.net/.well-known/oauth-cimd must list the same Firefox redirect URI',
    );
  }
}

console.log('✓ oauth: Firefox redirect URI matches sha1(gecko id) in both the allow-list and the CIMD doc');

// THE BROWSER HIDES THE ONE THING WORTH KNOWING.
//
// chrome.identity.launchWebAuthFlow collapses any non-2xx from the authorization endpoint
// into "Authorization page could not be loaded." — and a 4xx HTML page is exactly how a
// provider answers an unregistered redirect_uri or an unknown client_id. Hugging Face
// returns 400 with `x-error-message: Invalid redirect_uri, must be one of the registered
// redirect_uris for this client_id`, which never reaches the user. Passing the browser's
// sentence through unchanged reads as "the provider is down" when the provider is answering
// precisely, and leaves the one string that has to be copied unmentioned.
{
  const { oauthLaunchFailureMessage } = await import('../extension/js/oauth.js');
  const uri = 'https://abc.chromiumapp.org/oauth/huggingface';
  const msg = oauthLaunchFailureMessage(new Error('Authorization page could not be loaded.'), {
    providerLabel: 'Hugging Face', redirectUri: uri, clientId: '02ee6450',
  });
  assert.ok(msg.includes(uri), 'the redirect URI to register was not named');
  assert.ok(/registered/i.test(msg), 'the likeliest cause was not stated');
  assert.ok(msg.includes('02ee6450'), 'the client ID in play was not named');

  // Anything else is the provider's own words and must survive untouched — a real message
  // replaced by a guess is worse than the guess alone.
  const real = 'invalid_scope: inference-api is not enabled for this app';
  assert.equal(oauthLaunchFailureMessage(new Error(real), { redirectUri: uri }), real);
}

console.log('✓ oauth: an opaque browser auth failure names the redirect URI that has to be registered');
