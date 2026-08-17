// GENERATED — do not edit.
// Source of truth: chatpanel-events/mcp-errors.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Turn an MCP launch failure into something a person can act on.
//
// A local MCP server that will not start reports whatever its process printed, and that is
// usually a wall of shell noise. A real example: a published package whose executable has
// no `#!/usr/bin/env node` line, so the SHELL ran a JavaScript file and produced twelve
// lines of "import: command not found". Nothing in that says what is wrong, whose fault it
// is, or what to do — and the natural reading is "ChatPanel is broken", which is the one
// interpretation that is definitely false.
//
// The signatures are recognisable, so recognising them is cheap. Where we cannot recognise
// one, the raw output is still shown: a wrong explanation is worse than none.
//
// Shared because the gateway and the bridge launch the same servers and will hit the same
// failures — diagnosing them in three places would produce three different diagnoses.

const RULES = [
  {
    id: 'missing-shebang',
    // `import:`/`const:` "command not found" means a shell executed JavaScript.
    test: (t) => /(import|const|export):\s*(command not found|not found)/i.test(t)
      || /syntax error near unexpected token/i.test(t) && /command not found/i.test(t),
    explain: (pkg) => ({
      summary: `${pkg || 'This MCP server'} cannot start: its executable is missing a shebang.`,
      detail:
        'The package\'s entry file is JavaScript but has no `#!/usr/bin/env node` first line, so the '
        + 'shell tries to run it as a shell script. That is a bug in the published package, not in your '
        + 'setup — nothing you configure here can fix it.',
      fix: 'Report it to the package author, pin an earlier version that worked, or use a different server.',
      blame: 'package',
    }),
  },
  {
    id: 'not-found',
    test: (t) => /npm ERR!.*(404|E404)|could not determine executable|command not found: npx/i.test(t),
    explain: (pkg) => ({
      summary: `${pkg || 'The package'} could not be found or has no runnable command.`,
      detail: 'npm resolved nothing to run for this package name and version.',
      fix: 'Check the package name and version, and that the registry in use publishes it.',
      blame: 'config',
    }),
  },
  {
    id: 'no-bridge',
    test: (t) => /can'?t reach the chatpanel bridge|ECONNREFUSED.*4319/i.test(t),
    explain: () => ({
      summary: 'The ChatPanel Bridge is not running.',
      detail: 'Local MCP servers are launched by the bridge, so nothing can start without it.',
      fix: 'Start it with `npx @chatpanel/bridge`, then try again.',
      blame: 'setup',
    }),
  },
  {
    id: 'node-version',
    test: (t) => /requires node|unsupported engine|SyntaxError: Unexpected token '\?\?'/i.test(t),
    explain: (pkg) => ({
      summary: `${pkg || 'This server'} needs a newer Node than the one launching it.`,
      detail: 'The process started but failed on syntax its Node version does not support.',
      fix: 'Upgrade Node, or run the server with a version manager that selects a newer one.',
      blame: 'setup',
    }),
  },
];

/**
 * @returns { id, summary, detail, fix, blame, raw } — or null when nothing is recognised,
 * because a confident wrong explanation costs more than showing the output as it came.
 */
export function explainMcpError(text, { packageName = '' } = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const rule of RULES) {
    if (!rule.test(t)) continue;
    return { id: rule.id, ...rule.explain(packageName), raw: t };
  }
  return null;
}

/** The package a command was trying to run, for naming it in the explanation. */
export function packageFromArgs(args = []) {
  for (const a of args) {
    const s = String(a);
    if (s.startsWith('-')) continue;
    if (s === 'npx' || s === 'node') continue;
    return s;
  }
  return '';
}
