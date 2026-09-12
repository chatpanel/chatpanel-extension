// GENERATED — do not edit.
// Source of truth: chatpanel-events/cowriter-writer.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// cowriter-writer.js — the WRITER's half of the co-writer: when it may draft, what it is
// asked, and how much it may spend.
//
// The Editor's half (lint, diff, the copy-editor prompt) is cowriter.js. This is the member
// that WRITES — a continuation from the caret on ⌘↵, a section under a heading you paused on,
// the next line toward a goal, or the result of an instruction typed into the note — and it
// lived as a dozen functions inside the extension's notes.js until the desktop needed the
// same member. Everything here is a decision or a string; the ghost text, the keys and the
// stream are the client's.
//
// The standing rule of this member: IT OFFERS, THE USER ACCEPTS. Every draft is a suggestion
// with an accept and a reject, and nothing here writes into a document.

// ── What the cursor line affords ─────────────────────────────────────────────────

/** The line the caret is on, as `{ text, start, end }` — `end` excludes the newline. */
export function lineAt(text, caret) {
  const src = String(text ?? '');
  const pos = Math.max(0, Math.min(caret ?? 0, src.length));
  const start = src.lastIndexOf('\n', pos - 1) + 1;
  const nl = src.indexOf('\n', pos);
  const end = nl < 0 ? src.length : nl;
  return { text: src.slice(start, end), start, end };
}

/**
 * What the cursor line affords the Writer: an empty outline item, a TODO marker, or a
 * heading whose section has no body yet → `{ kind, at, label }`, or null. Detecting the
 * spot is free; drafting it is a model call, and only happens on a nudge, ⌘↵ or Focus.
 */
export function writerAffordance(text, caret) {
  const v = String(text ?? '');
  const line = lineAt(v, caret);
  const t = line.text;
  if (/^\s*([-*]|\d+\.)\s*(\[ \]\s*)?$/.test(t)) return { kind: 'item', at: line.end, label: 'this item' };
  if (/\b(TODO|TK|TBD)\b:?\s*$/i.test(t)) return { kind: 'todo', at: line.end, label: 'this to-do' };
  if (/^#{1,6}\s+\S/.test(t)) { // a heading whose section has no body yet
    const next = v.slice(line.end).replace(/^\n/, '').split('\n', 1)[0] || '';
    if (!next.trim() || /^#{1,6}\s/.test(next)) return { kind: 'section', at: line.end, label: 'this section' };
  }
  if (!t.trim()) { // a blank line directly under a heading
    const before = v.slice(0, line.start).replace(/\n$/, '');
    const prev = before.slice(before.lastIndexOf('\n') + 1);
    if (/^#{1,6}\s+\S/.test(prev)) return { kind: 'section', at: line.start, label: 'this section' };
  }
  return null;
}

/**
 * An imperative line the user wants ACTED on — "summarize the above in 3 sentences", "list
 * the key risks", "rewrite this as bullets" — as distinct from prose to continue. A
 * conservative verb-led match, never an @mention or a /command line (those run elsewhere).
 */
export const INSTRUCTION_RE = /^\s*(?:please\s+|can you\s+|now\s+)?(summari[sz]e|recap|tl;?dr|rewrite|re-?write|reword|rephrase|expand|elaborate|continue|list|enumerate|outline|draft|write|compose|generate|create|add|explain|describe|define|compare|contrast|shorten|condense|tighten|simplify|translate|convert|turn\s+.+\s+into|make\s+(?:this|it|these|a\b)|bullet|brainstorm|suggest|proofread|polish|improve)\b/i;

export function instructionOnLine(text, caret) {
  const line = lineAt(text, caret);
  const t = line.text.trim();
  if (t.length < 6) return null;
  if (/^[@/]/.test(t) || /@\[[^\]]+\]/.test(t)) return null;
  if (!INSTRUCTION_RE.test(t)) return null;
  return { text: t, start: line.start, end: line.end };
}

// ── Goal-drive ───────────────────────────────────────────────────────────────────

/** Chars of the user's OWN writing required between two automatic drafts. */
export const GOAL_MIN_NEW = 24;

/**
 * May the goal draft the next line now?
 *
 * It must NOT loop: without this guard it re-fires on every pause (each Enter changes the
 * length) and re-drafts near-duplicates. So it fires at most once per burst of the user's
 * own writing — the document must have grown by `minNew` chars since the last draft, the
 * caret must sit at a line end, and there must be real context to continue. `lastLen` is
 * the body length at the last draft (-1 = armed: fire once there is context); the caller
 * re-baselines it when a draft is accepted, so an accepted line does not trigger the next.
 */
export function goalDraftAllowed({ text, caret, lastLen = -1, minNew = GOAL_MIN_NEW } = {}) {
  const v = String(text ?? '');
  const from = Math.max(0, Math.min(caret ?? 0, v.length));
  if (from !== v.length && v[from] !== '\n') return false;
  if (v.slice(0, from).trim().length < 24) return false;
  if (lastLen >= 0 && v.length <= lastLen + minNew) return false;
  return true;
}

// ── Spend ────────────────────────────────────────────────────────────────────────

/**
 * A rolling per-minute cap on MODEL calls the team makes on its own. Free work — the
 * deterministic Editor pass, retrieval-only research — never counts; over the cap the
 * spending members skip until the window clears. Visible, so "why did it stop" has an answer.
 */
export function createSpendMeter({ capPerMin = 20, now = Date.now } = {}) {
  let calls = [];
  const prune = () => { const t = now(); calls = calls.filter((c) => t - c < 60_000); };
  return {
    cap: capPerMin,
    ok() { prune(); return calls.length < capPerMin; },
    spend() { calls.push(now()); },
    used() { prune(); return calls.length; },
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────────────

/** The tail of the note the Writer continues from — capped, with the title as context. */
export function writerTail(before, title = '') {
  const b = String(before ?? '');
  const tail = b.length > 1600 ? `…${b.slice(-1600)}` : b;
  const t = String(title || '').trim();
  return (t ? `# ${t}\n\n` : '') + tail;
}

/** Where an instruction's result goes: on its own line under the instruction. */
export function draftSeparator(before) {
  const b = String(before ?? '');
  return b.endsWith('\n\n') ? '' : b.endsWith('\n') ? '\n' : '\n\n';
}

/** The Researcher's shelf, as the lines the Writer may draw on — a handoff, not a dump. */
export function groundingBlock(cards = [], { limit = 5 } = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.title).slice(0, limit);
  if (!list.length) return '';
  return '\n\nRelated material you may draw on (only if genuinely useful — cite as [[title]] or [text](url)):\n'
    + list.map((c) => `- ${c.title}${c.snippet ? ` — ${c.snippet}` : ''}`).join('\n');
}

/**
 * The Writer's request: a continuation from where the note stops, or an instruction executed
 * over the note above it. -> { system, user, maxTokens, temperature }
 */
export function writerRequest({ before, title = '', instruction = '', contextBefore = null, intent = '', cards = [] } = {}) {
  const grounding = groundingBlock(cards);
  const goal = String(intent || '').trim();
  if (instruction) {
    return {
      system: `You are executing an instruction inside the user's note. Use the note as context and do EXACTLY what the instruction says. Match the note's voice, tone, and markdown style. Output ONLY the resulting markdown to insert — no preamble, no restating the instruction, no meta commentary.${goal ? ` The note's goal: ${goal}.` : ''}${grounding}`,
      user: `NOTE SO FAR:\n${writerTail(contextBefore ?? before, title)}\n\nINSTRUCTION (do exactly this, output only the result):\n${instruction}`,
      maxTokens: 600,
      temperature: 0.4,
    };
  }
  return {
    system: `${goal ? `The note's goal (guide your writing toward it): ${goal}.\n\n` : ''}You continue the user's note from where it stops. Match their voice, tone, and markdown style exactly. Write only the NEXT one or two sentences (or finish the current one) — concise, natural, no preamble, no repetition of prior text, no meta commentary. Output ONLY the continuation.${grounding}`,
    user: writerTail(before, title),
    maxTokens: 220,
    temperature: 0.6,
  };
}

/** Inline autocomplete: a few words, at most one sentence, at the very end of the note. */
export const AUTOCOMPLETE_SYSTEM = 'You are an inline writing autocomplete. Continue the note from EXACTLY where it stops with a SHORT continuation — a few words up to one sentence. Match the voice and markdown. Output ONLY the text to append: no quotes, no preamble, no repetition of prior text. If nothing sensible follows, output nothing.';
export const AUTOCOMPLETE_MAX_TOKENS = 48;
export const AUTOCOMPLETE_TEMPERATURE = 0.1;

/** Keep a completion short: the first line, and at most the first sentence of it. */
export function clipCompletion(s) {
  let t = String(s ?? '').replace(/^\s+/, '');
  const nl = t.indexOf('\n');
  if (nl >= 0) t = t.slice(0, nl);
  const m = t.match(/^.*?[.!?](\s|$)/);
  if (m) t = m[0];
  return t.replace(/\s+$/, '');
}

// ── The switches, in one voice ───────────────────────────────────────────────────

/** The two gears — and what each DOES to your text, which is the question. */
export const GEARS = Object.freeze([
  Object.freeze({ id: 'ambient', name: 'Suggest', note: 'Nothing is written for you. Typo fixes, links and research collect quietly in the Co-writer tab, and you decide what to take. Press ⌘↵ any time to draft ahead.' }),
  Object.freeze({ id: 'focus', name: 'Write with me', note: 'The team writes alongside you: it drafts a section when you pause on a heading, and every draft is still accept-or-reject. The per-minute spend cap still applies.' }),
]);

/** The opt-ins. Each is a model call the team may make WITHOUT being asked, so each is off. */
export const WRITER_PREFS = Object.freeze([
  Object.freeze({ k: 'revealFixes', label: 'Show fixes as they land', desc: 'Open the Co-writer tab when a typo fix or a draft is ready — no hunting for the badge.', spends: false }),
  Object.freeze({ k: 'actOnInstructions', label: 'Act on instruction lines', desc: 'A line like “summarize the above in 3 sentences” becomes a task the Writer drafts (accept/reject).', spends: true }),
  Object.freeze({ k: 'goalDrive', label: 'Let the goal keep writing', desc: 'With a goal set, draft the next line toward it whenever you pause at a line end. Always accept/reject; respects the spend cap.', spends: true }),
  Object.freeze({ k: 'autocomplete', label: 'Autocomplete as I type', desc: 'A short ghost continuation at the end of the note after a pause — one small call per pause, Tab keeps it. Counts against the spend cap.', spends: true }),
]);

export const WRITER_PREF_DEFAULTS = Object.freeze({ gear: 'ambient', revealFixes: false, actOnInstructions: false, goalDrive: false, autocomplete: false });

/** A stored prefs object, with unknown keys dropped and missing ones defaulted. */
export function normalizeWriterPrefs(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = { ...WRITER_PREF_DEFAULTS };
  out.gear = s.gear === 'focus' ? 'focus' : 'ambient';
  for (const p of WRITER_PREFS) out[p.k] = s[p.k] === true;
  return out;
}

/** A note's goal, as stored: one line, capped. */
export function normalizeIntent(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
