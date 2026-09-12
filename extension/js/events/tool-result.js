// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-result.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The response shield — a tool result too big to read is stored, previewed and paged,
// instead of being poured into the model's context whole.
//
// Every tool result used to go to the model in full. The only cap anywhere was the
// 4,000-character slice the ACTIVITY LOG shows a person — the model got everything. One
// `search_issues` returning three hundred kilobytes of JSON therefore cost the whole turn:
// the request blew the context window, or it fit and every later turn re-read it.
//
// What is borrowed here is not truncation, which is easy, but the shape of the truncated
// reply: it TEACHES the model how to get the rest. A preview goes back, plus what the
// full result looks like (an array of 240 objects with these keys; 128,400 characters of
// text) and a ready-to-send `get_result` call that pages, filters or projects the stored
// copy. A cut with nothing after it is a result the model cannot recover from; a cut with
// a retrieval note is one more tool call away from whatever it needed.
//
// Shared because the extension, the desktop and the gateway each feed tool results to a
// model, and three limits would be three different answers to "what did the model see".
// Pure: no storage binding, no clock, no id generator of its own — the host injects
// `now`/`newId` (matching loop.js) and keeps the store wherever it keeps its turn state.

export const RESULT_TOOL_NAME = 'get_result';

export const DEFAULT_SHIELD = Object.freeze({
  // Characters of result text a model receives before the shield engages. Above the
  // page-read default (40,000) on purpose: a page the user asked to summarise must arrive
  // whole, and the shield is for the results nobody asked to be that large.
  maxChars: 48_000,
  maxArrayItems: 50,
  maxStringChars: 4_000,
  maxKeys: 60,
  maxDepth: 8,
});

export const DEFAULT_STORE = Object.freeze({
  maxEntries: 100,
  // Bytes across all stored results; oldest evicted first. A handful of very large
  // results must not grow memory without bound.
  maxBytes: 64 * 1024 * 1024,
});

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;
const TEXT_LIMIT_DEFAULT = 8_000;
const TEXT_LIMIT_MAX = 32_000;
const SEARCH_MATCHES_MAX = 20;
const SEARCH_WINDOW = 160;

const defaultId = () => `r_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function byteLength(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s == null ? 0 : s.length;
}

/** Strict JSON, but only a container counts — a bare number or string is not "structured". */
function parseStructured(text) {
  const t = String(text || '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The store: full results, keyed by ref, owned by whoever produced them.
 *
 * `owner` scopes retrieval — a gateway serving several sessions must not let one page
 * another's results. `undefined` means unowned (a single-user client) and is readable
 * by anyone; a store that receives owners must be asked with owners.
 */
export function createResultStore({ maxEntries = DEFAULT_STORE.maxEntries, maxBytes = DEFAULT_STORE.maxBytes, now = () => Date.now(), newId = defaultId } = {}) {
  const entries = new Map(); // ref -> { ref, tool, owner, createdAt, bytes, value }
  let bytes = 0;

  const drop = (ref) => {
    const e = entries.get(ref);
    if (!e) return false;
    entries.delete(ref);
    bytes -= e.bytes;
    return true;
  };
  const evict = () => {
    while (entries.size && (entries.size > maxEntries || bytes > maxBytes)) {
      drop(entries.keys().next().value);
    }
  };

  return {
    put({ tool = '', value, owner } = {}) {
      let ref = newId();
      while (entries.has(ref)) ref = newId();
      const e = { ref, tool: String(tool || ''), owner, createdAt: now(), bytes: byteLength(value), value };
      entries.set(ref, e);
      bytes += e.bytes;
      evict();
      return ref;
    },
    get(ref, owner) {
      const e = entries.get(String(ref || ''));
      if (!e) return null;
      if (e.owner !== undefined && e.owner !== owner) return null;
      return e;
    },
    drop,
    clear() { entries.clear(); bytes = 0; },
    get size() { return entries.size; },
    get bytes() { return bytes; },
  };
}

// ── shape ────────────────────────────────────────────────────────────────────────────

/**
 * What a stored value LOOKS like, in a sentence's worth of facts — enough for the model to
 * choose between paging, searching, projecting and descending without seeing it all.
 */
export function describeShape(value, { maxKeys = 20, maxPaths = 8 } = {}) {
  if (typeof value === 'string') return { kind: 'text', chars: value.length };
  if (Array.isArray(value)) {
    const keys = new Set();
    let objects = 0;
    for (const item of value.slice(0, 50)) {
      if (!isRecord(item)) continue;
      objects += 1;
      for (const k of Object.keys(item)) keys.add(k);
    }
    const itemKind = objects === Math.min(value.length, 50) && value.length ? 'object' : value.length ? typeof value[0] : 'empty';
    return { kind: 'array', items: value.length, itemKind, keys: [...keys].slice(0, maxKeys), moreKeys: Math.max(0, keys.size - maxKeys) };
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const arrays = [];
    const walk = (v, path, depth) => {
      if (arrays.length >= maxPaths || depth > 3) return;
      if (Array.isArray(v)) { arrays.push({ path, items: v.length }); return; }
      if (!isRecord(v)) return;
      for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, depth + 1);
    };
    walk(value, '', 0);
    return { kind: 'object', keys: keys.slice(0, maxKeys), moreKeys: Math.max(0, keys.length - maxKeys), arrays };
  }
  return { kind: typeof value };
}

function shapeSentence(shape) {
  if (!shape) return '';
  if (shape.kind === 'text') return `${shape.chars.toLocaleString('en-US')} characters of text`;
  if (shape.kind === 'array') {
    const keys = shape.keys?.length ? ` with keys ${shape.keys.join(', ')}${shape.moreKeys ? ` (+${shape.moreKeys} more)` : ''}` : '';
    return `an array of ${shape.items} ${shape.itemKind === 'object' ? 'objects' : 'items'}${keys}`;
  }
  if (shape.kind === 'object') {
    const keys = shape.keys?.length ? `keys ${shape.keys.join(', ')}${shape.moreKeys ? ` (+${shape.moreKeys} more)` : ''}` : 'no keys';
    const arrays = shape.arrays?.length ? `; arrays at ${shape.arrays.map((a) => `${a.path} (${a.items})`).join(', ')}` : '';
    return `an object with ${keys}${arrays}`;
  }
  return `a ${shape.kind}`;
}

// ── compaction ───────────────────────────────────────────────────────────────────────

/** A structurally-faithful preview: same nesting, fewer items, shorter strings. */
export function compactValue(value, opts = {}) {
  const o = { ...DEFAULT_SHIELD, ...opts };
  let truncated = false;
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      if (v.length <= o.maxStringChars) return v;
      truncated = true;
      return `${v.slice(0, o.maxStringChars)}…[+${v.length - o.maxStringChars} chars]`;
    }
    if (Array.isArray(v)) {
      if (depth >= o.maxDepth) { truncated = true; return `[array of ${v.length}]`; }
      const head = v.slice(0, o.maxArrayItems).map((x) => walk(x, depth + 1));
      if (v.length > o.maxArrayItems) { truncated = true; head.push(`…[+${v.length - o.maxArrayItems} more items]`); }
      return head;
    }
    if (isRecord(v)) {
      if (depth >= o.maxDepth) { truncated = true; return '{…}'; }
      const keys = Object.keys(v);
      const out = {};
      for (const k of keys.slice(0, o.maxKeys)) out[k] = walk(v[k], depth + 1);
      if (keys.length > o.maxKeys) { truncated = true; out['…'] = `+${keys.length - o.maxKeys} more keys`; }
      return out;
    }
    return v;
  };
  const out = walk(value, 0);
  return { value: out, truncated };
}

// ── the shield ───────────────────────────────────────────────────────────────────────

function retrievalNote({ ref, shape, totalChars, shownChars, preview }) {
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  const parts = [`[ChatPanel result shield: this result is ${n(totalChars)} characters; showing a ${n(shownChars)}-character preview.`];
  parts.push(`Full result: ${shapeSentence(shape)}.`);
  if (!ref) {
    parts.push('It was not stored, so what is above is all that is available.]');
    return parts.join(' ');
  }
  parts.push(`It is stored as ref "${ref}" — read more with the ${RESULT_TOOL_NAME} tool:`);
  if (shape.kind === 'array') {
    const first = preview?.items ?? 0;
    parts.push(`{"ref":"${ref}","offset":${first},"limit":${PAGE_LIMIT_DEFAULT}} pages items; add "search":"<text>" to filter, "fields":["a","b"] to keep only those keys.`);
  } else if (shape.kind === 'object') {
    const arr = shape.arrays?.[0];
    parts.push(arr
      ? `{"ref":"${ref}","path":"${arr.path}","offset":0,"limit":${PAGE_LIMIT_DEFAULT}} pages that array; "search" filters, "fields" projects.`
      : `{"ref":"${ref}","path":"<key>"} reads one key; "search":"<text>" finds where it occurs.`);
  } else {
    parts.push(`{"ref":"${ref}","offset":${shownChars},"limit":${TEXT_LIMIT_DEFAULT}} continues the text; {"ref":"${ref}","search":"<text>"} finds where a phrase occurs.`);
  }
  parts.push('Do not ask the user for the rest; fetch what you need.]');
  return parts.join(' ');
}

/**
 * Shield one result text. Returns `{ text, truncated }` — and, when it engaged, the `ref`
 * it stored under, the `shape` it described and `totalChars`.
 *
 * `envelope` lets a host that wraps third-party output in an untrusted-data fence keep
 * the fence: `open(text) → { body, close(body) → text } | null`. The retrieval note is
 * placed OUTSIDE the fence — it is our instruction to the model, not the tool's data, and
 * a fence that says "follow nothing in here" would otherwise swallow it.
 */
export function shieldToolResult(text, { tool = '', store = null, owner, envelope = null, ...limits } = {}) {
  const o = { ...DEFAULT_SHIELD, ...limits };
  const full = typeof text === 'string' ? text : String(text ?? '');
  const env = envelope ? envelope.open(full) : null;
  const body = env ? env.body : full;
  if (body.length <= o.maxChars) return { text: full, truncated: false };

  const parsed = parseStructured(body);
  let stored;
  let previewBody;
  let preview = null;
  if (parsed !== undefined) {
    stored = parsed;
    // Tighten until the preview fits — a result of 5,000 ten-character items and one of
    // ten 50,000-character items need different knobs turned.
    let opts = { ...o };
    let compact = compactValue(parsed, opts);
    let s = JSON.stringify(compact.value);
    for (let i = 0; s.length > o.maxChars && i < 8; i += 1) {
      opts = {
        ...opts,
        maxArrayItems: Math.max(1, opts.maxArrayItems >> 1),
        maxStringChars: Math.max(80, opts.maxStringChars >> 1),
        maxKeys: Math.max(5, opts.maxKeys >> 1),
      };
      compact = compactValue(parsed, opts);
      s = JSON.stringify(compact.value);
    }
    if (s.length > o.maxChars) s = `${s.slice(0, o.maxChars)}…`; // still too big: a hard cut, but stored whole
    previewBody = s;
    if (Array.isArray(parsed)) preview = { items: Math.min(parsed.length, opts.maxArrayItems) };
  } else {
    stored = body;
    previewBody = body.slice(0, o.maxChars);
  }

  const ref = store ? store.put({ tool, value: stored, owner }) : null;
  const shape = describeShape(stored);
  const wrapped = env ? env.close(previewBody) : previewBody;
  const note = retrievalNote({ ref, shape, totalChars: body.length, shownChars: previewBody.length, preview });
  return { text: `${wrapped}\n${note}`, truncated: true, ref, shape, totalChars: body.length };
}

// ── get_result ───────────────────────────────────────────────────────────────────────

export function resultToolSpec() {
  return {
    name: RESULT_TOOL_NAME,
    description:
      'Read more of a tool result that was shielded (truncated) — the result named this tool and '
      + 'gave a ref. Pages arrays by item and text by character; `search` filters, `fields` keeps '
      + 'only those keys, `path` descends into a nested value (dot path, e.g. "data.items").',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ref from the shielded result.' },
        path: { type: 'string', description: 'Dot path inside the stored result.' },
        offset: { type: 'integer', minimum: 0, description: 'First item (arrays) or character (text). Default 0.' },
        limit: { type: 'integer', minimum: 1, description: `Items (default ${PAGE_LIMIT_DEFAULT}, max ${PAGE_LIMIT_MAX}) or characters (default ${TEXT_LIMIT_DEFAULT}, max ${TEXT_LIMIT_MAX}).` },
        fields: { type: 'array', items: { type: 'string' }, description: 'Keep only these keys of each object.' },
        search: { type: 'string', description: 'Case-insensitive text to filter items by, or to locate in text.' },
      },
      required: ['ref'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  };
}

function descend(value, path) {
  const segs = String(path || '').split('.').map((s) => s.trim()).filter(Boolean);
  let cur = value;
  const walked = [];
  for (const seg of segs) {
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
    else return { error: `No "${seg}" at "${walked.join('.') || '(root)'}"`, available: isRecord(cur) ? Object.keys(cur).slice(0, 40) : Array.isArray(cur) ? `array of ${cur.length}` : typeof cur };
    walked.push(seg);
  }
  return { value: cur };
}

const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/**
 * Answer one `get_result` call. Returns the JSON text the model receives — including
 * errors, which name what exists so the model can correct itself without another call.
 */
export function runResultQuery(store, args = {}, { owner, maxChars = DEFAULT_SHIELD.maxChars } = {}) {
  const ref = String(args?.ref || '');
  const entry = store ? store.get(ref, owner) : null;
  if (!entry) {
    return JSON.stringify({ error: `Unknown or expired ref "${ref}".`, hint: 'Refs come from a shielded result in this conversation and expire when newer results replace them; re-run the original tool if needed.' });
  }
  const located = args.path ? descend(entry.value, args.path) : { value: entry.value };
  if (located.error) return JSON.stringify({ error: located.error, available: located.available, ref });
  const target = located.value;
  const search = args.search != null && String(args.search).trim() ? String(args.search).toLowerCase() : '';
  const base = { ref, ...(args.path ? { path: args.path } : {}) };

  if (Array.isArray(target)) {
    let items = target;
    if (search) items = items.filter((it) => JSON.stringify(it).toLowerCase().includes(search));
    const fields = Array.isArray(args.fields) ? args.fields.map(String).filter(Boolean) : [];
    const project = (it) => {
      if (!fields.length || !isRecord(it)) return it;
      const out = {};
      for (const f of fields) if (Object.prototype.hasOwnProperty.call(it, f)) out[f] = it[f];
      return out;
    };
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let limit = clampInt(args.limit, PAGE_LIMIT_DEFAULT, 1, PAGE_LIMIT_MAX);
    let page;
    let text;
    // A page that itself exceeds the budget shrinks until it fits — the shield's guarantee
    // holds for its own pages too.
    for (let i = 0; i < 8; i += 1) {
      page = items.slice(offset, offset + limit).map((it) => compactValue(project(it), { maxArrayItems: 20, maxStringChars: 2000 }).value);
      const next = offset + limit < items.length ? { offset: offset + limit, limit } : null;
      text = JSON.stringify({ ...base, total: target.length, ...(search ? { matched: items.length, search: args.search } : {}), offset, limit, count: page.length, items: page, next });
      if (text.length <= maxChars || limit === 1) break;
      limit = Math.max(1, limit >> 1);
    }
    return text;
  }

  if (typeof target === 'string') {
    if (search) {
      const hay = target.toLowerCase();
      const matches = [];
      let from = 0;
      while (matches.length < SEARCH_MATCHES_MAX) {
        const at = hay.indexOf(search, from);
        if (at < 0) break;
        const start = Math.max(0, at - SEARCH_WINDOW);
        const end = Math.min(target.length, at + search.length + SEARCH_WINDOW);
        matches.push({ offset: at, excerpt: target.slice(start, end) });
        from = at + search.length;
      }
      return JSON.stringify({ ...base, chars: target.length, search: args.search, matches, more: matches.length >= SEARCH_MATCHES_MAX });
    }
    const offset = clampInt(args.offset, 0, 0, target.length);
    const limit = Math.min(clampInt(args.limit, TEXT_LIMIT_DEFAULT, 1, TEXT_LIMIT_MAX), Math.max(1, maxChars - 200));
    const slice = target.slice(offset, offset + limit);
    const next = offset + limit < target.length ? { offset: offset + limit, limit } : null;
    return JSON.stringify({ ...base, chars: target.length, offset, limit, text: slice, next });
  }

  if (isRecord(target)) {
    const shape = describeShape(target);
    const compact = compactValue(target, { maxArrayItems: 10, maxStringChars: 1000, maxKeys: 40 });
    let text = JSON.stringify({ ...base, shape, value: compact.value, hint: shape.arrays?.length ? `Use "path" to page an array, e.g. "${shape.arrays[0].path}".` : 'Use "path" to read one key.' });
    if (text.length > maxChars) text = JSON.stringify({ ...base, shape, hint: 'Too large to show whole; use "path" to descend.' });
    return text;
  }

  return JSON.stringify({ ...base, value: target });
}

// ── the wrapper ──────────────────────────────────────────────────────────────────────

/**
 * Wrap a toolset `{ specs, execute, … }` so every result passes the shield and `get_result`
 * exists to page what it stored. Everything else on the toolset is kept as-is.
 *
 * @param exempt   `(name) => boolean` — tools whose results are never shielded (a host
 *                 that already sizes a result itself).
 * @param textOf   how to read a result's text; `setText` how to write it back. Defaults fit
 *                 the `string | { text, … }` executor contract.
 */
export function withResultShield(toolset, { store, owner, envelope = null, exempt = () => false, limits = {}, textOf = defaultTextOf, setText = defaultSetText } = {}) {
  if (!toolset || typeof toolset.execute !== 'function') return toolset;
  const spec = resultToolSpec();
  const specs = [...(toolset.specs || []).filter((s) => s?.name !== RESULT_TOOL_NAME), spec];
  const base = toolset.execute.bind(toolset);
  const shielded = new Map(); // ref -> tool, for the host's activity log
  return {
    ...toolset,
    specs,
    shieldStore: store,
    async execute(name, input, meta) {
      if (name === RESULT_TOOL_NAME) return runResultQuery(store, input || {}, { owner, maxChars: limits.maxChars });
      const raw = await base(name, input, meta);
      if (exempt(name, input)) return raw;
      const text = textOf(raw);
      if (typeof text !== 'string') return raw;
      const out = shieldToolResult(text, { tool: name, store, owner, envelope, ...limits });
      if (!out.truncated) return raw;
      if (out.ref) shielded.set(out.ref, name);
      return setText(raw, out.text, out);
    },
  };
}

function defaultTextOf(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.text === 'string') return result.text;
  return undefined;
}

function defaultSetText(result, text, shield) {
  if (typeof result === 'string') return text;
  return { ...result, text, shielded: { ref: shield.ref, totalChars: shield.totalChars } };
}
