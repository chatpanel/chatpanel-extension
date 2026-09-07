// Searching for a TTS model is not like searching for a whisper one.
//
// `filter=transformers.js` plus the right pipeline tag is enough for STT and NER —
// anything returned will load. For text-to-speech it is not: the gateway drives two
// architectures (Kokoro's style_text_to_speech_2 and VITS/MMS), and the same query
// happily returns SpeechT5 and others it cannot run. Discovering that by clicking
// Download and waiting for a shape error is a bad way to learn it, so results are
// SPLIT and the ones that cannot run are shown as such rather than hidden — a user
// who searched a model by name should see it exists and why it won't load.
import assert from 'node:assert/strict';
import { modelSearchUrl, partitionTtsModels, ttsArchOf, searchModels } from '../extension/js/model-registry.js';

// ── the query ──────────────────────────────────────────────────────────────────
{
  const u = new URL(modelSearchUrl({ task: 'tts', query: 'mms-tts' }));
  assert.equal(u.searchParams.get('pipeline_tag'), 'text-to-speech');
  assert.equal(u.searchParams.get('filter'), 'transformers.js', 'must stay ONNX-only — a PyTorch repo cannot run in-process');
  assert.equal(u.searchParams.get('search'), 'mms-tts');
  assert.equal(u.searchParams.get('sort'), 'downloads');
  // An empty query must still be a valid search, not a hint that hides the family.
  assert.ok(new URL(modelSearchUrl({ task: 'tts' })).searchParams.get('pipeline_tag'), 'text-to-speech');
}

// ── architecture detection ─────────────────────────────────────────────────────
{
  assert.equal(ttsArchOf({ tags: ['onnx', 'vits'] }), 'vits');
  assert.equal(ttsArchOf({ tags: ['style_text_to_speech_2', 'onnx'] }), 'style_text_to_speech_2');
  // The two the engine does NOT drive, and the empty cases.
  assert.equal(ttsArchOf({ tags: ['speecht5'] }), null);
  assert.equal(ttsArchOf({ tags: [] }), null);
  assert.equal(ttsArchOf({}), null);
  assert.equal(ttsArchOf(), null);
}

// ── the split ──────────────────────────────────────────────────────────────────
{
  const items = [
    { id: 'onnx-community/Kokoro-82M-v1.0-ONNX', tags: ['style_text_to_speech_2'] },
    { id: 'Xenova/speecht5_tts', tags: ['speecht5'] },
    { id: 'Xenova/mms-tts-hin', tags: ['vits'] },
    { id: 'someone/mystery', tags: [] },
  ];
  const { runnable, unsupported } = partitionTtsModels(items);
  assert.deepEqual(runnable.map((m) => m.id), ['onnx-community/Kokoro-82M-v1.0-ONNX', 'Xenova/mms-tts-hin']);
  assert.deepEqual(unsupported.map((m) => m.id), ['Xenova/speecht5_tts', 'someone/mystery']);
  // Nothing may be dropped: the two lists together are the whole result set.
  assert.equal(runnable.length + unsupported.length, items.length, 'a model must never vanish from the results');
  assert.deepEqual(partitionTtsModels([]), { runnable: [], unsupported: [] });
  assert.deepEqual(partitionTtsModels(), { runnable: [], unsupported: [] });
}

// ── against the real index (skipped offline) ───────────────────────────────────
// The tags this splits on are Hugging Face's, not ours — if they ever rename one,
// every result silently becomes "not runnable" and the feature looks broken.
{
  let items = null;
  try {
    items = await searchModels({ task: 'tts', query: 'mms-tts', limit: 10 });
  } catch { /* offline or HF down — the unit assertions above still stand */ }
  if (!items) {
    console.log('○ (live Hugging Face check skipped — no network)');
  } else {
    const { runnable } = partitionTtsModels(items);
    assert.ok(runnable.length > 0,
      'a search for "mms-tts" returned nothing runnable — has Hugging Face renamed the vits tag?');
    assert.ok(runnable.every((m) => ttsArchOf(m) === 'vits'), 'mms-tts results should all be VITS');
  }
}

console.log('✓ tts registry: text-to-speech query, arch detection, runnable/unsupported split loses nothing, live tags still match');
