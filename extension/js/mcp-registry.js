export const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers';

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export function registryListUrl({ search = '', cursor = '', limit = 30 } = {}) {
  const url = new URL(MCP_REGISTRY_API);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(Math.max(1, Math.min(Number(limit) || 30, 100))));
  if (String(search || '').trim()) url.searchParams.set('search', String(search).trim());
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

export async function fetchMcpRegistryPage(opts = {}, fetchImpl = fetch) {
  const res = await fetchImpl(registryListUrl(opts), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Registry HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  return normalizeRegistryPage(await res.json());
}

export function normalizeRegistryPage(page = {}) {
  const items = (page.servers || [])
    .map(normalizeRegistryEntry)
    .filter(Boolean);
  return {
    items,
    nextCursor: page.metadata?.nextCursor || '',
    count: page.metadata?.count ?? items.length,
  };
}

export function normalizeRegistryEntry(entry = {}) {
  const server = entry.server || entry;
  const official = entry._meta?.[OFFICIAL_META] || server._meta?.[OFFICIAL_META] || {};
  if (!server?.name) return null;
  if (official.status && official.status !== 'active') return null;
  if (official.isLatest === false) return null;

  const remote = (server.remotes || []).find((r) => r?.type === 'streamable-http' && r.url);
  if (remote) {
    return baseItem(server, {
      kind: 'remote',
      url: remote.url,
      auth: hasAuthInputs(remote.headers),
    });
  }

  const pkg = (server.packages || [])
    .map(packageConfig)
    .find(Boolean);
  if (!pkg) return null;
  return baseItem(server, {
    kind: 'local',
    command: pkg.command,
    args: pkg.args,
    env: envPlaceholders(pkg.envInputs),
    auth: hasAuthInputs(pkg.envInputs),
    packageLabel: pkg.packageLabel,
  });
}

function baseItem(server, extra) {
  return {
    source: 'registry',
    registryName: server.name,
    name: server.title || humanName(server.name),
    version: server.version || '',
    desc: server.description || '',
    websiteUrl: server.websiteUrl || '',
    repositoryUrl: server.repository?.url || '',
    ...extra,
  };
}

function packageConfig(pkg = {}) {
  if (pkg.transport?.type !== 'stdio' || !pkg.identifier) return null;
  const id = pkg.identifier;
  const versioned = withVersion(id, pkg.version, pkg.registryType);
  if (pkg.registryType === 'npm') {
    return {
      // Always npx, even when the registry hints `bun`/`bunx`: our args are
      // npx-shaped (`-y <pkg>`, which bunx rejects), and npx ships with Node while
      // bun often isn't installed — so honoring the hint produces a broken command.
      // Normalizing to npx gives a runner that works out of the box. (The user can
      // still switch the command after adding.)
      command: 'npx',
      args: `-y ${versioned}`,
      envInputs: pkg.environmentVariables || [],
      packageLabel: `npm:${id}`,
    };
  }
  if (pkg.registryType === 'pypi') {
    return {
      command: pkg.runtimeHint || 'uvx',
      args: versioned,
      envInputs: pkg.environmentVariables || [],
      packageLabel: `pypi:${id}`,
    };
  }
  return null;
}

function withVersion(id, version, registryType) {
  if (!version) return id;
  if (registryType === 'pypi') return `${id}==${version}`;
  if (id.includes('@') && !id.startsWith('@')) return id;
  return `${id}@${version}`;
}

function hasAuthInputs(inputs = []) {
  return inputs.some((i) => i?.isRequired || i?.isSecret || /^authorization$/i.test(i?.name || ''));
}

function envPlaceholders(inputs = []) {
  return Object.fromEntries(
    inputs
      .filter((i) => i?.name)
      .map((i) => [i.name, i.value || '']),
  );
}

function humanName(name) {
  const leaf = String(name || '').split('/').pop() || name;
  return leaf
    .replace(/[-_]+/g, ' ')
    .replace(/\bmcp\b/gi, 'MCP')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
