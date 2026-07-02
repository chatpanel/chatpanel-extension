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

// ── @agent mentions (pure) ──────────────────────────────────────────────────────
// Pull an "@[Agent Name] task" mention out of a single note line. The instruction may
// sit BEFORE or AFTER the token — "Update the plan @[Agent]" and "@[Agent] update the
// plan" both resolve to the same task — so we take the whole line minus the token.
// Returns { name, task } (both '' when the line carries no runnable @[…] mention).
export function parseAgentMention(line) {
  const s = String(line || '');
  const m = s.match(/@\[([^\]\n]+)\]/);
  if (!m) return { name: '', task: '' };
  const name = m[1].trim();
  const task = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { name, task };
}

// ── research relevance (pure) ───────────────────────────────────────────────────
// Content-bearing terms of a query — lowercased words ≥4 chars that aren't stop-words,
// so relevance is judged on what the note is ABOUT, not "can/you/plan/today".
const RESEARCH_STOP = new Set(('the a an and or but for to of in on at by with from as is are was were be been being this that these those it its i you your my me we our they them he she his her can could would should will shall may might do does did done get got make made just like about into over under out up down off not no yes plan planning day today check please help note notes write writing').split(/\s+/));
export function salientTerms(q) {
  const out = new Set();
  for (const w of String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) || []) {
    if (!RESEARCH_STOP.has(w)) out.add(w);
  }
  return out;
}
// Relevance of a source card to the query's salient terms → a score (0 = unrelated;
// callers sort by it and drop zeros). A single shared GENERIC word ("trip", "morning")
// is NOT enough — that surfaces unrelated past notes (and their PII) — so a local card
// must share TWO terms, or one SPECIFIC (≥6-char) term. `web` results are already
// query-driven, so one shared term is enough to keep the junk out without over-gating.
export function researchRelevance(card, salient, { web = false } = {}) {
  if (!salient || !salient.size) return 0;
  const hay = `${card?.title || ''} ${card?.snippet || ''}`.toLowerCase();
  let hits = 0, specific = 0, score = 0;
  for (const t of salient) {
    if (!hay.includes(t)) continue;
    hits++; score += t.length >= 6 ? 2 : 1;
    if (t.length >= 6) specific++;
  }
  if (!hits) return 0;
  if (web || hits >= 2 || specific >= 1) return score;
  return 0; // a lone generic word → not related enough
}

// ── #skill mentions (pure) ─────────────────────────────────────────────────────
// Pull a "#[Skill Name]" mention out of a note command/task instruction. Returns the
// skill name (or '') and the instruction with the token removed.
export function parseSkillMention(instruction) {
  const s = String(instruction || '');
  const m = s.match(/#\[([^\]\n]+)\]/);
  if (!m) return { name: '', text: s.trim() };
  return { name: m[1].trim(), text: s.replace(m[0], '').replace(/[ \t]{2,}/g, ' ').trim() };
}
// Merge a skill's saved prompt with the user's task: substitute {{input}} placeholders
// when present, else append the task under the prompt.
export function mergeSkillPrompt(prompt, task) {
  const p = String(prompt || '');
  const t = String(task || '');
  if (/{{\s*input[^}]*}}/i.test(p)) return p.replace(/{{\s*input[^}]*}}/gi, t);
  return p ? (t ? `${p}\n\n${t}` : p) : t;
}
// Resolve a skill by display name (exact, then contains) from settings.skills.
export function findSkillByName(skills, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const list = Array.isArray(skills) ? skills : [];
  return list.find((s) => String(s?.name || s?.title || '').toLowerCase() === q)
    || list.find((s) => String(s?.name || s?.title || '').toLowerCase().includes(q))
    || null;
}
