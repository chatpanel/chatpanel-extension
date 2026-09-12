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

import { buildGroupDispatchSpec, makeGroupDispatchExecutor } from './events/tool-dispatch.js';

// The GENERIC half — the menu, the spec, validation, the executor — is shared
// (`@chatpanel/events/tool-dispatch.js`) and re-exported here so existing imports hold.
// What stays in this file is the one thing that is the page's own: its wording.
export {
  DESCRIBE_ACTION, actionMenu, buildGroupDispatchSpec, validateAction, makeGroupDispatchExecutor,
  withGuidance, estimateTokens,
} from './events/tool-dispatch.js';

export const DISPATCH_TOOL_NAME = 'page';

/** The single registered spec for page actions. Resident cost is this and nothing else. */
export function buildDispatchSpec(specs) {
  return buildGroupDispatchSpec({
    name: DISPATCH_TOOL_NAME,
    specs,
    description:
      'Read or act on the user\'s active browser tab. Pass an `action` with that action\'s '
      + 'own arguments inside `args`, e.g. {"action":"click_at","args":{"x":120,"y":340}}.\n'
      + 'TO READ (summarise, quote, answer about the page): {"action":"read_page","args":{}} '
      + 'ONCE — it returns the whole text. Never screenshot-and-scroll to read.\n'
      + 'TO ACT: {"action":"inspect_page","args":{}} first, for real selectors. Screenshots '
      + 'are for layout only.\n'
      + 'Arguments? {"action":"describe","args":{"tool":"<action>"}}.',
  });
}

/** Page-action executor — the guarded per-action path, unchanged. */
export function makeDispatchExecutor(specs, runAction) {
  return makeGroupDispatchExecutor({ name: DISPATCH_TOOL_NAME, specs, runAction });
}
