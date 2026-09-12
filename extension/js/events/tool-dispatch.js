// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-dispatch.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// PROGRESSIVE TOOL DISCLOSURE — a group of tools registered as ONE tool.
//
// Twenty page-action schemas cost ~3,300 tokens on EVERY turn; six data tools cost ~1,760.
// Paid whether or not the turn touched any of them, and on a small local model that can eat
// half the context before the user has typed anything. So a group is registered as one
// compact tool carrying an action enum and a one-line gist each; the full schema for any
// action is REACHABLE via `{action:'describe', tool:'<name>'}`, and arguments are validated
// at execution with a structured error the model can act on.
//
// WHY A DISPATCHER RATHER THAN AN INDEX. Over MCP a model may only call tools that are
// REGISTERED; returning a schema from an index tool would not make the described tool
// callable. A dispatcher is one registered tool that can reach all of them, so the same
// mechanism works for a relayed CLI agent and for an in-client loop.
//
// The page dispatcher proved the shape and earned three bugs doing it (the stripped `args`
// envelope, the blinded loop guard, the unreadable activity rows). Every later group — the
// user's own data, MCP servers, and now the desktop's turn — goes through this instead of
// re-earning them. What a group supplies is only what is genuinely its own: a name, a
// sentence about when to reach for it, and whether its tools are remote.

import { FIND_ACTION, findToolsResult, findActionArgs } from './tool-discovery.js';
import { traitsIndex } from './tool-traits.js';

export const DESCRIBE_ACTION = 'describe';

/** First sentence of a description — enough to choose an action, not to call it blind. */
function gistOf(spec) {
  const text = String(spec.description || '').replace(/\s+/g, ' ').trim();
  const stop = text.search(/(?<=[.!?])\s/);
  const first = stop > 0 ? text.slice(0, stop) : text;
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first;
}

function requiredOf(spec) {
  const req = spec?.parameters?.required;
  return Array.isArray(req) ? req : [];
}

/** The action menu — one line per action, enough to choose but not to call blind. */
export function actionMenu(specs) {
  return specs.map((s) => {
    const req = requiredOf(s);
    return `- ${s.name}${req.length ? `(${req.join(', ')})` : '()'}: ${gistOf(s)}`;
  }).join('\n');
}

/**
 * Build a dispatcher spec for ANY group of tools.
 *
 * @param hidden how many more actions the group can reach than the menu lists (a relevance
 *               cap trimmed it). When > 0 the spec says so and names the way back: `find`
 *               searches every tool the group owns, listed or not. Without that line a tool
 *               the cap dropped was, for that turn, gone.
 */
export function buildGroupDispatchSpec({ name, description, specs, hidden = 0 }) {
  const more = hidden > 0
    ? `\n${hidden} more action${hidden === 1 ? '' : 's'} not listed — {"action":"${FIND_ACTION}","args":{"query":"<task words>"}} finds them by name.`
    : '';
  return {
    name,
    description: `${description}\n\nActions:\n${actionMenu(specs)}${more}`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [DESCRIBE_ACTION, ...(hidden > 0 ? [FIND_ACTION] : []), ...specs.map((s) => s.name)],
          description: 'Which action to run.',
        },
        // A DECLARED envelope, not `additionalProperties`. Providers and MCP validators
        // routinely strip properties that are not in `properties`, so undeclared top-level
        // arguments silently vanish before they reach the executor — which is exactly how
        // `structured_insert` lost its `elements` array. Anything declared survives.
        args: {
          type: 'object',
          description: 'The chosen action\'s own arguments, verbatim. Use {} when it takes none.',
          additionalProperties: true,
        },
        tool: { type: 'string', description: `With action="${DESCRIBE_ACTION}": the action to describe.` },
        ...(hidden > 0 ? findActionArgs() : {}),
      },
      required: ['action'],
      additionalProperties: true, // tolerated, but never relied upon — see `args`
    },
  };
}

/**
 * Validate arguments against the REAL spec. Returns null when fine, else a structured error
 * naming exactly what is missing — a bounded repair path instead of a dead turn.
 */
export function validateAction(spec, args) {
  const missing = requiredOf(spec).filter((k) => args[k] === undefined || args[k] === null);
  if (!missing.length) return null;
  return {
    error: `Missing required argument(s) for "${spec.name}": ${missing.join(', ')}.`,
    required: requiredOf(spec),
    hint: `Put them inside \`args\`: {"action":"${spec.name}","args":{...}}. `
      + `Call {"action":"${DESCRIBE_ACTION}","args":{"tool":"${spec.name}"}} for the full schema.`,
  };
}

/**
 * Route one dispatch call to the real per-action executor.
 *
 * `runAction(name, args, meta)` is the EXISTING guarded executor, so every confirmation gate,
 * budget and site grant keeps firing on the real action name — the dispatcher must never
 * become a way around them.
 *
 * @param specs  the MENU — what the dispatcher lists
 * @param all    everything the group can reach; defaults to the menu. When larger, `find`
 *               searches it and any action in it runs, listed or not.
 * @param rank   `(specs, query) => specs` for `find`; the shared IDF ranker when given
 */
export function makeGroupDispatchExecutor({ name: dispatchName, specs, all = specs, runAction, rank }) {
  const byName = new Map(all.map((s) => [s.name, s]));
  for (const s of specs) byName.set(s.name, s); // the menu's copy wins a duplicate name
  const menuNames = specs.map((s) => s.name);
  return async (name, input, meta) => {
    if (name !== dispatchName) return runAction(name, input, meta); // direct calls still work
    // Accept BOTH shapes. `args` is the declared envelope and the one the description
    // teaches; top-level arguments are merged too, so a model that ignores the envelope — or
    // a provider that happens to pass extras through — still works rather than failing in a
    // way that looks like the tool is broken.
    const raw = input || {};
    const { action: rawAction, args: envelope, tool: rawTool, ...rest } = raw;
    const args = { ...rest, ...(envelope && typeof envelope === 'object' ? envelope : {}) };
    const action = String(rawAction || '');

    if (action === FIND_ACTION) {
      return findToolsResult(all, String(args.query ?? rawTool ?? ''), { rank, describeAction: DESCRIBE_ACTION, menu: menuNames });
    }

    if (action === DESCRIBE_ACTION) {
      const spec = byName.get(String(args.tool || rawTool || ''));
      return JSON.stringify(
        spec
          ? {
            name: spec.name,
            // The full contract when the menu carried a compressed one (tool-schema.js).
            description: spec.full?.description || spec.description,
            parameters: spec.full?.parameters || spec.parameters,
            ...(spec.annotations ? { annotations: spec.annotations } : {}),
            callAs: { action: spec.name, args: '<the properties above, verbatim>' },
          }
          : { error: `Unknown action "${args.tool || rawTool}".`, actions: [...byName.keys()] },
      );
    }

    const spec = byName.get(action);
    if (!spec) {
      return JSON.stringify({
        error: `Unknown action "${action}".`,
        actions: menuNames,
        ...(all.length > specs.length ? { hint: `${all.length - specs.length} more are reachable: {"action":"${FIND_ACTION}","args":{"query":"…"}} finds them.` } : {}),
      });
    }
    const bad = validateAction(spec, args);
    if (bad) return JSON.stringify(bad);
    return runAction(action, args, meta);
  };
}

/**
 * Attach a group's detailed guidance to `describe` instead of the prompt. The model reads it
 * at the moment it is about to act on it — which is when it is most likely to follow it —
 * and a turn that never reaches for the group never pays for it.
 */
export function withGuidance(execute, guidance) {
  if (!guidance) return execute;
  return async (name, input, meta) => {
    const out = await execute(name, input, meta);
    if (String(input?.action || '') !== DESCRIBE_ACTION) return out;
    try {
      const parsed = JSON.parse(out);
      if (!parsed || !parsed.name) return out;
      return JSON.stringify({ ...parsed, guidance });
    } catch {
      return out;
    }
  };
}

/**
 * Turn a toolset into ONE provider — the reusable half of progressive disclosure.
 *
 * @param inner    a toolset ({ specs, execute, system }) — the real tools, kept whole.
 * @param resident the ONE line that stays in the prompt. Everything else the group wants to
 *                 say travels with `describe`.
 * @param remote   true when these tools call a third party. This is load-bearing for
 *                 PRIVACY, not bookkeeping: the harness uses it to keep PII off remote tools
 *                 under "redact remote". A dispatcher that lost the flag would quietly turn
 *                 redacted tools into unredacted ones.
 * @param all      every spec the group can reach when the menu (`inner.specs`) is a
 *                 relevance-capped subset. `find` searches it; any action in it runs.
 * @param rank     the ranker `find` uses — the shared IDF one, so discovery agrees with the
 *                 narrowing that hid the tool in the first place.
 */
export function makeDispatchProvider({ name, description, resident, inner, remote = false, all = null, rank = undefined }) {
  if (!inner || !inner.specs?.length) return null;
  const specs = inner.specs;
  const reach = all && all.length > specs.length ? all : specs;
  return {
    specs: [buildGroupDispatchSpec({ name, specs, description, hidden: reach.length - specs.length })],
    system: resident,
    remote,
    // What each REAL tool does to the world (annotations, else its name) — read by the round
    // runner through the dispatcher, which otherwise hides every inner spec.
    traits: traitsIndex(reach),
    // …and WHICH tools are behind this name, so a recipe step can name the real tool and be
    // routed through the dispatcher (buildToolset builds `hiddenVia` from it).
    reach,
    execute: withGuidance(
      makeGroupDispatchExecutor({
        name,
        specs,
        all: reach,
        rank,
        // Routes on the REAL tool name so every guard, budget and gate downstream keeps
        // firing on the name it was written against.
        runAction: (toolName, args, meta) => inner.execute(toolName, args, meta),
      }),
      inner.system,
    ),
  };
}

/** Rough token estimate — used by budget tests, not at runtime. */
export function estimateTokens(value) {
  return Math.round(JSON.stringify(value).length / 4);
}
