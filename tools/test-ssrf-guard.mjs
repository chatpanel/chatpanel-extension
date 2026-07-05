// SSRF guard (context.js assertFetchable) — the panel holds <all_urls>, so a pasted
// or redirected-to URL must never reach loopback / LAN / cloud metadata. Classification
// is delegated to the shared vendored net.js; this pins the extension's policy + messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFetchable } from '../extension/js/context.js';

test('blocks loopback, LAN, and cloud metadata', () => {
  for (const u of [
    'http://127.0.0.1:4319/health',       // the local bridge
    'http://localhost:8080/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://100.64.0.1/',                 // CGNAT
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://printer.local/',
  ]) {
    assert.throws(() => assertFetchable(u), /private\/loopback\/metadata/, `${u} must be blocked`);
  }
});

test('allows genuinely public hosts', () => {
  for (const u of ['https://example.com/x', 'http://8.8.8.8/', 'https://172.15.0.1/', 'https://172.32.0.1/']) {
    assert.doesNotThrow(() => assertFetchable(u), `${u} should be allowed`);
  }
});

test('rejects non-http(s) schemes and junk', () => {
  assert.throws(() => assertFetchable('file:///etc/passwd'), /Only http/);
  assert.throws(() => assertFetchable('javascript:alert(1)'), /Only http/);
  assert.throws(() => assertFetchable('not a url'), /Invalid URL/);
});
