// Minimal MCP (Model Context Protocol) client over the Streamable HTTP transport
// — enough to initialize, list tools, and call them. Runs straight from the
// extension (MV3 can fetch HTTP/SSE; it CANNOT spawn stdio servers, so stdio MCP
// servers must be fronted by the bridge as HTTP). JSON-RPC 2.0 over POST; the
// server replies with either application/json or a text/event-stream of messages.
//
// Spec: https://modelcontextprotocol.io (Streamable HTTP, 2025-06-18).

import { mcpInventorySystem } from './tool-hints.js';
import { adaptiveToolRetryHint } from './adaptive-tool-policy.js';

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  // Two transports:
  //   http  — { url, headers }: connect straight to a Streamable HTTP server.
  //   stdio — { transport:'stdio', id, command, args, env, bridgeUrl }: the
  //           extension can't spawn processes, so proxy JSON-RPC through the
  //           bridge's POST /mcp-local, which spawns & keeps the process alive.
  constructor({ url, headers = {}, transport, id, command, args, env, bridgeUrl } = {}) {
    this.transport = transport === 'stdio' || command ? 'stdio' : 'http';
    this.url = url;
    this.headers = headers || {};
    this.id = id;
    this.command = command;
    this.args = args;
    this.env = env;
    this.bridgeUrl = (bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
    this.sessionId = null;
    this.tools = [];
    this._id = 0;
  }

  _hdrs() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  // POST one JSON-RPC message. For requests (with id) return the result; for
  // notifications (no id) return null. Handles both json and SSE responses.
  async _send(message, signal) {
    if (this.transport === 'stdio') return this._sendLocal(message, signal);
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this._hdrs(),
      body: JSON.stringify(message),
      signal,
    });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    if (message.id == null) {
      // Notification — drain and ignore (often 202 Accepted with empty body).
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return null;
    }
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('text/event-stream')) return this._readSse(res, message.id);
    return this._unwrap(await res.json(), message.id);
  }

  _unwrap(json, id) {
    const msg = Array.isArray(json) ? json.find((m) => m.id === id) : json;
    if (!msg) throw new Error('MCP: no response for request');
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  // stdio transport: relay the message through the bridge, which owns the process.
  async _sendLocal(message, signal) {
    let res;
    try {
      res = await fetch(`${this.bridgeUrl}/mcp-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: { id: this.id, command: this.command, args: this.args, env: this.env },
          message,
        }),
        signal,
      });
    } catch (e) {
      throw new Error(`Can't reach the ChatPanel Bridge for local MCP (${e.message}). Start it with \`npx @chatpanel/bridge\`.`);
    }
    if (message.id == null) return null; // notification → 202, no body
    if (!res.ok) throw new Error(`Bridge MCP HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const msg = await res.json();
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  // Read an SSE body until we see the JSON-RPC response matching `id`.
  async _readSse(res, id) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let data = []; // accumulated `data:` lines of the current event
    // A complete SSE event (terminated by a blank line) holds one JSON-RPC
    // message; return it if its id matches. Tolerates \n and \r\n line endings.
    const take = () => {
      if (!data.length) return undefined;
      const payload = data.join('\n');
      data = [];
      let json;
      try { json = JSON.parse(payload); } catch { return undefined; }
      for (const m of Array.isArray(json) ? json : [json]) {
        if (m.id === id) {
          if (m.error) throw new Error(`MCP error ${m.error.code}: ${m.error.message}`);
          return { result: m.result };
        }
      }
      return undefined;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line === '') {
            const hit = take(); // blank line = end of event
            if (hit) return hit.result;
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''));
          }
          // ignore other SSE fields (event:, id:, retry:) and `:` comments
        }
      }
      const hit = take(); // stream ended — flush a trailing event with no blank line
      if (hit) return hit.result;
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    throw new Error('MCP: stream ended without a response');
  }

  _rpc(method, params, signal) {
    return this._send({ jsonrpc: '2.0', id: ++this._id, method, params }, signal);
  }

  async connect(signal) {
    await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ChatPanel', version: '1.0' },
    }, signal);
    // Best-effort "initialized" notification (some servers require it).
    await this._send({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch(() => {});
    await this.listTools(signal);
    return this;
  }

  async listTools(signal) {
    const result = await this._rpc('tools/list', {}, signal);
    this.tools = result?.tools || [];
    return this.tools;
  }

  callTool(name, args, signal) {
    return this._rpc('tools/call', { name, arguments: args || {} }, signal);
  }
}

// kebab/slug a server name for use in a namespaced tool id.
function slug(s) {
  return String(s || 'mcp').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
}

// Convert an MCP tool-call result ({content:[{type,text|data}], isError}) into
// our executor contract: a string, or { text, image } when an image is returned.
function toToolResult(res) {
  const content = Array.isArray(res?.content) ? res.content : [];
  const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text);
  const img = content.find((c) => c.type === 'image' && c.data);
  let text = texts.join('\n');
  if (!text) text = JSON.stringify({ ok: !res?.isError });
  if (res?.isError) text = `error: ${text}`;
  if (img) return { text, image: `data:${img.mimeType || 'image/png'};base64,${img.data}` };
  return text;
}

// Wrap a connected McpClient as a generic tool provider. Tool names are
// namespaced (mcp_<server>__<tool>) so they never collide with page tools or
// other servers.
export function mcpProvider(client, serverName) {
  const prefix = `mcp_${slug(serverName)}__`;
  const specs = (client.tools || []).map((t) => ({
    name: prefix + t.name,
    description: `[${serverName}] ${t.description || t.name}`.slice(0, 1024),
    parameters: t.inputSchema || { type: 'object', properties: {} },
  }));
  return {
    specs,
    system: mcpInventorySystem(serverName, specs),
    async execute(name, input) {
      const tool = name.startsWith(prefix) ? name.slice(prefix.length) : name;
      try {
        return toToolResult(await client.callTool(tool, input));
      } catch (e) {
        const message = String(e?.message || e);
        return JSON.stringify({
          error: message,
          tool: name,
          retry_hint: adaptiveToolRetryHint(name),
        });
      }
    },
  };
}
