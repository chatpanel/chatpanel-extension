// L3 wiring: buildToolset derives an explicit remoteTools set (from a provider's
// `remote` flag, with the mcp_ name as fallback), and the harness uses it — so a
// remote tool that ISN'T mcp_-prefixed still keeps PII off it under "redact remote".
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolset } from '../extension/js/toolset.js';
import { makeToolHarness } from '../extension/js/tool-harness.js';
import { createVault, redactText } from '../extension/js/pii-redact.js';

test('buildToolset flags remote-provider tools + mcp_ names, not locals', () => {
  const ts = buildToolset([
    { remote: true, specs: [{ name: 'weird_search', description: 'x' }], execute: async () => 'ok' },
    { specs: [{ name: 'read_page', description: 'y' }], execute: async () => 'ok' },
    { specs: [{ name: 'mcp_wiki__q', description: 'z' }], execute: async () => 'ok' },
  ]);
  assert.equal(ts.remoteTools.has('weird_search'), true);  // by provider flag
  assert.equal(ts.remoteTools.has('mcp_wiki__q'), true);   // by name fallback
  assert.equal(ts.remoteTools.has('read_page'), false);    // local stays local
});

test('harness keeps PII off a non-mcp_ remote tool via the explicit set', () => {
  const v = createVault();
  const OPTS = { tier: 'full', entities: [{ value: 'Microsoft', type: 'ORG' }] };
  redactText('I am at Microsoft', v, OPTS);
  const ts = buildToolset([{ remote: true, specs: [{ name: 'weird_search' }], execute: async () => 'ok' }]);
  const h = makeToolHarness({ vault: v, toolData: 'redactRemote', redactOpts: OPTS, remoteTools: ts.remoteTools });
  assert.deepEqual(h.toTool('weird_search', { q: '[[ORG_1]]' }), { q: '[[ORG_1]]' }); // stays redacted
  assert.deepEqual(h.toTool('local_lookup', { q: '[[ORG_1]]' }), { q: 'Microsoft' });  // local → real
});
