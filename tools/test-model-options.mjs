import assert from 'node:assert/strict';

import { normalizeModelOptions } from '../extension/js/providers.js';

const openRouterModels = {
  data: [
    {
      id: 'paid/model',
      name: 'Paid Model',
      context_length: 32000,
      top_provider: { max_completion_tokens: 4096 },
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
    {
      id: 'cohere/north-mini-code:free',
      name: 'Cohere: North Mini Code (free)',
      context_length: 256000,
      top_provider: { max_completion_tokens: 64000 },
      pricing: { prompt: '0', completion: '0' },
    },
  ],
};

const options = normalizeModelOptions(openRouterModels, { authMode: 'openrouter' });
assert.deepEqual(
  options.map((m) => m.id),
  ['cohere/north-mini-code:free', 'paid/model'],
  'OpenRouter free models should sort ahead of paid models',
);
assert.equal(options[0].free, true);
assert.equal(options[0].contextLength, 256000);
assert.equal(options[0].maxCompletionTokens, 64000);
assert.match(options[0].label, /FREE/);
assert.match(options[0].label, /256K ctx/);
assert.match(options[0].label, /64K max/);
assert.equal(options[1].free, false);
assert.doesNotMatch(options[1].label, /FREE/);

const genericOptions = normalizeModelOptions(openRouterModels, { baseUrl: 'https://api.example.com/v1' });
assert.equal(genericOptions[0].free, false, 'zero pricing should only create a free marker for OpenRouter endpoints');

console.log('model option tests passed');
