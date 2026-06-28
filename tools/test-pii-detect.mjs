import assert from 'node:assert/strict';

import { detectEntities, normalizeEntities, clearDetectCache } from '../extension/js/pii-detect.js';

// --- normalizeEntities: tolerate the common detector shapes + map labels ---
assert.deepEqual(
  normalizeEntities({ entities: [{ value: 'Alex', type: 'PERSON' }, { value: 'Acme', type: 'ORG' }] }),
  [{ value: 'Alex', type: 'PERSON' }, { value: 'Acme', type: 'ORG' }],
);
// spaCy displacy shape {ents:[{text,label}]} + label mapping PER->PERSON, GPE->LOCATION
assert.deepEqual(
  normalizeEntities({ ents: [{ text: 'Alex', label: 'PER' }, { text: 'Paris', label: 'GPE' }] }),
  [{ value: 'Alex', type: 'PERSON' }, { value: 'Paris', type: 'LOCATION' }],
);
// bare array + HF entity_group + de-dup
assert.deepEqual(
  normalizeEntities([{ word: 'Alex', entity_group: 'PER' }, { word: 'Alex', entity_group: 'PER' }]),
  [{ value: 'Alex', type: 'PERSON' }],
);

// --- filter: keep names/locations + long digit runs; drop benign DATE / short CARDINAL ---
assert.deepEqual(
  normalizeEntities({ ents: [
    { text: 'John', label: 'PERSON' }, { text: 'San Jose', label: 'GPE' },
    { text: 'today', label: 'DATE' }, { text: '4', label: 'CARDINAL' }, { text: 'one', label: 'CARDINAL' },
    { text: '9320434444', label: 'CARDINAL' },
  ] }),
  [{ value: 'John', type: 'PERSON' }, { value: 'San Jose', type: 'LOCATION' }, { value: '9320434444', type: 'CARDINAL' }],
);

// --- type toggles: location OFF keeps cities, person stays redacted ---
assert.deepEqual(
  normalizeEntities(
    { ents: [{ text: 'John', label: 'PERSON' }, { text: 'San Jose', label: 'GPE' }, { text: 'Acme', label: 'ORG' }] },
    { person: true, org: false, location: false, number: true },
  ),
  [{ value: 'John', type: 'PERSON' }],
);

const okJson = (body) => async () => ({ ok: true, json: async () => body });

// --- endpoint (NER / spaCy) backend ---
{
  clearDetectCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ entities: [{ value: 'John', type: 'PERSON' }] }) }; };
  const det = { detection: { backend: 'endpoint', url: 'http://127.0.0.1:9009/ner' } };
  const ents = await detectEntities('hi my name is John and I work a lot', det, { fetchImpl });
  assert.deepEqual(ents, [{ value: 'John', type: 'PERSON' }]);
  // cache: a second identical call must NOT hit the network again
  await detectEntities('hi my name is John and I work a lot', det, { fetchImpl });
  assert.equal(calls, 1, 'content-hash cache prevents repeat detection');
}

// --- openai (local LLM) backend: JSON parsed out of the chat completion ---
{
  clearDetectCache();
  const fetchImpl = okJson({ choices: [{ message: { content: 'sure:\n{"entities":[{"value":"John","type":"PER"}]}' } }] });
  const det = { detection: { backend: 'openai', url: 'http://127.0.0.1:8080', model: 'gemma-4-26b' } };
  const ents = await detectEntities('please redact my name John from this', det, { fetchImpl });
  assert.deepEqual(ents, [{ value: 'John', type: 'PERSON' }]);
}

// --- fail-open: a throwing/non-ok detector yields [] (never blocks chat) ---
{
  clearDetectCache();
  const boom = async () => { throw new Error('connrefused'); };
  assert.deepEqual(await detectEntities('some text with names here', { detection: { backend: 'endpoint', url: 'http://x/y' } }, { fetchImpl: boom }), []);
  clearDetectCache();
  const non200 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.deepEqual(await detectEntities('some text with names here', { detection: { backend: 'endpoint', url: 'http://x/y' } }, { fetchImpl: non200 }), []);
}

// --- strict mode (Test button): errors propagate instead of failing open ---
{
  clearDetectCache();
  const boom = async () => { throw new Error('connrefused'); };
  await assert.rejects(
    detectEntities('some text with names here', { detection: { backend: 'endpoint', url: 'http://x/y' } }, { fetchImpl: boom, strict: true }),
    /connrefused/,
  );
  // strict also bypasses the cache so a re-run always re-tests
  clearDetectCache();
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => ({ entities: [{ value: 'Jordan Blake', type: 'PERSON' }] }) }; };
  const det = { detection: { backend: 'endpoint', url: 'http://x/y' } };
  assert.deepEqual(await detectEntities('redact Jordan Blake please', det, { fetchImpl: ok, strict: true }), [{ value: 'Jordan Blake', type: 'PERSON' }]);
  await detectEntities('redact Jordan Blake please', det, { fetchImpl: ok, strict: true });
  assert.equal(calls, 2, 'strict bypasses the cache (re-runs each time)');
}

// --- timeout: a slow detector fails open ---
{
  clearDetectCache();
  const slow = () => new Promise((r) => setTimeout(() => r({ ok: true, json: async () => ({ entities: [{ value: 'X', type: 'PERSON' }] }) }), 300));
  const det = { detection: { backend: 'endpoint', url: 'http://x/y', timeoutMs: 200 } };
  assert.deepEqual(await detectEntities('a reasonably long sentence to detect', det, { fetchImpl: slow }), []);
}

// --- disabled / too-short / no url -> [] (no network) ---
{
  clearDetectCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ entities: [] }) }; };
  assert.deepEqual(await detectEntities('hello there friend', { detection: { backend: 'off', url: 'http://x' } }, { fetchImpl }), []);
  assert.deepEqual(await detectEntities('hi', { detection: { backend: 'endpoint', url: 'http://x' } }, { fetchImpl }), []);
  assert.deepEqual(await detectEntities('long enough text here', { detection: { backend: 'endpoint', url: '' } }, { fetchImpl }), []);
  assert.equal(calls, 0, 'no detector call when disabled/short/urlless');
}

console.log('pii detect tests passed');
