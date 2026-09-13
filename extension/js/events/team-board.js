// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-board.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The board — what a team's members say to each other, as typed findings, not talk.
//
// Members do not read each other's transcripts. A task ends with FINDINGS: claims with the
// refs they came from (the brief shape, I-K1), drafts, links, questions. A later task reads
// the board, sized like a shielded tool result so a long-running team does not feed a
// later member forty thousand characters of earlier members. The board is the run's record:
// durable, attributable per role, and — after a run — the thing that can become draft
// briefs and be promoted on convergence (W7), rather than evaporating with the run.
//
// Findings are parsed GENEROUSLY from a model's answer through the structured layer, and a
// task whose answer cannot be read as findings is not lost: its whole answer becomes one
// `draft` finding. A member that only wrote prose still contributed.

import { defineSchema, describeSchema, coerce } from './structured.js';

export const FINDING_KINDS = Object.freeze(['claim', 'draft', 'link', 'question', 'answer']);
export const MAX_FINDINGS_PER_TASK = 40;
export const BOARD_TEXT_MAX = 12_000;

export const FINDINGS_SCHEMA = defineSchema({
  name: 'findings',
  purpose: 'what this task established, each item on its own with where it came from',
  fields: {
    findings: {
      type: 'object[]', required: true, maxItems: MAX_FINDINGS_PER_TASK,
      describe: 'one entry per fact, draft, link or open question — never a paragraph of several',
      fields: {
        kind: { type: 'enum', values: FINDING_KINDS, default: 'claim' },
        text: { type: 'string', required: true, max: 2000 },
        refs: { type: 'string[]', maxItems: 8, describe: 'record ids or URLs this rests on, when any' },
        confidence: { type: 'number', describe: '0–1, how sure' },
      },
    },
  },
  nothing: { findings: [] },
});

/** The instruction appended to every task so the answer can be read as findings. */
export function findingsInstruction() {
  return `When you are done, end your answer with your findings in this shape:\n${describeSchema(FINDINGS_SCHEMA)}`;
}

/**
 * Read a task's answer into findings. The JSON block, when present; otherwise the whole
 * answer as one draft — a member that only wrote prose still contributed.
 */
export function parseFindings(text, { role, taskId } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const got = coerce(raw, FINDINGS_SCHEMA);
  const list = Array.isArray(got?.value?.findings) ? got.value.findings.filter((f) => f && String(f.text || '').trim()) : [];
  const stamp = (f, i) => ({
    id: `${taskId || 't'}:${i + 1}`,
    kind: FINDING_KINDS.includes(f.kind) ? f.kind : 'claim',
    text: String(f.text).trim().slice(0, 2000),
    refs: Array.isArray(f.refs) ? f.refs.map(String).filter(Boolean).slice(0, 8) : [],
    // Absent or zero reads as "not stated": a model that gives no number is not 0% sure.
    confidence: Number.isFinite(Number(f.confidence)) && Number(f.confidence) > 0 ? Math.min(1, Number(f.confidence)) : null,
    role: role || null,
    taskId: taskId || null,
  });
  if (list.length) return list.slice(0, MAX_FINDINGS_PER_TASK).map(stamp);
  // No JSON block: the prose is the finding. Strip a fenced JSON tail that failed to parse.
  const prose = raw.replace(/```json[\s\S]*$/i, '').trim() || raw;
  return [stamp({ kind: 'draft', text: prose.slice(0, 2000), refs: [] }, 0)];
}

export function createBoard({ now = () => Date.now() } = {}) {
  const findings = [];
  const listeners = new Set();
  return {
    add(list) {
      const at = now();
      for (const f of Array.isArray(list) ? list : [list]) {
        if (!f || !f.text) continue;
        const entry = { ...f, at };
        findings.push(entry);
        for (const l of listeners) l(entry);
      }
      return findings.length;
    },
    all: () => [...findings],
    byTask: (taskId) => findings.filter((f) => f.taskId === taskId),
    byRole: (role) => findings.filter((f) => f.role === role),
    onFinding(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get size() { return findings.length; },
  };
}

/**
 * What a later task READS: the findings of the tasks it depends on (or everything so far),
 * sized. Newest are kept whole; the oldest are what get cut, and the cut is stated.
 */
export function boardText(findings, { taskIds = null, max = BOARD_TEXT_MAX } = {}) {
  const list = (findings || []).filter((f) => !taskIds || taskIds.includes(f.taskId));
  if (!list.length) return '';
  const lines = list.map((f) => `- [${f.kind}${f.role ? ` · ${f.role}` : ''}${f.confidence != null ? ` · ${Math.round(f.confidence * 100)}%` : ''}] ${f.text}${f.refs?.length ? ` (refs: ${f.refs.join(', ')})` : ''}`);
  let out = lines.join('\n');
  if (out.length <= max) return `Findings so far:\n${out}`;
  let kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (size + lines[i].length + 1 > max) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return `Findings so far (${lines.length - kept.length} earlier ones omitted for length):\n${kept.join('\n')}`;
}

/** Findings → the claim shape a draft brief takes (W7): text + refs as `{ kind, id }`. */
export function toBriefClaims(findings) {
  return (findings || [])
    .filter((f) => f.kind === 'claim' && f.text)
    .map((f) => ({
      text: f.text,
      refs: (f.refs || []).map((r) => {
        const m = /^([a-z][a-z0-9_-]*):(?!\/\/)(.+)$/.exec(String(r));
        return m ? { kind: m[1], id: m[2] } : { kind: 'url', id: String(r) };
      }),
      by: f.role || 'team',
      confidence: f.confidence,
    }));
}
