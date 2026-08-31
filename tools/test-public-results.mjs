// Redaction protects what LEAVES the device. Rewriting what comes BACK from a public web
// search buys no privacy and corrupts facts — a dictionary pseudonym renamed a public actor
// inside search results and the answer came back about "Mysore Seshaiah John Babu Naidu".
import assert from 'node:assert/strict';
import { makeToolHarness, isPublicSourceTool } from '../extension/js/tool-harness.js';
import { createVault } from '../extension/js/pii-redact.js';

// The allowlist is explicit and narrow — being wrong in the "public" direction would send
// real PII to a model.
assert.equal(isPublicSourceTool('web_search'), true);
assert.equal(isPublicSourceTool('WEB_SEARCH'), true, 'case-insensitive');
for (const local of ['history_search', 'read_page', 'inspect_page', 'list_meetings', 'mcp_jira__issue', 'get_record']) {
  assert.equal(isPublicSourceTool(local), false, `${local} is NOT public — its output can be private`);
}

const vault = createVault();
const harness = makeToolHarness({
  vault,
  toolData: 'redactRemote',
  redactOpts: { tier: 'basic', dictionary: [{ value: 'Suresh', alias: 'John' }] },
});

// A public search result keeps the real public name — the answer stays factually correct.
const web = harness.toModelResult('web_search', { text: 'Mysore Seshaiah Suresh Babu Naidu is an actor.' });
assert.match(web.text, /Suresh/, 'a public figure is not renamed in fetched results');
assert.ok(!/John/.test(web.text), 'the pseudonym is not applied to public content');

// A LOCAL result is still redacted — this is where a leak could actually happen.
const local = harness.toModelResult('history_search', { text: 'Meeting with Suresh about the roadmap.' });
assert.ok(!/Suresh/.test(local.text), "the user's own history is still pseudonymised");
assert.match(local.text, /John/, 'and the pseudonym is applied there');

console.log('ok — public results stay factual; local/private results stay redacted');
