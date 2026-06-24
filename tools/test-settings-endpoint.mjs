import assert from 'node:assert/strict';

import {
  clearEndpointModelState,
  endpointErrorAuthStatus,
  modelListAuthStatus,
  isAuthErrorMessage,
} from '../extension/js/settings-endpoint.js';

const geminiError = 'Google Gemini: HTTP 400 — [{ "error": { "code": 400, "message": "Missing or invalid Authorization header.", "status": "INVALID_ARGUMENT" } }]';
assert.equal(isAuthErrorMessage(geminiError), true, 'Gemini missing authorization errors should be auth errors');
assert.equal(
  endpointErrorAuthStatus(new Error(geminiError)),
  '✕ ' + geminiError,
  'auth errors should be formatted for the Authentication section',
);

assert.equal(
  isAuthErrorMessage('OpenRouter: HTTP 402 — this request requires more credits'),
  false,
  'provider billing errors should not overwrite Authentication status',
);
assert.equal(endpointErrorAuthStatus(new Error('OpenRouter: HTTP 402 — add credits')), '');

const geminiNotFound = 'Google AI Studio · Gemini: HTTP 404 — { "error": { "code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND" } }';
assert.equal(
  endpointErrorAuthStatus(new Error(geminiNotFound), { includeNonAuth: true }),
  '✕ ' + geminiNotFound,
  'Load models errors should be mirrorable into Authentication status even when the provider body is not auth-worded',
);

const deepInfraCaptcha = 'DeepInfra: HTTP 422 — {"detail":{"error":"Missing captcha token"}}';
assert.equal(isAuthErrorMessage(deepInfraCaptcha), true, 'DeepInfra captcha errors should be treated as auth/setup errors');
assert.equal(endpointErrorAuthStatus(new Error(deepInfraCaptcha)), '✕ ' + deepInfraCaptcha);

assert.deepEqual(
  modelListAuthStatus({ authMode: 'apiKey', apiKey: '' }),
  {
    text: 'Models loaded. Add an API key, then click Test to verify chat authentication.',
    cls: '',
  },
  'model listing without an API key should not claim chat auth is accepted',
);

assert.deepEqual(
  modelListAuthStatus({ authMode: 'apiKey', apiKey: 'di-abc' }),
  {
    text: 'Models loaded. Click Test to verify chat authentication.',
    cls: '',
  },
  'model listing with an API key still should not claim chat auth is accepted',
);

const endpoint = {
  model: 'google/gemma-3-12b-it',
  models: ['google/gemma-3-12b-it'],
  modelOptions: [{ id: 'google/gemma-3-12b-it', label: 'Gemma' }],
  autocompleteModel: 'google/gemma-3-4b-it',
  name: 'NVIDIA',
};
const cleared = clearEndpointModelState(endpoint);
assert.equal(cleared.name, 'NVIDIA', 'non-model endpoint fields should be preserved');
assert.equal(cleared.model, '');
assert.deepEqual(cleared.models, []);
assert.deepEqual(cleared.modelOptions, []);
assert.equal(cleared.autocompleteModel, '');

console.log('settings endpoint tests passed');
