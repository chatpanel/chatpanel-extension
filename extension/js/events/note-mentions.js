// GENERATED — do not edit.
// Source of truth: chatpanel-events/note-mentions.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Delegation inside a note: `@[Agent Name] task` and `#[Skill Name]`.
//
// A note is not only a document a model writes INTO — it is a place to hand a job to a named
// agent and scope it to a saved skill. Both are written as tokens in the text, which means
// both are grammar: something has to say where the token ends and the instruction begins, and
// two clients answering that differently is one feature behaving as two.
//
// These were `notes-util.js` in the extension — already pure, already tested, and already the
// right shape; they simply lived where only one client could reach them. The desktop needs
// exactly the same answers, and a mobile client will too.
//
// WHAT IS NOT HERE: running the agent, arming its tools, and streaming into the editor. Those
// need a target resolver, a transport and a document — all platform. What is here is the
// reading of the line and the resolving of a name against a list the caller supplies.

/**
 * Pull an `@[Agent Name] task` mention out of one line.
 *
 * The instruction may sit BEFORE or AFTER the token — "Update the plan @[Codex]" and
 * "@[Codex] update the plan" are the same request — so the task is the whole line minus the
 * token. Brackets are what let an agent's name contain spaces.
 *
 * Returns `{ name, task }`, both `''` when the line carries no runnable mention. A mention
 * with no task is not runnable: `@[Codex]` alone is someone still typing.
 */
export function parseAgentMention(line) {
  const s = String(line || '');
  const m = s.match(/@\[([^\]\n]+)\]/);
  if (!m) return { name: '', task: '' };
  const name = m[1].trim();
  const task = (`${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`).replace(/\s+/g, ' ').trim();
  return { name, task };
}

/**
 * The runnable `@[Agent] task` on the caret's line, or null — `{ name, task, start, end }`
 * where [start, end) is the WHOLE line, because the Q&A replaces the line it was written on.
 */
export function agentMentionAt(text, pos) {
  const v = String(text ?? '');
  const p = Math.max(0, Math.min(Number.isFinite(pos) ? pos : 0, v.length));
  const start = v.lastIndexOf('\n', p - 1) + 1;
  let end = v.indexOf('\n', p);
  if (end < 0) end = v.length;
  const { name, task } = parseAgentMention(v.slice(start, end));
  if (!name || !task) return null;
  return { name, task, start, end };
}

/**
 * Pull a `#[Skill Name]` out of an instruction. Returns the name (or `''`) and the
 * instruction with the token removed — the token is addressing, not content, and leaving it
 * in means the model is asked to do something with the literal text "#[Weekly review]".
 */
export function parseSkillMention(instruction) {
  const s = String(instruction || '');
  const m = s.match(/#\[([^\]\n]+)\]/);
  if (!m) return { name: '', text: s.trim() };
  return { name: m[1].trim(), text: s.replace(m[0], '').replace(/[ \t]{2,}/g, ' ').trim() };
}

/**
 * Merge a skill's saved prompt with the user's task.
 *
 * `{{input}}` placeholders are substituted when the author wrote any — a skill that says
 * "Summarize {{input}} for an exec" wants the task in the middle, not stapled underneath.
 * With no placeholder the task is appended, which is what an instruction-style skill expects.
 */
export function mergeSkillPrompt(prompt, task) {
  const p = String(prompt || '');
  const t = String(task || '');
  if (/\{\{\s*input[^}]*\}\}/i.test(p)) return p.replace(/\{\{\s*input[^}]*\}\}/gi, t);
  return p ? (t ? `${p}\n\n${t}` : p) : t;
}

/** Resolve a skill by display name — exact first, then contains. */
export function findSkillByName(skills, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const list = Array.isArray(skills) ? skills : [];
  const of = (s) => String(s?.name || s?.title || '').toLowerCase();
  return list.find((s) => of(s) === q) || list.find((s) => of(s).includes(q)) || null;
}

/**
 * Resolve a mentioned TARGET by name against whatever list the client has.
 *
 * Exact name, then a contains match, then the underlying model or agent id — so `@[Claude]`
 * finds "Claude Code", and `@[codex]` finds a target named something else that runs `codex`.
 * The entries are duck-typed (`name`, `model`, `bridgeAgent`, or a bare `id`) because the
 * extension holds configured endpoints and agents while the desktop holds the gateway's model
 * list, and neither should have to reshape its data to ask this question.
 */
export function findTargetByName(targets, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  const list = Array.isArray(targets) ? targets : [];
  const nameOf = (t) => String(t?.name || '').toLowerCase();
  const idOf = (t) => String(t?.model || t?.bridgeAgent || t?.id || '').toLowerCase();
  return list.find((t) => nameOf(t) === q)
    || list.find((t) => idOf(t) === q)
    || list.find((t) => nameOf(t) && nameOf(t).includes(q))
    || list.find((t) => idOf(t).includes(q))
    || null;
}

/**
 * How a delegated answer is written into the note.
 *
 * The question is quoted and the agent named above its reply, so a note that collected three
 * delegations reads as a transcript rather than as three anonymous blocks of prose. Returned
 * separately from the answer because the client streams INTO the gap between them.
 */
export function mentionAnswerPrefix(name, task) {
  const quoted = String(task || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `${quoted}\n\n**${String(name || 'Agent')}:**\n\n`;
}
