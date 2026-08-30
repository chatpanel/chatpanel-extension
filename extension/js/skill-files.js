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

import { enabledSkills, skillHandle, skillPackageFiles } from './skill-runtime.js';

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


// ── Discovery: use any INSTALLED skill without adding it first ─────────────────────────
//
// The counterpart to the level-0 catalog (skillCatalogSystem). The model sees a catalog of
// every skill the machine has — the user's own added ones AND everything installed under
// any known agent harness (Claude Code, Codex, Copilot, Gemini, Hermes, ~/.agents, and any
// custom folder) — and calls skill_open(name) to load the one that fits. The full prompt is
// fetched only on that open, so nothing but a line per skill is paid up front.
//
// This is what makes Add optional: you do not add a skill to USE it, only to pin it as a
// /command or edit its prompt. An entry carries its body inline (added skills) or fetches it
// on open (installed skills), so the catalog stays cheap either way.
//
// Reference files are gated behind the open: a skill's references become fetchable only
// after the model has decided to use that skill, never before.

/** A catalog entry the discovery provider works on. `prompt` may be null (loaded on open). */
export function skillEntry(skill, { prompt = skill?.prompt ?? null } = {}) {
  return {
    command: skillHandle(skill),
    name: skill?.name || skillHandle(skill),
    description: skill?.description || '',
    files: skillPackageFiles(skill),
    origin: skill?.origin?.source ? { source: skill.origin.source, id: skill.origin.id || '' } : null,
    prompt,
  };
}

/**
 * @param entries    merged catalog: [{ command, name, description, files, origin, prompt }]
 * @param loadPrompt async (entry) -> the skill's full instructions (entry.prompt, or fetched)
 * @param read       async (origin, path) -> { text } for a reference file
 */
export function skillDiscoveryProvider({ entries = [], loadPrompt, read }) {
  const list = entries.filter((e) => e && e.command);
  if (!list.length) return null;
  const byHandle = new Map(list.map((e) => [e.command, e]));
  const opened = new Map(); // handle -> entry; a reference is fetchable only after its open

  const specs = [{
    name: 'skill_open',
    description:
      'Load a skill from the SKILLS AVAILABLE list to get its full instructions. Open one '
      + 'only when the request clearly matches it, then follow what it returns.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', enum: [...byHandle.keys()].slice(0, 60) } },
      required: ['name'],
    },
  }];

  const anyFiles = typeof read === 'function' && list.some((e) => e.files?.length);
  if (anyFiles) {
    specs.push({
      name: 'skill_file',
      description: 'Read one reference file from a skill you have opened with skill_open.',
      input_schema: {
        type: 'object',
        properties: { skill: { type: 'string' }, path: { type: 'string' } },
        required: ['skill', 'path'],
      },
    });
  }

  return {
    id: 'skill-discovery',
    specs,
    async execute(name, args) {
      if (name === 'skill_open') {
        const e = byHandle.get(String(args?.name || '').trim().toLowerCase());
        if (!e) return `No such skill. Available: ${[...byHandle.keys()].join(', ')}`;
        opened.set(e.command, e);
        let prompt = '';
        try { prompt = (await loadPrompt(e)) || ''; } catch (err) { return `Could not load ${e.name}: ${err?.message || err}`; }
        let out = prompt.trim() || '(this skill has no extra instructions — just apply it.)';
        if (e.files?.length) {
          out += `\n\nThis skill ships reference files: ${e.files.join(', ')}. `
            + `Call skill_file with skill="${e.command}" and one of those paths to read one, only if the task needs it.`;
        }
        return out;
      }
      if (name === 'skill_file') {
        const e = opened.get(String(args?.skill || '').trim().toLowerCase());
        if (!e) return 'Open the skill first with skill_open, then read its files.';
        const path = String(args?.path || '').trim();
        if (!e.files?.includes(path)) return `Not available. ${e.name} ships: ${(e.files || []).join(', ')}`;
        if (!e.origin?.source) return `${e.name} has no package files on disk.`;
        try {
          const out = await read(e.origin, path);
          const text = String(out?.text ?? '');
          if (!text.trim()) return `${path} is empty.`;
          return text.length > MAX_CHARS
            ? `${text.slice(0, MAX_CHARS)}\n\n…[truncated — ${text.length - MAX_CHARS} more characters]`
            : text;
        } catch (err) {
          return `Could not read ${path}: ${err?.message || err}`;
        }
      }
      return null;
    },
  };
}
