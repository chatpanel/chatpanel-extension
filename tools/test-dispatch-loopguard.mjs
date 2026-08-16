// The dispatcher must not blind name-based policy.
//
// Moving page tools behind one registered `page` tool renamed every call, so the loop
// guard's observation exemption stopped matching: screenshot takes {} every time, four in
// a row looked like a stuck loop, and the agent was blocked from LOOKING at the page it
// was trying to fix. That single regression turned a two-step task into forty-four.

import assert from 'node:assert/strict';
import { createToolLoopGuard } from '../extension/js/providers.js';

const guard = createToolLoopGuard ? createToolLoopGuard() : null;
if (!guard) {
  console.log('  (skipped — guard not exported; covered indirectly by providers tests)');
  process.exit(0);
}

// A read taken through the dispatcher is still a read, however many times it repeats.
for (let i = 0; i < 12; i++) {
  const r = guard.check('page', { action: 'screenshot', args: {} });
  assert.equal(r.blocked, false, `screenshot via dispatcher blocked on attempt ${i + 1}`);
}
for (let i = 0; i < 12; i++) {
  assert.equal(guard.check('page', { action: 'marked_screenshot', args: {} }).blocked, false);
  assert.equal(guard.check('page', { action: 'inspect_page', args: {} }).blocked, false);
}

// A genuinely repeated MUTATION still trips — the guard must not be defanged.
let blocked = false;
for (let i = 0; i < 12 && !blocked; i++) {
  blocked = guard.check('page', { action: 'click_at', args: { x: 5, y: 5 } }).blocked;
}
assert.ok(blocked, 'a repeated identical mutation should still be blocked');

// Directly-named tools behave exactly as before.
for (let i = 0; i < 12; i++) assert.equal(guard.check('screenshot', {}).blocked, false);

console.log('✓ loop guard sees through the dispatcher (reads exempt, mutations still capped)');
