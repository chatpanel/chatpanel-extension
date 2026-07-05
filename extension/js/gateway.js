// Client for the ChatPanel Privacy Gateway's localhost config API. The gateway is
// a separate local process that owns its own settings; the "Gateway" tab is just a
// UI over these endpoints (GET/POST /config, GET /status). See chatpanel-gateway.

const TIMEOUT_MS = 4000;

// Admin token for the gateway's guarded routes (GET /config, /logs). The gateway
// normally trusts the extension by its chrome-extension:// Origin, but Chrome omits
// Origin on GET requests to a host the extension has permission for — so config READS
// need the token. Set from Settings (settings.gatewayToken) or the auto-handshake.
let ADMIN_TOKEN = '';
export function setGatewayToken(token) { ADMIN_TOKEN = String(token || '').trim(); }
export function getGatewayToken() { return ADMIN_TOKEN; }

export function normalizeGatewayUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

async function jfetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Attach the admin token when set — harmless on open routes, required on GET /config.
    const headers = ADMIN_TOKEN ? { ...(opts.headers || {}), Authorization: `Bearer ${ADMIN_TOKEN}` } : opts.headers;
    const res = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(json?.error?.message || json?.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Liveness + monitoring. Returns { ok, version, backend, tier, ner, pro, usage,
// uptimeSeconds } or { ok:false, error }.
export async function checkGateway(baseUrl) {
  const base = normalizeGatewayUrl(baseUrl);
  if (!base) return { ok: false, error: 'no gateway URL' };
  try {
    const s = await jfetch(`${base}/status`);
    return { ok: true, ...s };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Auto-handshake: fetch the gateway's admin token via a POST. POSTs DO carry the
// chrome-extension:// Origin (unlike GETs to a permitted host), so the gateway can
// authorize us by Origin and hand back the token we then use on GET admin routes. No-op
// against an older gateway with no /admin/token — falls back to any manual token. Returns
// true if a token is set afterward.
export async function handshakeGatewayToken(baseUrl) {
  const base = normalizeGatewayUrl(baseUrl);
  if (!base) return false;
  try {
    const r = await jfetch(`${base}/admin/token`, { method: 'POST' });
    if (r?.token) { setGatewayToken(r.token); return true; }
  } catch { /* old gateway, or not authorized — keep any manually-entered token */ }
  return !!ADMIN_TOKEN;
}

export async function getGatewayConfig(baseUrl) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/config`);
}

// NER model manager. List returns { active, state, progress, available:[{id,label,
// lang,approxMB,note,installed}] }. Switching downloads the model if needed (the
// gateway returns 202 and downloads in the background — poll the list for progress).
export async function getNerModels(baseUrl) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/ner/models`);
}

export async function setNerModel(baseUrl, id) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/ner/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

// STT (dictation) model manager — mirrors the NER one. List returns { active,
// state, progress, available:[{id,label,lang,tier,approxMB,ramMB,note,installed}] }.
// Switching downloads the model if needed (202 + background download; poll the
// list for progress). Custom (non-catalog) whisper ids are accepted too.
export async function getSttModels(baseUrl) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/stt/models`);
}

export async function setSttModel(baseUrl, id, dtype) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/stt/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dtype ? { id, dtype } : { id }),
  });
}

// Speaker (diarization) model — the "who said what" model for meeting
// transcription. GET → { active, state, progress, available:[{id,label,approxMB,
// installed}] }; POST force-downloads it (explicit user action).
export async function getDiarizeModel(baseUrl) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/diarize/model`);
}
export async function downloadDiarizeModel(baseUrl) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/diarize/model`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
}

// Recent request summaries (counts only, no values) for the monitoring view.
export async function getGatewayLogs(baseUrl) {
  try { return (await jfetch(`${normalizeGatewayUrl(baseUrl)}/logs`))?.entries || []; }
  catch { return []; }
}

export async function setGatewayConfig(baseUrl, patch) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
}

// Parse the dictionary textarea (same syntax as the Privacy tab) into the
// gateway's dictionary shape: { value|pattern, type, alias? }.
//   John => PERSON          reversible redaction to [[PERSON_n]]
//   Acme Corp -> Globex     permanent pseudonym (alias)
//   /EMP-\d+/ => TICKET     regex → reversible
//   John                    bare term → TERM
export function parseDictionary(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const alias = line.match(/^(.*?)\s*->\s*(.+)$/);
    const label = line.match(/^(.*?)\s*=>\s*(.+)$/);
    if (alias) {
      out.push({ value: alias[1].trim(), alias: alias[2].trim() });
    } else if (label) {
      const left = label[1].trim();
      const rx = left.match(/^\/(.*)\/([a-z]*)$/i);
      if (rx) out.push({ pattern: rx[1], flags: rx[2] || '', type: label[2].trim() });
      else out.push({ value: left, type: label[2].trim() });
    } else {
      out.push({ value: line, type: 'TERM' });
    }
  }
  return out;
}

// Inverse — render the gateway dictionary back into editable lines.
export function stringifyDictionary(dict) {
  return (Array.isArray(dict) ? dict : []).map((d) => {
    if (d.alias != null && d.alias !== '') return `${d.value} -> ${d.alias}`;
    if (d.pattern) return `/${d.pattern}/${d.flags || ''} => ${d.type || 'PII'}`;
    return `${d.value} => ${d.type || 'TERM'}`;
  }).join('\n');
}
