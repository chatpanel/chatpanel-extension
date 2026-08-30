// skill_file — level 2 of progressive disclosure.
//
// A packaged skill ships a lean SKILL.md plus reference documents it deliberately does NOT
// inline. That is the whole point of the format: a knowledge-base skill can carry a book's
// worth of distilled material and cost nothing until a question needs one chapter. Until
// this tool existed, ChatPanel imported the SKILL.md and silently ignored everything it
// pointed at — so a skill would refer the model to `references/auth.md` and the model had
// no way to open it. That reads to a user as the skill being wrong.
//
// One tool, not one per file. The turn already pays for the INDEX in the system prompt
// (skillToolSystem); a tool per document would multiply the per-turn schema cost by the
// size of the package, which is the mistake F2.1 was written to stop.
//
// WHAT IT WILL NOT DO
//   • serve `scripts/` — tier-3 code runs in the bridge behind the scanner, and handing a
//     model the source instead would carry the injection surface with none of the use;
//   • serve a path the skill did not declare. The allowlist is the skill's own `files`
//     index, so a prompt cannot talk the model into requesting ../../.ssh/id_rsa. The
//     bridge refuses that too — this is the near side of the same boundary.

const MAX_CHARS = 24_000; // one reference document, not a corpus dumped into the context

export const SKILL_FILE_TOOL = 'skill_file';

/**
 * @param skillRun  from skillRunFromSkill — carries `files` (the declared index) and
 *                  `origin` (which source the skill came from)
 * @param read      (origin, path) -> Promise<{ text }>. Injected: reaching the bridge is a
 *                  platform concern, and this module has to stay testable without one.
 */
export function skillFileProvider({ skillRun, read }) {
  const allowed = Array.isArray(skillRun?.files) ? skillRun.files.filter(Boolean) : [];
  // No package, no tool. An empty tool advertised on every turn is pure token cost.
  if (!allowed.length || !skillRun?.origin?.source || typeof read !== 'function') return null;

  return {
    id: 'skill-files',
    specs: [{
      name: SKILL_FILE_TOOL,
      description:
        'Read one reference file that the active skill ships. Only the exact paths listed in '
        + 'the skill instructions are available. Read one at a time, and only when the task needs it.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Exact path from the skill\'s file list, e.g. references/auth.md',
            enum: allowed.slice(0, 40), // the schema IS the allowlist the model sees
          },
        },
        required: ['path'],
      },
    }],
    async execute(name, args) {
      if (name !== SKILL_FILE_TOOL) return null;
      const path = String(args?.path || '').trim();
      // Checked against the declared index rather than trusted from the arguments: the
      // enum is a hint to the model, never a guarantee about what arrives.
      if (!allowed.includes(path)) {
        return `Not available. This skill ships: ${allowed.join(', ')}`;
      }
      try {
        const out = await read(skillRun.origin, path);
        const text = String(out?.text ?? '');
        if (!text.trim()) return `${path} is empty.`;
        return text.length > MAX_CHARS
          ? `${text.slice(0, MAX_CHARS)}\n\n…[truncated — ${text.length - MAX_CHARS} more characters]`
          : text;
      } catch (e) {
        // A missing reference must not fail the turn: the model can still answer from the
        // SKILL.md, and saying so is more useful than an exception the user has to decode.
        return `Could not read ${path}: ${e?.message || e}`;
      }
    },
  };
}
