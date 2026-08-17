// PROGRESSIVE DISCLOSURE for the user's own data — one registered tool instead of six.
//
// The history and web-search schemas cost ~1,760 tokens on EVERY turn (1,081 of schema
// plus a 678-token system block explaining them). That is paid whether or not the turn
// touches the user's data — including when the user types "hi", which is where it was
// noticed: the model, handed 678 tokens of instructions about history tools, opened the
// conversation by listing them.
//
// `narrowToolset` could not help. It culls remote MCP tools by relevance but is called
// with `keep: isLocalToolSpec`, so local tools were exempt from culling and therefore
// unconditionally resident. Making them culled-by-relevance instead would trade a
// constant cost for a guessing game — a turn that needed history would silently lose it.
//
// A dispatcher has no such trade: everything stays reachable, nothing is guessed, and the
// saving is the same on every turn. Built on the page dispatcher's generalised core
// rather than a second copy, because the three bugs that shape earned (the stripped
// `args` envelope, the blinded loop guard, the unreadable activity rows) are exactly the
// bugs a hand-written second copy would earn again.

import { buildGroupDispatchSpec, makeGroupDispatchExecutor } from './page-dispatch.js';

export const DATA_TOOL_NAME = 'find';

const DESCRIPTION =
  'Search and read the user\'s own saved data (past chats, notes, meetings) and the web. '
  + 'Pass an `action` and put that action\'s own arguments inside `args`, e.g. '
  + '{"action":"history_search","args":{"query":"pricing"}}. Unsure of an action\'s '
  + 'arguments? {"action":"describe","args":{"tool":"<action>"}} returns its full schema. '
  + 'Use this when the answer plausibly depends on something the user already has; do not '
  + 'call it for greetings or general knowledge.';

/**
 * Wrap history/web providers into ONE provider exposing a single `find` tool.
 *
 * The inner toolset keeps its own routing and its own `system` text — but that text is no
 * longer resident. It is returned by `describe`, so the model reads the detailed guidance
 * exactly when it is about to act on it, which is also when it is most likely to follow it.
 */
export function dataDispatchProvider(inner) {
  if (!inner || !inner.specs?.length) return null;
  const specs = inner.specs;
  return {
    specs: [buildGroupDispatchSpec({ name: DATA_TOOL_NAME, specs, description: DESCRIPTION })],
    // One line resident, not 678. The rest travels with `describe`.
    system: 'Call `find` to search the user\'s own chats, notes and meetings, or the web.',
    execute: withGuidance(
      makeGroupDispatchExecutor({
        name: DATA_TOOL_NAME,
        specs,
        // Routes to the REAL executor on the REAL tool name, so every guard, budget and
        // Pro gate downstream keeps firing on the name it was written against. A
        // dispatcher must never become a way around them.
        runAction: (name, args, meta) => inner.execute(name, args, meta),
      }),
      inner.system,
    ),
  };
}

/**
 * Attach the detailed guidance (citation policy, when to prefer which source) to
 * `describe` instead of the prompt. The model reads it at the moment it is about to act
 * on it, which is also when it is most likely to actually follow it — and a turn that
 * never searches never pays for it.
 */
function withGuidance(execute, guidance) {
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

/** Rough token estimate — used by the budget test, not at runtime. */
export const estimate = (v) => Math.round(JSON.stringify(v).length / 4);
