// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-traits.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// What a tool DOES to the world — read from its annotations, guessed from its name, and
// turned into the three decisions every host was making by hand.
//
// MCP tools carry `annotations` (readOnlyHint, destructiveHint, idempotentHint,
// openWorldHint) and nothing in any ChatPanel client read them. Meanwhile each client
// decided separately whether a call could run alongside another (never — every round ran
// one call at a time), whether a repeat could be answered from the last result (a
// hand-kept list of seven tool names), and whether an action deserved a confirmation
// (per-action, per-site rules with no idea what the tool itself declared). Three
// decisions, one fact underneath: is this a read, and could it destroy something.
//
// Annotations win when present. When absent, the NAME is read — `get_`, `list_`,
// `search_` on one side, `delete_`, `purge_`, `revoke_` on the other — with the
// conservative default in the middle: a tool nobody can classify is a write, not a read,
// and "unknown" is never promoted to "safe".
//
// Class R: strings in, booleans out. No I/O, so the extension, desktop, gateway and bridge
// give the same answer for the same spec.

const READ_VERBS = new Set([
  'get', 'list', 'search', 'read', 'find', 'fetch', 'query', 'describe', 'lookup', 'look', 'show',
  'view', 'count', 'check', 'status', 'recall', 'inspect', 'screenshot', 'preview', 'browse', 'grep',
  'glob', 'head', 'tail', 'cat', 'ls', 'stat', 'resolve', 'detect', 'validate', 'explain', 'summarize',
  'summarise', 'summary', 'history', 'recent', 'latest', 'whoami', 'info', 'render', 'compare', 'diff',
  'ping', 'health', 'select', 'retrieve', 'load', 'peek', 'watch', 'tools', 'schema', 'suggest', 'smart',
]);

// Anything that changes the world without necessarily destroying part of it. A name that
// carries one of these is never a read, whatever else it carries: `search_and_replace`
// searches, and replaces.
const WRITE_VERBS = new Set([
  'create', 'update', 'set', 'post', 'put', 'send', 'write', 'add', 'edit', 'move', 'rename',
  'upload', 'run', 'execute', 'exec', 'click', 'type', 'submit', 'save', 'insert', 'patch', 'apply',
  'merge', 'push', 'commit', 'start', 'stop', 'enable', 'disable', 'assign', 'close', 'reopen',
  'login', 'logout', 'install', 'replace', 'transfer', 'pay', 'order', 'book', 'schedule',
  'publish', 'deploy', 'restart', 'import', 'sync', 'remember', 'label', 'tag', 'mark', 'fill',
  'press', 'scroll', 'navigate', 'open', 'goto', 'drag', 'invoke', 'call', 'trigger', 'act',
]);

const DESTRUCTIVE_VERBS = new Set([
  'delete', 'remove', 'drop', 'purge', 'destroy', 'reset', 'clear', 'kill', 'wipe', 'revoke',
  'truncate', 'erase', 'overwrite', 'rm', 'rmdir', 'uninstall', 'terminate', 'ban', 'force',
  'unlink', 'discard', 'forget',
]);

// `mcp_<server>__<tool>` → `<tool>`; `jira:delete-issue` → `delete-issue`.
export function bareToolName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('__');
  return i >= 0 ? s.slice(i + 2) : s.replace(/^mcp[_-]/i, '');
}

const tokensOf = (name) => bareToolName(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function hasHint(a) {
  return !!a && typeof a === 'object' && ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].some((k) => typeof a[k] === 'boolean');
}

/**
 * @returns {{ readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean, source: 'annotations'|'heuristic' }}
 */
export function toolTraits(spec) {
  const name = typeof spec === 'string' ? spec : spec?.name;
  const a = typeof spec === 'object' && spec ? spec.annotations : null;
  const toks = tokensOf(name);
  const namedDestructive = toks.some((t) => DESTRUCTIVE_VERBS.has(t));
  const namedWrite = namedDestructive || toks.some((t) => WRITE_VERBS.has(t));
  // A read verb anywhere (`web_search`, `issue_get`) — as long as nothing in the name writes.
  const namedRead = !namedWrite && toks.some((t) => READ_VERBS.has(t));

  if (hasHint(a)) {
    const readOnly = a.readOnlyHint === true;
    // The spec's default for an absent destructiveHint is TRUE, which would put every
    // `create_issue` behind a confirmation. Explicit wins; absent falls back to the name.
    const destructive = readOnly ? false : (typeof a.destructiveHint === 'boolean' ? a.destructiveHint : namedDestructive);
    return {
      readOnly,
      destructive,
      idempotent: readOnly || a.idempotentHint === true,
      openWorld: typeof a.openWorldHint === 'boolean' ? a.openWorldHint : true,
      source: 'annotations',
    };
  }
  return { readOnly: namedRead, destructive: namedDestructive, idempotent: namedRead, openWorld: true, source: 'heuristic' };
}

/** Two reads never race each other for the world; a write is a barrier. */
export const canRunConcurrently = (t) => !!t?.readOnly;

/** A read asked twice has one answer, so the second can be served from the first. */
export const isCacheable = (t) => !!t?.readOnly;

/** Destroying is the one thing a person should be asked about, whatever the site rules say. */
export const needsConfirmation = (t) => t?.destructive === true;

/** Name → traits for a whole toolset, including the tools a dispatcher hides. */
export function traitsIndex(specs = []) {
  const index = new Map();
  for (const s of specs) if (s?.name) index.set(s.name, toolTraits(s));
  return index;
}
