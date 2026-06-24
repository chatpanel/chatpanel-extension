const RESERVED_BODY_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
  'system',
]);

const RESERVED_HEADER_FIELDS = new Set([
  'authorization',
  'content-type',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'x-api-key',
]);

export function parseJsonObject(text, label = 'JSON') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

export function sanitizeExtraBody(value = {}) {
  const clean = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (!key || RESERVED_BODY_FIELDS.has(key)) continue;
    clean[key] = entry;
  }
  return clean;
}

export function mergeExtraBody(baseBody = {}, extraBody = {}) {
  return {
    ...sanitizeExtraBody(extraBody),
    ...baseBody,
  };
}

export function sanitizeExtraHeaders(headers = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key || '').trim();
    if (!name || RESERVED_HEADER_FIELDS.has(name.toLowerCase())) continue;
    if (value == null || value === '') continue;
    clean[name] = String(value);
  }
  return clean;
}

export function prettyJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}
