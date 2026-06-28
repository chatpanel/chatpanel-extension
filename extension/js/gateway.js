// Client for the ChatPanel Privacy Gateway's localhost config API. The gateway is
// a separate local process that owns its own settings; the "Gateway" tab is just a
// UI over these endpoints (GET/POST /config, GET /status). See chatpanel-gateway.

const TIMEOUT_MS = 4000;

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
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
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

export async function getGatewayConfig(baseUrl) {
  return jfetch(`${normalizeGatewayUrl(baseUrl)}/config`);
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
