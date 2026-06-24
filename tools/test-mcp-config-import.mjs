import test from 'node:test';
import assert from 'node:assert/strict';
import { argsToText, parseArgsInput, parseMcpConfig } from '../extension/js/mcp-config-import.js';

const jiraToml = `
[mcp_servers.central_jira_confluence]
startup_timeout_sec = 300
command = "uvx"
type = "stdio"
args = [
  "--python", "3.12",
  "--default-index", "https://pypi.example.com/simple",
  "mcp-atlassian",
  "--jira-url", "https://jira.example.com",
  "--jira-use-web-session",
  "--confluence-url", "https://confluence.example.com",
  "--confluence-use-web-session"
]
`;

test('parseMcpConfig imports Codex-style stdio TOML args as an argv array', () => {
  const [server] = parseMcpConfig(jiraToml);
  assert.equal(server.name, 'Central Jira Confluence');
  assert.equal(server.transport, 'stdio');
  assert.equal(server.command, 'uvx');
  assert.deepEqual(server.args, [
    '--python',
    '3.12',
    '--default-index',
    'https://pypi.example.com/simple',
    'mcp-atlassian',
    '--jira-url',
    'https://jira.example.com',
    '--jira-use-web-session',
    '--confluence-url',
    'https://confluence.example.com',
    '--confluence-use-web-session',
  ]);
});

test('parseMcpConfig imports remote HTTP TOML with headers', () => {
  const [server] = parseMcpConfig(`
[mcp_servers.movies]
type = "http"
url = "https://gateway.pipeworx.io/movies/mcp?_apiKey=abc"
headers = { Authorization = "Bearer token", "X-Team" = "dev" }
`);
  assert.deepEqual(server, {
    name: 'Movies',
    enabled: true,
    transport: 'http',
    url: 'https://gateway.pipeworx.io/movies/mcp?_apiKey=abc',
    headers: { Authorization: 'Bearer token', 'X-Team': 'dev' },
  });
});

test('parseMcpConfig imports Claude-style JSON mcpServers', () => {
  const [server] = parseMcpConfig(JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { FOO: 'bar' },
      },
    },
  }));
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.deepEqual(server.env, { FOO: 'bar' });
});

test('parseArgsInput handles shell-style multiline arguments', () => {
  assert.deepEqual(parseArgsInput('--python 3.12\n--default-index "https://example.test/simple"'), [
    '--python',
    '3.12',
    '--default-index',
    'https://example.test/simple',
  ]);
});

test('argsToText displays arrays one argument per line', () => {
  assert.equal(argsToText(['--python', '3.12', 'mcp-atlassian']), '--python\n3.12\nmcp-atlassian');
});
