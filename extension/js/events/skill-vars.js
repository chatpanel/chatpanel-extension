// GENERATED — do not edit.
// Source of truth: chatpanel-events/skill-vars.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// skill-vars.js — the placeholders a skill prompt may carry, declared ONCE.
//
// A skill prompt can interpolate a few runtime values: what the user typed, the
// selection, the page URL/title, today's date. Until this module existed that set
// lived as a regex chain inside the extension's side panel, and nothing else knew
// it — so three things drifted apart:
//
//   • the EDITOR advertised placeholders in a placeholder attribute,
//   • the PANEL substituted a different set,
//   • prompt-assist was told to "preserve any {{placeholders}} verbatim" without
//     being told which ones exist — so the model invented {{content}}, guarded it,
//     and the user shipped a prompt with a slot nothing would ever fill.
//
// That last failure is silent by construction: an unknown placeholder is just text,
// so the model receives the literal characters `{{content}}` and usually papers over
// it. The skill looks broken for a reason no surface names. Declaring the set once
// makes the same list authoritative for the editor's lint, the assist prompt, and
// substitution — a fourth client (mobile, the gateway, the bridge) inherits it
// rather than re-deriving it.
//
// Platform access is INJECTED, never imported: the page URL comes from `chrome.tabs`
// in the extension, from the request in the gateway, and from nothing at all in a
// batch run. This module knows the contract; the host knows how to satisfy it.

export class SkillVarError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillVarError'; this.code = code; }
}

/**
 * The complete set. `source` says where the value comes from, which is what the
 * lint and the assist guidance need to explain it:
 *   'args'     — the text the user supplied with the invocation
 *   'resolver' — the host fills it (page URL, title, selection, date)
 */
export const SKILL_VARS = Object.freeze([
  Object.freeze({
    name: 'input',
    source: 'args',
    labelled: true, // {{input:label}} — the label is a hint to the author, not sent
    summary: 'What the user typed after the /command — or whatever is already in the composer when they pick the skill from the menu.',
  }),
  Object.freeze({
    name: 'selection',
    source: 'resolver',
    summary: 'The text selected on the page right now.',
  }),
  Object.freeze({
    name: 'url',
    source: 'resolver',
    summary: "The active tab's URL.",
  }),
  Object.freeze({
    name: 'title',
    source: 'resolver',
    summary: "The active tab's title.",
  }),
  Object.freeze({
    name: 'date',
    source: 'resolver',
    summary: "Today's date.",
  }),
]);

export const SKILL_VAR_NAMES = Object.freeze(SKILL_VARS.map((v) => v.name));

const BY_NAME = new Map(SKILL_VARS.map((v) => [v.name, v]));

export function skillVar(name) {
  return BY_NAME.get(String(name || '').trim().toLowerCase()) || null;
}

// Any {{ token }}, with an optional :label. Deliberately permissive on what it
// CAPTURES — an unknown name has to be recognised as a placeholder before it can be
// reported as unknown. A pattern that only matched known names would make the
// {{content}} class of bug invisible all over again.
const TOKEN = /\{\{\s*([a-z_][a-z0-9_-]*)\s*(?::([^}]*))?\s*\}\}/gi;

/** The token pattern for one variable — `g` and `i`, fresh each call (no lastIndex sharing). */
export function skillVarPattern(name) {
  const v = skillVar(name);
  if (!v) throw new SkillVarError('UNKNOWN_VAR', `unknown skill variable '${name}'`);
  return v.labelled
    ? new RegExp(`\\{\\{\\s*${v.name}(?::[^}]*)?\\s*\\}\\}`, 'gi')
    : new RegExp(`\\{\\{\\s*${v.name}\\s*\\}\\}`, 'gi');
}

/**
 * Every placeholder in a prompt, in source order.
 * -> [{ name, label, raw, index, known }]
 */
export function parseSkillVars(text) {
  const out = [];
  const src = String(text || '');
  TOKEN.lastIndex = 0;
  let m = TOKEN.exec(src);
  while (m) {
    const name = m[1].toLowerCase();
    out.push({
      name,
      label: (m[2] || '').trim(),
      raw: m[0],
      index: m.index,
      known: BY_NAME.has(name),
    });
    m = TOKEN.exec(src);
  }
  return out;
}

// Damerau-free Levenshtein, bounded by the short names we compare. Enough to turn
// {{content}} → {{input}}? No — those are not near neighbours, which is the point:
// a bad suggestion is worse than none, so `suggestSkillVar` falls back to the input
// slot only when the unknown name READS like a content slot.
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const row = [i];
    for (let j = 1; j <= n; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n];
}

// Names a model reaches for when it invents a "put the user's text here" slot. These
// are NOT aliases — nothing substitutes them, because silently filling a placeholder
// the user never agreed to is how a prompt starts meaning something else. They only
// make the suggestion in the lint concrete.
const INPUT_SHAPED = new Set([
  'content', 'text', 'body', 'draft', 'document', 'doc', 'args', 'arguments',
  'query', 'question', 'task', 'request', 'prompt', 'message', 'user_input', 'userinput',
]);

/** Nearest known variable for a misspelling or an invented name, or '' if none is close. */
export function suggestSkillVar(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q || BY_NAME.has(q)) return '';
  if (INPUT_SHAPED.has(q)) return 'input';
  let best = '';
  let bestD = Infinity;
  for (const known of SKILL_VAR_NAMES) {
    const d = distance(q, known);
    if (d < bestD) { bestD = d; best = known; }
  }
  // Two edits, or a third of a longer name — enough to catch a transposition
  // ("titel") without turning an unrelated word into a confident wrong guess.
  return bestD <= Math.max(2, Math.floor(q.length / 3)) ? best : '';
}

/**
 * Static check of a prompt, for the skill editor.
 * -> { known: [names], unknown: [{ name, raw, suggestion }], hasInput: boolean }
 *
 * `hasInput` is what decides whether the caller's text goes INTO the prompt or gets
 * appended after it, so the editor can explain which of the two will happen.
 */
export function lintSkillPrompt(text) {
  const seen = parseSkillVars(text);
  const known = [];
  const unknown = [];
  const dedupe = new Set();
  for (const tok of seen) {
    if (dedupe.has(tok.name)) continue;
    dedupe.add(tok.name);
    if (tok.known) known.push(tok.name);
    else unknown.push({ name: tok.name, raw: tok.raw, suggestion: suggestSkillVar(tok.name) });
  }
  return { known, unknown, hasInput: dedupe.has('input') };
}

/**
 * Fill a prompt's placeholders.
 *
 * @param text      the skill prompt
 * @param args      the user's text, for {{input}}
 * @param resolvers { selection, url, title, date } — each () => string | Promise<string>.
 *                  A resolver is called ONLY when its variable actually appears, so a
 *                  prompt without {{selection}} never pays for a tab read. A missing
 *                  resolver, or one that throws, yields '' and is reported in `empty`
 *                  rather than failing the turn.
 *
 * -> { text, filled: [names], empty: [names], unknown: [{ name, raw, suggestion }] }
 *
 * UNKNOWN PLACEHOLDERS ARE LEFT ALONE. Rewriting a user's prompt because we did not
 * recognise a token would be a silent edit of the thing they wrote; reporting it lets
 * the caller say so out loud, which is the actual fix.
 */
export async function substituteSkillVars(text, { args = '', resolvers = {} } = {}) {
  const src = String(text || '');
  const lint = lintSkillPrompt(src);
  if (!lint.known.length) return { text: src, filled: [], empty: [], unknown: lint.unknown };

  const filled = [];
  const empty = [];
  let out = src;

  for (const name of lint.known) {
    let value = '';
    if (name === 'input') {
      value = args == null ? '' : String(args);
    } else {
      const resolve = resolvers[name];
      if (typeof resolve === 'function') {
        try {
          value = (await resolve()) ?? '';
        } catch {
          value = ''; // a dead tab or a denied permission is an empty slot, not a failure
        }
      }
      value = String(value);
    }
    if (value.trim()) filled.push(name);
    else empty.push(name);
    out = out.replace(skillVarPattern(name), () => value);
  }

  return { text: out, filled, empty, unknown: lint.unknown };
}

/**
 * The sentence prompt-assist needs so the model stops inventing placeholders.
 * Generated from SKILL_VARS so a variable added here reaches the assist prompt
 * without anyone remembering to update a string.
 */
export function skillVarGuidance() {
  const list = SKILL_VARS.map((v) => `{{${v.name}}} (${v.summary})`).join(' ');
  return `The prompt may use ONLY these placeholders, and they are filled at run time: ${list} `
    + 'Preserve the ones already present verbatim, and never invent another — an unrecognised '
    + `placeholder is sent to the model as literal text. For the user's own text use {{input}}.`;
}
