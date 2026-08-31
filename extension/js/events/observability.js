// GENERATED — do not edit.
// Source of truth: chatpanel-events/observability.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// observability.js — the contract for "who consumed what, when, and how much is stored".
//
// ChatPanel's data is reachable by more than one agent now: the side panel, and any CLI
// (Codex, Claude Code, OpenCode…) wired to the gateway's MCP server. Once several agents
// read your history and skills, you need to SEE that — which agent touched what, and how
// much sits in each storage tier. That is one question with one answer shape, so it lives
// here, not re-derived in every client. The extension renders it; the gateway records it;
// a desktop/mobile app will do both against this same contract.
//
// Pure and dependency-free (the @chatpanel/events rule): identical code in browser ESM,
// the gateway (Node) and a mobile JS runtime. No clock, no storage, no platform APIs —
// the caller passes `ts`; the caller owns persistence.
//
// PRIVACY IS THE POINT of the redactor below. An access log that stored raw tool arguments
// would quietly become a second copy of every search query — the exact PII we redact
// everywhere else. So the note attached to each event is built from a per-tool WHITELIST of
// non-sensitive fields; a search query's TEXT is never recorded, only that a search ran.

export const ACCESS_LOG_VERSION = 1;

// Default ring size — enough to see a working session's activity without unbounded growth.
export const ACCESS_LOG_MAX = 500;

// Per-tool whitelist: which argument fields are safe to keep in the human note. Anything not
// listed here is dropped. Content-bearing fields (a search `query`) are deliberately ABSENT —
// the tool name already says "a search happened"; the words searched are not logged.
const SAFE_ARGS = {
  search_history: ['limit'],
  list_history: ['limit', 'offset'],
  get_record: ['id'],            // opaque record id, not content
  open_skill: ['skill'],         // skill names are catalog identifiers, not PII
  read_skill_file: ['skill', 'path'],
  list_skills: ['limit'],
};

/**
 * A short, SAFE descriptor of a call's arguments for display. Never returns content that
 * could carry PII. Unknown tools get an empty note (the tool name is the only signal).
 */
export function redactAccessArgs(tool, args) {
  const allow = SAFE_ARGS[tool];
  if (!allow || !args || typeof args !== 'object') return '';
  const parts = [];
  for (const key of allow) {
    const v = args[key];
    if (v === undefined || v === null || v === '') continue;
    // Cap any string field so a long id/path can't smuggle content or blow up the row.
    const s = typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 77)}…` : v) : String(v);
    parts.push(`${key}=${s}`);
  }
  return parts.join(' ');
}

/**
 * Normalize one access into the record everything stores and renders. `client` is the calling
 * agent's self-reported name (MCP clientInfo) — untrusted, so it's coerced to a short string.
 */
export function makeAccessEvent({ ts, client, tool, ok = true, ms, args, error } = {}) {
  return {
    v: ACCESS_LOG_VERSION,
    ts: Number(ts) || 0,
    client: shortStr(client, 'unknown', 60),
    tool: shortStr(tool, 'unknown', 60),
    ok: !!ok,
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null,
    note: redactAccessArgs(tool, args),
    error: error ? shortStr(error, '', 200) : '',
  };
}

function shortStr(v, fallback, max) {
  const s = (v == null ? '' : String(v)).trim() || fallback;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A tiny fixed-capacity ring for access events. Pure and synchronous — the gateway keeps one
 * in memory and snapshots it for the dashboard; the caller decides whether/how to persist.
 */
export function createAccessLog(max = ACCESS_LOG_MAX) {
  const cap = Math.max(1, max | 0);
  let buf = [];
  return {
    push(evt) { buf.push(evt); if (buf.length > cap) buf = buf.slice(buf.length - cap); return evt; },
    // Newest first, optionally limited — the order a dashboard wants.
    snapshot(limit) { const out = buf.slice().reverse(); return limit ? out.slice(0, limit) : out; },
    get size() { return buf.length; },
    clear() { buf = []; },
  };
}

// ── Storage tiers ────────────────────────────────────────────────────────────────────────
// One descriptor per place data lives: hot (browser), warm (local gateway), cold (cloud,
// future). The dashboard renders a row per tier; a tier that isn't configured says so.

export function makeStorageTier({ tier, label, present = true, records = null, bytes = null, newest = null, note = '' } = {}) {
  return {
    tier: String(tier || ''),
    label: String(label || tier || ''),
    present: !!present,
    records: records == null ? null : Math.max(0, records | 0),
    bytes: bytes == null ? null : Math.max(0, Number(bytes) || 0),
    newest: newest == null ? null : Number(newest) || 0,
    note: String(note || ''),
  };
}

/** Human-friendly byte size. Binary units, one decimal above KB. */
export function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
