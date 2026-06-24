import assert from 'node:assert/strict';

globalThis.chrome = {
  storage: {
    onChanged: { addListener() {} },
  },
};

const { resolveTarget } = await import('../extension/js/store.js');

const endpoint = {
  id: 'ep-openrouter',
  name: 'OpenRouter',
  kind: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  authMode: 'openrouter',
  providerPreset: 'openrouter',
  oauth: { providerId: 'openrouter' },
  headers: { 'HTTP-Referer': 'https://chatpanel.net' },
  extraBody: { top_p: 0.9, reasoning_effort: 'low' },
  model: 'openrouter/free-model:free',
  autocompleteModel: 'openrouter/fast-model',
};

const resolved = resolveTarget(
  {
    id: 'agent-on-endpoint',
    name: 'Endpoint persona',
    kind: 'model',
    endpointId: endpoint.id,
    systemPrompt: 'Be concise.',
    temperature: 0.2,
    maxTokens: 2048,
  },
  { endpoints: [endpoint] },
);

assert.deepEqual(
  {
    kind: resolved.kind,
    baseUrl: resolved.baseUrl,
    authMode: resolved.authMode,
    providerPreset: resolved.providerPreset,
    oauth: resolved.oauth,
    headers: resolved.headers,
    extraBody: resolved.extraBody,
    model: resolved.model,
    autocompleteModel: resolved.autocompleteModel,
    systemPrompt: resolved.systemPrompt,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
  },
  {
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    authMode: 'openrouter',
    providerPreset: 'openrouter',
    oauth: { providerId: 'openrouter' },
    headers: { 'HTTP-Referer': 'https://chatpanel.net' },
    extraBody: { top_p: 0.9, reasoning_effort: 'low' },
    model: 'openrouter/free-model:free',
    autocompleteModel: 'openrouter/fast-model',
    systemPrompt: 'Be concise.',
    temperature: 0.2,
    maxTokens: 2048,
  },
);

console.log('resolve target tests passed');
