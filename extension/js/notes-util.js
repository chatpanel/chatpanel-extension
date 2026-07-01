// notes-util.js — pure, dependency-free helpers shared across the Notes editor and its
// co-writer swarm. Nothing here touches module state or the DOM, so it's safe to reuse
// from any Notes feature module (and portable enough for the gateway/bridge to borrow).

// ── time / text ────────────────────────────────────────────────────────────────
export function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
export function highlight(text, q) {
  const t = escapeHtml(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return escapeHtml(text.slice(0, i)) + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>' + escapeHtml(text.slice(i + q.length));
}
// Escape markdown-significant brackets in link/anchor text so titles don't break syntax.
export function escapeMdText(s) { return String(s || '').replace(/[[\]]/g, '\\$&'); }
// Normalize a phrase into a hyphenated tag slug.
export const tagify = (s) => String(s).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

// The list snippet for a note: everything after the first line (the title), stripped of
// markdown noise and clipped.
export function snippetOf(body) {
  const b = String(body || '');
  const nl = b.indexOf('\n');
  const rest = nl >= 0 ? b.slice(nl + 1) : '';
  return rest.replace(/[#*_`>~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}

// ── research / source helpers ────────────────────────────────────────────────────
export const KIND_ICON = { note: '📝', meeting: '👥', chat: '💬', web: '🌐' };
export function sourceKind(sourceId = '') {
  if (sourceId.startsWith('note:')) return 'note';
  if (sourceId.startsWith('meeting:')) return 'meeting';
  return 'chat';
}
export function researchSnippet(text = '') {
  return String(text)
    .replace(/^(NOTE|CHAT|MEETING):.*$/gim, '').replace(/^(Date|Tags):.*$/gim, '')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}

// ── tool-trace helpers (activity panel + @command jobs) ──────────────────────────
export const JOB_ICON = { starting: '⏳', thinking: '💭', tool: '🔎', writing: '✍️' };

// Compact a (possibly structured) tool input into a short one-line preview.
export function compactInput(input, max = 60) {
  try {
    if (input == null) return '';
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  } catch { return ''; }
}
// Compact, readable tool names for the armed-toolset line (MCP tools are namespaced
// `mcp_<server>__<tool>` — show just server/tool), capped so the line stays short.
export function prettyTools(names) {
  const pretty = names.map((n) => {
    const m = /^mcp_(.+?)__(.+)$/.exec(n);
    return m ? `${m[1]}/${m[2]}` : n;
  });
  const shown = pretty.slice(0, 6).join(', ');
  return pretty.length > 6 ? `${shown}, +${pretty.length - 6} more` : shown;
}
export function toolTitle(name) {
  if (/^task$/i.test(name)) return 'subagent';
  const m = /^mcp_(.+?)__(.+)$/.exec(name || '');
  return m ? `${m[1]} / ${m[2]}` : (name || 'tool');
}
export function stepIcon(s) {
  if (/^task$/i.test(s.tool)) return '🪆'; // a spawned subagent
  if (/search/i.test(s.tool)) return '🌐';
  if (/^mcp_/.test(s.tool)) return '🔌';
  if (/^history_/.test(s.tool)) return '🗂';
  if (/^(read|write|edit|glob|grep|ls)$/i.test(s.tool)) return '📄';
  if (/^bash$/i.test(s.tool)) return '⌘';
  return '🔧';
}
