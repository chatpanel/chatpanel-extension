// The Privacy Gateway is a separate process: a Pro extension must hand it the
// signed entitlement after the admin handshake, while Free/already-unlocked
// states must not write anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ensureGatewayEntitlement } from '../extension/js/gateway.js';

test('gateway entitlement sync is gated and posts the signed token exactly once', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body || '' });
    const payload = opts.method === 'POST'
      ? { pro: { unlocked: true, hasToken: true } }
      : { ok: true, version: '0.6.32', backend: 'api', pro: { unlocked: true }, usage: { used: 7, cap: 100 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    assert.equal((await ensureGatewayEntitlement('http://127.0.0.1:4320', { localPro: false, token: 'signed' })).synced, false);
    assert.equal((await ensureGatewayEntitlement('http://127.0.0.1:4320', { localPro: true, token: 'signed', unlocked: true })).synced, false);
    assert.equal((await ensureGatewayEntitlement('http://127.0.0.1:4320', { localPro: true, token: '' })).synced, false);
    assert.equal(calls.length, 0, 'non-Pro, unlocked, and tokenless states must not write gateway config');

    const result = await ensureGatewayEntitlement('http://127.0.0.1:4320/', {
      localPro: true,
      token: 'signed-entitlement',
      unlocked: false,
    });
    assert.equal(result.synced, true);
    assert.equal(result.status.pro.unlocked, true);
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [
      ['POST', 'http://127.0.0.1:4320/config'],
      ['GET', 'http://127.0.0.1:4320/status'],
    ]);
    assert.deepEqual(JSON.parse(calls[0].body), { pro: { entitlementToken: 'signed-entitlement' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gateway refresh wires automatic entitlement sync after connecting', () => {
  const source = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('async function refreshGateway()'), source.indexOf('// Show the status of the ACTIVE detector'));
  assert.match(refresh, /handshakeGatewayToken\(url\)/, 'refresh must authenticate the gateway admin API first');
  assert.match(refresh, /isPro\(license\).*gatewayState\.pro\?\.unlocked/s, 'refresh must detect local-Pro/gateway-Free drift');
  assert.match(refresh, /ensureGatewayEntitlement\(url/, 'refresh must repair entitlement drift automatically');
});

console.log('✓ gateway entitlement: Pro syncs automatically; Free and unlocked states do not write');
