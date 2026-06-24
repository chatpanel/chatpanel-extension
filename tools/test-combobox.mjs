import assert from 'node:assert/strict';

import { filterComboboxOptions, normalizeComboboxOptions } from '../extension/js/combobox.js';

const options = normalizeComboboxOptions([
  { id: 'openai/gpt-oss-120b:free', label: 'FREE · GPT OSS · 128K ctx', free: true },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', label: 'Nemotron Super', free: false },
  'google/gemma-3-12b-it',
]);

assert.deepEqual(options.map((o) => o.value), [
  'openai/gpt-oss-120b:free',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'google/gemma-3-12b-it',
]);
assert.equal(options[0].meta, 'FREE · GPT OSS · 128K ctx');

assert.deepEqual(
  filterComboboxOptions(options, 'nemotron').map((o) => o.value),
  ['nvidia/llama-3.3-nemotron-super-49b-v1'],
);
assert.deepEqual(
  filterComboboxOptions(options, 'free').map((o) => o.value),
  ['openai/gpt-oss-120b:free'],
);
assert.deepEqual(
  filterComboboxOptions(options, 'GOOGLE 12b').map((o) => o.value),
  ['google/gemma-3-12b-it'],
);
assert.equal(filterComboboxOptions(options, 'missing').length, 0);

console.log('combobox tests passed');
