import assert from 'node:assert/strict';

import {
  API_PROVIDER_PRESETS,
  applyProviderPreset,
  orderedProviderPresets,
  providerPresetForEndpoint,
} from '../extension/js/provider-presets.js';

const byId = Object.fromEntries(API_PROVIDER_PRESETS.map((p) => [p.id, p]));
const ordered = orderedProviderPresets();

assert.equal(ordered[0].id, 'custom', 'Custom should stay first in provider picker');
assert.deepEqual(
  ordered.slice(-4).map((p) => p.id),
  ['ollama', 'lmstudio', 'llamacpp', 'vllm'],
  'Local/self-hosted provider presets should stay at the bottom',
);
const hostedNames = ordered.slice(1, -4).map((p) => p.name);
assert.deepEqual(
  hostedNames,
  hostedNames.slice().sort((a, b) => a.localeCompare(b)),
  'Hosted provider presets should be alphabetical between Custom and local presets',
);

assert.equal(byId.nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
assert.equal(byId.nvidia.kind, 'openai');
assert.equal(byId.nvidia.authMode, 'apiKey');

assert.equal(byId.anthropic.baseUrl, 'https://api.anthropic.com');
assert.equal(byId.anthropic.kind, 'anthropic');

for (const id of [
  'openai',
  'openrouter',
  'gemini-api-key',
  'huggingface-api-key',
  'vercel-ai-gateway',
  'opencode-zen',
  'groq',
  'cohere',
  'github-models',
  'cloudflare-workers-ai',
  'together',
  'mistral',
  'mistral-codestral',
  'xai',
  'deepinfra',
  'fireworks',
  'cerebras',
  'nvidia',
  'anthropic',
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
]) {
  assert.ok(byId[id], `missing provider preset ${id}`);
  assert.ok(byId[id].docsUrl || byId[id].keyUrl || byId[id].signupUrl, `missing setup links for ${id}`);
}

assert.deepEqual(byId.openrouter.defaultHeaders, {
  'HTTP-Referer': 'https://chatpanel.net',
});
assert.equal(byId['vercel-ai-gateway'].baseUrl, 'https://ai-gateway.vercel.sh/v1');
assert.equal(byId['opencode-zen'].baseUrl, 'https://opencode.ai/zen/v1');
assert.equal(byId.cohere.baseUrl, 'https://api.cohere.ai/compatibility/v1');
assert.match(byId['huggingface-api-key'].note, /API key/i);
assert.match(byId['huggingface-api-key'].note, /OAuth/i);
assert.match(byId['huggingface-api-key'].note, /401/i);
assert.match(byId.deepinfra.note, /Missing captcha token/i);
assert.equal(byId['github-models'].baseUrl, 'https://models.github.ai/inference');
assert.equal(byId['cloudflare-workers-ai'].baseUrl, 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1');

const nvidia = applyProviderPreset({
  name: 'Old name',
  kind: 'anthropic',
  baseUrl: 'https://example.invalid',
  authMode: 'openrouter',
  apiKey: 'secret',
  providerPreset: 'nvidia',
});
assert.deepEqual({
  name: nvidia.name,
  kind: nvidia.kind,
  baseUrl: nvidia.baseUrl,
  authMode: nvidia.authMode,
  apiKey: nvidia.apiKey,
  providerPreset: nvidia.providerPreset,
  headers: nvidia.headers,
}, {
  name: 'NVIDIA NIM',
  kind: 'openai',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  authMode: 'apiKey',
  apiKey: 'secret',
  providerPreset: 'nvidia',
  headers: {},
});

const openrouter = applyProviderPreset({
  name: 'Old name',
  kind: 'openai',
  baseUrl: 'https://example.invalid',
  authMode: 'apiKey',
  providerPreset: 'openrouter',
});
assert.deepEqual(openrouter.headers, { 'HTTP-Referer': 'https://chatpanel.net' });

const openrouterCustomReferer = applyProviderPreset({
  name: 'Old name',
  kind: 'openai',
  baseUrl: 'https://example.invalid',
  authMode: 'apiKey',
  providerPreset: 'openrouter',
  headers: { 'HTTP-Referer': 'https://my-app.example' },
});
assert.deepEqual(openrouterCustomReferer.headers, { 'HTTP-Referer': 'https://my-app.example' });

const custom = applyProviderPreset({
  name: 'Self hosted',
  kind: 'openai',
  baseUrl: 'https://models.example.com/v1',
  authMode: 'apiKey',
  providerPreset: 'custom',
});
assert.equal(custom.baseUrl, 'https://models.example.com/v1');
assert.equal(custom.name, 'Self hosted');

assert.equal(
  providerPresetForEndpoint({ baseUrl: 'https://integrate.api.nvidia.com/v1/' })?.id,
  'nvidia',
);
assert.equal(
  providerPresetForEndpoint({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })?.id,
  'anthropic',
);
assert.equal(
  providerPresetForEndpoint({ baseUrl: 'https://models.example.com/v1' }),
  null,
);

console.log('provider preset tests passed');
