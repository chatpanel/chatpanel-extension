import assert from 'node:assert/strict';
import { candidatesFrom, previewRoute, redactionStep } from '../extension/js/model-router.js';

// The settings shape this actually reads: endpoints and agents as a user configures them.
const settings = {
  endpoints: [
    { id: 'mqk41ucyhmz1au', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'gemma-4-26b' },
    { id: 'mqr28rqkw7tuhq', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
    { id: 'lan', name: 'Workshop box', baseUrl: 'http://192.168.1.40:8080/v1', model: 'qwen' },
    { id: 'disabled', name: 'Old', baseUrl: 'https://x/v1', model: 'm', enabled: false },
  ],
  agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'bridge' }],
};

const models = candidatesFrom(settings);
const byId = Object.fromEntries(models.map((m) => [m.id, m]));

// NAMES, NOT IDS. A generated id is meaningless to the person reading a routing decision,
// and an explanation nobody can read is not an explanation.
assert.equal(byId['mqk41ucyhmz1au'].label, 'Ollama · gemma-4-26b');
assert.equal(byId['mqr28rqkw7tuhq'].label, 'OpenAI · gpt-4o');
assert.equal(byId['claude-code'].label, 'Claude Code');
assert.ok(!models.some((m) => m.label === m.id), 'a candidate fell back to showing its raw id');

// REACH IS WHAT PRIVACY DEPENDS ON, so it has to be judged correctly per target.
assert.equal(byId['mqk41ucyhmz1au'].reach, 'device', 'a loopback endpoint was not treated as on-device');
assert.equal(byId['mqr28rqkw7tuhq'].reach, 'any');
assert.equal(byId.lan.reach, 'trusted', 'a LAN host is neither this device nor a third party');
// A bridge agent runs locally but the model behind it may be remote — claiming 'device'
// would let a device-only request reach a cloud model through a local process.
assert.equal(byId['claude-code'].reach, 'trusted');

// A disabled endpoint is offered but not available, so it shows up in a rejection with a
// reason rather than vanishing unexplained.
assert.equal(byId.disabled.available, false);

// Local is free; a frontier model is not. Only the ordering matters, never the units.
assert.equal(byId['mqk41ucyhmz1au'].costPer1k, 0);
assert.ok(byId['mqr28rqkw7tuhq'].costPer1k > 0);

// ── the decision, as the settings page shows it ─────────────────────────────
const anywhere = await previewRoute(settings, undefined, { capabilities: ['tools'] });
assert.ok(anywhere.chosen, 'nothing was chosen with everything available');
assert.ok(!/^m[a-z0-9]{12}$/.test(anywhere.chosen), 'the decision named a raw id');
assert.ok(anywhere.runnersUp.every((x) => typeof x === 'string' && x.length));

// Device-only must reach the loopback model and reject the rest WITH reasons.
const onDevice = await previewRoute(settings, undefined, { reach: 'device' });
assert.equal(onDevice.chosen, 'Ollama · gemma-4-26b');
assert.ok(onDevice.rejected.some((x) => x.id === 'OpenAI · gpt-4o' && /exceeds/.test(x.why)),
  'a rejection did not name the model or say why');

// REDACTION IS REQUIRED FOR ANYTHING LEAVING THE MACHINE — declared, so the router can
// refuse rather than relying on everyone remembering.
assert.equal(redactionStep.requiredFor({ reach: 'any' }), true);
assert.equal(redactionStep.requiredFor({ reach: 'device' }), false);
assert.equal(redactionStep.stage, 'request');

// No models configured is an explained answer, not a crash.
const empty = await previewRoute({}, undefined, {});
assert.equal(empty.chosen, null);

console.log('✓ model router binding: real names, reach judged per target, redaction required for egress');

// ── the mode dial ───────────────────────────────────────────────────────────
const { routingSettings, routeForTurn } = await import('../extension/js/model-router.js');

// Defaults change nothing: a user who has never opened the page gets observation, not a
// router silently choosing their models.
assert.equal(routingSettings({}).mode, 'observe');
assert.equal(routingSettings({ ui: { routing: { mode: 'on' } } }).mode, 'on');

// Observe and off both decline to choose — only "on" returns a target.
assert.equal(await routeForTurn(settings, undefined, {}), null);
assert.equal(await routeForTurn({ ...settings, ui: { routing: { mode: 'off' } } }, undefined, {}), null);

const on = { ...settings, ui: { routing: { mode: 'on', reach: 'device' } } };
const picked = await routeForTurn(on, undefined, {});
assert.ok(picked?.target, 'routing was on and chose nothing');
assert.equal(picked.decision.model.label, 'Ollama · gemma-4-26b');

// WHAT THE TURN NEEDS OUTRANKS THE SAVED PREFERENCE. A turn carrying tools cannot use a
// model without them, whatever the dials say.
const toolsOnly = { ...settings, ui: { routing: { mode: 'on', reach: 'any', prefer: 'cost' } } };
const withTools = await routeForTurn(toolsOnly, undefined, { capabilities: ['tools'] });
assert.ok(withTools.decision.model.capabilities.includes('tools'));

// Constraints nothing satisfies mean the caller's own choice stands, rather than an error
// or a silent downgrade to something forbidden.
const impossible = { ...settings, ui: { routing: { mode: 'on', reach: 'device', maxCostPer1k: 0, maxLatencyMs: 1 } } };
assert.equal(await routeForTurn(impossible, undefined, {}), null);

// A decision naming something unresolvable also defers rather than guessing.
assert.equal(await routeForTurn({ endpoints: [], agents: [], ui: { routing: { mode: 'on' } } }, undefined, {}), null);

console.log('✓ routing modes: observe by default, on chooses, and every uncertainty defers');

// ── human overrides ─────────────────────────────────────────────────────────
const { applyOverride } = await import('../extension/js/model-router.js');

// The defaults are guesses — a name matched against a regex, a URL judged local. Right often
// enough to be useful, wrong often enough that someone who knows their own setup must be
// able to say so. A router that cannot be corrected is one people work around.
const overridden = candidatesFrom({
  ...settings,
  ui: { routing: { models: {
    'mqk41ucyhmz1au': { quality: 0.9, capabilities: ['tools', 'vision'], costPer1k: 0, latencyMs: 400 },
    'mqr28rqkw7tuhq': { available: false },
  } } },
});
const o = Object.fromEntries(overridden.map((m) => [m.id, m]));
assert.equal(o['mqk41ucyhmz1au'].quality, 0.9, 'a quality the user set was ignored');
assert.ok(o['mqk41ucyhmz1au'].capabilities.includes('vision'), 'a capability the user declared was dropped');
assert.equal(o['mqk41ucyhmz1au'].latencyMs, 400);
assert.equal(o['mqr28rqkw7tuhq'].available, false, 'a model the user disabled stayed available');

// REACH MOVES OUTWARD ONLY, and the two directions are not symmetric.
//
// "This cloud endpoint is really on my device" would let a device-only request reach a third
// party from one typo or one synced settings file. Refused.
assert.equal(applyOverride({ id: 'x', reach: 'any', capabilities: [] }, { reach: 'device' }).reach, 'any',
  'an override claimed a remote model was local');
assert.equal(applyOverride({ id: 'x', reach: 'trusted', capabilities: [] }, { reach: 'device' }).reach, 'trusted');

// "This local-looking endpoint actually goes out" makes FEWER requests eligible for it, so
// it is always allowed — a user is entitled to trust their own setup less than we do.
assert.equal(applyOverride({ id: 'x', reach: 'device', capabilities: [] }, { reach: 'any' }).reach, 'any');
assert.equal(applyOverride({ id: 'x', reach: 'device', capabilities: [] }, { reach: 'trusted' }).reach, 'trusted');

// Garbage is ignored rather than crashing routing or silently zeroing a value.
const junk = applyOverride({ id: 'x', reach: 'any', capabilities: ['tools'], costPer1k: 2, quality: null }, { costPer1k: 'free', capabilities: 'lots' });
assert.equal(junk.costPer1k, 2);
assert.deepEqual(junk.capabilities, ['tools']);
assert.deepEqual(applyOverride({ id: 'x', reach: 'any' }, null), { id: 'x', reach: 'any' });

// The inferred defaults stay inspectable, so a settings page can show what it would have
// guessed next to what the user chose.
const raw = candidatesFrom({ ...settings, ui: { routing: { models: { 'mqk41ucyhmz1au': { quality: 0.9 } } } } }, undefined, { ignoreOverrides: true });
assert.equal(raw.find((m) => m.id === 'mqk41ucyhmz1au').quality, null);

console.log('✓ overrides: the user corrects the guesses, but can never widen reach');
