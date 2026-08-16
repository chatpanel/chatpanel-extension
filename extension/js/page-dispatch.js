// PROGRESSIVE TOOL DISCLOSURE for page actions — one registered tool instead of twenty.
//
// The twenty page-action schemas cost ~3,300 tokens on EVERY turn with a web tab open.
// That is paid whether or not the turn touches the page, and on a small local model it
// can eat half the context before the user has typed anything.
//
// Everything is available; only what earns its tokens is resident. So one compact tool is
// registered — `page` — carrying an action enum and a one-line gist each. The full schema
// for any action is REACHABLE via `page({action:'describe', tool:'fill_form'})`, and
// arguments are validated at execution with a structured error the model can act on.
//
// WHY A DISPATCHER RATHER THAN AN INDEX. Over MCP a model may only call tools that are
// REGISTERED; returning a schema from an index tool would not make the described tool
// callable. A dispatcher is one registered tool that can reach all twenty, so the same
// mechanism works for a bridge/CLI agent and for the in-panel loop.
//
// The trade is per-argument schema checking at request time. It is bought back at
// execution: `validateAction` compares arguments against the REAL spec and returns a
// precise, correctable error rather than a failure — which weak models need anyway.

export const DISPATCH_TOOL_NAME = 'page';
const DESCRIBE = 'describe';

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

/** The single registered spec. Resident cost is this and nothing else. */
export function buildDispatchSpec(specs) {
  const lines = specs.map((s) => {
    const req = requiredOf(s);
    return `- ${s.name}${req.length ? `(${req.join(', ')})` : '()'}: ${gistOf(s)}`;
  });
  return {
    name: DISPATCH_TOOL_NAME,
    description:
      'Act on the user\'s active browser tab. Pass an `action` plus that action\'s own '
      + 'arguments, e.g. {"action":"click_at","x":120,"y":340}. Start with '
      + '{"action":"inspect_page"} to learn the page\'s real selectors. Unsure of an '
      + 'action\'s arguments? {"action":"describe","tool":"<action>"} returns its full '
      + 'schema.\n\nActions:\n'
      + lines.join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [DESCRIBE, ...specs.map((s) => s.name)],
          description: 'Which page action to run.',
        },
        tool: { type: 'string', description: `Only with action="${DESCRIBE}": the action to describe.` },
      },
      required: ['action'],
      additionalProperties: true, // each action's own arguments travel here
    },
  };
}

/**
 * Validate arguments against the REAL spec. Returns null when fine, else a structured
 * error naming exactly what is missing — a bounded repair path instead of a dead turn.
 */
export function validateAction(spec, args) {
  const missing = requiredOf(spec).filter((k) => args[k] === undefined || args[k] === null);
  if (!missing.length) return null;
  return {
    error: `Missing required argument(s) for "${spec.name}": ${missing.join(', ')}.`,
    required: requiredOf(spec),
    hint: `Call {"action":"${DESCRIBE}","tool":"${spec.name}"} for the full schema, then retry.`,
  };
}

/**
 * Route one dispatch call to the real per-action executor.
 *
 * `runAction(name, args, meta)` is the EXISTING guarded executor, so the per-action
 * confirmation gate and the site grant keep firing on the real action name — the
 * dispatcher must never become a way around them.
 */
export function makeDispatchExecutor(specs, runAction) {
  const byName = new Map(specs.map((s) => [s.name, s]));
  return async (name, input, meta) => {
    if (name !== DISPATCH_TOOL_NAME) return runAction(name, input, meta); // direct calls still work
    const args = { ...(input || {}) };
    const action = String(args.action || '');
    delete args.action;

    if (action === DESCRIBE) {
      const spec = byName.get(String(args.tool || ''));
      return JSON.stringify(
        spec
          ? { name: spec.name, description: spec.description, parameters: spec.parameters }
          : { error: `Unknown action "${args.tool}".`, actions: [...byName.keys()] },
      );
    }

    const spec = byName.get(action);
    if (!spec) {
      return JSON.stringify({ error: `Unknown action "${action}".`, actions: [...byName.keys()] });
    }
    const bad = validateAction(spec, args);
    if (bad) return JSON.stringify(bad);
    return runAction(action, args, meta);
  };
}

/** Rough token estimate — used by the budget test, not at runtime. */
export function estimateTokens(value) {
  return Math.round(JSON.stringify(value).length / 4);
}
