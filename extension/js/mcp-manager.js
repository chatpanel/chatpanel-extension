// Holds live MCP client connections so we don't re-handshake every message, and
// turns the user's configured servers into tool providers for the registry.
// Never throws — a server that won't connect is skipped so it can't break a chat.

import { McpClient, mcpProvider } from './mcp-client.js';

const clients = new Map(); // key -> { client, sig, name }

const keyOf = (s) => s.id || s.url || s.command;
const sigOf = (s) => JSON.stringify([s.url, s.headers || {}, s.command, s.args, s.env || {}]);

// Build an McpClient from a server config: stdio (local command, via the bridge)
// or http (Streamable HTTP, direct).
function clientFor(s, bridgeUrl) {
  if (s.command) {
    return new McpClient({ transport: 'stdio', id: s.id, command: s.command, args: s.args, env: s.env, bridgeUrl });
  }
  return new McpClient({ url: s.url, headers: s.headers || {} });
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
export async function getMcpProviders(servers, { onError, timeoutMs = 8000, bridgeUrl } = {}) {
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
          const client = clientFor(s, bridgeUrl);
          // stdio servers spawn a process on the bridge (often `npx`, which may
          // download on first run) — give them much longer than HTTP servers.
          await withTimeout((signal) => client.connect(signal), s.command ? 45000 : timeoutMs);
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
export async function testMcpServer(server, { timeoutMs = 8000, bridgeUrl } = {}) {
  const client = clientFor(server, bridgeUrl);
  await withTimeout((signal) => client.connect(signal), server.command ? 45000 : timeoutMs);
  return client.tools;
}

export function resetMcp() {
  clients.clear();
}
