// The one page tool that needs no page.
//
// A New Tab page, a chrome:// page and ChatPanel's own dashboards are not web pages, so the
// tools that read and act on a tab have nothing to attach to there — and the provider used
// to answer with NOTHING. That withheld `open_tab`, whose executor never touches the current
// tab, and "go to google.com and search for X" is the most natural thing to say to a browser
// from a new tab. Asked exactly that (by voice, four ways), the agent truthfully reported it
// had no way to reach the browser. Now it gets the one action that works anywhere, and is
// told why the rest is missing — so it opens the page instead of apologising.
//
// Pure: the browser call and the approval are injected, so this runs in Node.
import { buildGroupDispatchSpec, makeDispatchExecutor, DISPATCH_TOOL_NAME } from './page-dispatch.js';
import { withGuidance } from './group-dispatch.js';

/** A short phrase for the system line: what the user is looking at instead of a web page. */
export function whereNoPage(url = '') {
  const u = String(url || '');
  if (!u || /^(chrome|edge|brave):\/\/(newtab|new-tab-page)\b/.test(u) || /^about:(blank|newtab|home)\b/.test(u)) return 'a new tab';
  if (/^(chrome|moz)-extension:/.test(u)) return 'an extension page';
  if (/^(chrome|edge|brave|about|vivaldi|opera):/.test(u)) return 'a browser settings page';
  if (/^file:/.test(u)) return 'a local file';
  return 'not a web page';
}

export function openTabOnlySystem(where = 'not a web page') {
  return `The user's current tab is ${where}, not a web page, so the tools that read and act on a page are `
    + 'not attached this turn. You CAN still open a URL: call the `page` tool with '
    + '{"action":"open_tab","args":{"url":"https://…"}} — for "go to X" or "search for X" build the full URL '
    + '(https://www.google.com/search?q=…) and open it; the user approves it. Never tell the user you cannot '
    + 'open a page — you can. To READ or ACT on a page, ask the user to switch to it: the full page tools '
    + 'attach on their next message.';
}

/**
 * @param spec  the open_tab tool spec (from PAGE_TOOL_SPECS — one source of truth)
 * @param run   (url, { active }) → { url, tabId } | { error }   — the browser call
 * @param gate  (input) → Promise<boolean>                        — spoken authority or the confirm dialog
 * @param where whereNoPage(url)
 */
export function makeOpenTabOnlyProvider({ spec, run, gate, where = 'not a web page' }) {
  if (!spec || spec.name !== 'open_tab') throw new Error('makeOpenTabOnlyProvider needs the open_tab spec');
  const specs = [spec];
  const runAction = async (name, input) => {
    if (name !== 'open_tab') {
      return JSON.stringify({ error: `Only open_tab is available here: the current tab is ${where}, not a web page. Ask the user to switch to the page you need.` });
    }
    if (!(await gate(input || {}))) {
      return JSON.stringify({ error: 'The user DECLINED this page action. Do not retry it — stop and ask the user how to proceed.' });
    }
    const r = await run(input?.url, { active: input?.focus !== false });
    return JSON.stringify(r?.error ? r : {
      ...r,
      note: 'Opened in a new tab. Nothing here can read or act on it — if the user wants that, ask them to switch to the tab and say so.',
    });
  };
  const system = openTabOnlySystem(where);
  return {
    // The same `page` tool the agent knows, with its OWN preamble: the standard one teaches
    // read_page and inspect_page first, which here would be instructions for actions that
    // do not exist — the exact confusion this provider is meant to end.
    specs: [buildGroupDispatchSpec({
      name: DISPATCH_TOOL_NAME,
      specs,
      description:
        `Open a URL in a NEW browser tab. The user's current tab is ${where}, not a web page, so this is `
        + 'the ONLY page action available right now: {"action":"open_tab","args":{"url":"https://…"}}. '
        + 'For "search for X" build the URL (https://www.google.com/search?q=…). '
        + 'Arguments? {"action":"describe","args":{"tool":"open_tab"}}.',
    })],
    execute: withGuidance(makeDispatchExecutor(specs, runAction), system),
    system,
  };
}
