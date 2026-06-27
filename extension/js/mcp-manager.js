// Holds live MCP client connections so we don't re-handshake every message, and
// turns the user's configured servers into tool providers for the registry.
// Never throws — a server that won't connect is skipped so it can't break a chat.

import { McpClient, mcpProvider } from './mcp-client.js';

const clients = new Map(); // key -> { client, sig, name }

const keyOf = (s) => s.id || s.url || s.command;
const sigOf = (s) => JSON.stringify([s.url, s.headers || {}, s.command, s.args, s.env || {}, s.remoteMode || 'auto']);

// Should this remote (http) server be reached via the bridge (server-side fetch,
// no browser Origin) rather than a direct fetch? mode: 'auto' (bridge when the
// bridge is running, else direct), 'bridge' (always), 'direct' (never).
const remoteViaBridge = (s, bridgeAvailable) =>
  !s.command && ((s.remoteMode || 'auto') === 'bridge' || ((s.remoteMode || 'auto') === 'auto' && !!bridgeAvailable));

// Build an McpClient from a server config: stdio (local command, via the bridge),
// or http (Streamable HTTP) connected directly OR proxied through the bridge.
function clientFor(s, bridgeUrl, bridgeAvailable) {
  if (s.command) {
    return new McpClient({ transport: 'stdio', id: s.id, command: s.command, args: s.args, env: s.env, bridgeUrl });
  }
  return new McpClient({ url: s.url, headers: s.headers || {}, bridgeUrl, viaBridge: remoteViaBridge(s, bridgeAvailable) });
}

async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

// Connect (or reuse) each enabled server and return its tool provider. Servers
// whose config changed since last time are reconnected; failures are reported
// via onError and skipped.
export async function getMcpProviders(servers, { onError, timeoutMs = 8000, bridgeUrl, bridgeAvailable = false } = {}) {
  const enabled = (servers || []).filter((s) => s && s.enabled !== false && (s.url || s.command));
  const providers = [];
  await Promise.all(
    enabled.map(async (s) => {
      const key = keyOf(s);
      const sig = sigOf(s);
      let entry = clients.get(key);
      if (entry && entry.sig !== sig) {
        clients.delete(key); // config edited → drop and reconnect
        entry = null;
      }
      try {
        if (!entry) {
          const client = clientFor(s, bridgeUrl, bridgeAvailable);
          // stdio servers spawn a process on the bridge (often `npx`, which may
          // download on first run) — give them much longer than HTTP servers.
          // Bridge-proxied http adds a hop (and may front a slow upstream) → a bit more.
          const ms = s.command ? 45000 : (remoteViaBridge(s, bridgeAvailable) ? 20000 : timeoutMs);
          await withTimeout((signal) => client.connect(signal), ms);
          entry = { client, sig, name: s.name || s.url || s.command };
          clients.set(key, entry);
        }
        if (entry.client.tools.length) providers.push(mcpProvider(entry.client, entry.name));
      } catch (e) {
        clients.delete(key);
        onError?.(s, e);
      }
    }),
  );
  return providers;
}

// Test a single server config (used by Settings "Test" button). Returns the
// tool list on success; throws on failure.
export async function testMcpServer(server, { timeoutMs = 8000, bridgeUrl, bridgeAvailable = false } = {}) {
  const client = clientFor(server, bridgeUrl, bridgeAvailable);
  const ms = server.command ? 45000 : (remoteViaBridge(server, bridgeAvailable) ? 20000 : timeoutMs);
  await withTimeout((signal) => client.connect(signal), ms);
  return client.tools;
}

export function resetMcp() {
  clients.clear();
}
