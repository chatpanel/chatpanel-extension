// A RELAYED AGENT KEEPS ITS OWN TOOLS.
//
// ChatPanel hands a CLI agent a set of relayed tools — the live tab, the user's own data,
// their connected MCP servers — and every word written about that set was a RESTRICTION:
// "use only the ChatPanel browser tools", "do NOT use any built-in browser", "do not fetch
// the URL". Each was written to stop a specific substitution. Read together by a model that
// also carries a Slack connector, they say something nobody meant.
//
// The observed cost: asked what a decision was, the agent read the page, saw it referenced an
// internal thread, and told the user to go look it up — while holding a connector that
// reaches that thread, which ChatPanel cannot see and never forbade.
import assert from 'node:assert/strict';
import { ownToolsSystem, isRelayedAgent } from '../extension/js/agent-capabilities.js';
import { PAGE_AUTOMATION_SYSTEM } from '../extension/js/page-tools.js';

// A CLI agent runs its own loop and brings its own connectors.
assert.equal(isRelayedAgent({ kind: 'bridge' }), true);
// An API model has no tools of its own, so the question does not arise — and a note about
// connectors it does not have would be noise on every turn.
assert.equal(isRelayedAgent({ kind: 'endpoint' }), false);
assert.equal(ownToolsSystem({ kind: 'endpoint' }), '');
assert.equal(ownToolsSystem(null), '');

const note = ownToolsSystem({ kind: 'bridge' });

// It states the boundary POSITIVELY: ChatPanel is authoritative for what only ChatPanel
// reaches, and explicitly not a restriction on the rest.
assert.match(note, /not a restriction on the rest of your toolset/);
assert.match(note, /Slack, Jira, GitHub/, 'the connectors an agent actually carries are not named');

// And it says what to DO with them, which is the behaviour that was missing.
assert.match(note, /FINISH THE JOB RATHER THAN HANDING IT BACK/);
assert.match(note, /go and read it, then answer/);
// Declining is still allowed — but only when it is true, and it has to say what is missing.
assert.match(note, /last resort/);
assert.match(note, /say which tool you lack/);

// THE TAB RULE STAYS A TAB RULE. Narrowing the prohibition is half the fix; without this the
// positive note and the page manual contradict each other, and a model resolves that by doing
// nothing.
assert.match(PAGE_AUTOMATION_SYSTEM, /TO SEE OR ACT ON THIS BROWSER TAB/);
assert.match(PAGE_AUTOMATION_SYSTEM, /This is a rule about the TAB, not about your other tools/);
assert.match(PAGE_AUTOMATION_SYSTEM, /DO NOT FETCH THIS TAB'S URL/);
// It must NOT read as a blanket ban any more.
assert.doesNotMatch(PAGE_AUTOMATION_SYSTEM, /^USE ONLY/m, 'the manual still opens with an unbounded restriction');

// GRANTS NOTHING. The agent already had these tools and the user already connected them; this
// only removes an inhibition the harness created. Nothing here mentions widening reach,
// bypassing redaction, or acting without the user.
for (const forbidden of [/bypass/i, /ignore the user/i, /without asking/i, /disable/i]) {
  assert.doesNotMatch(note, forbidden, `the capability note contains ${forbidden}`);
}

// ── AND IT NAMES WHAT THE AGENT ACTUALLY HAS ────────────────────────────────
//
// The bridge reads each agent's own MCP config and reports the server NAMES on /health.
// "You have slack and jira configured" is a fact the agent can act on; a generic list invites
// it to look for connectors it does not have and read the whole paragraph as hypothetical.
{
  const named = ownToolsSystem({ kind: 'bridge' }, ['slack', 'jira-cloud', 'github']);
  assert.match(named, /you have slack, jira-cloud, github configured/);
  // The generic list is gone once we know the real one — otherwise it says both.
  assert.doesNotMatch(named, /Confluence, calendar, email/);

  // AN OLDER BRIDGE SENDS NOTHING, and that must not be worse than before the feature: the
  // generic wording still beats the silence that made an agent hand the question back.
  assert.match(ownToolsSystem({ kind: 'bridge' }, []), /Slack, Jira, GitHub/);
  assert.match(ownToolsSystem({ kind: 'bridge' }), /Slack, Jira, GitHub/);

  // Deduped and bounded: this rides in every turn's system prompt, so forty servers cost a
  // line, not a paragraph.
  const many = ownToolsSystem({ kind: 'bridge' }, [...Array(40)].map((_, i) => `srv-${i}`).concat('srv-0'));
  assert.equal((many.match(/srv-\d+/g) || []).length, 24);

  // Junk in the list never reaches the prompt.
  assert.match(ownToolsSystem({ kind: 'bridge' }, ['slack', '', '   ', null, 7]), /you have slack configured/);

  // AN API MODEL STILL GETS NOTHING, connectors or not — it has no tools of its own, so the
  // note would be noise on every turn.
  assert.equal(ownToolsSystem({ kind: 'endpoint' }, ['slack']), '');
}

console.log('✓ relayed agents: ChatPanel bounds what it owns, and does not disown the rest');
