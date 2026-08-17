import assert from 'node:assert/strict';

const store = {}; const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: v, oldValue: store[k] }; store[k] = v; }
        listeners.forEach((fn) => fn(changes, 'local'));
      },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};

const { BUILTIN_RULES, repeatedFailureRule, slowSetupRule, ruleEngine, dispatchToRules } =
  await import('../extension/js/rules-builtin.js');
const { pluginManifest } = await import('../extension/js/plugins.js');

await ruleEngine();
const manifest = await pluginManifest();

// SAFETY POSTURE, asserted rather than intended. Every shipped rule is class R and needs no
// approval — which is only acceptable BECAUSE none of them act on the world. A rule that
// sends, clicks or spends must be user-authored and approved, and that path does not exist
// yet.
for (const r of BUILTIN_RULES) {
  assert.equal(r.classUsed, 'R', `${r.id} is not class R — it costs something`);
  assert.equal(r.requiresApproval, false, `${r.id} needs approval but no approver is wired`);
}

// Declared, so a user can switch them off.
for (const r of BUILTIN_RULES) {
  assert.ok(manifest.list().some((e) => e.id === r.id), `${r.id} is not declared to the manifest`);
}

const ev = (payload, id = 'e1') => ({ type: 'turn.ended', id, payload });

// ── repeated failures ───────────────────────────────────────────────────────
assert.equal(repeatedFailureRule.when(ev({}), { repeats: [{ name: 'page.click_at', count: 6 }] }), true);
assert.equal(repeatedFailureRule.when(ev({}), { repeats: [] }), false);
assert.equal(repeatedFailureRule.when(ev({}), {}), false, 'a turn with no repeat data must not match');

// ── slow setup ──────────────────────────────────────────────────────────────
// Setup dominating the turn is the signal; setup that is merely present is not.
assert.equal(slowSetupRule.when(ev({ prepMs: 45000, ms: 48000 })), true);
assert.equal(slowSetupRule.when(ev({ prepMs: 500, ms: 20000 })), false, 'fast setup was flagged');
assert.equal(slowSetupRule.when(ev({ prepMs: 4000, ms: 60000 })), false, 'setup was a small share and still flagged');
assert.equal(slowSetupRule.when(ev({})), false, 'a turn with no timing was flagged');

// ── the engine, end to end ──────────────────────────────────────────────────
let out = await dispatchToRules(ev({ prepMs: 45000, ms: 48000 }, 'slow-1'));
assert.ok(out.find((o) => o.ruleId === 'rule:slow-setup')?.fired, 'the slow-setup rule did not fire');

// Rate limited: a broken MCP server makes EVERY turn slow, and warning on all of them is
// noise that trains the user to ignore it.
out = await dispatchToRules(ev({ prepMs: 45000, ms: 48000 }, 'slow-2'));
assert.equal(out.find((o) => o.ruleId === 'rule:slow-setup')?.fired, false);

// Switched off means off — and the reason is recorded, not silent.
manifest.setEnabled('rule:repeated-failure', false);
await new Promise((r) => setTimeout(r, 10));
out = await dispatchToRules(ev({}, 'x1'), { repeats: [{ name: 'page.click_at', count: 6 }] });
assert.equal(out.find((o) => o.ruleId === 'rule:repeated-failure')?.reason, 'disabled');

manifest.setEnabled('rule:repeated-failure', true);
out = await dispatchToRules(ev({}, 'x2'), { repeats: [{ name: 'page.click_at', count: 6 }] });
assert.equal(out.find((o) => o.ruleId === 'rule:repeated-failure')?.fired, true, 're-enabling did not take effect');

// An event no rule listens for is not an error, just nothing.
assert.deepEqual(await dispatchToRules({ type: 'privacy.egress', id: 'p1', payload: {} }), []);

console.log('✓ built-in rules: class R only, switchable, rate-limited, and they never act on the world');
