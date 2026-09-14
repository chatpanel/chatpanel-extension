import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
// Every path — both API providers' rounds and the bridge's one-at-a-time relay — runs its
// calls through the shared call runner (events/turn-loop.js), which is where the call id
// reaches execute.
const turnLoop = readFileSync(new URL('../extension/js/events/turn-loop.js', import.meta.url), 'utf8');
// The registry is the shared copy now (@chatpanel/events/toolset.js); the extension's own
// file only hands in the MCP guidance. The contract under test lives in the vendored module.
const toolset = readFileSync(new URL('../extension/js/events/toolset.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../extension/js/store.js', import.meta.url), 'utf8');
const turnTools = readFileSync(new URL('../extension/js/turn-tools.js', import.meta.url), 'utf8');
// MCP gating moved out of turn-tools into a registered tool group — the decision is
// unchanged, the file that owns it is not.
const mcpGroup = readFileSync(new URL('../extension/js/tool-groups/mcp.js', import.meta.url), 'utf8');

assert.match(html, /id="btn-mcp"/, 'Composer should expose an MCP tools control.');
assert.match(store, /mcpToolsMode:\s*'auto'/, 'Settings should default MCP tools to Auto.');
// Turn-arming (tools + MCP gating) lives in the shared turn-tools capability that
// both the side panel and Notes call; the side panel delegates to it.
assert.match(mcpGroup, /shouldExposeMcpForTurn/, 'The MCP tool group should gate providers with the context-aware policy helper.');
// And the group must still be reachable from the shared turn assembly both surfaces call.
assert.match(turnTools, /buildToolGroups/, 'turn-tools should assemble the registered tool groups.');
assert.match(js, /buildTurnTools/, 'Sidepanel should arm tools via the shared buildTurnTools capability.');
assert.match(js, /mcpMode:\s*m\.mcpMode/, 'Run profile should carry the user turn MCP mode.');
assert.match(js, /userText:\s*m\.content/, 'Run profile should carry the user text for MCP relevance gating.');
assert.match(js, /attachments:\s*m\.attachments/, 'Run profile should carry attachments for MCP relevance gating.');
assert.match(js, /mcpMode:\s*normalizeMcpTurnMode\(state\.settings\.ui\?\.mcpToolsMode\)/, 'User messages should persist the MCP mode used for that turn.');
assert.match(js, /withToolCancellation/, 'Sidepanel should wrap tools with cancellable execution.');
assert.match(js, /skipToolCall/, 'Sidepanel should expose a skip action for running tools.');
assert.match(js, /toolCancels:\s*new Map\(\)/, 'State should keep pending tool cancel handles.');
assert.match(js, /renderMcpToolsBtn/, 'Composer should render the MCP tools mode.');
assert.match(turnLoop, /tools\.execute\(c\.name,\s*c\.input,\s*\{\s*callId:\s*c\.id,/, 'The call runner should pass a call id into execute.');
assert.match(providers, /function streamOpenAI[\s\S]*runSharedLoop\(/, 'OpenAI tools should run through the shared loop.');
assert.match(providers, /function streamAnthropic[\s\S]*runSharedLoop\(/, 'Anthropic tools should run through the shared loop.');
assert.match(providers, /r\.one\(ev,\s*\{\s*session:\s*ev\.session\s*\}\)/, 'Bridge tool relay should answer through the same runner, with the session in the meta.');
assert.match(toolset, /async execute\(name,\s*input,\s*meta/, 'Toolset execute should preserve metadata for wrappers/providers.');

console.log('MCP tool controls tests passed');
