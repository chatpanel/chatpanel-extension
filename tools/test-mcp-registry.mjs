import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRegistryEntry,
  normalizeRegistryPage,
  registryListUrl,
} from '../extension/js/mcp-registry.js';

test('registryListUrl requests latest server versions with bounded limits', () => {
  const url = new URL(registryListUrl({ search: 'filesystem', cursor: 'next', limit: 500 }));
  assert.equal(url.origin + url.pathname, 'https://registry.modelcontextprotocol.io/v0/servers');
  assert.equal(url.searchParams.get('version'), 'latest');
  assert.equal(url.searchParams.get('search'), 'filesystem');
  assert.equal(url.searchParams.get('cursor'), 'next');
  assert.equal(url.searchParams.get('limit'), '100');
});

test('normalizeRegistryEntry maps streamable HTTP remotes to addable remote servers', () => {
  const item = normalizeRegistryEntry({
    server: {
      name: 'ai.example/docs',
      title: 'Example Docs',
      description: 'Docs for Example.',
      version: '1.2.3',
      remotes: [{
        type: 'streamable-http',
        url: 'https://example.ai/mcp',
        headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
      }],
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true },
    },
  });

  assert.deepEqual(item, {
    source: 'registry',
    registryName: 'ai.example/docs',
    name: 'Example Docs',
    version: '1.2.3',
    desc: 'Docs for Example.',
    websiteUrl: '',
    repositoryUrl: '',
    kind: 'remote',
    url: 'https://example.ai/mcp',
    auth: true,
  });
});

test('normalizeRegistryEntry maps npm stdio packages to local bridge commands', () => {
  const item = normalizeRegistryEntry({
    server: {
      name: 'io.github/example',
      description: 'Local tools.',
      version: '0.4.0',
      packages: [{
        registryType: 'npm',
        identifier: '@example/mcp-server',
        version: '0.4.0',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'EXAMPLE_TOKEN', isRequired: true, isSecret: true }],
      }],
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true },
    },
  });

  assert.equal(item.kind, 'local');
  assert.equal(item.command, 'npx');
  assert.equal(item.args, '-y @example/mcp-server@0.4.0');
  assert.deepEqual(item.env, { EXAMPLE_TOKEN: '' });
  assert.equal(item.auth, true);
});

test('normalizeRegistryPage drops non-latest and deprecated entries', () => {
  const page = normalizeRegistryPage({
    servers: [
      {
        server: { name: 'ok/server', remotes: [{ type: 'streamable-http', url: 'https://ok.test/mcp' }] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
      },
      {
        server: { name: 'old/server', remotes: [{ type: 'streamable-http', url: 'https://old.test/mcp' }] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false } },
      },
      {
        server: { name: 'deprecated/server', remotes: [{ type: 'streamable-http', url: 'https://deprecated.test/mcp' }] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated', isLatest: true } },
      },
    ],
    metadata: { nextCursor: 'cursor-2', count: 3 },
  });

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].url, 'https://ok.test/mcp');
  assert.equal(page.nextCursor, 'cursor-2');
  assert.equal(page.count, 3);
});
