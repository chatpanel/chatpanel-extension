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

// A connect that is still running is not started again. Without this, every turn during a
// slow first connect launches another one, and the slow server gets slower.
const inflight = new Map();

/**
 * Connect (or reuse) one server. Never rejects — a broken server is reported and skipped,
 * because one bad entry must not take the others down.
 */
function connectTask(s, { onError, timeoutMs, bridgeUrl, bridgeAvailable }) {
  const key = keyOf(s);
  const sig = sigOf(s);
  let entry = clients.get(key);
  if (entry && entry.sig !== sig) { clients.delete(key); entry = null; } // config edited → reconnect
  if (entry) return Promise.resolve(entry.client.tools.length ? mcpProvider(entry.client, entry.name) : null);
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const client = clientFor(s, bridgeUrl, bridgeAvailable);
      // stdio servers spawn a process on the bridge (often `npx`, which may download on
      // first run) — give them much longer than HTTP servers. Bridge-proxied http adds a
      // hop (and may front a slow upstream) → a bit more.
      const ms = s.command ? 45000 : (remoteViaBridge(s, bridgeAvailable) ? 20000 : timeoutMs);
      await withTimeout((signal) => client.connect(signal), ms);
      const fresh = { client, sig, name: s.name || s.url || s.command };
      clients.set(key, fresh);
      return client.tools.length ? mcpProvider(client, fresh.name) : null;
    } catch (e) {
      clients.delete(key);
      onError?.(s, e);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/**
 * The tool providers available NOW, waiting at most `budgetMs` for connections.
 *
 * A turn used to await every connect, and an stdio server is allowed 45 seconds because
 * `npx` may download on first run. So one cold server held the whole first message for
 * forty-five seconds before the model saw a single byte — measured, twice, in a user's
 * exported log (mcpMs 45002).
 *
 * The connect timeout was never the problem: a server that legitimately takes 45s to start
 * should still be allowed to. What was wrong is that the USER waited for it. The connect
 * now continues in the background and the turn proceeds without that server, which arrives
 * for the next turn. A tool that shows up a message late is a far smaller cost than a
 * product that appears frozen on first use.
 */
export async function getMcpProviders(servers, { onError, timeoutMs = 8000, bridgeUrl, bridgeAvailable = false, budgetMs = 4000 } = {}) {
  const enabled = (servers || []).filter((s) => s && s.enabled !== false && (s.url || s.command));
  if (!enabled.length) return [];

  // Record each result as it lands, so when the budget expires we can take whatever is
  // ready without cancelling anything still in flight.
  const ready = new Array(enabled.length).fill(null);
  const tasks = enabled.map((s, i) => connectTask(s, { onError, timeoutMs, bridgeUrl, bridgeAvailable })
    .then((p) => { ready[i] = p; return p; }));

  if (budgetMs > 0) {
    let timer;
    await Promise.race([
      Promise.all(tasks),
      new Promise((res) => { timer = setTimeout(res, budgetMs); }),
    ]);
    clearTimeout(timer);
  } else {
    await Promise.all(tasks);
  }
  return ready.filter(Boolean);
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
