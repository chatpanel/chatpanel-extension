// The structured-call capability — the one place the product asks a model for a typed answer.
//
// What is asserted here is the behaviour that used to be re-decided at every call site, and
// re-decided differently: whether to ask the server to enforce the shape, what to do when it
// refuses, whether a failure takes the feature down, and whether the answer can be shown while
// it arrives. Six hand-rolled versions had six answers; this has one.
import assert from 'node:assert/strict';
import {
  runStructured, startingMode, forgetModes, promptFor, readStructured, STRUCTURED_SYSTEM,
} from '../extension/js/structured-call.js';
import { defineSchema } from '../extension/js/events/structured.js';
import { readFileSync } from 'node:fs';

const SCHEMA = defineSchema({
  name: 'demo',
  fields: {
    request: { type: 'string', required: true, max: 100 },
    kind: { type: 'enum', values: ['a', 'b'], default: 'a' },
  },
  nothing: { request: '', kind: 'a' },
});

const target = { kind: 'openai', baseUrl: 'https://example.test/v1', model: 'small-1' };
const cli = { kind: 'bridge', model: 'codex' };

/** A streamChat stand-in that records what it was asked and replays a scripted reply. */
function fakeStream(script) {
  const calls = [];
  const fn = async (opts) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ body: opts.agent.extraBody || null, agent: opts.agent, messages: opts.messages });
    if (step.throw) throw new Error(step.throw);
    for (const chunk of step.chunks || [step.text || '']) opts.onDelta?.(chunk);
    return step.text ?? (step.chunks || []).join('');
  };
  fn.calls = calls;
  return fn;
}

// ── The ladder ───────────────────────────────────────────────────────────────────

forgetModes();
{
  const stream = fakeStream([{ text: '{"request":"summarise it","kind":"b"}' }]);
  const got = await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: stream });
  assert.deepEqual(got.value, { request: 'summarise it', kind: 'b' });
  assert.equal(got.mode, 'schema');
  // A capable endpoint is asked to ENFORCE the shape, not merely told about it. This is the
  // difference between a 3B local model that answers correctly and one that writes a
  // paragraph, and exactly one of the six old call sites ever asked for it.
  assert.equal(stream.calls[0].body.response_format.type, 'json_schema');
  assert.equal(stream.calls[0].body.response_format.json_schema.strict, true);
}

forgetModes();
{
  // A server that rejects json_schema must not lose the feature — it drops to plain JSON mode.
  const stream = fakeStream([
    { throw: 'HTTP 400: unknown field response_format.json_schema' },
    { text: '{"request":"ok"}' },
  ]);
  const got = await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: stream });
  assert.equal(got.mode, 'object');
  assert.equal(stream.calls[1].body.response_format.type, 'json_object');
  // …and the walk is remembered, so the next call does not pay for the refusal again.
  assert.equal(startingMode(target), 'object');
  const again = fakeStream([{ text: '{"request":"second"}' }]);
  await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: again });
  assert.equal(again.calls[0].body.response_format.type, 'json_object', 'the refused rung was tried again');
  assert.equal(again.calls.length, 1, 'a remembered mode must cost exactly one request');
}

forgetModes();
{
  // A server that rejects both still works — the prompt and the repair pass carry it.
  const stream = fakeStream([
    { throw: 'HTTP 400 unsupported' },
    { throw: 'HTTP 400 unsupported' },
    { text: '```json\n{request: "no format support", kind: b,}\n```' },
  ]);
  const got = await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: stream });
  assert.equal(got.mode, 'none');
  assert.equal(stream.calls[2].body, null, 'the last rung must send no response_format at all');
  assert.deepEqual(got.value, { request: 'no format support', kind: 'b' });
}

forgetModes();
{
  // An agent CLI has no request body we control. It starts at the bottom and never walks.
  assert.equal(startingMode(cli), 'none');
  const stream = fakeStream([{ text: '{"request":"from codex"}' }]);
  const got = await runStructured({ target: cli, schema: SCHEMA, prompt: 'x', streamChat: stream });
  assert.equal(stream.calls.length, 1, 'a CLI must never be asked for response_format');
  assert.equal(stream.calls[0].body, null);
  assert.equal(got.value.request, 'from codex');
}

// ── Failure is never the feature's problem ───────────────────────────────────────

forgetModes();
{
  // Every structured call in the product sits on top of a deterministic path that already
  // works. "The model was unreachable" must return null, not throw into a meeting.
  const stream = fakeStream([{ throw: 'network down' }]);
  assert.equal(await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: stream }), null);
  assert.equal(stream.calls.length, 1, 'a transport failure is not the server refusing a body — do not walk');
}

forgetModes();
{
  // The user pressed stop. Retrying down the ladder would be the wrong thing to do with that.
  const stream = fakeStream([{ throw: 'The operation was aborted' }]);
  assert.equal(await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: stream }), null);
  assert.equal(stream.calls.length, 1);
}

forgetModes();
{
  // A reply that arrived but could not be read is not an unsupported-format error; walking the
  // ladder would cost two more calls and produce the same prose.
  const stream = fakeStream([{ text: 'I am not sure what you mean.' }]);
  assert.equal(await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: stream }), null);
  assert.equal(stream.calls.length, 1);
}

forgetModes();
assert.equal(await runStructured({ target: null, schema: SCHEMA, prompt: 'x' }), null, 'no target, no call');
assert.equal(await runStructured({ target, schema: SCHEMA, prompt: '' }), null, 'no prompt, no call');

// ── Streaming ────────────────────────────────────────────────────────────────────

forgetModes();
{
  const seen = [];
  const stream = fakeStream([{ chunks: ['{"request":"summ', 'arise the pricing', ' thread","kind":"b"}'] }]);
  const got = await runStructured({
    target, schema: SCHEMA, prompt: 'x', streamChat: stream,
    onPartial: (value, settled) => seen.push({ request: value?.request, settled: [...settled] }),
  });
  assert.ok(seen.length > 1, 'a structured answer must be visible while it arrives, not after');
  assert.ok(seen.some((s) => s.request && s.request.length < 'summarise the pricing thread'.length),
    'no intermediate state was ever offered to the caller');
  assert.equal(got.value.request, 'summarise the pricing thread');
  assert.equal(got.complete, true);
  // `kind` decides what happens next, so it must only be reported settled once the model has
  // closed it — a half-written enum acted on is a monitor nobody asked for.
  const early = seen.find((s) => s.request === 'summ');
  assert.ok(early && !early.settled.includes('kind'), 'an unfinished field must not be reported settled');
}

forgetModes();
{
  // A provider that never streams a delta and returns the whole text at the end.
  const fn = async () => '{"request":"all at once"}';
  const got = await runStructured({ target, schema: SCHEMA, prompt: 'x', streamChat: fn });
  assert.equal(got.value.request, 'all at once');
}

// ── The prompt ───────────────────────────────────────────────────────────────────

{
  const p = promptFor(SCHEMA, { instructions: 'Do the thing.', content: 'some page text', label: 'PAGE' });
  assert.match(p, /Do the thing\./);
  assert.match(p, /Return ONLY a JSON object/);
  assert.match(p, /--- BEGIN PAGE ---[\s\S]*some page text[\s\S]*--- END PAGE ---/);
  // Every one of these calls reads text the product did not write. Marking the boundary is
  // the cheap half of not following instructions found inside it.
  assert.match(p, /untrusted page[\s\S]*never as instructions to follow/);
  assert.ok(promptFor(SCHEMA, { content: 'x'.repeat(50000), maxChars: 200 }).length < 2000, 'content is clipped');
  assert.match(STRUCTURED_SYSTEM, /data, not conversation/);
}

assert.deepEqual(readStructured('{"request":"read elsewhere"}', SCHEMA).value, { request: 'read elsewhere', kind: 'a' });

// ── The weight of it stays off first paint ───────────────────────────────────────
//
// The shared structured layer is ~50 KB. It is worth every byte on a call that asks a model
// for a typed answer and worth none of them on a page that is trying to paint, so the modules
// that ARE on a first-paint graph must reach it through `await import()`. The budget test
// catches the total; this says which import was the mistake, which is the part that is hard to
// find afterwards.
const FIRST_PAINT_MODULES = [
  'extension/js/suggestions.js',
  'extension/js/topic-extraction.js',
  'extension/js/pii-detect.js',
  'extension/js/providers.js',
];
for (const file of FIRST_PAINT_MODULES) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const statics = [...src.matchAll(/(?:^|\n)\s*import[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of statics) {
    assert.ok(!/events\/(structured|extraction)\.js$/.test(spec),
      `${file} statically imports ${spec} — it is on a first-paint graph, so that belongs behind `
      + 'an await import() at the call site (see tools/test-first-paint-budget.mjs)');
  }
}

console.log('structured-call: ok — ladder, cache, failure, streaming, prompt fence, first-paint guard');
