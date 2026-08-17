import assert from 'node:assert/strict';

// The plugin manifest persists to chrome.storage; give it somewhere to write so the router's
// own plugin registration can be exercised the way the extension exercises it.
const mem = {}; const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: mem[k] }),
      set: async (o) => { Object.assign(mem, o); listeners.forEach((fn) => fn({}, 'local')); },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};

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

// AUTO IS THE ONLY SWITCH. A settings mode that could route an explicitly chosen model would
// override the user's own selection — they picked that model for a reason, and answering from
// another is exactly the substitution this codebase keeps removing.
assert.equal(await routeForTurn(settings, undefined, {}), null);
assert.equal(await routeForTurn({ ...settings, ui: { routing: { mode: 'on' } } }, undefined, {}), null,
  'a settings dial routed a request the user had not asked to route');

// A REAL TURN'S NEEDS COME FROM THE TURN. The settings panel's reach/cost/speed controls are
// a test harness — persisting them made a value someone set while exploring silently
// constrain everything afterwards, and a panel titled "which model would answer" must not be
// the thing deciding it.
const picked = await routeForTurn(settings, undefined, { force: true });
assert.ok(picked?.target, 'routing was on and chose nothing');

// WHAT THE TURN NEEDS OUTRANKS THE SAVED PREFERENCE. A turn carrying tools cannot use a
// model without them, whatever the dials say.
const withTools = await routeForTurn(settings, undefined, { capabilities: ['tools'], force: true });
assert.ok(withTools.decision.model.capabilities.includes('tools'));

// Constraints nothing satisfies mean the caller's own choice stands, rather than an error or
// a silent downgrade to something forbidden. The constraint comes from the TURN — here, a
// capability none of the configured models has.
assert.equal(await routeForTurn(settings, undefined, { capabilities: ['telepathy'], force: true }), null);

// And a saved preference no longer decides anything: the same call with leftover settings
// from someone exploring the panel returns the same answer.
const leftovers = { ...settings, ui: { routing: { reach: 'device', maxCostPer1k: 0, prefer: 'cost' } } };
assert.equal(
  (await routeForTurn(leftovers, undefined, { force: true }))?.decision.model.id,
  (await routeForTurn(settings, undefined, { force: true }))?.decision.model.id,
  'a leftover preview value changed a real routing decision',
);

// A decision naming something unresolvable also defers rather than guessing.
assert.equal(await routeForTurn({ endpoints: [], agents: [] }, undefined, { force: true }), null);

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
// guessed next to what the user chose — and the guess is a real value, not a blank. A blank
// made every model interchangeable, which is how a frontier model got replaced by an 8B one.
const raw = candidatesFrom({ ...settings, ui: { routing: { models: { 'mqk41ucyhmz1au': { quality: 0.9 } } } } }, undefined, { ignoreOverrides: true });
const inferredQuality = raw.find((m) => m.id === 'mqk41ucyhmz1au').quality;
assert.ok(Number.isFinite(inferredQuality) && inferredQuality !== 0.9, 'the inferred default was the override, or missing');

console.log('✓ overrides: the user corrects the guesses, but can never widen reach');

// PERSISTENCE. A rating survived being written and was then deleted by the next dial
// change, because the preview re-renders after saving and re-assigned the whole routing
// branch. Saving a rating was itself what removed it.
//
// The shape both writers must respect: dials and per-model overrides live on one branch,
// so either writing the other wholesale is a silent delete.
{
  const state = { ui: { routing: { models: { ep1: { quality: 0.9 } } } } };
  // What the dial handler does — merge, never replace.
  state.ui.routing = { ...(state.ui.routing || {}), reach: 'device', prefer: 'cost', mode: 'on' };
  assert.equal(state.ui.routing.models?.ep1?.quality, 0.9, 'a dial change deleted the model ratings');
  assert.equal(state.ui.routing.reach, 'device');

  // And what the rating handler does — patch one model, leave the dials and the others.
  const saved = state.ui.routing.models;
  state.ui.routing.models = { ...saved, ep2: { ...(saved.ep2 || {}), capabilities: ['tools'] } };
  assert.equal(state.ui.routing.mode, 'on', 'a rating change deleted the dials');
  assert.equal(state.ui.routing.models.ep1.quality, 0.9, 'a rating change deleted another model');
  assert.deepEqual(state.ui.routing.models.ep2.capabilities, ['tools']);
}

// And a saved rating actually reaches the router.
const rated = candidatesFrom({ ...settings, ui: { routing: { reach: 'any', models: { 'mqk41ucyhmz1au': { quality: 0.9 } } } } });
assert.equal(rated.find((m) => m.id === 'mqk41ucyhmz1au').quality, 0.9);

console.log('✓ routing settings: dials and per-model ratings share a branch without deleting each other');

// ── every lever, and what each one does ─────────────────────────────────────
const { KNOWN_CAPABILITIES, complexityStrategy } = await import('../extension/js/model-router.js');

// Named rather than free-form: a capability only matters if something asks for it, and a
// typo in a free-text field would make a model ineligible forever with no way to see why.
assert.deepEqual(KNOWN_CAPABILITIES.map((c) => c.id).sort(),
  ['coding', 'json', 'long-context', 'reasoning', 'tools', 'vision']);
assert.ok(KNOWN_CAPABILITIES.every((c) => c.label && c.hint), 'a lever has no explanation');

// Inference is a starting point, not a verdict — the user corrects it.
const inferred = candidatesFrom({
  endpoints: [
    { id: 'o3', name: 'Reasoner', baseUrl: 'https://api.x/v1', model: 'o3-mini' },
    { id: 'tiny', name: 'Tiny', baseUrl: 'https://api.x/v1', model: 'llama-3.1-8b-instant' },
  ],
  agents: [{ id: 'cc', name: 'Claude Code', kind: 'bridge' }],
});
const cap = Object.fromEntries(inferred.map((m) => [m.id, m.capabilities]));
assert.ok(cap.o3.includes('reasoning'), 'a reasoning model was not recognised');
assert.ok(!cap.tiny.includes('reasoning'), 'a small fast model was credited with reasoning');
// A CLI coding agent is a coding agent whatever its model is called.
assert.ok(cap.cc.includes('coding') && cap.cc.includes('reasoning'));

// ── escalation prefers what the task wants, without eliminating everything ───
const pair = [
  { id: 'cheap', capabilities: ['tools', 'json'], quality: 0.4, costPer1k: 0 },
  { id: 'thinker', capabilities: ['tools', 'reasoning'], quality: 0.8, costPer1k: 3 },
];
const hard = await complexityStrategy.decide(pair, { signals: { complexity: 'high' } });
assert.equal(hard[0].id, 'thinker', 'a hard task did not prefer a reasoning model');

// Easy work gets no opinion at all, so cost decides.
assert.equal(await complexityStrategy.decide(pair, { signals: { complexity: 'low' } }), null);

// NOT a hard filter. On a setup where nobody has ticked "reasoning", requiring it would
// eliminate every model — and an empty candidate list is a worse answer than an adequate
// model.
const noneClaim = [{ id: 'a', capabilities: ['tools'], quality: 0.3, costPer1k: 1 }];
const still = await complexityStrategy.decide(noneClaim, { signals: { complexity: 'high' } });
assert.equal(still.length, 1, 'escalation eliminated the only model available');

// A long request asks for long context; a picture asks for vision.
const longReq = await complexityStrategy.decide(
  [{ id: 'short', capabilities: [], quality: 0.9, costPer1k: 0 }, { id: 'long', capabilities: ['long-context'], quality: 0.5, costPer1k: 1 }],
  { signals: { complexity: 'high', approxTokens: 50_000 } },
);
assert.equal(longReq[0].id, 'long', 'a 50k-token request ignored long-context');

console.log('✓ levers: six named capabilities, inferred then correctable, escalation prefers without eliminating');

// ── failover replaces like with like ────────────────────────────────────────
const { failoverStrategy } = await import('../extension/js/model-router.js');

// A frontier model that ran out of credits mid-task should be replaced by the same model
// elsewhere, or something comparable — not by a small local one. The task did not get easier
// because the provider said no, and that is how a drawing going well becomes a circle in the
// wrong place.
const pool = [
  { id: 'tiny', model: 'llama-3.1-8b', capabilities: ['tools'], quality: 0.2, costPer1k: 0 },
  { id: 'sameElsewhere', model: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: ['tools', 'reasoning'], quality: 0.7, costPer1k: 1 },
  { id: 'comparable', model: 'claude-sonnet', capabilities: ['tools', 'reasoning', 'vision'], quality: 0.8, costPer1k: 3 },
];
const failed = { model: 'DeepSeek-V4-Flash', capabilities: ['tools', 'reasoning'] };

const ranked = await failoverStrategy.decide(pool, { like: failed });
assert.equal(ranked[0].id, 'sameElsewhere', 'the same model at another provider was not preferred');
assert.equal(ranked[1].id, 'comparable', 'a capability-covering model lost to a weaker one');
assert.equal(ranked[2].id, 'tiny', 'an inferior model was not ranked last');

// Provider prefixes and tags must not stop the same model matching itself.
assert.equal((await failoverStrategy.decide(
  [{ id: 'a', model: 'gemma4:latest', capabilities: [], quality: 0.1 }, { id: 'b', model: 'x', capabilities: [], quality: 0.9 }],
  { like: { model: 'gemma4', capabilities: [] } },
))[0].id, 'a', 'a tagged model name failed to match itself');

// With nothing to replace, the strategy has no opinion and the usual preference applies.
assert.equal(await failoverStrategy.decide(pool, {}), null);

// Nothing comparable still returns something: a completed turn on a weaker model beats a
// failed one.
assert.equal((await failoverStrategy.decide([pool[0]], { like: failed }))[0].id, 'tiny');

console.log('✓ failover: same model first, comparable next, inferior only as a last resort');

// A RETIRED MODEL IS RETIRED EVERYWHERE. "Same model at another provider" is the ideal
// replacement when the PROVIDER declined — out of credits, rate limited — and the worst
// possible one when the MODEL is gone. deepseek-v4-flash reaching end of life on HuggingFace
// means the identical name on NVIDIA is equally dead, and preferring it walks into the same
// wall, which is exactly what happened.
{
  const providers = [
    { id: 'hfSame', model: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: ['tools'], quality: 0.7, costPer1k: 1 },
    { id: 'other', model: 'claude-sonnet', capabilities: ['tools'], quality: 0.6, costPer1k: 3 },
  ];
  const declined = { model: 'deepseek-v4-flash', capabilities: ['tools'], reason: 'quota' };
  assert.equal((await failoverStrategy.decide(providers, { like: declined }))[0].id, 'hfSame',
    'a provider running out of credits should be replaced by the same model elsewhere');

  const retired = { ...declined, reason: 'gone' };
  assert.equal((await failoverStrategy.decide(providers, { like: retired }))[0].id, 'other',
    'a retired model was replaced by the same retired model at another provider');

  // Unless it is the only thing left — a turn on the same name somewhere else still beats no
  // turn at all, and the health memo will have stood the dead one down anyway.
  assert.equal((await failoverStrategy.decide([providers[0]], { like: retired }))[0].id, 'hfSame');
}

console.log('✓ failover reasons: same model for a provider saying no, a different one for a model that is gone');

// SAME KIND OF THING. Class is not a quality score, it is how the model is REACHED: an API
// model answers a request; a CLI agent spawns a process with its own tools, its own loop and
// its own idea of what to do next. Substituting one for the other mid-task is not a
// fallback, it is a different program — a drawing request handed to a coding agent went off
// reading files for a minute instead of drawing.
{
  const mixed = [
    { id: 'cli', model: 'gpt-5.6-sol', classUsed: 'A', capabilities: ['tools', 'reasoning', 'coding'], quality: 0.9, costPer1k: 0 },
    { id: 'api', model: 'claude-sonnet', classUsed: 'C', capabilities: ['tools', 'reasoning'], quality: 0.7, costPer1k: 3 },
  ];
  const failedApi = { model: 'deepseek-v4-flash', classUsed: 'C', capabilities: ['tools', 'reasoning'], reason: 'gone' };
  const ranked = await failoverStrategy.decide(mixed, { like: failedApi });
  assert.equal(ranked[0].id, 'api', 'an API model was replaced by a CLI agent despite a comparable API model existing');

  // A CLI agent that fails is replaced by a CLI agent, for the same reason in reverse.
  const failedCli = { model: 'claude-code', classUsed: 'A', capabilities: ['tools'], reason: 'server' };
  assert.equal((await failoverStrategy.decide(mixed, { like: failedCli }))[0].id, 'cli');

  // A different class is still better than nothing — the turn completing matters more than
  // it completing the same way.
  assert.equal((await failoverStrategy.decide([mixed[0]], { like: failedApi }))[0].id, 'cli');
}

console.log('✓ failover class: like is replaced by like, and a CLI agent is not an API model');

// STRUCTURED WORK WANTS A MODEL, NOT AN AGENT. A canvas or spreadsheet adapter is one call:
// hand it the data, it applies it, done. A CLI agent runs its OWN loop — explores, reads
// files, decides what to do next — and having applied the shapes correctly it carries on,
// because finishing is not something its loop is told about. A user watched the circle
// appear and then waited until they killed the process.
{
  const both = [
    { id: 'agent', classUsed: 'A', capabilities: ['tools', 'reasoning', 'coding'], quality: 0.9, costPer1k: 0 },
    { id: 'model', classUsed: 'C', capabilities: ['tools', 'reasoning'], quality: 0.7, costPer1k: 3 },
  ];
  const drawing = { signals: { complexity: 'high' }, structured: true };
  assert.equal((await complexityStrategy.decide(both, drawing))[0].id, 'model',
    'a structured drawing task went to a CLI agent that will not stop');

  // Without structured work, the better model wins on quality as before.
  assert.equal((await complexityStrategy.decide(both, { signals: { complexity: 'high' } }))[0].id, 'agent');

  // Not a hard filter: with only agents available, an agent that overruns still beats no
  // answer at all.
  assert.equal((await complexityStrategy.decide([both[0]], drawing))[0].id, 'agent');
}

console.log('✓ structured tasks prefer a model over an agent that runs its own loop');

// "USE CLAUDE" IS AN INSTRUCTION, NOT A TOPIC. A user naming a model was being ignored
// entirely — the router read length, modality and tools, and not the one signal that is an
// explicit answer to the question it was asking. Being given another model after asking for
// one is the most annoying failure a router has, because it looks like the request was not
// read.
{
  const { explicitModelStrategy } = await import('../extension/js/model-router.js');
  const pool = [
    { id: 'cc', label: 'Claude Code', model: 'claude-sonnet', capabilities: ['tools'], quality: 0.9, costPer1k: 0 },
    { id: 'cx', label: 'Codex · gpt-5.6-sol', model: 'gpt-5.6-sol', capabilities: ['tools'], quality: 0.9, costPer1k: 0 },
  ];
  const ask = (t) => explicitModelStrategy.decide(pool, { requestText: t });

  assert.equal((await ask('use formulas and create a 2 times table here. use claude')).id, 'cc');
  assert.equal((await ask('draw this with codex')).id, 'cx');
  assert.equal((await ask('ask claude code to review this')).id, 'cc');
  assert.equal((await ask('switch to codex')).id, 'cx');

  // CONSERVATIVE ON PURPOSE. A false positive silently sends work to the wrong model, which
  // is worse than missing an unusual phrasing — so only imperative forms count.
  assert.equal(await ask('tell me about claude'), null, 'a question about a model was read as an instruction');
  assert.equal(await ask('what is the difference between claude and codex'), null);
  assert.equal(await ask('draw a circle'), null);
  assert.equal(await ask(''), null);

  // Naming something not configured says nothing rather than guessing at the nearest match.
  assert.equal(await ask('use gpt-9'), null);
}

console.log('✓ an explicit "use <model>" is honoured, and a question about one is not');

// QUALITY HAS A DEFAULT. Shipping the lever with none meant every model scored the same, so a
// frontier model that declined was replaced by an 8B instant model with equal standing —
// "same capabilities, cheaper" is what the ranking saw, and it is nonsense. A wrong guess a
// user can correct beats a blank that makes every model interchangeable.
{
  const q = (model, name = '') => candidatesFrom({ endpoints: [{ id: 'x', name, baseUrl: 'https://a/v1', model }] })[0].quality;

  // Size is read as a NUMBER. A regex for "digits followed by b" cannot tell 8B from 26B from
  // 405B, and the first version scored a 26B model as tiny for exactly that reason.
  assert.equal(q('llama-3.1-8b-instant'), 0.3);
  assert.equal(q('gemma-4-26b'), 0.6, 'a 26B model was scored as tiny');
  assert.equal(q('llama-3.1-405b'), 0.85);
  assert.equal(q('qwen-72b'), 0.85);

  // Named tiers for hosted models that do not advertise a size.
  assert.equal(q('gpt-5.5'), 0.9);
  assert.equal(q('claude-opus-4.6'), 0.9);
  assert.equal(q('claude-haiku'), 0.3);
  assert.equal(q('deepseek-ai/DeepSeek-V4-Flash'), 0.6);

  // Unknown stays mid-table: neither buried nor promoted, so a new model is tried rather than
  // permanently skipped.
  assert.equal(q('some-new-thing'), 0.5);

  // The point of all of it: a declining frontier model is not replaced by a tiny one.
  const pool = candidatesFrom({
    endpoints: [
      { id: 'tiny', name: 'Groq', baseUrl: 'https://a/v1', model: 'llama-3.1-8b-instant' },
      { id: 'mid', name: 'Local', baseUrl: 'https://a/v1', model: 'gemma-4-26b' },
      { id: 'big', name: 'OpenAI', baseUrl: 'https://a/v1', model: 'gpt-5.5' },
    ],
  });
  const ranked = await failoverStrategy.decide(pool, {
    like: { model: 'deepseek-v4-flash', capabilities: ['tools'], classUsed: 'C', reason: 'gone' },
  });
  assert.equal(ranked[0].id, 'big', 'a frontier model was replaced by something weaker than the alternatives');
  assert.equal(ranked.at(-1).id, 'tiny', 'the smallest model was not ranked last');
}

console.log('✓ quality: sizes read as numbers, tiers named, and a frontier model is not replaced by an 8B');

// PROVIDER PREFERENCE. The same model is often available from several places, and ties were
// breaking alphabetically — not a preference, but the absence of one, which is how every
// equal choice ended up at whichever provider sorted first.
{
  const many = candidatesFrom({
    endpoints: [
      { id: 'or', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.5' },
      { id: 'oai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' },
      { id: 'local', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'gemma-4-26b' },
    ],
    agents: [{ id: 'cc', name: 'Claude Code', kind: 'bridge', model: 'opus' }],
  });
  const rank = Object.fromEntries(many.map((m) => [m.id, m.providerRank]));

  // Fewer hops first: the user's own machine, then a first-party API, then a local agent that
  // spawns a process, then an aggregator carrying someone else's quota and outages.
  assert.ok(rank.local < rank.oai, 'a local model did not outrank a hosted API');
  assert.ok(rank.oai < rank.cc, 'a direct API did not outrank a CLI agent');
  assert.ok(rank.cc < rank.or, 'a CLI agent did not outrank an aggregator');

  // A user's own ordering overrides the guess entirely.
  const pinned = candidatesFrom({
    endpoints: [{ id: 'or', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-5.5' }],
    ui: { routing: { models: { or: { providerRank: 0 } } } },
  });
  assert.equal(pinned[0].providerRank, 0);
}

console.log('✓ provider preference: fewest hops by default, and the user reorders it');

// A FULL ORDERING, NOT THREE BUCKETS. With ten providers, "first / normal / last" puts
// everything in the same bucket and leaves the tiebreak nothing to break with.
{
  const ten = candidatesFrom({
    endpoints: Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`, name: `Provider ${i}`, baseUrl: `https://p${i}.example/v1`, model: 'gpt-5.5',
    })),
    ui: { routing: { models: { p7: { providerRank: 1 }, p2: { providerRank: 2 } } } },
  });
  const rank = Object.fromEntries(ten.map((m) => [m.id, m.providerRank]));
  assert.equal(rank.p7, 1, 'an explicit position was not honoured');
  assert.equal(rank.p2, 2);
  // Unranked providers keep their inferred position rather than being forced to a bucket.
  assert.ok(rank.p0 > 2, 'an unranked provider was promoted above an explicitly ranked one');

  // STILL ONLY A TIEBREAK. Position 1 does not win a race it lost on capability: a model
  // without the tools this turn needs is eliminated before ordering happens at all.
  const mixed = candidatesFrom({
    endpoints: [
      { id: 'first', name: 'Preferred', baseUrl: 'https://a/v1', model: 'llama-3.1-8b-instant' },
      { id: 'second', name: 'Other', baseUrl: 'https://b/v1', model: 'gpt-5.5' },
    ],
    ui: { routing: { models: { first: { providerRank: 1 } } } },
  });
  const ranked = await failoverStrategy.decide(mixed, {
    like: { model: 'x', capabilities: ['tools'], classUsed: 'C', reason: 'gone' },
  });
  assert.equal(ranked[0].id, 'second', 'provider order outranked a real quality difference');
}

console.log('✓ provider order: a full 1..N ranking that still only breaks ties');

// REQUIREMENTS ELIMINATE; COST AND SPEED ONLY ORDER WHAT SURVIVES. A drawing task was
// allowed to consider an 8B model because escalation only expressed a preference — and a
// model that merely ranks lower still wins once the better ones decline, which is how a
// chain of five ended on one that could not do the job.
{
  const { needForTurn } = await import('../extension/js/model-router.js');

  const easy = needForTurn({}, { request: { messages: [{ content: 'hi' }] } });
  assert.deepEqual(easy.capabilities, [], 'a greeting was given requirements');
  assert.equal(easy.minQuality, 0, 'a greeting was given a quality floor');

  const drawing = needForTurn({}, {
    capabilities: ['tools'], structured: true,
    request: { messages: [{ content: 'draw a circle around mickey' }] },
  });
  assert.ok(drawing.capabilities.includes('tools'));
  assert.ok(drawing.minQuality >= 0.55, 'structured work set no quality floor');
  assert.ok(drawing.requirementReasons.length, 'the requirement could not explain itself');

  // The floor does the work: with it, a tiny model is not a candidate at all.
  const pool = candidatesFrom({
    endpoints: [
      { id: 'tiny', name: 'Groq', baseUrl: 'https://a/v1', model: 'llama-3.1-8b-instant' },
      { id: 'mid', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'gemma-4-26b' },
    ],
  });
  const { createModelRouter } = await import('../extension/js/events/router.js');
  const decided = createModelRouter({ models: pool }).route(drawing);
  assert.equal(decided.model.id, 'mid', 'a structured task chose the model below its quality floor');
  assert.ok(decided.rejected.some((x) => x.id === 'tiny' && /below the quality/.test(x.why)));
}

console.log('✓ requirements: derived from the prompt, eliminating rather than merely preferring');

// ── the router's parts are plugins ──────────────────────────────────────────
{
  const { ROUTE_STRATEGIES, ROUTE_MIDDLEWARE, declareRouterPlugins, buildRouter } =
    await import('../extension/js/model-router.js');
  const { pluginManifest } = await import('../extension/js/plugins.js');

  await declareRouterPlugins();
  const manifest = await pluginManifest();
  const listed = manifest.list().map((e) => e.id);

  // A strategy nobody can see or turn off is a hard-coded behaviour wearing a plugin's
  // interface.
  for (const st of ROUTE_STRATEGIES) assert.ok(listed.includes(`route:${st.id}`), `${st.id} is not listed`);
  for (const mw of ROUTE_MIDDLEWARE) assert.ok(listed.includes(`route-step:${mw.id}`), `${mw.id} is not listed`);

  // Order is a decision, not an accident: an explicit request outranks every heuristic, and
  // failover is newer information than the preference that made the original choice.
  assert.deepEqual(ROUTE_STRATEGIES.map((s) => s.id),
    ['named-by-user', 'failover-to-similar', 'escalate-on-complexity']);

  // Switching a strategy off stops it being consulted, and routing still answers — turning
  // them all off degrades to plain deterministic scoring rather than to no routing.
  manifest.setEnabled('route:named-by-user', false);
  const router = buildRouter(settings, undefined, { manifest });
  const decided = await router.routeWith({ requestText: 'use claude', capabilities: [] });
  assert.ok(decided.model, 'disabling a strategy broke routing entirely');
  assert.notEqual(decided.strategy, 'named-by-user', 'a disabled strategy was still consulted');
  manifest.setEnabled('route:named-by-user', true);

  // REDACTION IS NOT SWITCHABLE. Its requiredFor already makes the router refuse to reach a
  // third party without it, so honouring a toggle would turn a refusal into a silently
  // skipped guarantee.
  manifest.setEnabled('route-step:redaction', false);
  const stillThere = buildRouter(settings, undefined, { manifest }).middleware().map((m) => m.id);
  assert.ok(stillThere.includes('redaction'), 'redaction could be switched off');
}

console.log('✓ router plugins: strategies listed and switchable, redaction listed and not');
