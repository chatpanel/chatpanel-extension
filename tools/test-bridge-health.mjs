// The bridge health check: one fetch, no dependencies, and it cannot hang.
//
// Two faults, both on the path every panel open takes.
//
// 1 · IT LIVED IN THE MODEL LAYER. `checkBridge` was in providers.js, so init() →
//     refreshBridge() → `await import('./js/providers.js')` pulled 382 KB across 25 modules
//     on every open — to read one JSON object from localhost. The panel is built around
//     keeping that off first paint, and one line undid it. On a low-spec Windows machine
//     that is the difference between a panel that appears and one that hangs.
//
// 2 · IT COULD NOT TIME OUT. A bare fetch() with no signal. A REFUSED connection answers at
//     once, but a DROPPED one does not — Windows security software and corporate filters
//     routinely discard loopback SYNs instead of rejecting them, and the OS then retries for
//     ~21 seconds. The panel's agent header sat unresolved behind a promise that looked
//     healthy the whole time.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { checkBridge, HEALTH_TIMEOUT_MS, DEFAULT_BRIDGE_URL } =
  await import('../extension/js/bridge-health.js');

// ── it must not drag anything behind it ──────────────────────────────────────────
const src = readFileSync(new URL('../extension/js/bridge-health.js', import.meta.url), 'utf8');
assert.doesNotMatch(
  src, /^\s*import\s/m,
  'bridge-health.js must have NO imports — the moment it has one it can grow a graph again, '
  + 'and growing a graph is the entire bug it was extracted to fix',
);
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
assert.match(
  panel, /import \{ checkBridge \} from '\.\/js\/bridge-health\.js';/,
  'the panel must take the health check from the small module, not the model layer',
);
// The public name has to keep working for the pages that already import it from providers.
const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
assert.match(
  providers, /export \{ checkBridge \} from '\.\/bridge-health\.js';/,
  'providers.js must keep re-exporting checkBridge — settings.js, notes.js and '
  + 'bridge-update.js import it from there, and a moved export is a broken contract',
);

// ── a healthy bridge ─────────────────────────────────────────────────────────────
{
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([url, opts]);
    return { ok: true, json: async () => ({ agents: [{ id: 'codex', available: true }], version: '1.2.3', skills: { count: 4 } }) };
  };
  const r = await checkBridge('http://127.0.0.1:4319/', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.version, '1.2.3');
  assert.deepEqual(r.agents, [{ id: 'codex', available: true }]);
  assert.equal(r.skills.count, 4);
  assert.equal(seen[0][0], 'http://127.0.0.1:4319/health', 'a trailing slash must not double up');
  assert.ok(seen[0][1].signal, 'every call must carry an abort signal');
}
// An older bridge omits `skills` entirely — that is how a newer client learns not to call
// endpoints that are not there. Additive only; never a failure.
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '0.9.0' }) });
  const r = await checkBridge('', { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.agents, []);
  assert.equal(r.skills, null);
}

// ── THE TIMEOUT. A dropped packet must not hold the panel. ───────────────────────
{
  // Never settles unless aborted — exactly what a filtered loopback SYN looks like.
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      const e = new Error('The operation was aborted.');
      e.name = 'TimeoutError';
      reject(e);
    });
  });
  const started = Date.now();
  // AbortSignal.timeout uses an UNREF'd timer in Node, so with nothing else pending the
  // process would exit before it fires. Hold the loop open for the length of the check.
  const keepAlive = setTimeout(() => {}, 5000);
  const r = await checkBridge('http://127.0.0.1:4319', { fetchImpl, timeoutMs: 60 });
  clearTimeout(keepAlive);
  const took = Date.now() - started;
  assert.equal(r.ok, false);
  assert.ok(took < 2000, `a dropped connection must give up promptly, took ${took}ms`);
  assert.match(r.reason, /no response/i, 'and must say WHY — "signal is aborted without reason" says nothing');
  assert.doesNotMatch(r.reason, /abort/i, 'the browser\'s internal wording must not reach the user');
}
assert.ok(HEALTH_TIMEOUT_MS > 0 && HEALTH_TIMEOUT_MS <= 5000, 'loopback is fast or it is absent');
assert.equal(DEFAULT_BRIDGE_URL, 'http://127.0.0.1:4319', 'the default port is part of the contract');

// ── every other failure is a reason, never a throw ───────────────────────────────
// A status line that can throw is a panel that can go blank.
for (const [name, fetchImpl] of [
  ['refused', async () => { throw new Error('Failed to fetch'); }],
  ['bad status', async () => ({ ok: false, status: 502 })],
  ['not JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } })],
]) {
  const r = await checkBridge('http://127.0.0.1:4319', { fetchImpl });
  assert.equal(r.ok, false, `${name} must resolve, not reject`);
  assert.ok(r.reason, `${name} must carry a reason`);
}
assert.equal((await checkBridge('x', { fetchImpl: null, timeoutMs: 10 })).ok !== undefined, true,
  'a context with no fetch must still answer');

console.log('bridge health: ok');

// ── who started it ───────────────────────────────────────────────────────────────
// Bridge 0.11.12+ reports `managedBy` when ChatPanel Desktop registered it as a login
// service. The card uses it to stop offering install.sh for a runtime that is already
// installed and kept current by the app. Older bridges omit it, and that must read as ''.
{
  const reply = (body) => async () => ({ ok: true, json: async () => body });
  const managed = await checkBridge(DEFAULT_BRIDGE_URL, { fetchImpl: reply({ ok: true, version: '0.11.12', agents: [], managedBy: 'desktop' }) });
  assert.equal(managed.managedBy, 'desktop');
  const older = await checkBridge(DEFAULT_BRIDGE_URL, { fetchImpl: reply({ ok: true, version: '0.11.10', agents: [] }) });
  assert.equal(older.managedBy, '', 'an older bridge says nothing, and nothing is not "desktop"');
  const odd = await checkBridge(DEFAULT_BRIDGE_URL, { fetchImpl: reply({ ok: true, version: '0.11.12', agents: [], managedBy: { evil: 1 } }) });
  assert.equal(odd.managedBy, '', 'a non-string is not trusted into the UI');
}
console.log('ok  bridge-health: managedBy passes through, absent reads as none');
