// A small curated catalog of popular PUBLIC remote MCP servers that speak the
// Streamable HTTP transport (the only kind MV3 can reach directly — stdio servers
// can't run from a browser). Used by Settings → MCP → Discover for one-click add.
//
// These are run by their respective providers; endpoints and availability are out
// of our control and can change. `auth: true` means the server needs a token/login
// the user supplies after adding (via the row's Auth header field or its own OAuth).
export const MCP_CATALOG = [
  {
    name: 'DeepWiki',
    url: 'https://mcp.deepwiki.com/mcp',
    auth: false,
    desc: 'Ask questions about any public GitHub repository.',
  },
  {
    name: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    auth: false,
    desc: 'Up-to-date documentation & code examples for libraries.',
  },
  {
    name: 'Microsoft Learn',
    url: 'https://learn.microsoft.com/api/mcp',
    auth: false,
    desc: 'Microsoft, Azure & .NET official documentation.',
  },
  {
    name: 'Hugging Face',
    url: 'https://huggingface.co/mcp',
    auth: false,
    desc: 'Search models, datasets & Spaces (token optional for more).',
  },
  {
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: true,
    desc: 'Repositories, issues, pull requests & code search.',
  },
  {
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    auth: true,
    desc: 'Errors, issues & releases from your Sentry org.',
  },
];
