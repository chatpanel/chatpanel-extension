export function parseMcpConfig(text) {
  const src = String(text || '').trim();
  if (!src) return [];
  const json = parseJson(src);
  if (json) return parseJsonConfig(json);
  return parseTomlConfig(src);
}

export function parseArgsInput(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) return parseArray(text);
  return splitArgs(text).map((a) => a.replace(/,+$/, '')).filter(Boolean);
}

export function argsToText(args) {
  if (Array.isArray(args)) return args.join('\n');
  return String(args || '');
}

function parseJson(src) {
  try {
    return JSON.parse(src);
  } catch {
    return null;
  }
}

function parseJsonConfig(obj) {
  const root = obj?.mcpServers || obj?.mcp_servers || obj?.servers || obj;
  if (!root || typeof root !== 'object') return [];
  if (root.command || root.url) return [normalizeServer('Imported MCP server', root)];
  return Object.entries(root)
    .map(([name, cfg]) => normalizeServer(name, cfg))
    .filter(Boolean);
}

function parseTomlConfig(src) {
  const sections = [];
  const re = /^\s*\[(mcp_servers|mcpServers)\.([^\]]+)\]\s*$/gm;
  let m;
  while ((m = re.exec(src))) sections.push({ name: m[2].trim().replace(/^["']|["']$/g, ''), start: re.lastIndex });
  return sections
    .map((section, i) => {
      const end = sections[i + 1]?.start ? src.lastIndexOf('\n', sections[i + 1].start - sections[i + 1].name.length - 15) : src.length;
      const block = src.slice(section.start, end < section.start ? src.length : end);
      return normalizeServer(section.name, parseTomlBlock(block));
    })
    .filter(Boolean);
}

function parseTomlBlock(block) {
  const cfg = {};
  for (const key of ['type', 'transport', 'command', 'url']) {
    const raw = tomlValue(block, key);
    if (raw != null) cfg[key] = parseScalar(raw);
  }
  const args = tomlValue(block, 'args');
  if (args != null) cfg.args = parseArray(args);
  const env = tomlValue(block, 'env') ?? tomlValue(block, 'environment') ?? tomlValue(block, 'environmentVariables');
  if (env != null) cfg.env = parseInlineTable(env);
  const headers = tomlValue(block, 'headers');
  if (headers != null) cfg.headers = parseInlineTable(headers);
  const auth = tomlValue(block, 'authorization') ?? tomlValue(block, 'auth_header');
  if (auth != null) cfg.headers = { ...(cfg.headers || {}), Authorization: parseScalar(auth) };
  return cfg;
}

function normalizeServer(name, cfg = {}) {
  if (!cfg || typeof cfg !== 'object') return null;
  const command = str(cfg.command);
  const url = str(cfg.url);
  const transport = String(cfg.type || cfg.transport || (command ? 'stdio' : 'http')).toLowerCase();
  const base = {
    name: humanName(name),
    enabled: cfg.enabled !== false,
  };
  if (command || transport === 'stdio') {
    if (!command) return null;
    return {
      ...base,
      transport: 'stdio',
      command,
      args: parseArgsInput(cfg.args),
      env: plainObject(cfg.env || cfg.environment || cfg.environmentVariables),
    };
  }
  if (!url) return null;
  return {
    ...base,
    transport: 'http',
    url,
    headers: plainObject(cfg.headers),
  };
}

function tomlValue(block, key) {
  const lines = String(block || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`).exec(lines[i]);
    if (!m) continue;
    let raw = stripComment(m[1]).trim();
    if (!raw) return '';
    const open = raw[0];
    const close = open === '[' ? ']' : open === '{' ? '}' : '';
    if (!close) return raw;
    let depth = bracketDepth(raw, open, close);
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      raw += `\n${stripComment(lines[i])}`;
      depth = bracketDepth(raw, open, close);
    }
    return raw.trim();
  }
  return null;
}

function parseArray(raw) {
  const text = String(raw || '').trim();
  const body = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const out = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (i >= body.length) break;
    const q = body[i];
    if (q === '"' || q === "'") {
      const parsed = readQuoted(body, i);
      out.push(parsed.value);
      i = parsed.next;
      continue;
    }
    let j = i;
    while (j < body.length && body[j] !== ',') j += 1;
    const value = body.slice(i, j).trim();
    if (value) out.push(value);
    i = j + 1;
  }
  return out;
}

function parseInlineTable(raw) {
  const text = String(raw || '').trim();
  const body = text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;
  const out = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (i >= body.length) break;
    let key = '';
    if (body[i] === '"' || body[i] === "'") {
      const parsed = readQuoted(body, i);
      key = parsed.value;
      i = parsed.next;
    } else {
      let j = i;
      while (j < body.length && body[j] !== '=' && body[j] !== ':') j += 1;
      key = body.slice(i, j).trim();
      i = j;
    }
    while (i < body.length && /[\s=:]/.test(body[i])) i += 1;
    if (!key) break;
    if (body[i] === '"' || body[i] === "'") {
      const parsed = readQuoted(body, i);
      out[key] = parsed.value;
      i = parsed.next;
    } else {
      let j = i;
      while (j < body.length && body[j] !== ',') j += 1;
      out[key] = parseScalar(body.slice(i, j).trim());
      i = j + 1;
    }
  }
  return out;
}

function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let esc = false;
  for (const ch of String(text || '')) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function readQuoted(s, start) {
  const quote = s[start];
  let value = '';
  let esc = false;
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      value += quote === '"' ? unescapeChar(ch) : ch;
      esc = false;
      continue;
    }
    if (ch === '\\' && quote === '"') { esc = true; continue; }
    if (ch === quote) return { value, next: i + 1 };
    value += ch;
  }
  return { value, next: s.length };
}

function parseScalar(raw) {
  const s = String(raw || '').trim().replace(/,+$/, '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return readQuoted(s, 0).value;
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
}

function humanName(name) {
  return String(name || 'MCP server').replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = '';
      if (ch === '\\' && quote === '"') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function bracketDepth(s, open, close) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
  }
  return depth;
}

function unescapeChar(ch) {
  return ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[ch] ?? ch;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
