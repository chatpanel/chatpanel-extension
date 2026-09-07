// GENERATED — do not edit.
// Source of truth: chatpanel-events/structured.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Structured output — one schema, one prompt, one parser, everywhere.
//
// A dozen places in ChatPanel ask a model for a small typed answer: what was this person
// actually asking for, what are the topics of this note, which entities in this text are
// PII, what should this meeting be called. Every one of them was written the same way and
// none of them shared a line of code:
//
//     const prompt = 'Return ONLY a JSON object: {"kind":"...","name":"..."}';   // hand-typed
//     const obj = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
//
// That shape has three faults, and each of them cost a real bug:
//
//   1. THE SHAPE IS TYPED TWICE — once in the prompt string and once in the parser, thirty
//      lines apart, with nothing making them agree. Add a field to one and the other
//      silently ignores it forever.
//   2. THE REPAIRS DO NOT PROPAGATE. voice-intents learned in production that a small model
//      answers "none" as prose with no JSON at all; topic-extraction learned separately that
//      models wrap answers in code fences; suggestions learned separately that they emit a
//      markdown list instead of an array. Three files, three lessons, no sharing — and the
//      fourth site starts from zero and re-earns all three.
//   3. indexOf('{') … lastIndexOf('}') IS NOT A PARSER. It breaks on a brace inside a
//      string, on prose that mentions JSON, and on every truncated response — which is
//      every response, while it is still streaming.
//
// So: describe the answer ONCE as a schema. The prompt is rendered from it, the JSON Schema
// for models that support structured output is derived from it, and the parser coerces onto
// it. A field cannot drift from its own description.
//
// WHY NOT A LIBRARY. The obvious answer is BAML, which is right about the two ideas here —
// schema-aligned parsing and deriving the prompt from the schema. Its runtime is a Rust core
// behind a Node native addon (eight platform binaries) driven by codegen. This package is
// vendored into the extension by file copy, loads as raw ES modules under MV3 CSP with no
// bundler, and must also run in the gateway, the bridge and a mobile JS runtime. A native
// addon cannot go here. The ideas can, and they are small.
//
// WHY IT LIVES IN THE SHARED PACKAGE. Ask the test from CLAUDE.md: could a mobile client
// need it? It is the only thing standing between a 3B local model and a usable answer, so
// yes — every client needs it, including the ones that do not exist yet. Pure input → output,
// no clock, no network, no platform API.
//
// THE TWO AUDIENCES, one schema:
//
//   • A CAPABLE MODEL over an OpenAI-compatible endpoint gets `responseFormat(schema)` and is
//     constrained by the server — the answer arrives well-formed and `coerce` is a formality.
//   • A SMALL LOCAL MODEL, or an agent CLI (Claude Code, Codex) which has no response_format
//     at all, gets `describe(schema)` in the prompt and everything it emits goes through the
//     repair pass. This is the path that actually needed building, and it is why the parser
//     is generous rather than strict.
//
// AND IT STREAMS. `createStructuredStream` re-reads the buffer as tokens arrive and hands
// back the object so far plus the set of fields that are FINISHED — so a panel can render a
// request as it is being written and only commit an enum once the model has closed it.
// Truncated JSON is the normal case mid-stream, not an error, which is why the repair pass
// treats "close whatever is open" as a first-class operation.

export class StructuredError extends Error {
  constructor(code, message) { super(message); this.name = 'StructuredError'; this.code = code; }
}

/** Field types a schema may declare. Deliberately small — this is for SMALL answers. */
export const FIELD_TYPES = Object.freeze([
  'string', 'number', 'integer', 'boolean', 'enum', 'string[]', 'number[]', 'object[]',
]);

// Whole-answer prose a model emits INSTEAD of JSON when the honest answer is "nothing".
// Told to return JSON and having nothing to report, small models very often just say the
// word. Reading that as unparseable is worse than useless: the caller falls back to its
// deterministic reading and acts on something the model has just said was not there.
const NOTHING = /^(?:none|n\/a|na|nothing|no|null|nil|empty|no results?|nothing found|no request|-{1,3}|\.)\s*[.!]?$/i;

// Prose a model puts in FRONT of the JSON. Stripped only when a structural character
// follows, so a legitimate answer that happens to start with "Sure" is never touched.
const LEAD_IN = /^(?:(?:sure|certainly|of course|okay|ok|got it|here(?:'s| is)(?: the)?(?: \w+)?|the (?:json|answer|result|output)(?: is)?|json|output|answer|result)\s*[:.!,-]*\s*)+/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}` : s);

// ---------------------------------------------------------------------------
// Defining a schema
// ---------------------------------------------------------------------------

/**
 * Declare the answer once.
 *
 *   defineSchema({
 *     name: 'refinement',
 *     purpose: 'what the speaker actually wants done',
 *     fields: {
 *       request: { type: 'string', required: true, max: 200, describe: 'one sentence, their words' },
 *       kind:    { type: 'enum', values: ['question','monitor','note'], default: 'question' },
 *     },
 *   })
 *
 * `fields` is ORDERED — the prompt lists them in declaration order, and models answer in the
 * order they are asked, which is what makes the streaming `settled` set arrive in a useful
 * sequence rather than at random.
 */
export function defineSchema(spec = {}) {
  const name = String(spec.name || '').trim();
  if (!name) throw new StructuredError('no-name', 'a schema needs a name');
  if (!isObj(spec.fields) || !Object.keys(spec.fields).length) {
    throw new StructuredError('no-fields', `schema ${name} declares no fields`);
  }
  const fields = {};
  for (const [key, raw] of Object.entries(spec.fields)) fields[key] = defineField(name, key, raw);
  if (spec.nothingIf != null && !(spec.nothingIf instanceof RegExp)) {
    throw new StructuredError('bad-nothing', `schema ${name}: nothingIf must be a RegExp`);
  }
  if (spec.fallback != null && spec.fallback !== 'lines' && typeof spec.fallback !== 'function') {
    throw new StructuredError('bad-fallback', `schema ${name}: fallback must be 'lines' or a function`);
  }
  return Object.freeze({
    name,
    purpose: String(spec.purpose || '').trim(),
    fields: Object.freeze(fields),
    order: Object.freeze(Object.keys(fields)),
    // WHAT "THE MODEL REPORTED NOTHING" LOOKS LIKE, as a value the caller can act on.
    //
    // Two different answers mean it and neither is a parse failure: the whole reply is the
    // word ("none", "N/A", "nothing found"), or the reply is valid JSON whose required field
    // is that word. Both were read as unparseable before, so the caller fell back to its
    // deterministic reading and acted on something the model had just said was not there —
    // which is how a user ended up with a chat message reading "none".
    //
    // A schema that declares no `nothing` gets null for both, which is the honest answer when
    // there is no meaningful empty value to hand back.
    nothing: spec.nothing ?? null,
    nothingIf: spec.nothingIf ?? null,
    // How to read an answer that never contained JSON at all. 'lines' handles the case every
    // list-shaped schema hits — the model replied with a markdown list — and is only legal
    // when there is exactly one array field to put the lines into.
    fallback: spec.fallback ?? null,
    // Reject the whole answer when a required field is missing, rather than handing back a
    // half-object the caller has to re-validate. A caller that wants the half-object asks
    // for `partial`.
    strictRequired: spec.strictRequired !== false,
  });
}

function defineField(schemaName, key, raw) {
  const spec = typeof raw === 'string' ? { type: raw } : { ...(raw || {}) };
  const type = String(spec.type || 'string');
  if (!FIELD_TYPES.includes(type)) {
    throw new StructuredError('bad-type', `schema ${schemaName}.${key}: unknown type ${JSON.stringify(type)}`);
  }
  if (type === 'enum') {
    const values = (spec.values || []).map((v) => String(v));
    if (!values.length) throw new StructuredError('bad-enum', `schema ${schemaName}.${key}: enum with no values`);
    if (spec.default != null && !values.includes(String(spec.default))) {
      throw new StructuredError('bad-default', `schema ${schemaName}.${key}: default ${JSON.stringify(spec.default)} is not one of its values`);
    }
    spec.values = Object.freeze(values);
    // Lower-cased alias → canonical value. Models answer "Question", "a question" and
    // "question." for the same enum; an unknown value falling through to the default is a
    // silently wrong answer, so near-misses are mapped rather than discarded.
    const aliases = new Map();
    for (const v of values) aliases.set(v.toLowerCase(), v);
    for (const [from, to] of Object.entries(spec.aliases || {})) {
      if (!values.includes(String(to))) throw new StructuredError('bad-alias', `schema ${schemaName}.${key}: alias → ${to}, which is not a value`);
      aliases.set(String(from).toLowerCase(), String(to));
    }
    spec.aliasMap = aliases;
  }
  if (type === 'object[]') {
    if (!isObj(spec.fields)) throw new StructuredError('bad-items', `schema ${schemaName}.${key}: object[] needs \`fields\``);
    const sub = {};
    for (const [k, v] of Object.entries(spec.fields)) sub[k] = defineField(`${schemaName}.${key}[]`, k, v);
    spec.fields = Object.freeze(sub);
    spec.order = Object.freeze(Object.keys(sub));
  }
  if (spec.emptyIf != null && !(spec.emptyIf instanceof RegExp)) {
    throw new StructuredError('bad-emptyif', `schema ${schemaName}.${key}: emptyIf must be a RegExp`);
  }
  spec.type = type;
  spec.describe = String(spec.describe || '').trim();
  return Object.freeze(spec);
}

const isListType = (t) => t === 'string[]' || t === 'number[]' || t === 'object[]';

/** The single array field of a schema, when there is exactly one. Null otherwise. */
function soleListField(schema) {
  const lists = schema.order.filter((k) => isListType(schema.fields[k].type));
  return lists.length === 1 ? lists[0] : null;
}

// ---------------------------------------------------------------------------
// Rendering the prompt
// ---------------------------------------------------------------------------

/**
 * The instruction block, rendered FROM the schema — so the shape a model is shown and the
 * shape the parser expects cannot disagree.
 *
 * Kept short on purpose. These calls run on fast models while a meeting is happening; the
 * schema block is paid for on every one of them, and a paragraph per field would cost more
 * than the answer. A field's `describe` is the one place to spend words.
 */
export function describeSchema(schema, { fences = false } = {}) {
  const shape = schema.order.map((k) => `${JSON.stringify(k)}: ${shapeOf(schema.fields[k])}`).join(', ');
  const notes = [];
  for (const key of schema.order) {
    const f = schema.fields[key];
    const bits = [];
    if (f.describe) bits.push(f.describe);
    if (f.required) bits.push('required');
    if (f.default != null && !f.required) bits.push(`defaults to ${JSON.stringify(f.default)}`);
    if (f.type === 'string' && f.max) bits.push(`at most ${f.max} characters`);
    if (isListType(f.type) && f.maxItems) bits.push(`at most ${f.maxItems} items`);
    if (bits.length) notes.push(`- ${key} — ${bits.join('; ')}.`);
  }
  return [
    schema.purpose ? `${schema.purpose}` : '',
    schema.purpose ? '' : '',
    fences
      ? 'Return a single JSON object in a ```json code fence and nothing else:'
      : 'Return ONLY a JSON object — no prose, no code fences, no explanation:',
    `{${shape}}`,
    notes.length ? '' : '',
    ...notes,
  ].filter((l) => l !== '').join('\n');
}

function shapeOf(f) {
  switch (f.type) {
    case 'enum': return f.values.map((v) => JSON.stringify(v)).join('|');
    case 'string[]': return '[string, …]';
    case 'number[]': return '[number, …]';
    case 'object[]': return `[{${f.order.map((k) => `${JSON.stringify(k)}: ${shapeOf(f.fields[k])}`).join(', ')}}, …]`;
    case 'integer': return 'integer';
    case 'number': return 'number';
    case 'boolean': return 'true|false';
    default: return 'string';
  }
}

// ---------------------------------------------------------------------------
// The same schema, as JSON Schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for the endpoints that can enforce it — OpenAI `json_schema` response format,
 * and tool/function parameters.
 *
 * `strict` mode on OpenAI-compatible servers requires that EVERY property is listed in
 * `required` and that `additionalProperties` is false, so optional fields are expressed as a
 * union with null rather than by omission. That is the server's rule, not ours; `coerce`
 * still treats a null there as absent.
 */
export function toJsonSchema(schema, { strict = true } = {}) {
  const properties = {};
  for (const key of schema.order) properties[key] = jsonSchemaField(schema.fields[key]);
  const required = strict
    ? schema.order.slice()
    : schema.order.filter((k) => schema.fields[k].required);
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function jsonSchemaField(f) {
  const base = f.describe ? { description: f.describe } : {};
  switch (f.type) {
    case 'enum': return { ...base, type: 'string', enum: f.values.slice() };
    case 'integer': return { ...base, type: 'integer' };
    case 'number': return { ...base, type: 'number' };
    case 'boolean': return { ...base, type: 'boolean' };
    case 'string[]': return { ...base, type: 'array', items: { type: 'string' } };
    case 'number[]': return { ...base, type: 'array', items: { type: 'number' } };
    case 'object[]': return {
      ...base,
      type: 'array',
      items: {
        type: 'object',
        properties: Object.fromEntries(f.order.map((k) => [k, jsonSchemaField(f.fields[k])])),
        required: f.order.slice(),
        additionalProperties: false,
      },
    };
    default: return { ...base, type: 'string' };
  }
}

/**
 * The request body fragment that makes a server do the work for us.
 *
 * `mode: 'schema'` is the strongest and the narrowest — real grammar-constrained decoding,
 * supported by OpenAI and a growing set of compatible servers. `mode: 'object'` is the older,
 * near-universal JSON mode, which guarantees only that the answer parses. `mode: 'none'`
 * returns null, which is what an agent CLI (Claude Code, Codex) and llama.cpp-era endpoints
 * get: no server-side constraint at all, the prompt and the repair pass carry it.
 *
 * Callers should DEGRADE, not branch: try 'schema', fall back to 'object', then to null —
 * because `coerce` produces the same answer from all three, the only thing that changes is
 * how often it has to work for it. That is exactly what providers.js already does by hand.
 */
export function responseFormat(schema, { mode = 'schema', strict = true } = {}) {
  if (mode === 'none') return null;
  if (mode === 'object') return { response_format: { type: 'json_object' } };
  return {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schema.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'answer',
        strict,
        schema: toJsonSchema(schema, { strict }),
      },
    },
  };
}

/** The degradation ladder, in order. A caller retries down it on a 4xx from the server. */
export const RESPONSE_MODES = Object.freeze(['schema', 'object', 'none']);

// ---------------------------------------------------------------------------
// Finding the JSON
// ---------------------------------------------------------------------------

/** Strip code fences and the "Sure, here's the JSON:" preamble. Never touches the inside. */
export function unfence(text) {
  let t = String(text ?? '').trim();
  // A fenced block anywhere in the answer wins over the prose around it.
  const fenced = t.match(/```(?:json|jsonc|json5)?\s*\n?([\s\S]*?)(?:```|$)/i);
  if (fenced && fenced[1].trim()) t = fenced[1].trim();
  const led = t.replace(LEAD_IN, '');
  // Only when a structure follows — otherwise "OK" as a whole answer becomes ''.
  if (led !== t && /^[[{"]/.test(led)) t = led;
  return t.trim();
}

/**
 * Locate the JSON value inside an answer, honestly.
 *
 * The pattern this replaces — `slice(indexOf('{'), lastIndexOf('}') + 1)` — is wrong in three
 * ways that all happen: a `}` inside a string ends the slice early, prose after the object
 * that mentions a brace extends it past the end, and a response still arriving has no closing
 * brace at all so the slice is empty. This scans with string and escape awareness and
 * reports what it found, including how deep it was when the text ran out.
 *
 * @returns { text, start, end, complete } | null
 */
export function findJson(text) {
  const src = String(text ?? '');
  let best = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '{' && c !== '[') continue;
    const scan = scanFrom(src, i);
    if (scan.complete) return { text: src.slice(i, scan.end), start: i, end: scan.end, complete: true };
    // Incomplete: remember the FIRST opener and keep looking for a complete one later in the
    // answer — a model that writes a broken example and then the real object is common enough
    // to survive, and mid-stream there is only ever the one.
    if (!best) best = { text: src.slice(i), start: i, end: src.length, complete: false };
  }
  return best;
}

/** Walk from an opener, tracking strings and escapes. Returns where it closed, or how deep it still is. */
function scanFrom(src, start) {
  const stack = [];
  let inStr = false;
  let quote = '"';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (QUOTE_PAIRS.has(c)) { inStr = true; quote = QUOTE_PAIRS.get(c); continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) return { end: i + 1, complete: true, depth: 0, inStr: false };
    }
  }
  return { end: src.length, complete: false, depth: stack.length, inStr };
}

// ---------------------------------------------------------------------------
// Repairing it
// ---------------------------------------------------------------------------

const LITERALS = new Map([
  ['true', 'true'], ['false', 'false'], ['null', 'null'],
  ['True', 'true'], ['False', 'false'], ['None', 'null'],   // a model that has read Python
  ['TRUE', 'true'], ['FALSE', 'false'], ['NULL', 'null'],
  ['yes', 'true'], ['no', 'false'], ['Yes', 'true'], ['No', 'false'],
  ['undefined', 'null'], ['NaN', 'null'], ['Infinity', 'null'],
]);

// A curly quote opens a string that closes with its PARTNER, never with itself — mapping the
// opener to '"' before reading the string is how the closing '”' got missed and the rest of the
// answer was swallowed into one giant value.
const QUOTE_PAIRS = new Map([['"', '"'], ["'", "'"], ['“', '”'], ['”', '”'], ['‘', '’'], ['’', '’']]);
const isQuote = (c) => QUOTE_PAIRS.has(c);

/**
 * Rewrite almost-JSON into JSON.
 *
 * Everything here is something a model has actually emitted while being told to return JSON:
 * single quotes, unquoted keys, `//` comments, trailing commas, Python literals, curly quotes
 * from a model that has been trained on prose, a raw newline inside a string — and, on every
 * single response that is still arriving, an ending that simply is not there yet.
 *
 * `partial: true` closes what is open: an unterminated string gets its quote, a key with no
 * value yet is dropped rather than invented, and the container stack is closed in order. That
 * is what makes a half-received answer renderable instead of an error.
 *
 * Also reports which TOP-LEVEL keys finished on their own — the streaming contract. A field
 * is `settled` only if its value ended because the model ended it, never because we closed it.
 */
export function rewriteJson(src, { partial = false } = {}) {
  const text = String(src ?? '');
  let out = '';
  const stack = [];            // { kind: '{'|'[', expect: 'key'|'colon'|'value'|'comma' }
  const settled = new Set();
  let pendingComma = false;
  let currentKey = null;       // the key whose value we are inside, at depth 1
  let keyMark = -1;            // where in `out` the pending key started, for rollback
  let commaMark = -1;          // where in `out` the comma before it started
  let truncated = false;

  const top = () => stack[stack.length - 1] || null;
  const flushComma = () => { if (pendingComma) { commaMark = out.length; out += ','; pendingComma = false; } };
  // Depth 1 means "a value of the root object", which is the only level the streaming
  // contract talks about. Nested settling is not reported — a caller that needs it wants a
  // different schema, not a deeper report.
  const settleValue = () => {
    const t = top();
    if (t && t.kind === '{') { if (stack.length === 1 && currentKey) settled.add(currentKey); t.expect = 'comma'; }
    else if (t) t.expect = 'comma';
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (/\s/.test(c)) { if (out && !/\s$/.test(out)) out += ' '; continue; }

    // Comments — a model asked for JSON explains itself in it surprisingly often.
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      if (text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
      else { const close = text.indexOf('*/', i + 2); i = close < 0 ? text.length : close + 1; }
      continue;
    }

    if (c === '{' || c === '[') {
      flushComma();
      stack.push({ kind: c, expect: c === '{' ? 'key' : 'value' });
      out += c;
      continue;
    }

    if (c === '}' || c === ']') {
      pendingComma = false;                      // a trailing comma before a closer, dropped
      const t = top();
      if (!t) continue;                          // a closer with nothing open: noise, skipped
      // A key with no value: `{"a":"x","b"}`. Roll the dangling key back out.
      if (t.kind === '{' && (t.expect === 'colon' || (t.expect === 'value' && out.endsWith(':')))) rollbackKey();
      stack.pop();
      out += t.kind === '{' ? '}' : ']';         // the closer the STACK says, not the one written
      settleValue();
      continue;
    }

    if (c === ':') { out += ':'; const t = top(); if (t) t.expect = 'value'; continue; }

    if (c === ',') {
      // Buffered rather than emitted, so the next thing gets to decide whether it was a
      // separator or a trailing comma. `,]` and `,}` are both routine.
      pendingComma = true;
      const t = top();
      if (t) t.expect = t.kind === '{' ? 'key' : 'value';
      continue;
    }

    if (isQuote(c)) {
      flushComma();
      const t = top();
      const isKey = !!t && t.kind === '{' && t.expect !== 'value';
      if (isKey) { keyMark = out.length; }
      const str = readString(text, i, c);
      i = str.end;
      if (!str.closed) {
        truncated = true;
        if (!partial) return { json: null, complete: false, settled, truncated: true };
        // Mid-stream: a half-written KEY names nothing, so it goes; a half-written VALUE is
        // the thing the user is watching appear, so it stays and gets its quote.
        if (isKey) { rollbackKey(); break; }
        out += `${JSON.stringify(str.value)}`;
        if (stack.length === 1 && currentKey) { /* deliberately NOT settled — we closed it */ }
        break;
      }
      out += JSON.stringify(str.value);
      if (isKey) { if (stack.length === 1) currentKey = str.value; if (t) t.expect = 'colon'; }
      else settleValue();
      continue;
    }

    // A bare word or number.
    const word = readBare(text, i);
    if (!word.value) continue;                   // a character that is not JSON at all
    i = word.end;
    flushComma();
    const t = top();
    const wantsKey = !!t && t.kind === '{' && t.expect !== 'value';
    if (wantsKey) {
      keyMark = out.length;
      out += JSON.stringify(word.value);         // unquoted key
      if (stack.length === 1) currentKey = word.value;
      t.expect = 'colon';
      continue;
    }
    const lit = LITERALS.get(word.value);
    if (lit) out += lit;
    else if (/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(word.value)) out += word.value;
    else out += JSON.stringify(word.value);      // an unquoted string value
    // A bare word at the very end may still be growing ("questi" → "question"), so mid-stream
    // it is never settled. Complete text settles it normally.
    if (!(partial && word.end >= text.length - 1)) settleValue();
    else truncated = true;
  }

  function rollbackKey() {
    if (keyMark < 0) return;
    out = out.slice(0, commaMark >= 0 && commaMark >= keyMark - 1 ? commaMark : keyMark);
    if (out.endsWith(',')) out = out.slice(0, -1);
    keyMark = -1;
    if (stack.length === 1) currentKey = null;
  }

  if (stack.length) {
    truncated = true;
    if (!partial) return { json: null, complete: false, settled, truncated: true };
    // `{"request"` — a key arrived and its colon has not. The key names nothing yet, so it
    // goes; keeping it would produce `{"request"}`, which is the one shape JSON.parse cannot
    // be talked into accepting, and every streamed answer passes through it.
    const t = top();
    if (t && t.kind === '{' && t.expect === 'colon') rollbackKey();
    // `{"request":` — the value has not been written. Null, never a guess: an invented value
    // is indistinguishable downstream from one the model actually chose.
    if (out.trimEnd().endsWith(':')) out += 'null';
    if (out.trimEnd().endsWith(',')) out = out.trimEnd().slice(0, -1);
    while (stack.length) out += stack.pop().kind === '{' ? '}' : ']';
  }

  return { json: out.trim(), complete: !truncated, settled, truncated };
}

/** Read one string literal, tolerating raw newlines and either quote style. */
function readString(text, start, opener) {
  const quote = QUOTE_PAIRS.get(opener) || '"';
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      if (n === undefined) return { value, end: text.length, closed: false };
      // Keep real escapes, unescape a quote that only needed escaping in the other style.
      if (n === 'n') value += '\n';
      else if (n === 't') value += '\t';
      else if (n === 'r') value += '\r';
      else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 4;
      } else value += n;
      i++;
      continue;
    }
    if (c === quote) return { value, end: i, closed: true };
    value += c;                                  // a raw newline inside a string, kept
  }
  return { value, end: text.length, closed: false };
}

/** Read one unquoted token — a key, a number, or a bare word a model forgot to quote. */
function readBare(text, start) {
  let end = start;
  while (end < text.length && !/[\s,:{}[\]"']/.test(text[end])) end++;
  return { value: text.slice(start, end), end: end - 1 };
}

/** Almost-JSON in, JSON text out (or null when it cannot be made to parse). */
export function repairJson(text, { partial = false } = {}) {
  const found = findJson(unfence(text));
  if (!found) return null;
  return rewriteJson(found.text, { partial }).json;
}

// ---------------------------------------------------------------------------
// Coercing onto the schema
// ---------------------------------------------------------------------------

/**
 * Read a model's answer as the schema says it should be.
 *
 * @returns {{ value, complete, settled: string[], source: 'json'|'sentinel'|'fallback' }|null}
 *          null means "nothing usable" — the caller falls back to its deterministic reading
 *          rather than acting on a guess. That distinction is the whole point of the return
 *          shape: an empty ANSWER and an unreadable one lead to different behaviour.
 */
export function coerce(text, schema, { partial = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const body = unfence(raw);

  // "none", on its own, is an answer.
  if (NOTHING.test(body) || schema.nothingIf?.test(body)) return nothingResult(schema);

  const found = findJson(body);
  let parsed = null;
  let complete = false;
  let settled = new Set();
  if (found) {
    const rewritten = rewriteJson(found.text, { partial });
    complete = rewritten.complete && found.complete;
    settled = rewritten.settled;
    if (rewritten.json) { try { parsed = JSON.parse(rewritten.json); } catch { parsed = null; } }
  }

  if (parsed == null) {
    const fb = runFallback(body, schema);
    if (fb) {
      const v = coerceObject(fb, schema, { partial });
      if (v === NOTHING_MARK) return nothingResult(schema);
      if (v) return { value: v, complete: true, settled: schema.order.slice(), source: 'fallback' };
    }
    return null;
  }

  // A bare array against a schema with exactly one list field IS that field. Models do this
  // constantly — asked for {"topics":[…]} they return […] — and it is unambiguous, so it is
  // read rather than rejected.
  if (Array.isArray(parsed)) {
    const sole = soleListField(schema);
    if (!sole) return null;
    parsed = { [sole]: parsed };
  }
  if (!isObj(parsed)) return null;

  const value = coerceObject(parsed, schema, { partial });
  // Valid JSON whose required field is the word "none" is the model saying nothing, in the
  // shape it was asked to say it in. Same answer as the prose form, and not a failure.
  if (value === NOTHING_MARK) return nothingResult(schema);
  if (value == null) return null;
  return { value, complete, settled: [...settled].filter((k) => schema.order.includes(k)), source: 'json' };
}

/** Distinguishable from both null (unreadable) and an object (an answer). Never escapes. */
const NOTHING_MARK = Symbol('nothing');

function nothingResult(schema) {
  if (schema.nothing == null) return null;
  return { value: schema.nothing, complete: true, settled: schema.order.slice(), source: 'nothing' };
}

/** The common case: the object, or null. */
export function parseStructured(text, schema, opts) {
  return coerce(text, schema, opts)?.value ?? null;
}

function runFallback(body, schema) {
  if (typeof schema.fallback === 'function') {
    try { const v = schema.fallback(body); return isObj(v) ? v : null; } catch { return null; }
  }
  if (schema.fallback !== 'lines') return null;
  const sole = soleListField(schema);
  if (!sole) return null;
  // The markdown list a model writes when it ignores "return JSON". Bullets if there are any,
  // otherwise every line — a bare list of lines is the other half of the same mistake.
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^(?:[-*+•]|\d+[.)])\s+/.test(l));
  // ONE line with no list marker is a SENTENCE, not a list of one. "I could not determine any
  // topics." read as an item is worse than reading nothing: it becomes a tag on the note.
  if (!bullets.length && lines.length < 2) return null;
  const items = (bullets.length ? bullets : lines)
    .map((l) => l.replace(/^(?:[-*+•]|\d+[.)])\s*/, '').replace(/^["'`]|["'`]$/g, '').trim())
    .filter(Boolean);
  return items.length ? { [sole]: items } : null;
}

function coerceObject(obj, schema, { partial }) {
  const out = {};
  let missingRequired = false;
  let emptiedRequired = false;
  let any = false;
  for (const key of schema.order) {
    const f = schema.fields[key];
    const present = pick(obj, key);
    const v = coerceValue(present, f);
    if (v === undefined) {
      if (f.required) missingRequired = true;
      if (f.default !== undefined) out[key] = f.default;
      else if (!partial) out[key] = emptyFor(f);
      continue;
    }
    any = true;
    out[key] = v;
    // A required field ANSWERED as empty is different from one never answered: the model
    // filled the key it was told it had to fill, with nothing. That is a "nothing" answer,
    // not a malformed one — and the two need different handling by the caller.
    if (f.required && isEmptyValue(v)) emptiedRequired = true;
  }
  if (!any) return null;
  // Mid-stream a required field is simply not written yet, which is not the same as a model
  // that finished and left it out.
  if (partial) return out;
  if (emptiedRequired) return NOTHING_MARK;
  if (missingRequired && schema.strictRequired) return null;
  return out;
}

const isEmptyValue = (v) => v === '' || v === null || (Array.isArray(v) && v.length === 0);

/**
 * Find a key however the model spelled it. `actionItems`, `action_items`, `Action Items` and
 * `action-items` are one key, and losing a field to casing is a silent, total failure of the
 * call — the model answered correctly and we threw it away.
 */
function pick(obj, key) {
  if (key in obj) return obj[key];
  const want = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === want) return obj[k];
  }
  return undefined;
}

function emptyFor(f) {
  if (isListType(f.type)) return [];
  if (f.type === 'boolean') return false;
  if (f.type === 'number' || f.type === 'integer') return null;
  if (f.type === 'enum') return f.default ?? f.values[0];
  return '';
}

function coerceValue(v, f) {
  if (v === undefined || v === null) return undefined;
  switch (f.type) {
    case 'string': {
      const s = coerceString(v, f);
      return s === undefined ? undefined : s;
    }
    case 'enum': {
      const s = String(typeof v === 'string' ? v : (v?.value ?? v)).trim().toLowerCase().replace(/[.!]+$/, '');
      const hit = f.aliasMap.get(s) ?? f.aliasMap.get(s.replace(/^(?:a|an|the)\s+/, ''));
      if (hit) return hit;
      // An unrecognised enum is NOT the default by accident — the default is a deliberate
      // "when in doubt, do the least surprising thing", and a schema that has not declared one
      // would rather the caller knew the answer was unusable.
      return f.default !== undefined ? f.default : undefined;
    }
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.eE+-]/g, ''));
      if (!Number.isFinite(n)) return undefined;
      const r = f.type === 'integer' ? Math.round(n) : n;
      if (f.min != null && r < f.min) return f.min;
      if (f.max != null && r > f.max) return f.max;
      return r;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (/^(?:true|yes|y|1)$/.test(s)) return true;
      if (/^(?:false|no|n|0)$/.test(s)) return false;
      return undefined;
    }
    case 'string[]':
    case 'number[]':
    case 'object[]': {
      // A single value where a list was asked for is a list of one — a routine answer when
      // there happens to be only one thing to report, and rejecting it loses that one thing.
      const arr = Array.isArray(v) ? v : (v === '' ? [] : [v]);
      const item = f.type === 'string[]'
        ? (x) => coerceString(x, { max: f.itemMax, emptyIf: f.itemEmptyIf })
        : f.type === 'number[]'
          ? (x) => coerceValue(x, { type: 'number', min: f.min, max: f.max })
          : (x) => (isObj(x) ? coerceObject(x, { order: f.order, fields: f.fields, strictRequired: true }, { partial: false }) : undefined);
      const out = [];
      const seen = new Set();
      for (const x of arr) {
        const c = item(x);
        // NOTHING_MARK here means the item's own required field came back empty — an entity
        // with no value, a topic with no text. There is nothing to keep, so it is dropped
        // rather than turning the whole list into a "nothing" answer.
        if (c === undefined || c === null || c === '' || c === NOTHING_MARK) continue;
        if (f.dedupe !== false) {
          const k = typeof c === 'object' ? JSON.stringify(c) : String(c).toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
        }
        out.push(c);
        if (f.maxItems && out.length >= f.maxItems) break;
      }
      return out;
    }
    default: return undefined;
  }
}

function coerceString(v, f = {}) {
  if (v === undefined || v === null) return undefined;
  // An object where a string was asked for usually carries it under an obvious key.
  const raw = typeof v === 'string' ? v : (isObj(v) ? String(v.value ?? v.text ?? v.name ?? '') : String(v));
  let s = raw.replace(/\s+/g, ' ').trim();
  if (f.emptyIf && f.emptyIf.test(s)) return '';
  // "none" written INTO a field, which is how a model says "not this one" when it has been
  // told it must fill every key. Anchored, so a real answer that contains the word survives.
  if (NOTHING.test(s)) return '';
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (f.max && s.length > f.max) {
    // Clip on a word boundary — a label cut mid-word reads as a bug, not as a limit.
    const cut = s.slice(0, f.max);
    s = /\s/.test(cut) ? cut.replace(/\s+\S*$/, '') : cut;
  }
  return s;
}

/** True when nothing was said — the prose form, exported because callers check it too. */
export function isNothing(text) { return NOTHING.test(String(text ?? '').trim()); }

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// Re-reading the whole buffer on every token is O(n²). These answers are a few hundred
// characters, so it does not matter in practice — but a schema with a long string field
// streamed token by token is exactly the case where it would start to, so a re-read is
// earned rather than automatic: it happens when the shape may have changed (a structural
// character arrived) or when enough new text has accumulated to be worth showing.
const STRUCTURAL = /[{}[\]",:]/;
const GROWTH_BEFORE_REPARSE = 12;

/**
 * Read a structured answer AS IT ARRIVES.
 *
 * The reason this exists rather than "wait for the end and parse once": these calls are made
 * while a person is waiting — mid-meeting, mid-turn — and the standing UX rule is that every
 * model output streams with visible progress. A structured answer had no way to do that, so
 * structured calls were the one place in the product that showed a spinner.
 *
 *     const s = createStructuredStream(REFINEMENT);
 *     await dispatchStream({ …, onDelta: (d) => { const { value, settled } = s.push(d); render(value, settled); } });
 *     const final = s.end();
 *
 * `settled` is the contract that makes this safe to render: a field in it is FINISHED — the
 * model closed it — so committing to it (starting the monitor, choosing the branch) is sound.
 * A field not in it is still being written and must only ever be displayed.
 */
export function createStructuredStream(schema, { onChange = null } = {}) {
  let buffer = '';
  let sinceParse = 0;
  let last = null;                 // the most recent successful read
  let lastJson = '';               // for change detection, so onChange is not called per token

  const read = (partial) => {
    const got = coerce(buffer, schema, { partial });
    if (got) {
      last = got;
      const json = JSON.stringify(got.value);
      if (json !== lastJson) { lastJson = json; onChange?.(got.value, got.settled); }
    }
    sinceParse = 0;
    return last;
  };

  return {
    /** Feed a delta. Returns the answer so far — never throws, never blocks. */
    push(chunk) {
      const s = String(chunk ?? '');
      if (s) { buffer += s; sinceParse += s.length; }
      if (s && (STRUCTURAL.test(s) || sinceParse >= GROWTH_BEFORE_REPARSE)) read(true);
      return this.snapshot();
    },
    /** No more deltas. Re-reads once strictly, so a truncation that never resolved is caught. */
    end() {
      read(false);
      // Nothing parsed strictly, but something parsed while it was arriving: the answer was
      // cut off. Better a partial object than none — the caller decides with `complete`.
      if (!last) read(true);
      return this.snapshot();
    },
    /** What we know right now. */
    snapshot() {
      return {
        value: last?.value ?? null,
        settled: last?.settled ?? [],
        complete: !!last?.complete,
        source: last?.source ?? null,
        text: buffer,
      };
    },
    /** Throw away the buffer and start again — one stream object per call site, reused. */
    reset() { buffer = ''; sinceParse = 0; last = null; lastJson = ''; },
    get text() { return buffer; },
  };
}
