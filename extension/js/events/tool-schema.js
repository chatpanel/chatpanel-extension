// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-schema.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Schema compression — a tool's contract, with the prose it does not need for the model to
// call it correctly taken out.
//
// A connected server's tools arrive as full JSON schemas: a paragraph of description per
// tool, a sentence per parameter, `title`s, `examples`, `$schema` and `$comment`. All of
// it is re-sent on every turn the tool is armed, whether it is called or not. What the
// model actually needs to make a correct call is small and structural — the names, the
// types, which fields are required, the enum values, the bounds and defaults — plus enough
// description to choose the tool and to disambiguate a parameter whose name does not say
// what it holds.
//
// So `balanced` (the default) keeps everything structural, caps the tool description at a
// sentence or two, and keeps a parameter's description only when it adds something the
// name and type do not already say — `cursor: "opaque token from the previous page"` stays;
// `issue_number: "The number of the issue"` goes. `aggressive` keeps parameter descriptions
// only for the handful of names that are ambiguous everywhere (`ref`, `mode`, `sort`).
// `off` is the schema as the server sent it.
//
// Pure and shared: the extension applies it as tools arrive from a server, the gateway
// as tools pass through its relay, and the stats function makes the saving a number a
// person can see rather than a claim.

export const COMPRESSION_MODES = Object.freeze(['off', 'balanced', 'aggressive']);

export const DEFAULT_COMPRESSION = Object.freeze({
  mode: 'balanced',
  maxDescriptionChars: 200,
  maxParamDescriptionChars: 100,
});

// Names that mean something different on every server, so their description always earns
// its place — a `ref` is a git ref here and a result ref there.
const AMBIGUOUS = new Set([
  'ref', 'mode', 'sort', 'order', 'direction', 'format', 'type', 'kind', 'state', 'status',
  'cursor', 'after', 'before', 'anchor', 'sha', 'q', 'query', 'filter', 'scope', 'target',
  'id', 'key', 'path', 'name', 'value', 'data', 'body', 'input', 'output', 'options',
]);

// Dropped outright: nothing a model needs to form a call.
const DROP_KEYS = new Set(['$schema', '$comment', 'title', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly', '$id', 'contentMediaType', 'contentEncoding']);

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Cut at a sentence end when one falls comfortably inside the budget; else at a word. */
export function trimDescription(text, max) {
  const s = collapse(text);
  if (!max || s.length <= max) return s;
  const head = s.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= max * 0.4) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  return `${(word > max * 0.6 ? head.slice(0, word) : head).trimEnd()}…`;
}

const words = (s) => new Set(collapse(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Does a parameter description say anything its name and type do not? */
const FILLER = new Set([
  'the', 'this', 'that', 'for', 'and', 'with', 'optional', 'required', 'string', 'number', 'integer',
  'boolean', 'array', 'object', 'value', 'values', 'field', 'parameter', 'param', 'name', 'identifier',
  'text', 'list', 'given', 'specified', 'target', 'item', 'items', 'new', 'existing', 'which', 'whose',
  'will', 'should', 'must', 'can', 'may', 'used', 'use', 'set', 'get', 'input', 'output',
]);

function informative(name, desc, node) {
  const d = words(desc);
  const own = [...words(name.replace(/([a-z])([A-Z])/g, '$1 $2'))];
  for (const w of [...d]) {
    if (FILLER.has(w)) { d.delete(w); continue; }
    // `repo` covers "repository", `issue_number` covers "issues": a shared stem is the name.
    if (own.some((n) => n.length >= 3 && (w.startsWith(n) || n.startsWith(w)))) d.delete(w);
  }
  if (node && typeof node.type === 'string') d.delete(node.type);
  return d.size >= 2;
}

function compressNode(node, o, { name = '', depth = 0 } = {}) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => compressNode(n, o, { depth: depth + 1 }));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'description') {
      if (depth === 0) { out[k] = trimDescription(v, o.maxDescriptionChars); continue; }
      const keep = o.mode === 'aggressive'
        ? AMBIGUOUS.has(name.toLowerCase())
        : (AMBIGUOUS.has(name.toLowerCase()) || informative(name, v, node));
      if (keep) {
        const t = trimDescription(v, o.maxParamDescriptionChars);
        if (t) out[k] = t;
      }
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {};
      for (const [pn, pv] of Object.entries(v)) props[pn] = compressNode(pv, o, { name: pn, depth: depth + 1 });
      out[k] = props;
      continue;
    }
    if ((k === 'items' || k === 'additionalProperties' || k === 'not') && v && typeof v === 'object') {
      out[k] = compressNode(v, o, { name, depth: depth + 1 });
      continue;
    }
    if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) {
      out[k] = v.map((n) => compressNode(n, o, { name, depth: depth + 1 }));
      continue;
    }
    if (k === '$defs' || k === 'definitions') {
      const defs = {};
      for (const [dn, dv] of Object.entries(v || {})) defs[dn] = compressNode(dv, o, { name: dn, depth: depth + 1 });
      out[k] = defs;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Compress one spec. Works on the extension shape (`parameters`) and the MCP shape
 * (`inputSchema`); everything else on the spec (name, annotations, …) is kept as-is.
 */
export function compressToolSpec(spec, opts = {}) {
  const o = { ...DEFAULT_COMPRESSION, ...opts };
  if (!spec || o.mode === 'off' || !COMPRESSION_MODES.includes(o.mode)) return spec;
  const out = { ...spec };
  if (typeof spec.description === 'string') {
    const d = trimDescription(spec.description, o.maxDescriptionChars);
    if (d) out.description = d; else delete out.description;
  }
  for (const k of ['parameters', 'inputSchema']) {
    if (spec[k] && typeof spec[k] === 'object') out[k] = compressNode(spec[k], o, { depth: 1 });
  }
  return out;
}

export function compressToolSpecs(specs, opts) {
  return (specs || []).map((s) => compressToolSpec(s, opts));
}

/** The saving, as a number: bytes of JSON before and after, per tool and in total. */
export function compressionStats(specs, opts = {}) {
  const list = specs || [];
  const size = (v) => JSON.stringify(v ?? null).length;
  let before = 0;
  let after = 0;
  const tools = [];
  for (const s of list) {
    const b = size(s);
    const a = size(compressToolSpec(s, opts));
    before += b; after += a;
    tools.push({ name: s?.name, before: b, after: a });
  }
  return { mode: opts.mode || DEFAULT_COMPRESSION.mode, tools: list.length, before, after, saved: before - after, savedPercent: before ? Math.round(((before - after) / before) * 100) : 0, perTool: tools };
}
