// GENERATED — do not edit.
// Source of truth: chatpanel-events/note-plan.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Planning a goal into a note: the decomposition, the document it becomes, and who wrote
// which part of it.
//
// "Plan this in a new note" is not one model call. A goal is decomposed into sub-tasks, each
// sub-task is assigned a ROLE — research (needs facts, options, current information) or write
// (drafting, structure, synthesis) — and each is then run by whichever member of the team
// suits it. The note is rebuilt after every step, so the user watches a checklist fill in
// rather than a spinner.
//
// What has to be shared is the SHAPE: the decomposition prompt and how its answer is read,
// the document the tasks render into, and the authorship ledger that matches that document
// character for character. What stays in the client is the orchestration — running the calls,
// choosing the models, and painting the editor.
//
// THE LEDGER IS BUILT FROM THE SAME PARTS AS THE BODY, which is the whole reason `planParts`
// exists rather than a template string. A plan note is written entirely by agents; attributing
// it to "You" would be a lie the History tab then repeats forever. Building the text and the
// run-list from one list of `{ author, text }` parts means the ledger cannot drift from the
// document — it sums to its length by construction, which is the invariant every attribution
// test asserts.

import { mergeRuns } from './attribution.js';

/** Roles a sub-task can be assigned. Anything a model invents is coerced to `write`. */
export const PLAN_ROLES = Object.freeze(['research', 'write']);

/** The authors a plan note's ledger can name — the team, not the user. */
export const PLAN_AUTHORS = Object.freeze({ planner: 'Planner', research: 'Researcher', write: 'Writer' });

export const PLAN_DECOMPOSE_SYSTEM = 'You are a planning orchestrator. Break the goal into 3–6 concrete sub-tasks. For each, pick a role: "research" (needs facts, options, prices, or current info — it will web + history search) or "write" (drafting, structure, synthesis). Return ONLY compact JSON: {"tasks":[{"title":"short title","role":"research|write","prompt":"a focused instruction for this sub-task"}]}';
export const PLAN_DECOMPOSE_MAX_TOKENS = 600;
export const PLAN_DECOMPOSE_TEMPERATURE = 0.2;

/** The instruction for ONE drafted section of a plan. */
export function planSectionSystem(goal, task) {
  return `You are drafting ONE section of a plan for the goal "${goal}". Write the section titled "${task?.title || ''}". Instruction: ${task?.prompt || task?.title || ''}. Be concrete and actionable — bullets, - [ ] tasks, or a small table for options. Output ONLY the section's markdown content (no heading, no preamble).`;
}
export const PLAN_SECTION_MAX_TOKENS = 700;
export const PLAN_SECTION_TEMPERATURE = 0.5;

/**
 * Read the decomposer's answer into tasks.
 *
 * Generous on purpose: this is a model returning JSON through whatever wrapper its provider
 * felt like adding, and a plan that fails because the answer arrived in a fenced block is a
 * plan that failed for no reason. The object is found inside the text, an unknown role
 * becomes `write`, and a completely unreadable answer falls back to ONE task carrying the
 * original goal — which still produces a useful note rather than an error.
 */
export function parsePlanTasks(raw, goal = '', max = 6) {
  let tasks = [];
  try {
    const json = JSON.parse((String(raw || '').match(/\{[\s\S]*\}/) || ['{}'])[0]);
    tasks = (Array.isArray(json.tasks) ? json.tasks : []).slice(0, max).map((t) => makeTask(t));
  } catch { /* fall through to the single-task plan */ }
  tasks = tasks.filter((t) => t.title || t.prompt);
  if (!tasks.length && String(goal).trim()) tasks = [makeTask({ title: planTitleFor(goal), role: 'write', prompt: goal })];
  return tasks;
}

const makeTask = (t) => ({
  title: String(t?.title || 'Task').slice(0, 80),
  role: t?.role === 'research' ? 'research' : 'write',
  prompt: String(t?.prompt || t?.title || ''),
  done: false,
  working: false,
  output: '',
});

/** A goal reduced to something that reads as a title — markdown stripped, one line, capped. */
export function planTitleFor(goal, max = 60) {
  return String(goal || '').replace(/[#*_`>~[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The plan note, as `{ author, text }` parts.
 *
 * A checklist at the top that fills in as the work lands — so the note is a progress report
 * at a glance — then one section per sub-task. A task with no output yet says which member is
 * working on it rather than showing an empty heading, because a heading with nothing under it
 * reads as a section that came back empty.
 */
export function planParts(goal, tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const done = list.filter((t) => t.done).length;
  const checklist = list
    .map((t, i) => `- [${t.done ? 'x' : ' '}] ${i + 1}. ${t.title}${t.working ? ' — _working…_' : ''}`)
    .join('\n');
  const parts = [{
    author: PLAN_AUTHORS.planner,
    text: `# ${goal}\n\n**Plan** — ${done}/${list.length} sub-tasks done\n\n${checklist}\n\n---\n\n`,
  }];
  list.forEach((t, i) => {
    const who = t.role === 'research' ? PLAN_AUTHORS.research : PLAN_AUTHORS.write;
    parts.push({ author: PLAN_AUTHORS.planner, text: `## ${i + 1}. ${t.title}\n\n` });
    parts.push({
      author: t.output ? who : PLAN_AUTHORS.planner,
      text: t.output || (t.working ? `_⏳ ${who} working…_` : '_pending_'),
    });
    parts.push({ author: PLAN_AUTHORS.planner, text: i < list.length - 1 ? '\n\n' : '\n' });
  });
  return parts;
}

/** The plan note's markdown. */
export function planBody(goal, tasks) {
  return planParts(goal, tasks).map((p) => p.text).join('');
}

/** The authorship run-list for `planBody(goal, tasks)` — equal in length by construction. */
export function planAttribution(goal, tasks, at = Date.now()) {
  return mergeRuns(planParts(goal, tasks).map((p) => ({ len: p.text.length, author: p.author, at })));
}
