// The privacy boundary of warm sync: the decrypted corpus may leave the browser
// ONLY toward a loopback gateway. A non-loopback `warmSearch.url` must fail closed
// — never a "try anyway" that ships plaintext history to a remote host.
import assert from 'node:assert/strict';
import { isLoopbackGateway, syncHistoryToGateway } from '../extension/js/warm-sync.js';

for (const url of ['http://127.0.0.1:4320', 'http://localhost:4320', 'http://[::1]:4320', 'http://foo.localhost:4320']) {
  assert.equal(isLoopbackGateway(url), true, `${url} is loopback`);
}
for (const url of ['http://evil.example.com', 'https://10.0.0.5:4320', 'http://169.254.169.254', 'not a url', '']) {
  assert.equal(isLoopbackGateway(url), false, `${url} is NOT loopback`);
}

// End to end: a remote URL must refuse to send, and fetch must never be called.
let fetched = 0;
const fetchImpl = async () => { fetched++; return { ok: true, json: async () => ({ size: 1 }) }; };
const loadSources = async () => [{ id: 'a', text: 'hello', title: 't', type: 'note', date: 1 }];

const remote = await syncHistoryToGateway('http://evil.example.com', { loadSources, fetchImpl });
assert.equal(remote.ok, false, 'remote gateway refused');
assert.match(remote.error || '', /loopback/i, 'refusal names the reason');
assert.equal(fetched, 0, 'nothing was sent off-box');

const local = await syncHistoryToGateway('http://127.0.0.1:4320', { loadSources, fetchImpl });
assert.equal(local.ok, true, 'loopback gateway proceeds');
assert.equal(fetched, 1, 'one batch sent to the local gateway');

console.log('ok — warm sync fails closed off-loopback, proceeds on loopback');
