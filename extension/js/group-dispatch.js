// Turn a group of tools into ONE registered tool — the reusable half of progressive
// disclosure.
//
// The page dispatcher proved the shape and earned three bugs doing it (the stripped
// `args` envelope, the blinded loop guard, the unreadable activity rows). Every later
// group — the user's own data, MCP servers — goes through this instead of re-earning
// them.
//
// What a group supplies is only what is genuinely its own: a name, a sentence about when
// to reach for it, and whether its tools are remote. Everything structural is here.

import { buildGroupDispatchSpec, makeGroupDispatchExecutor } from './page-dispatch.js';
import { traitsIndex } from './events/tool-traits.js';

/**
 * @param inner    a toolset ({ specs, execute, system }) — the real tools, kept whole.
 * @param resident the ONE line that stays in the prompt. Everything else the group wants
 *                 to say travels with `describe`.
 * @param remote   true when these tools call a third party. This is load-bearing for
 *                 PRIVACY, not bookkeeping: the harness uses it to keep PII off remote
 *                 tools under "redact remote". A dispatcher that lost the flag would
 *                 quietly turn redacted tools into unredacted ones.
 * @param all      every spec the group can reach when the menu (`inner.specs`) is a
 *                 relevance-capped subset. `find` searches it; any action in it runs.
 * @param rank     the ranker `find` uses — the shared IDF one, so discovery agrees with
 *                 the narrowing that hid the tool in the first place.
 */
export function makeDispatchProvider({ name, description, resident, inner, remote = false, all = null, rank = undefined }) {
  if (!inner || !inner.specs?.length) return null;
  const specs = inner.specs;
  const reach = all && all.length > specs.length ? all : specs;
  return {
    specs: [buildGroupDispatchSpec({ name, specs, description, hidden: reach.length - specs.length })],
    system: resident,
    remote,
    // What each REAL tool does to the world (annotations, else its name) — read by the
    // round runner through the dispatcher, which otherwise hides every inner spec.
    traits: traitsIndex(reach),
    execute: withGuidance(
      makeGroupDispatchExecutor({
        name,
        specs,
        all: reach,
        rank,
        // Routes on the REAL tool name so every guard, budget and gate downstream keeps
        // firing on the name it was written against. A dispatcher must never become a
        // way around them.
        runAction: (toolName, args, meta) => inner.execute(toolName, args, meta),
      }),
      inner.system,
    ),
  };
}

/**
 * Attach a group's detailed guidance to `describe` instead of the prompt. The model reads
 * it at the moment it is about to act on it — which is when it is most likely to follow
 * it — and a turn that never reaches for the group never pays for it.
 */
export function withGuidance(execute, guidance) {
  if (!guidance) return execute;
  return async (name, input, meta) => {
    const out = await execute(name, input, meta);
    if (String(input?.action || '') !== 'describe') return out;
    try {
      const parsed = JSON.parse(out);
      if (!parsed || !parsed.name) return out;
      return JSON.stringify({ ...parsed, guidance });
    } catch {
      return out;
    }
  };
}

/** Rough token estimate — used by budget tests, not at runtime. */
export const estimate = (v) => Math.round(JSON.stringify(v).length / 4);
