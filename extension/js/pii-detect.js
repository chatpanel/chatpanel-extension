// Phase 2: configurable, LOCAL entity detection.
//
// Produces [{value, type}] spans that feed the redaction engine, so names / orgs /
// IDs get redacted WITHOUT a hand-maintained dictionary. Detection runs on-device
// only — the detector is a local NER service (spaCy / Presidio / any HTTP service)
// or a local LLM (OpenAI-compatible, e.g. a gemma served by llama.cpp). Raw text
// reaches the detector but never the final agent; only the redacted text does.
//
// Performance / flexibility (the whole point):
//   - backends are pluggable and user-configured (URL + model + timeout).
//   - a content-hash cache avoids re-detecting unchanged text.
//   - a per-call timeout + fail-open means a slow/broken detector NEVER blocks the
//     chat — redaction silently falls back to the deterministic layer.
//   - input is length-capped so a huge transcript can't stall detection.

const cache = new Map(); // key -> [{value,type}]
const CACHE_MAX = 300;

export function clearDetectCache() { cache.clear(); }

function cacheKey(text, det) {
  let h = 5381;
  const s = `${det?.backend}|${det?.url}|${det?.model}|${text}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

export function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('detect timeout')), Math.max(200, ms || 1500));
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true });
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Map common NER labels (spaCy, HF, Presidio) onto our placeholder types.
function normType(t) {
  const s = String(t || 'ENTITY').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ENTITY';
  const map = {
    PER: 'PERSON', PERSON: 'PERSON', PERSONNAME: 'PERSON',
    ORG: 'ORG', ORGANIZATION: 'ORG',
    GPE: 'LOCATION', LOC: 'LOCATION', LOCATION: 'LOCATION',
    NORP: 'GROUP', EMAIL: 'EMAIL', EMAILADDRESS: 'EMAIL',
    PHONE: 'PHONE', PHONENUMBER: 'PHONE',
  };
  return map[s] || s;
}

// Identifiers we ALWAYS redact (also caught deterministically). The user-facing
// category toggles (person/org/location/number) control the rest, so geography
// questions still work if "location" is turned off, etc. Numeric/temporal labels
// (DATE, CARDINAL, ORDINAL…) are noisy — small NER models tag "today" / "4" — so
// they only count when the value is a long digit run (phone/account/ID).
const ALWAYS_KEEP = new Set(['EMAIL', 'PHONE', 'SSN', 'CREDITCARD', 'IBAN', 'ID']);
const LOCATION_TYPES = new Set(['LOCATION', 'FAC', 'ADDRESS', 'GROUP', 'NRP']);

function keepEntity(value, type, types) {
  const on = (k) => !types || types[k] !== false; // default on
  if (ALWAYS_KEEP.has(type)) return true;
  if (type === 'PERSON') return on('person');
  if (type === 'ORG') return on('org');
  if (LOCATION_TYPES.has(type)) return on('location');
  const digits = (String(value).match(/\d/g) || []).length;
  return digits >= 7 ? on('number') : false;
}

// Normalize the many detector response shapes to [{value, type}], de-duplicated.
// `types` (optional) is the user's category toggles {person,org,location,number}.
export function normalizeEntities(data, types) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.entities)) list = data.entities;
  else if (data && Array.isArray(data.ents)) list = data.ents; // spaCy displacy
  else if (data && Array.isArray(data.results)) list = data.results; // Presidio
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e) continue;
    const value = String(e.value ?? e.text ?? e.entity ?? e.word ?? '').trim();
    const type = normType(e.type ?? e.label ?? e.entity_group ?? e.entity_type ?? e.tag);
    if (!value || value.length > 200 || !keepEntity(value, type, types)) continue;
    const k = `${type}:${value.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ value, type });
  }
  return out;
}

export function parseJsonLoose(s) {
  if (!s) return null;
  const a = String(s).indexOf('{');
  const b = String(s).lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(String(s).slice(a, b + 1)); } catch { return null; }
}

export const EXTRACT_SYS = 'You extract sensitive entities from text for redaction. '
  + 'Return ONLY JSON: {"entities":[{"value":"<verbatim text>","type":"PERSON|ORG|LOCATION|ID|EMAIL|PHONE|OTHER"}]}. '
  + 'Copy each value exactly as it appears. Include people, organizations, locations, and account/ID numbers. No commentary, no code fences.';

async function detectViaEndpoint(text, det, signal, fetchImpl) {
  const res = await fetchImpl(det.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(det.apiKey ? { Authorization: `Bearer ${det.apiKey}` } : {}) },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`detect HTTP ${res.status}`);
  return normalizeEntities(await res.json(), det.types);
}

async function detectViaOpenAI(text, det, signal, fetchImpl) {
  const base = String(det.url || '').replace(/\/$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(det.apiKey ? { Authorization: `Bearer ${det.apiKey}` } : {}) },
    body: JSON.stringify({
      model: det.model || 'local',
      temperature: 0,
      max_tokens: det.maxTokens || 256,
      messages: [{ role: 'system', content: EXTRACT_SYS }, { role: 'user', content: text }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`detect HTTP ${res.status}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? json?.content ?? '';
  return normalizeEntities(parseJsonLoose(content), det.types);
}

// Returns [{value, type}] spans for `text`, or [] (fail-open) on any error/timeout.
export async function detectEntities(text, cfg, { signal, fetchImpl = globalThis.fetch, strict = false } = {}) {
  const det = cfg?.detection;
  if (!det || !det.backend || det.backend === 'off' || !det.url || typeof fetchImpl !== 'function') return [];
  const capped = String(text || '').slice(0, det.maxChars || 8000);
  if (capped.trim().length < 8) return [];
  const key = cacheKey(capped, det);
  if (!strict && cache.has(key)) return cache.get(key);
  const run = det.backend === 'endpoint' ? detectViaEndpoint : detectViaOpenAI;
  let ents = [];
  try {
    ents = await withTimeout(run(capped, det, signal, fetchImpl), det.timeoutMs || 1500, signal);
  } catch (e) {
    if (strict) throw e; // surface errors to the Test button
    ents = []; // otherwise fail open — deterministic redaction still applies
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  if (!strict) cache.set(key, ents);
  return ents;
}
