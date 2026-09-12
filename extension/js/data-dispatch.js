// `find` — the user's own data and the web behind one tool. SHARED: the name, the wording
// and the routing live in `@chatpanel/events/find-tool.js`, so the desktop's `find` is this
// `find`. Only what goes BEHIND it (which history store, which search engines) is built
// here, in tool-groups/data.js.

export { FIND_TOOL_NAME as DATA_TOOL_NAME, findDispatchProvider as dataDispatchProvider } from './events/find-tool.js';
export { estimateTokens as estimate } from './events/tool-dispatch.js';
