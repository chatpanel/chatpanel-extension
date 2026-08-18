// What a relayed agent may do with its OWN tools.
//
// ChatPanel hands a CLI agent — Claude Code, Codex, OpenCode — a set of relayed tools: the
// live browser tab, the user's own ChatPanel data, their connected MCP servers. Every word
// written about that set was a RESTRICTION ("use only the ChatPanel browser tools", "do NOT
// use any built-in browser", "do not fetch the URL"), because each was written to stop a
// specific substitution. Read together, and by a model that also carries a Slack connector, a
// Jira connector and a filesystem, they say something nobody meant: do not use your own tools.
//
// The observed cost: asked what a decision was, the agent read the page, found it referenced
// an internal Slack thread, and told the user to go and look it up — while holding a Slack
// connector ChatPanel cannot see and did not forbid.
//
// So the boundary is stated positively and in one place. ChatPanel's tools are authoritative
// for the things only ChatPanel can reach; everything else the agent can reach is still the
// agent's to reach, and finishing the job beats handing it back.
//
// WHY THIS IS SAFE TO SAY. It grants nothing: the agent already had these tools and the user
// already connected them. It only removes an inhibition this harness created. Nothing here
// widens what the agent can touch, and the page/redaction/reach rules are unchanged.

/** Kinds of target that run their own tool loop and bring their own connectors. */
const RELAYED = new Set(['bridge']);

export function isRelayedAgent(agent) {
  return RELAYED.has(String(agent?.kind || ''));
}

/**
 * The capability note for a relayed agent, or '' for an API model (which has no tools of its
 * own, so the whole question does not arise).
 *
 * @param connectors the agent's OWN MCP server names, as the bridge read them out of that
 *        agent's config (`/health` → `agents[].connectors`). Naming them beats listing
 *        plausible ones: "you have slack and jira connected" is a fact the agent can act on,
 *        while a generic list invites it to look for connectors it does not have and conclude
 *        the whole paragraph is hypothetical.
 *
 *        NAMING THEM DISCLOSES NOTHING. This is the agent's own configuration, read from the
 *        agent's own config file, told back to that same agent — which already has it. The
 *        prompt is rebuilt per agent, so a failover to a different one does not carry the
 *        first one's connectors along.
 *
 *        Empty is the honest fallback, not a failure: an older bridge sends no connectors,
 *        and a generic list still beats the silence that made an agent hand the question back.
 */
export function ownToolsSystem(agent, connectors = []) {
  if (!isRelayedAgent(agent)) return '';
  const named = [...new Set((connectors || []).filter((c) => typeof c === 'string' && c.trim()))].slice(0, 24);
  const yours = named.length
    ? `your own MCP connectors — you have ${named.join(', ')} configured — plus your filesystem and your shell`
    : 'your own MCP connectors (Slack, Jira, GitHub, Confluence, calendar, email), your filesystem, your shell';
  return [
    'YOUR OWN TOOLS STILL APPLY. The ChatPanel tools above are authoritative for what only',
    'ChatPanel can reach — this browser tab, the user\'s ChatPanel notes/chats/meetings, and the',
    'MCP servers they connected THERE. They are not a restriction on the rest of your toolset.',
    `For anything else — ${yours} — use them normally.`,
    'FINISH THE JOB RATHER THAN HANDING IT BACK. If the answer points somewhere you can reach —',
    'a thread, a ticket, a repo, a document — go and read it, then answer. Telling the user to',
    'go and look something up themselves is a last resort, for when you genuinely have no tool',
    'that reaches it; say which tool you lack when that happens, rather than declining vaguely.',
  ].join(' ');
}
