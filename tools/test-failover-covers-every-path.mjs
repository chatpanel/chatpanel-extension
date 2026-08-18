// EVERY MODEL DISPATCH IN A TURN GOES THROUGH FAILOVER — including the redacted one.
//
// The redaction path called dispatchStream directly, so a declining model killed the turn
// outright, and only for users who had privacy switched ON. Privacy and reliability are not a
// trade: turning redaction on must not quietly remove the thing that keeps a turn alive when
// a provider says no.
//
// Checked structurally because the failure is structural. The redaction branch was added
// later and simply did not call the wrapper — no test of behaviour would have caught that,
// because the behaviour it skipped is the behaviour that only appears when a model fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');

// The turn itself: everything from streamChatTurn to the end of its redaction branch. The
// diagnostic harness above it ("Test a prompt" in Settings) is not a turn and needs no
// failover — it is one call the user explicitly asked for and watches fail.
const turnStart = src.indexOf('async function streamChatTurn(');
const turnEnd = src.indexOf('async function withFailover(');
assert.ok(turnStart > 0 && turnEnd > turnStart, 'the turn body could not be located');
const body = src.slice(turnStart, turnEnd);

// Both branches — with redaction and without — hand their dispatch to the wrapper.
const wrapped = body.match(/await withFailover\(/g) || [];
assert.equal(wrapped.length, 2, `expected both turn paths to use withFailover, found ${wrapped.length}`);

// And neither of them awaits the dispatcher directly, which is exactly what the redaction
// branch used to do.
assert.ok(!/=\s*await dispatchStream\(/.test(body),
  'a turn path awaits dispatchStream directly — that path cannot fail over');

// The replacement must be handed the REDACTED system prompt. withFailover spreads the new
// target over the agent, and a target carrying a system prompt of its own would otherwise
// replace the redacted copy with the raw one — a leak that appears only on the second hop.
assert.match(body, /agent:\s*\{\s*\.\.\.a,\s*systemPrompt\s*\}/,
  'the redacted system prompt is not re-applied to a replacement model');

// The turn travels with the re-route, or every replacement is chosen as though the turn were
// a generic one and the chain stops degrading in the direction it started in.
const failover = src.slice(turnEnd);
assert.match(failover, /request:\s*\{\s*messages\s*\}/,
  'the failover re-route does not carry the request, so the preference is recomputed from nothing');

console.log('✓ failover covers every turn path, redacted or not, and carries the turn with it');
