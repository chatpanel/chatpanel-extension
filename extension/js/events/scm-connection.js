// GENERATED — do not edit.
// Source of truth: chatpanel-events/scm-connection.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// An SCM CONNECTION — how a harness engine reaches the organisation's source-control hub —
// and the two names a job gets in it: its branch and its worktree directory.
// (architecture-pillars.md §14: the repository is the source of truth.)
//
// ChatPanel is not a git host and not a git client. The harness runs `git`, `gh`, `glab`;
// ChatPanel brings the CREDENTIAL, the WORKTREE, the BRANCH NAME and the RECORD. This module
// is the pure part: what a connection record holds, how a remote URL maps to one, what a
// job's branch is called, and the environment that hands a token to git for ONE process
// without writing it anywhere.
//
// THE TOKEN IS NEVER IN THE RECORD. A connection stores a `secretRef` — the name under which
// the machine's keychain (or the bridge's secret store) holds the token. The record travels
// with the client-prefs document (`connections` section) so both clients show the same
// connections; the secret does not travel, and `normalizeConnection` REFUSES a record that
// carries one, so a settings export, a sync, or a prompt can never carry it either.

export const SCM_KINDS = Object.freeze(['github', 'github-enterprise', 'gitlab', 'bitbucket', 'gitea', 'azure-devops', 'git']);
export const CONNECTION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export const SECRET_REF_RE = /^[a-zA-Z0-9_.:@/-]{1,200}$/;
const SECRET_FIELDS = ['token', 'password', 'secret', 'pat', 'apiKey', 'key'];
const DEFAULT_HOST = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', 'azure-devops': 'dev.azure.com' };

export class ScmError extends Error {
  constructor(code, message) { super(message); this.name = 'ScmError'; this.code = code; }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The host a connection serves: its baseUrl's, or the kind's public host. */
export function hostOf(conn) {
  const url = String(conn?.baseUrl || '').trim();
  if (url) { try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase(); } catch { return url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; } }
  return DEFAULT_HOST[conn?.kind] || '';
}

export function validateConnection(conn) {
  const errors = [];
  if (!isRecord(conn)) return { ok: false, errors: ['connection must be an object'] };
  if (!CONNECTION_ID_RE.test(String(conn.id || ''))) errors.push('id: a short identifier (letters, digits, _ -)');
  if (!SCM_KINDS.includes(conn.kind)) errors.push(`kind: one of ${SCM_KINDS.join(', ')}`);
  const needsHost = ['github-enterprise', 'gitea', 'git'].includes(conn.kind);
  if (needsHost && !String(conn.baseUrl || '').trim()) errors.push('baseUrl: the hub\'s URL');
  if (conn.baseUrl && !/^(https?:\/\/)?[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(String(conn.baseUrl).trim())) errors.push('baseUrl: a host or URL');
  const leaked = SECRET_FIELDS.filter((k) => conn[k] !== undefined && conn[k] !== null && conn[k] !== '');
  if (leaked.length) errors.push(`${leaked.join(', ')}: a connection never stores a secret — store it in the keychain and reference it by secretRef`);
  if (conn.secretRef !== undefined && conn.secretRef !== null && conn.secretRef !== '' && !SECRET_REF_RE.test(String(conn.secretRef))) errors.push('secretRef: a keychain / secret-store name');
  if (conn.reach !== undefined && !Array.isArray(conn.reach)) errors.push('reach: a list of remotes or owners this connection may be used for');
  return { ok: errors.length === 0, errors };
}

/** The stored form. Throws on a record that carries a secret. */
export function normalizeConnection(conn) {
  const v = validateConnection(conn);
  if (!v.ok) throw new ScmError('INVALID', v.errors.join('; '));
  const id = String(conn.id);
  return {
    id,
    kind: conn.kind,
    label: String(conn.label || conn.name || '').trim().slice(0, 80) || `${conn.kind} · ${hostOf(conn) || id}`,
    ...(conn.baseUrl ? { baseUrl: String(conn.baseUrl).trim().replace(/\/+$/, '') } : {}),
    // The secret's NAME — `chatpanel:scm:<id>` by default — under which the keychain holds it.
    secretRef: String(conn.secretRef || '').trim() || `chatpanel:scm:${id}`,
    ...(conn.username ? { username: String(conn.username).trim().slice(0, 80) } : {}),
    // Which remotes it may be used for: `owner/*`, `owner/name`, or a host. Empty = any on its host.
    reach: (Array.isArray(conn.reach) ? conn.reach : []).map((r) => String(r).trim().toLowerCase()).filter(Boolean).slice(0, 64),
    enabled: conn.enabled !== false,
    ...(conn.createdAt ? { createdAt: conn.createdAt } : {}),
  };
}

/**
 * A remote URL, read: `{ host, owner, name, protocol }` for https, ssh (`git@host:o/n.git`,
 * `ssh://git@host/o/n`) and plain `host/o/n`. Credentials in the URL are dropped, never
 * returned. Null for what cannot be read.
 */
export function parseRemote(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  let m = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([a-z0-9.-]+)(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s.replace(/^https?:\/\/(?:[^@/]+@)?/i, ''));
  if (m && !/^https?:/i.test(s)) return { host: m[1].toLowerCase(), owner: m[2], name: m[3], protocol: /^ssh:|^[\w.-]+@/.test(s) ? 'ssh' : 'plain' };
  try {
    const u = new URL(s);
    const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    // Azure DevOps: /org/project/_git/repo; GitLab subgroups: /a/b/c/repo — owner is all but the last.
    const name = parts.at(-1);
    const owner = parts.slice(0, -1).filter((p) => p !== '_git').join('/');
    return { host: u.host.toLowerCase(), owner, name, protocol: u.protocol.replace(':', '') };
  } catch { return null; }
}

/**
 * The connection to use for a remote: enabled, same host, and — when the connection lists
 * a reach — the remote's `owner/name` or `owner/*` in it. The most specific reach wins.
 */
export function connectionFor(remote, connections = []) {
  const r = typeof remote === 'string' ? parseRemote(remote) : remote;
  if (!r) return null;
  const slug = `${r.owner}/${r.name}`.toLowerCase();
  let best = null; let bestScore = -1;
  for (const c of connections || []) {
    if (!c || c.enabled === false) continue;
    if (hostOf(c) !== r.host) continue;
    const reach = Array.isArray(c.reach) ? c.reach : [];
    let score = reach.length ? -1 : 0;
    for (const x of reach) {
      if (x === slug) score = Math.max(score, 3);
      else if (x.endsWith('/*') && slug.startsWith(x.slice(0, -1))) score = Math.max(score, 2);
      else if (x === r.host) score = Math.max(score, 1);
    }
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48) || 'x';

/** A job's branch: `cp/<project>/<job>` — one branch per job, always under `cp/`, never a protected name. */
export function branchFor(projectId, jobId) { return `cp/${slug(projectId)}/${slug(jobId)}`; }

/** A job's worktree directory under the bridge's worktree root: `<project>/<job>`. */
export function worktreeDirFor(projectId, jobId) { return `${slug(projectId)}/${slug(jobId)}`; }

/**
 * The environment that hands ONE process the token, scoped to the connection's host:
 * git's `credential.<url>.helper` set through `GIT_CONFIG_*` (never a file, never the
 * command line), a helper that reads the token from the environment, terminal prompts
 * off, and the hub CLIs' own variables (`GH_TOKEN` / `GH_HOST`, `GITLAB_TOKEN`) so `gh` and
 * `glab` work in the same process. The caller spawns with `{ ...process.env, ...env }` and
 * the token dies with the process.
 */
export function credentialEnv(conn, token, { username = null } = {}) {
  const c = conn || {};
  const host = hostOf(c);
  if (!host || !token) return {};
  const user = username || c.username || ({ github: 'x-access-token', 'github-enterprise': 'x-access-token', gitlab: 'oauth2', bitbucket: 'x-token-auth', gitea: 'oauth2', 'azure-devops': 'pat' }[c.kind] || 'token');
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `credential.https://${host}.helper`,
    // A shell helper: on `get`, answer from the environment. Nothing is written anywhere.
    GIT_CONFIG_VALUE_0: '!f() { if [ "$1" = get ]; then printf "username=%s\\npassword=%s\\n" "$CHATPANEL_SCM_USER" "$CHATPANEL_SCM_TOKEN"; fi; }; f',
    GIT_CONFIG_KEY_1: `credential.https://${host}.useHttpPath`,
    GIT_CONFIG_VALUE_1: 'false',
    CHATPANEL_SCM_USER: user,
    CHATPANEL_SCM_TOKEN: String(token),
  };
  if (c.kind === 'github' || c.kind === 'github-enterprise') {
    env.GH_TOKEN = String(token);
    if (c.kind === 'github-enterprise') { env.GH_ENTERPRISE_TOKEN = String(token); env.GH_HOST = host; }
  }
  if (c.kind === 'gitlab') { env.GITLAB_TOKEN = String(token); env.GITLAB_HOST = host; }
  return env;
}

/** One line a person reads: "GitHub · github.com · acme/*". */
export function describeConnection(conn) {
  const c = conn || {};
  const kindLabel = { github: 'GitHub', 'github-enterprise': 'GitHub Enterprise', gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Gitea', 'azure-devops': 'Azure DevOps', git: 'Git' }[c.kind] || c.kind;
  return `${kindLabel} · ${hostOf(c)}${c.reach?.length ? ` · ${c.reach.join(', ')}` : ''}${c.enabled === false ? ' (off)' : ''}`;
}

export function blankConnection() { return { id: '', kind: 'github', label: '', baseUrl: '', reach: [], username: '' }; }

/** The editor's form → a connection, or the errors. The token is NOT part of the form's record: the host stores it separately. */
export function connectionFromForm(form) {
  const f = form || {};
  const id = String(f.id || '').trim() || slug(f.label || `${f.kind}-${hostOf(f)}`);
  const conn = {
    id, kind: f.kind || 'github', label: String(f.label || '').trim(),
    ...(f.baseUrl ? { baseUrl: String(f.baseUrl).trim() } : {}),
    ...(f.username ? { username: String(f.username).trim() } : {}),
    ...(f.secretRef ? { secretRef: String(f.secretRef).trim() } : {}),
    reach: String(Array.isArray(f.reach) ? f.reach.join(',') : f.reach || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    enabled: f.enabled !== false,
    ...(f.createdAt ? { createdAt: f.createdAt } : {}),
  };
  const v = validateConnection(conn);
  return v.ok ? { ok: true, connection: normalizeConnection(conn) } : { ok: false, errors: v.errors };
}
