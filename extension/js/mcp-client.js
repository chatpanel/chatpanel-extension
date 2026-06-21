// Minimal MCP (Model Context Protocol) client over the Streamable HTTP transport
// — enough to initialize, list tools, and call them. Runs straight from the
// extension (MV3 can fetch HTTP/SSE; it CANNOT spawn stdio servers, so stdio MCP
// servers must be fronted by the bridge as HTTP). JSON-RPC 2.0 over POST; the
// server replies with either application/json or a text/event-stream of messages.
//
// Spec: https://modelcontextprotocol.io (Streamable HTTP, 2025-06-18).

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  constructor({ url, headers = {} } = {}) {
    this.url = url;
    this.headers = headers || {};
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

  // Read an SSE body until we see the JSON-RPC response matching `id`.
  async _readSse(res, id) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data) continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          const arr = Array.isArray(json) ? json : [json];
          for (const m of arr) {
            if (m.id === id) {
              if (m.error) throw new Error(`MCP error ${m.error.code}: ${m.error.message}`);
              return m.result;
            }
          }
        }
      }
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
    async execute(name, input) {
      const tool = name.startsWith(prefix) ? name.slice(prefix.length) : name;
      try {
        return toToolResult(await client.callTool(tool, input));
      } catch (e) {
        return JSON.stringify({ error: String(e?.message || e) });
      }
    },
  };
}
