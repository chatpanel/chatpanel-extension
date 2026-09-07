// The extension's own "what left this device" record.
//
// Entity detection is the ONE call that sends RAW, pre-redaction text off the machine — you
// cannot redact until you have detected — and `detection.url` may be any public http(s) host,
// not only loopback. It was SSRF-guarded and logged nowhere, so the gateway's access table
// answered "what left my machine" for agents and nothing answered it for this.
//
// The tests that matter here are not that it records. They are that the record cannot itself
// become the leak.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// chrome.storage stands in for the real thing; everything else is the shipped module.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (k in store ? { [k]: store[k] } : {}),
      set: async (o) => Object.assign(store, o),
      remove: async (k) => { delete store[k]; },
    },
  },
};

const { recordAccess, detectorEgressHook, accessRows, clearAccessLog } =
  await import('../extension/js/access-log.js');

// ── The record carries the fact, never the content ───────────────────────────────

await clearAccessLog();
detectorEgressHook('redaction')({
  backend: 'openai',
  host: 'ner.example.com',
  chars: 412,
  entities: 3,
  ms: 88,
  ok: true,
  error: '',
});
// The hook is fire-and-forget by design (observability must never be why detection fails),
// so let its write settle.
await new Promise((r) => setTimeout(r, 20));

let rows = await accessRows();
assert.equal(rows.length, 1, 'the detector hop was not recorded');
const [row] = rows;
assert.equal(row.client, 'redaction');
// The HOST, never the URL — a detector URL can carry an API key in its query string.
assert.equal(row.tool, 'detect:openai@ner.example.com');
assert.equal(row.ok, true);
assert.equal(row.ms, 88);
// Counts only. Numbers cannot leak what they counted.
assert.match(row.note, /3 entities/);
assert.match(row.note, /412 chars/);

// ── A row must never be able to hold the text it is about ────────────────────────
//
// A record of what was redacted must not itself contain the redacted data. `makeAccessEvent`
// enforces that for `args`; this asserts the door stays shut even when a caller tries.
await clearAccessLog();
await recordAccess({
  client: 'redaction',
  tool: 'detect:endpoint@localhost',
  ok: true,
  // Everything a careless caller might pass. None of it may survive into the row.
  args: { text: 'Alex Rivera met Jordan Blake', entities: ['Alex Rivera'] },
  note: 'Alex Rivera met Jordan Blake',
  counts: { entities: 2 },
});
rows = await accessRows();
const dump = JSON.stringify(rows[0]);
for (const secret of ['Alex Rivera', 'Jordan Blake']) {
  assert.equal(dump.includes(secret), false, `the access row leaked ${secret}`);
}
assert.equal(rows[0].note, '2 entities', 'the note must be built from counts, not from a caller string');

// ── It never breaks the thing it observes ────────────────────────────────────────

globalThis.chrome.storage.local.set = async () => { throw new Error('quota exceeded'); };
await assert.doesNotReject(
  () => recordAccess({ client: 'redaction', tool: 'detect:endpoint@localhost', ok: true }),
  'a storage failure must not propagate — logging is not allowed to break redaction',
);
globalThis.chrome.storage.local.set = async (o) => Object.assign(store, o);

// A hook that throws must not reach the detector either.
assert.doesNotThrow(() => detectorEgressHook('redaction')(null), 'a malformed egress report must be swallowed');

// ── Newest first, and bounded ────────────────────────────────────────────────────

await clearAccessLog();
for (let i = 0; i < 250; i++) await recordAccess({ client: 'redaction', tool: `detect:x@h${i}`, ok: true });
rows = await accessRows();
assert.ok(rows.length <= 200, `the ring is unbounded: ${rows.length} rows`);
assert.equal(rows[0].tool, 'detect:x@h249', 'newest first — the order the table wants');

// ── All three detector backends land in the one list ─────────────────────────────
//
// The endpoint/openai backends report through @chatpanel/pii's onEgress hook; the agent
// backend runs through dispatchStream and reports separately. A user asking what left their
// machine must not have to know which backend they picked.
{
  const src = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
  assert.match(src, /onEgress: detectorEgressHook\('redaction'\)/,
    'the endpoint/openai detector backends do not report their egress');
  assert.match(src, /logDetectorEgress\(target, detT0, text, null\)/,
    'the agent detector backend does not report a successful egress');
  assert.match(src, /logDetectorEgress\(target, detT0, '', e\)/,
    'the agent detector backend does not report a failed egress');
  // The import must stay dynamic: providers.js is on settings.js's first paint.
  assert.doesNotMatch(src, /^\s*import[^;]*from\s*['"]\.\/access-log\.js['"]/m,
    'access-log.js is statically imported by providers.js, which is on a first-paint graph');
}

// And the settings table shows both sources as one list.
{
  const src = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
  assert.match(src, /access-log\.js'\)\.then\(\(m\) => m\.accessRows\(\)\)/,
    'the settings table does not read this browser\'s own access rows');
  assert.match(src, /\.sort\(\(a, b\) => \(b\.ts \|\| 0\) - \(a\.ts \|\| 0\)\)/,
    'the merged rows are not ordered by time');
}

console.log('access-log: ok — the fact not the content, bounded, unbreakable, one list');
