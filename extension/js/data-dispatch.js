// PROGRESSIVE DISCLOSURE for the user's own data — one registered tool instead of six.
//
// The history and web-search schemas cost ~1,760 tokens on EVERY turn (1,081 of schema
// plus a 678-token system block explaining them), paid whether or not the turn touched
// the user's data. It was noticed on "hi": the model, handed 678 tokens of instructions
// about history tools, opened the conversation by reciting them. It was doing what we
// asked.
//
// `narrowToolset` could not help. It culls remote MCP tools by relevance but is called
// with `keep: isLocalToolSpec`, so local tools were exempt from culling and therefore
// unconditionally resident. Culling them by relevance instead would trade a constant cost
// for a guessing game, and a turn that needed history would silently lose it. A
// dispatcher has no such trade: everything stays reachable, nothing is guessed, and the
// saving is identical on every turn.

import { makeDispatchProvider, estimate } from './group-dispatch.js';

export const DATA_TOOL_NAME = 'find';
export { estimate };

const DESCRIPTION =
  'Search and read the user\'s own saved data (past chats, notes, meetings) and the web. '
  + 'Pass an `action` and put that action\'s own arguments inside `args`, e.g. '
  + '{"action":"history_search","args":{"query":"pricing"}}. Unsure of an action\'s '
  + 'arguments? {"action":"describe","args":{"tool":"<action>"}} returns its full schema. '
  + 'Use this when the answer plausibly depends on something the user already has; do not '
  + 'call it for greetings or general knowledge.';

export function dataDispatchProvider(inner) {
  return makeDispatchProvider({
    name: DATA_TOOL_NAME,
    description: DESCRIPTION,
    // One line resident, not 678. The rest travels with `describe`.
    resident: 'Call `find` to search the user\'s own chats, notes and meetings, or the web.',
    inner,
    remote: false, // local execution — history is on-device, web search is proxied per settings
  });
}
