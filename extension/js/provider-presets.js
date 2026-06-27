export const API_PROVIDER_PRESETS = [
  {
    id: 'custom',
    name: 'Custom / self-hosted',
    kind: 'openai',
    baseUrl: '',
    authMode: 'apiKey',
    custom: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    authMode: 'apiKey',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    authMode: 'apiKey',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/overview',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    authMode: 'openrouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    defaultHeaders: { 'HTTP-Referer': 'https://chatpanel.net' },
    note: 'ChatPanel adds HTTP-Referer so OpenRouter can attribute traffic. You can edit or remove it in Advanced request options.',
  },
  {
    id: 'huggingface-api-key',
    name: 'Hugging Face Router',
    kind: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    authMode: 'apiKey',
    keyUrl: 'https://huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/docs/inference-providers/en/index',
    note: 'Use API key with a fine-grained HF token that has Inference Providers permission, or switch Method to OAuth: Hugging Face and connect. A 401 HTML page usually means the wrong auth method or token.',
  },
  {
    id: 'gemini-api-key',
    name: 'Google AI Studio · Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authMode: 'apiKey',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authMode: 'apiKey',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    docsUrl: 'https://docs.nvidia.com/ai-workbench/user-guide/latest/how-to/integrations/nvidia-integrations.html#integration-endpoint',
    note: 'NVIDIA endpoint API keys may require phone verification.',
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/openai',
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    kind: 'openai',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    authMode: 'apiKey',
    signupUrl: 'https://vercel.com/signup',
    docsUrl: 'https://vercel.com/docs/ai-gateway',
    note: 'Use a Vercel AI Gateway API key. Model IDs are provider-prefixed, for example anthropic/claude-sonnet-4.6.',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    authMode: 'apiKey',
    signupUrl: 'https://opencode.ai/zen',
    docsUrl: 'https://opencode.ai/docs/zen/',
    note: 'ChatPanel uses the OpenAI-compatible chat completions path. Use OpenCode Zen model IDs such as opencode/deepseek-v4-flash-free.',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    kind: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    authMode: 'apiKey',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
  },
  {
    id: 'mistral',
    name: 'Mistral · La Plateforme',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api',
  },
  {
    id: 'mistral-codestral',
    name: 'Mistral · Codestral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api',
    note: 'Codestral model IDs are available through the regular Mistral API.',
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    docsUrl: 'https://docs.x.ai/docs/api-reference',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    kind: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    authMode: 'apiKey',
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://deepinfra.com/docs/openai_api',
    note: 'Model listing may work without proving chat auth. If chat returns “Missing captcha token”, add a DeepInfra API key and click Test.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authMode: 'apiKey',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    docsUrl: 'https://docs.fireworks.ai/api-reference/introduction',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai/resources/openai',
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    kind: 'openai',
    baseUrl: 'https://models.github.ai/inference',
    authMode: 'apiKey',
    keyUrl: 'https://github.com/settings/personal-access-tokens',
    docsUrl: 'https://docs.github.com/en/rest/models/inference',
    defaultHeaders: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    note: 'Use a GitHub token with models:read. Model listing may differ from generic OpenAI-compatible /models endpoints.',
  },
  {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    kind: 'openai',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    authMode: 'apiKey',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
    note: 'Replace {account_id} in Base URL with your Cloudflare account ID.',
  },
  {
    id: 'ollama',
    name: 'Local · Ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    authMode: 'apiKey',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },
  {
    id: 'lmstudio',
    name: 'Local · LM Studio',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    authMode: 'apiKey',
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
  },
  {
    id: 'llamacpp',
    name: 'Local · llama.cpp',
    kind: 'openai',
    baseUrl: 'http://localhost:8080/v1',
    authMode: 'apiKey',
    docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
  },
  {
    id: 'vllm',
    name: 'Local · vLLM',
    kind: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    authMode: 'apiKey',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
  },
];

const LOCAL_PROVIDER_PRESET_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);

// Monogram "logos" for the provider picker and the site: a brand-tinted rounded
// square + a 1–2 letter mark. We use monograms (not official trademarked logos)
// so nothing brand-owned is bundled, while each provider still gets a
// recognizable color + initial.
const PROVIDER_BRANDS = {
  custom: { mark: '+', color: '#64748b' },
  openai: { mark: 'AI', color: '#10a37f' },
  anthropic: { mark: 'A', color: '#d97757' },
  openrouter: { mark: 'OR', color: '#6467f2' },
  'huggingface-api-key': { mark: 'HF', color: '#ff9d00' },
  'gemini-api-key': { mark: 'G', color: '#1a73e8' },
  nvidia: { mark: 'N', color: '#76b900' },
  groq: { mark: 'GQ', color: '#f55036' },
  'vercel-ai-gateway': { mark: '▲', color: '#111317' },
  'opencode-zen': { mark: 'Z', color: '#3b82f6' },
  cohere: { mark: 'C', color: '#ff7759' },
  together: { mark: 'T', color: '#0f6fff' },
  mistral: { mark: 'M', color: '#fa520f' },
  'mistral-codestral': { mark: 'MC', color: '#fa520f' },
  xai: { mark: 'X', color: '#111317' },
  deepinfra: { mark: 'DI', color: '#4f46e5' },
  fireworks: { mark: 'F', color: '#5019c5' },
  cerebras: { mark: 'CB', color: '#ff6b35' },
  'github-models': { mark: 'GH', color: '#2b3137' },
  'cloudflare-workers-ai': { mark: 'CF', color: '#f6821f' },
  ollama: { mark: 'OL', color: '#0b0d12' },
  lmstudio: { mark: 'LM', color: '#2563eb' },
  llamacpp: { mark: 'LC', color: '#6b7280' },
  vllm: { mark: 'VL', color: '#0ea5e9' },
};

// Preset ids that ship a bundled brand SVG under assets/providers/<id>.svg.
// Logos are full-color official marks (gilbarbara/logos — CC0, and svgl /
// simple-icons); trademarks remain their owners' and are shown nominatively.
// The rest fall back to the colored monogram above.
const PROVIDER_LOGO_IDS = new Set([
  'openai', 'anthropic', 'huggingface-api-key', 'gemini-api-key', 'nvidia',
  'vercel-ai-gateway', 'mistral', 'mistral-codestral', 'xai', 'github-models',
  'cloudflare-workers-ai', 'openrouter', 'groq', 'cohere', 'cerebras', 'ollama',
]);

// Brand icon for a preset id: { mark, color, logo }. `logo` is a bundled SVG
// path when we have the official mark, else null (render the monogram).
export function providerBrand(id) {
  const base = PROVIDER_BRANDS[id] || {
    mark: String(id || '?').replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?',
    color: '#64748b',
  };
  return { ...base, logo: PROVIDER_LOGO_IDS.has(id) ? `assets/providers/${id}.svg` : null };
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function orderedProviderPresets() {
  const custom = API_PROVIDER_PRESETS.filter((preset) => preset.custom);
  const local = API_PROVIDER_PRESETS.filter((preset) => LOCAL_PROVIDER_PRESET_IDS.has(preset.id));
  const hosted = API_PROVIDER_PRESETS
    .filter((preset) => !preset.custom && !LOCAL_PROVIDER_PRESET_IDS.has(preset.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...custom, ...hosted, ...local];
}

export function providerPresetById(id) {
  return API_PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

export function providerPresetForEndpoint(endpoint = {}) {
  if (endpoint.providerPreset) {
    const explicit = providerPresetById(endpoint.providerPreset);
    if (explicit && !explicit.custom) return explicit;
  }
  const base = cleanBaseUrl(endpoint.baseUrl);
  if (!base) return null;
  return API_PROVIDER_PRESETS.find((preset) => (
    !preset.custom &&
    cleanBaseUrl(preset.baseUrl) === base &&
    (!endpoint.kind || preset.kind === endpoint.kind)
  )) || null;
}

export function applyProviderPreset(endpoint = {}) {
  const preset = providerPresetById(endpoint.providerPreset);
  if (!preset || preset.custom) {
    return { ...endpoint, providerPreset: 'custom' };
  }
  return {
    ...endpoint,
    providerPreset: preset.id,
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    authMode: preset.authMode,
    headers: {
      ...(preset.defaultHeaders || {}),
      ...(endpoint.headers || {}),
    },
  };
}
