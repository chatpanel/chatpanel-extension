import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
const toolset = readFileSync(new URL('../extension/js/toolset.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../extension/js/store.js', import.meta.url), 'utf8');

assert.match(html, /id="btn-mcp"/, 'Composer should expose an MCP tools control.');
assert.match(store, /mcpToolsMode:\s*'auto'/, 'Settings should default MCP tools to Auto.');
assert.match(js, /shouldExposeMcpForTurn/, 'Sidepanel should gate MCP providers with the context-aware policy helper.');
assert.match(js, /mcpMode:\s*m\.mcpMode/, 'Run profile should carry the user turn MCP mode.');
assert.match(js, /userText:\s*m\.content/, 'Run profile should carry the user text for MCP relevance gating.');
assert.match(js, /attachments:\s*m\.attachments/, 'Run profile should carry attachments for MCP relevance gating.');
assert.match(js, /mcpMode:\s*normalizeMcpTurnMode\(state\.settings\.ui\?\.mcpToolsMode\)/, 'User messages should persist the MCP mode used for that turn.');
assert.match(js, /withToolCancellation/, 'Sidepanel should wrap tools with cancellable execution.');
assert.match(js, /skipToolCall/, 'Sidepanel should expose a skip action for running tools.');
assert.match(js, /toolCancels:\s*new Map\(\)/, 'State should keep pending tool cancel handles.');
assert.match(js, /renderMcpToolsBtn/, 'Composer should render the MCP tools mode.');
assert.match(providers, /tools\.execute\(c\.name,\s*input,\s*\{\s*callId:\s*c\.id\s*\}\)/, 'OpenAI tools should pass a call id into execute.');
assert.match(providers, /tools\.execute\(b\.name,\s*input,\s*\{\s*callId:\s*b\.id\s*\}\)/, 'Anthropic tools should pass a call id into execute.');
assert.match(providers, /tools\.execute\(ev\.name,\s*ev\.input,\s*\{\s*callId:\s*ev\.id/, 'Bridge tool relay should pass a call id into execute.');
assert.match(toolset, /async execute\(name,\s*input,\s*meta/, 'Toolset execute should preserve metadata for wrappers/providers.');

console.log('MCP tool controls tests passed');
