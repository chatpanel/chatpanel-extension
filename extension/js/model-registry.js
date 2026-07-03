// Searchable model registry — browse Hugging Face for transformers.js-compatible
// models the gateway can download & run in-process, the same way the MCP tab
// browses the MCP registry. Two tasks:
//   'stt' → automatic-speech-recognition (whisper)   → gateway /stt/models
//   'ner' → token-classification (PER/ORG/LOC)        → gateway /ner/models
//
// We restrict to `filter=transformers.js`, which returns ONLY repos that ship
// ONNX weights the in-process engine can actually load (no PyTorch-only repos —
// e.g. it correctly EXCLUDES openai/whisper-base, which can't run here). Note:
// there are no dedicated ONNX Telugu/Indic whisper repos today, so the honest
// pick for those is the multilingual onnx-community/whisper-large-v3-turbo.
// Results carry id + downloads + likes so the user can judge quality; a Download
// button hands the id to the existing set*Model gateway endpoints (BYO, fetched
// from HF directly). Reusable by ChatPanel and any derivative app.

const HF_API = 'https://huggingface.co/api/models';

const TASK = {
  stt: { pipeline: 'automatic-speech-recognition', hint: 'whisper' },
  ner: { pipeline: 'token-classification', hint: '' },
};

// Build the HF search URL: filter=transformers.js guarantees ONNX/runnable.
export function modelSearchUrl({ task = 'stt', query = '', limit = 30 } = {}) {
  const t = TASK[task] || TASK.stt;
  const url = new URL(HF_API);
  url.searchParams.set('filter', 'transformers.js');
  url.searchParams.set('pipeline_tag', t.pipeline);
  const q = String(query || '').trim() || t.hint;
  if (q) url.searchParams.set('search', q);
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(Math.max(1, Math.min(Number(limit) || 30, 100))));
  return url.toString();
}

export async function searchModels(opts = {}, fetchImpl = fetch) {
  const res = await fetchImpl(modelSearchUrl(opts), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hugging Face HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  const list = await res.json();
  return (Array.isArray(list) ? list : []).map(normalizeModel).filter(Boolean);
}

export function normalizeModel(m = {}) {
  const id = m.id || m.modelId;
  if (!id || !id.includes('/')) return null;
  return {
    id,
    name: id.split('/').pop(),
    org: id.split('/')[0],
    downloads: Number(m.downloads) || 0,
    likes: Number(m.likes) || 0,
    updated: m.lastModified || m.createdAt || '',
    tags: Array.isArray(m.tags) ? m.tags : [],
    // Best-effort language hints from tags (helps pick e.g. a Telugu model).
    langs: (Array.isArray(m.tags) ? m.tags : []).filter((t) => /^[a-z]{2,3}$/.test(t)).slice(0, 6),
    url: `https://huggingface.co/${id}`,
  };
}

export function formatDownloads(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n || 0);
}
