// GENERATED — do not edit.
// Source of truth: chatpanel-events/note-actions.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// AI writing in a note — what the model is asked, and where its answer lands.
//
// A note has three ways to ask a model to write: a NAMED ACTION on the selection or the whole
// note ("Continue writing", "Summarize", "Turn into tasks", "Improve writing"), an
// `@command instruction` typed on a line ("@table the G7 by population"), and a `/` palette
// that offers the actions at the caret. Every client has all three, and each has two halves
// that must agree: the PROMPT the model receives and the FRAME the output is written into —
// head, output, tail. Ask for a summary and land it at the caret, or ask for a checklist and
// replace the whole note with it, and the feature is wrong in a way no prompt fixes.
//
// These lived inside the extension's `notes.js` — five thousand lines, DOM-bound — and the
// desktop was about to type them a second time. Nothing here needs a window: the specs are
// data, the framing is body + selection in and three strings out, the triggers are text +
// caret in and a range out. So they are here, and the clients render the menu around them.
//
// THE CLIENT STILL OWNS: the model call (through its own streaming path), the editor write,
// attribution and versioning, and any tools it arms. `NOTE_COMMANDS[].tools` says a command
// WANTS live data; whether a target can fetch it is the client's to know.

/**
 * The named actions, keyed the way the menus and the `/` palette refer to them.
 *
 * `system` is the whole instruction; the user turn is the target text alone. Every prompt
 * ends in "Output ONLY …" because the answer is written INTO the note — a "Sure! Here is
 * your summary:" preamble would land in the document verbatim.
 */
export const NOTE_ACTIONS = Object.freeze({
  continue: Object.freeze({
    label: 'Continue writing',
    hint: 'draft inline from here',
    system: "You are a writing assistant continuing the user's note. Match their voice, tone and markdown style, and continue naturally from where the text stops. Output ONLY the continuation — no preamble, no repeating prior text.",
    maxTokens: 700,
    needsSelection: false,
  }),
  summarize: Object.freeze({
    label: 'Summarize',
    hint: 'a tight summary',
    system: 'Summarize the text concisely in GitHub-flavored markdown — a few tight bullets or a short paragraph. Output ONLY the summary.',
    maxTokens: 500,
    needsSelection: false,
  }),
  tasks: Object.freeze({
    label: 'Turn into tasks',
    hint: 'selection → checklist',
    system: 'Convert the text into a GitHub-flavored markdown checklist: one actionable item per line as "- [ ] item". Output ONLY the checklist.',
    maxTokens: 700,
    needsSelection: true,
  }),
  improve: Object.freeze({
    label: 'Improve writing',
    hint: 'rewrite clearer',
    system: 'Rewrite the text to be clearer and more concise while preserving its meaning, tone and markdown formatting. Output ONLY the rewritten text.',
    maxTokens: 1000,
    needsSelection: false,
  }),
});

/** The sampling every action uses. Low enough to stay on-task, high enough to write prose. */
export const NOTE_ACTION_TEMPERATURE = 0.5;

/** The order the `/` palette and the Agent menu list them in. */
export const NOTE_ACTION_ORDER = Object.freeze(['continue', 'summarize', 'tasks', 'improve']);

/** The label for an action key, or the key itself for one this build does not know. */
export const noteActionLabel = (kind) => NOTE_ACTIONS[kind]?.label || String(kind || '');

/**
 * Where an action's output lands.
 *
 * Returns `{ target, head, tail }`: the text the model is given, and what sits before and
 * after its answer in the finished note. Or `{ error }` — one of the two ways an action
 * cannot run — so a client shows the reason rather than sending an empty prompt and reading
 * the model's confusion back into the document.
 *
 *   continue   — the whole note in, the answer appended after a blank line;
 *   summarize  — the selection (or the note) in, a `## Summary` section appended at the end;
 *   tasks      — the selection in, the checklist REPLACES it; needs a selection, because a
 *                checklist of the entire note replacing the entire note is never what was meant;
 *   improve    — the selection in and replaced; with no selection the whole note is rewritten.
 *
 * `error` is 'select' (this action needs a selection) or 'empty' (nothing to work with).
 */
export function frameNoteAction(kind, body, selStart = 0, selEnd = selStart) {
  const spec = NOTE_ACTIONS[kind];
  if (!spec) return { error: 'unknown' };
  const text = String(body ?? '');
  const s0 = clamp(selStart, 0, text.length);
  const s1 = clamp(selEnd, s0, text.length);
  const sel = text.slice(s0, s1);

  let target;
  let head;
  let tail;
  if (kind === 'continue') {
    target = text;
    head = text + (text && !/\s$/.test(text) ? '\n\n' : '');
    tail = '';
  } else if (kind === 'summarize') {
    target = sel || text;
    head = `${text.replace(/\s+$/, '')}\n\n## Summary\n\n`;
    tail = '';
  } else if (kind === 'tasks') {
    if (!sel.trim()) return { error: 'select' };
    target = sel;
    head = text.slice(0, s0);
    tail = text.slice(s1);
  } else {
    target = sel || text;
    head = sel ? text.slice(0, s0) : '';
    tail = sel ? text.slice(s1) : '';
  }
  if (!target.trim()) return { error: 'empty' };
  return { target, head, tail };
}

/** What a client should tell the user for each `frameNoteAction` error. */
export const NOTE_ACTION_ERRORS = Object.freeze({
  select: 'Select some text first',
  empty: 'Nothing to work with yet',
  unknown: 'Unknown action',
});

/**
 * The `@command instruction` grammar — a line the user writes, and the model replaces.
 *
 * `tools: true` means the command is about live data and wants a web search armed. A target
 * that cannot search (an HTTP model with no tools) still answers; the prompt tells it not to
 * guess, and a client that knows its target cannot fetch may say so.
 */
export const NOTE_COMMANDS = Object.freeze([
  Object.freeze({ cmd: 'insert', label: 'Insert', hint: 'generate or fetch, then insert', tools: true, system: 'You insert content into the user\'s note. Follow the instruction. If it needs current, live, or web data, USE the web_search tool to fetch it — never guess or use stale knowledge. Output ONLY the content to insert as clean GitHub-flavored markdown — no preamble, no closing remarks.' }),
  Object.freeze({ cmd: 'table', label: 'Table', hint: 'produce a markdown table', tools: true, system: 'Produce the requested data as a GitHub-flavored markdown table. If it needs live/current data, USE the web_search tool. Output ONLY the table.' }),
  Object.freeze({ cmd: 'list', label: 'List', hint: 'produce a bullet/task list', tools: true, system: 'Produce the requested content as a GitHub-flavored markdown list (use - [ ] for actionable tasks). Use web_search for live data. Output ONLY the list.' }),
  Object.freeze({ cmd: 'summarize', label: 'Summarize', hint: 'summarize a topic', tools: false, system: 'Summarize the requested topic concisely in markdown. Output ONLY the summary.' }),
  Object.freeze({ cmd: 'translate', label: 'Translate', hint: 'translate to a language', tools: false, system: 'Translate the requested text to the requested language, preserving markdown. Output ONLY the translation.' }),
]);

/** The sampling a command runs at — tighter than an action, because it is following orders. */
export const NOTE_COMMAND_TEMPERATURE = 0.4;
export const NOTE_COMMAND_MAX_TOKENS = 1800;

// Matches `@command …` ANYWHERE on the line, not only at its start, so it works mid-sentence.
const NOTE_CMD_RE = new RegExp(`@(${NOTE_COMMANDS.map((c) => c.cmd).join('|')})\\b[ \\t]*(.*)$`, 'i');

/**
 * The runnable `@command instruction` on the line the caret is on, or null.
 *
 * Returns `{ spec, instruction, start, end }` where [start, end) is the span to replace —
 * from the `@` to the end of the line, so text BEFORE the command on that line survives.
 * A command with no instruction is not runnable: "@table" alone is the user still typing.
 */
export function commandLineAt(text, pos) {
  const v = String(text ?? '');
  const p = clamp(pos, 0, v.length);
  const lineStart = v.lastIndexOf('\n', p - 1) + 1;
  let end = v.indexOf('\n', p);
  if (end < 0) end = v.length;
  const line = v.slice(lineStart, end);
  const m = line.match(NOTE_CMD_RE);
  if (!m) return null;
  const spec = NOTE_COMMANDS.find((c) => c.cmd === m[1].toLowerCase());
  const instruction = (m[2] || '').trim();
  if (!spec || !instruction) return null;
  return { spec, instruction, start: lineStart + m.index, end };
}

/**
 * The `<trigger>word` being typed at the caret — `/` for the palette, `@` for commands and
 * mentions — or null. The trigger must open a token: at the start of the line or after
 * whitespace, so `a/b` and `alex@example.com` never pop a menu. A `#` trigger with a space
 * after it is a markdown heading, which `\w*` already refuses.
 *
 * Returns `{ word, start, end }` where [start, end) is the WORD (not the trigger), which is
 * what a client replaces when an item is picked. `hasSelection` suppresses it: a palette over
 * a selection is a different gesture from a palette at a caret.
 */
export function triggerQueryAt(text, pos, trigger, { hasSelection = false } = {}) {
  if (hasSelection) return null;
  const v = String(text ?? '');
  const p = clamp(pos, 0, v.length);
  const line = v.slice(v.lastIndexOf('\n', p - 1) + 1, p);
  const t = escapeRe(String(trigger || '/'));
  const m = line.match(new RegExp(`(?:^|\\s)${t}(\\w*)$`));
  if (!m) return null;
  return { word: m[1], start: p - m[1].length, end: p };
}

/**
 * Filter the `/` palette by what has been typed after the slash: a prefix of the key or a
 * substring of the label, case-insensitively. An empty word keeps everything, in order.
 */
export function filterNoteActions(items, word) {
  const w = String(word || '').trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];
  if (!w) return list;
  return list.filter((it) => (
    String(it.key || '').toLowerCase().startsWith(w)
    || String(it.label || '').toLowerCase().includes(w)
  ));
}

/**
 * The palette items for the actions this build lists, in order — `{ key, label, hint }`
 * with no runner, so a client maps keys to its own handlers and drops any it cannot run.
 */
export function noteActionItems(order = NOTE_ACTION_ORDER) {
  return order
    .filter((k) => NOTE_ACTIONS[k])
    .map((k) => ({ key: k, label: NOTE_ACTIONS[k].label, hint: NOTE_ACTIONS[k].hint }));
}

/** How much of the note rides along with a command — bounds the tokens, not the meaning. */
export const NOTE_CONTEXT_MAX_CHARS = 4000;

/**
 * The note itself (minus the command line) as grounding for an `@command` or `@[Agent]` task.
 *
 * "Summarize above", "action items for this meeting", "translate that" — the instruction
 * points at the document it sits in, and a model given only the instruction answers that
 * there is nothing to summarize. So the note travels with the task: everything before the
 * line (`head`) and after it (`tail`), the title when there is one, and a preface telling
 * the model to resolve references — a date, a [[wikilink]], a meeting link's #id — against
 * THIS text rather than free-searching history for a guess.
 *
 * Capped at `max` characters so a long note cannot blow the budget; the client's redaction
 * harness sees it like any other user turn. An empty note yields '' — there is nothing to
 * ground in, and a frame around nothing would only cost tokens.
 */
export function noteCommandContext(head, tail, { title = '', max = NOTE_CONTEXT_MAX_CHARS } = {}) {
  const body = `${head ?? ''}\n${tail ?? ''}`.replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return '';
  const clipped = body.length > max ? `${body.slice(0, max)}\n…(note truncated)` : body;
  const t = String(title || '').trim();
  return `The note I'm editing${t ? ` (title: "${t}")` : ''} is below. Resolve any reference in my instruction — "this meeting", "above", a date, a name, a [[wikilink]] or a URL (a meeting link's #id identifies that exact meeting) — against THIS note, not a guess. If a tool lets you fetch something referenced here by id, use that id.\n\n"""\n${clipped}\n"""`;
}

/**
 * The user turn for a command: the grounding (when there is any) and then the instruction,
 * separated so the model cannot mistake the note for the ask. One function, because the
 * separator is part of the contract — a client that joined them with a different rule
 * would get a different answer from the same note.
 */
export function groundedInstruction(instruction, context) {
  const ask = String(instruction ?? '');
  return context ? `${context}\n\n---\nInstruction: ${ask}` : ask;
}

function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
