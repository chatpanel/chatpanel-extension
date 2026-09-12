// GENERATED — do not edit.
// Source of truth: chatpanel-events/find-tool.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// `find` — the user's own data and the web, behind ONE registered tool.
//
// The history and web-search schemas cost ~1,760 tokens on EVERY turn (1,081 of schema plus
// a 678-token system block explaining them), paid whether or not the turn touched the user's
// data. It was noticed on "hi": the model, handed 678 tokens of instructions about history
// tools, opened the conversation by reciting them. It was doing what we asked.
//
// Relevance-narrowing could not help: local tools are exempt from culling on purpose, and
// culling them by relevance would trade a constant cost for a guessing game in which a turn
// that needed history silently lost it. A dispatcher has no such trade: everything stays
// reachable, nothing is guessed, and the saving is identical on every turn.
//
// The NAME and the WORDING are the contract every client shares. The extension's `find`
// and the desktop's `find` must be the same tool — a model that learned to call one on the
// panel should find the identical tool in the app, and a recipe recorded on one must run on
// the other. What goes BEHIND it (which search engine, which history store) is the host's.

import { makeDispatchProvider } from './tool-dispatch.js';

export const FIND_TOOL_NAME = 'find';

export const FIND_DESCRIPTION =
  'Search and read the user\'s own saved data (past chats, notes, meetings) and the web. '
  + 'Pass an `action` and put that action\'s own arguments inside `args`, e.g. '
  + '{"action":"history_search","args":{"query":"pricing"}}. Unsure of an action\'s '
  + 'arguments? {"action":"describe","args":{"tool":"<action>"}} returns its full schema. '
  + 'Use this when the answer plausibly depends on something the user already has; do not '
  + 'call it for greetings or general knowledge.';

// One line resident, not 678. The rest travels with `describe`.
//
// SAY THAT IT HAS THE DATA, not just that a tool exists. Asked "check my meetings with
// <name>", a model answered "I do not have access to your personal calendar, emails, or
// meeting history" — while `find` was sitting in its toolset. The old line named the tool
// and left the capability to be inferred, and inference is what small models are worst at.
export const FIND_RESIDENT =
  "You HAVE access to the user's own ChatPanel data — their past chats, notes, and "
  + 'meeting transcripts and summaries — through the `find` tool, plus the web. When the '
  + 'question is about past meetings, notes, people, decisions, or anything the user '
  + 'discussed or wrote, call `find` FIRST and answer from what it returns. Never tell '
  + 'the user you cannot access their meetings, notes or history: you can.';

/**
 * Wrap the real search/read tools (history, web search, weather…) as the one `find` tool.
 *
 * `remote` is false: history is on-device and web search is proxied by the host under its
 * own settings, so the harness hands these tools real values under "redact remote".
 */
export function findDispatchProvider(inner, { all = null, rank = undefined } = {}) {
  return makeDispatchProvider({
    name: FIND_TOOL_NAME,
    description: FIND_DESCRIPTION,
    resident: FIND_RESIDENT,
    inner,
    remote: false,
    all,
    rank,
  });
}
