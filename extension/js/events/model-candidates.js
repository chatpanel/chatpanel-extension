// GENERATED — do not edit.
// Source of truth: chatpanel-events/model-candidates.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// WHAT A MODEL IS, GUESSED FROM WHAT THE USER CONFIGURED — one answer for every client.
//
// Routing needs attributes nobody types in: how far a request travels to reach a model,
// what it can probably do, roughly what it costs, how good it is likely to be. The extension
// inferred these from names and URLs for its own endpoint and agent records; the desktop
// needed the same inference over the gateway's model list, and a second copy of a guess is
// two guesses that drift. So the heuristics live here and each client hands in its own
// shape: `inferCandidate(target, kind, { override, health })` takes anything with
// `{ id?, name?, model?, baseUrl?|url?, kind?, enabled?, bridgeAgent? }` and returns a router
// model. Health (rate-limited, observed down) is INJECTED, because measuring it is a host's
// job — the extension keeps a health map, the desktop asks the gateway.
//
// Everything below is a starting point the user corrects (`applyOverride`), never a verdict.

import { classifySource } from './sources.js';
import { defineModel } from './router.js';

/** Where a request must travel to reach this target — the only attribute privacy depends on. */
export function reachOf(target) {
  // A bridge agent runs a CLI on the user's own machine; the model behind it may still be
  // remote, which is why this says 'trusted' rather than 'device'. Claiming otherwise would
  // let a device-only request reach a cloud model through a local process.
  if (target.kind === 'bridge') return 'trusted';
  const url = String(target.baseUrl || target.url || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url)) return 'device';
  // A .local or on-LAN host is the user's own machine or network — not a third party, but
  // not the device either. Same private-address rules as the source classifier, so
  // "internal" cannot mean one thing for a page and another for an endpoint.
  //
  // BUT THE FAIL-SAFE DIRECTION IS OPPOSITE HERE. classifySource fails CLOSED — an
  // unreadable URL counts as internal, because a source we cannot identify must not be sent
  // out. A DESTINATION we cannot identify is the reverse: calling it 'trusted' would admit
  // it to a restricted turn. So an unparseable endpoint is treated as the furthest reach.
  const c = classifySource(url);
  return c.internal && c.matched !== 'unparseable' ? 'trusted' : 'any';
}

/**
 * The levers a user can pull, and what each one means for routing.
 *
 * Named rather than free-form: a capability only matters if something asks for it, and a
 * typo in a free-text field would silently make a model ineligible forever with no way to
 * see why.
 */
export const KNOWN_CAPABILITIES = Object.freeze([
  { id: 'tools', label: 'Tools', hint: 'Can call functions — needed for page actions, search and MCP.' },
  { id: 'vision', label: 'Vision', hint: 'Can read images and screenshots.' },
  { id: 'reasoning', label: 'Reasoning', hint: 'Thinks before answering — worth the wait on hard tasks.' },
  { id: 'long-context', label: 'Long context', hint: 'Handles large documents and long meetings.' },
  { id: 'coding', label: 'Coding', hint: 'Strong at writing and refactoring code.' },
  { id: 'json', label: 'Structured output', hint: 'Reliably returns valid JSON.' },
]);

/**
 * What a model can probably do, guessed from its name.
 *
 * Conservative on purpose: an unproven capability claimed here becomes a failed turn, and a
 * missing one only means the router does not volunteer it. The user corrects both — these
 * are a starting point, not a verdict.
 */
export function capabilitiesOf(target) {
  const m = String(target.model || '').toLowerCase();
  const caps = new Set(['json']);
  // Bridge agents relay tools through the bridge's MCP server; API endpoints vary, so tool
  // support is assumed only where the user has actually configured a model for it.
  if (target.kind === 'bridge' || target.model) caps.add('tools');
  if (/gpt-4|gpt-5|claude|gemini|vision|vl\b|llava|pixtral/.test(m)) caps.add('vision');
  if (/o1|o3|r1|reason|think|opus|sonnet|deepseek-r/.test(m)) caps.add('reasoning');
  if (/200k|1m\b|long|gemini|claude|gpt-4\.1|gpt-5/.test(m)) caps.add('long-context');
  if (/code|coder|codex|deepseek|qwen|opus|sonnet/.test(m)) caps.add('coding');
  // A CLI coding agent is a coding agent, whatever its model is called.
  if (target.kind === 'bridge') { caps.add('coding'); caps.add('reasoning'); }
  return [...caps];
}

/**
 * Which provider to prefer when two of them offer the same model. Lower wins.
 *
 * Ties were breaking alphabetically, which is not a preference — it is the absence of one,
 * and it sent every equal choice to whichever provider happened to sort first. The order
 * below is a starting point with a reason behind each rung; the user overrides it per model.
 *
 * FEWER HOPS FIRST. A direct API is one network call to the people who run the model; an
 * aggregator adds a hop, its own quotas, and its own outages on top of the provider's. When
 * everything else is equal, the shorter path is the more reliable one.
 */
const PROVIDER_ORDER = [
  // The user's own machine: no quota, no outage, no third party.
  /localhost|127\.0\.0\.1|ollama|lm.?studio/i,
  // First-party APIs.
  /anthropic|openai\.com|api\.deepseek|googleapis|x\.ai/i,
  // Local CLI agents — capable, but they spawn a process and run their own loop.
  /(^|\W)bridge(\W|$)/i,
  // Aggregators and gateways: an extra hop and someone else's quota.
  /openrouter|huggingface|together|groq|fireworks|nvidia|replicate/i,
];

// Inferred ranks sit ABOVE every number the settings UI can produce (it offers 1..N), so
// an order someone chose by hand always outranks one we guessed. Sharing the range meant
// picking "Order: 1" still lost to a local model we had silently rated 0 — the setting looked
// like the top priority and was not.
const INFERRED_RANK_FLOOR = 1000;

export function providerRankOf(target, kind) {
  const hay = `${target.baseUrl || target.url || ''} ${target.name || ''} ${kind || target.kind || ''}`;
  for (let i = 0; i < PROVIDER_ORDER.length; i++) {
    if (PROVIDER_ORDER[i].test(hay)) return INFERRED_RANK_FLOOR + i * 10;
  }
  // Unrecognised: mid-table, so a provider we have no opinion on is not buried.
  return INFERRED_RANK_FLOOR + 50;
}

/**
 * Roughly how capable a model is, guessed from its name.
 *
 * Shipping the quality lever with no default meant every model scored the same, so a
 * frontier model that declined was replaced by an 8B instant model with equal standing —
 * "same capabilities, cheaper" is what the ranking saw, and it is nonsense. A wrong guess a
 * user can correct beats a blank that makes every model interchangeable.
 *
 * Names are a crude signal and deliberately so: this only has to ORDER models, not score
 * them, and the ordering it needs is the obvious one everybody already knows.
 */
export function qualityOf(target) {
  const m = `${target.model || ''} ${target.name || ''}`.toLowerCase();

  // Parameter count, READ AS A NUMBER rather than pattern-matched. A regex for "any digits
  // followed by b" cannot tell 8B from 26B from 405B, and the first version of this scored
  // a 26B model as tiny for exactly that reason. Size is a number; treat it as one.
  const size = Number(/(\d+(?:\.\d+)?)\s*b\b/.exec(m)?.[1]);
  if (Number.isFinite(size)) {
    if (size >= 60) return 0.85;   // frontier-scale open weights
    if (size >= 20) return 0.6;    // the solid mid-range most people run locally
    return 0.3;                    // small and fast, never a stand-in for a frontier model
  }

  // Named tiers, for hosted models that do not advertise a size.
  if (/instant|mini|nano|tiny|lite|-small\b|haiku/.test(m)) return 0.3;
  if (/opus|gpt-5|o1|o3|\bpro\b|ultra|deepseek-r|thinking/.test(m)) return 0.9;
  if (/sonnet|gpt-4|flash|gemini|deepseek|qwen|mistral|codestral/.test(m)) return 0.6;
  // A CLI HARNESS IS NOT AN UNKNOWN MODEL, and the harness's NAME is not its model's name.
  //
  // Claude Code, Codex and the rest usually carry no `model` string — the CLI picks that
  // itself — and 'Claude Code' matches none of the tiers above, so every coding agent landed
  // on the "genuinely unknown" 0.5 below. requirementsFor puts a 0.55 quality floor on
  // complex, code and structured turns, so 0.5 meant a CLI coding agent was ELIMINATED from
  // precisely the tasks it exists for — rejected as "below the quality this task needs" while
  // the work went to an API model. A harness running a frontier model behind its own loop is
  // not the weakest thing configured.
  //
  // LAST, not first: an agent that names its model has told us something better than this
  // default, and overriding it would make a declared `opus` indistinguishable from a bare
  // harness — which is exactly the distance failover ranks by.
  if (target.kind === 'bridge') return 0.8;

  return 0.5;   // genuinely unknown: mid-table, so it is neither buried nor promoted
}

/** Rough relative cost — unitless, and only ever compared against its siblings. */
/**
 * Roughly how long this model takes, from the two things that actually decide it.
 *
 * This used to read WHERE a model runs and nothing else — every hosted model 700ms, every
 * local one 1500ms — so an 8B and a frontier model at the same provider were equally fast.
 * Asking the router for speed could therefore never find the small model, which is the one
 * thing "prefer latency" exists to do.
 *
 * SIZE IS THE OTHER HALF. A frontier model thinks for longer than an 8B wherever it runs,
 * and quality is the only size signal available here — it is already inferred from the
 * parameter count in the name (see qualityOf), and already correctable by the user, so
 * deriving from it keeps one number to fix rather than two.
 *
 * Still a guess, deliberately crude: this only has to ORDER models. Health can measure the
 * real thing later and override it per model, which is exactly why it is a plain field.
 */
export function latencyOf(reach, quality) {
  // A local model is slower to first token than a hosted one far more often than not: no
  // warm pool, and usually a laptop rather than a datacentre.
  const base = reach === 'device' ? 1500 : 700;
  const q = Number.isFinite(quality) ? quality : 0.5;
  // 0.6 + q: an 8B (0.3) is ~0.9x the base, a frontier model (0.9) ~1.5x. A spread of under
  // two to one, because the difference is real but not the order of magnitude a bigger
  // coefficient would claim.
  return Math.round(base * (0.6 + q));
}

export function costOf(target, reach) {
  if (reach === 'device') return 0;
  const m = String(target.model || '').toLowerCase();
  if (/opus|gpt-4|pro\b/.test(m)) return 5;
  if (/sonnet|mini|flash|haiku/.test(m)) return 1;
  return 2;
}

/**
 * Everything the router infers about one model, and what the user said instead.
 *
 * Defaults are guesses — a name matched against a regex, a URL judged local. They are right
 * often enough to be useful and wrong often enough that someone who knows their own setup
 * must be able to say so. A router that cannot be corrected is one people work around.
 *
 * OVERRIDES CAN ONLY MOVE REACH OUTWARD. Every other attribute is the user's to set, but
 * reach is what privacy depends on, and the two directions are not symmetric:
 *
 *   'this cloud endpoint is really on my device'  — would let a device-only request reach a
 *       third party, from one typo or one synced settings file. Refused.
 *   'this local-looking endpoint actually goes out' — makes FEWER requests eligible for it.
 *       Always allowed, because a user is entitled to trust their own setup less than we do.
 *
 * A model that reaches further can serve fewer kinds of request, so outward is the safe
 * direction and inward is the one that has to be earned rather than declared.
 */
/**
 * A number the user actually SET, or null for "cleared — use what we inferred".
 *
 * CLEARING AN OVERRIDE WAS SETTING IT TO ZERO. The settings selects write `null` for their
 * "default" option, and the guard here was `Number.isFinite(Number(v))` — but `Number(null)`
 * is 0 and 0 is finite, so every cleared field became a real, extreme value. Picking
 * "Speed: default" made a model claim it answers in 0 ms; "Cost: default" made it free;
 * "Quality: default" made it worthless; and clearing Order pinned it at position 0, ahead of
 * everything, flagged as a deliberate choice.
 *
 * It stayed invisible while the balanced score multiplied cost by latency — every free model
 * scored 0 anyway. The moment a request could ask for SPEED, a model with a cleared speed
 * field beat everything that had a real one, and "hi" went to the most expensive model
 * configured. An unset field must read as unset.
 */
export function numericOverride(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function applyOverride(inferred, override = {}) {
  if (!override || typeof override !== 'object') return inferred;
  const out = { ...inferred };
  const rank = numericOverride(override.providerRank);
  if (rank !== null) {
    out.providerRank = rank;
    // Flagged as chosen, not guessed: the router honours a hand-set order outright between
    // two routes to one model, and treats the order we inferred as a tie-break only.
    out.orderPinned = true;
  }
  if (Array.isArray(override.capabilities)) out.capabilities = [...override.capabilities];
  for (const key of ['costPer1k', 'latencyMs', 'quality']) {
    const n = numericOverride(override[key]);
    if (n !== null) out[key] = n;
  }
  if (typeof override.available === 'boolean') out.available = override.available;
  if (override.reach && REACH_RANK[override.reach] > REACH_RANK[inferred.reach]) {
    // Outward only. See the note above.
    out.reach = override.reach;
  }
  return out;
}

export const REACH_RANK = { device: 0, trusted: 1, any: 2 };
const REACH_STEPS = ['device', 'trusted', 'any'];

/**
 * The reach values a user may declare for a model we detected as `detected`.
 *
 * The rule and the CONTROL that offers it have to come from one place. They did not: the
 * settings page built its options by slicing from the model's CURRENT reach, which is the
 * value after the override has been applied — so saving 'any' left 'any' as the only option
 * and the correction could never be taken back. Enforcing outward-only in applyOverride while
 * a second copy of the rule decided what to offer is what turned a safety rule into a
 * one-way door.
 *
 * Always includes `detected` itself: coming back to what we detected is not moving inward, it
 * is dropping the override. Anything closer in than the detection is never offered, because
 * applyOverride would refuse it and a control that silently discards half its own values is
 * worse than no control.
 */
export function reachChoicesFor(detected) {
  const i = REACH_STEPS.indexOf(detected);
  return i < 0 ? [...REACH_STEPS] : REACH_STEPS.slice(i);
}


/**
 * One router model from one configured target. The core of every client's candidate list.
 *
 * `kind` is 'bridge' for a CLI agent on this machine and 'api' for an HTTP endpoint;
 * `override` is what the user said about this model (see applyOverride); `health` is
 * `{ available, rateLimited }` as the host measured it, or null for "nothing observed".
 * Returns null for a target that names no model and is not an agent — nothing to route to.
 */
export function inferCandidate(t, kind, { override = null, health = null } = {}) {
  if (!t || (!t.model && kind !== 'bridge' && t.kind !== 'bridge')) return null;
  const id = t.id || t.name || t.model;
  if (!id) return null;
  // NEVER A GENERATED ID. 'mqr0ifmw7sqxr7' appeared as the answer to "which model did this"
  // in a real log — falling back to the id was the same as having no label at all. A bridge
  // agent the user never renamed still knows which CLI it runs, and that is readable.
  const label = [t.name, t.model && t.model !== t.name ? t.model : null]
    .filter(Boolean).join(' · ')
    || [t.bridgeAgent, t.model].filter(Boolean).join(' · ')
    || kind || t.kind
    || String(id);
  const k = kind || t.kind;
  const reach = reachOf({ ...t, kind: k });
  const inferred = {
    id,
    label,
    // Kept so failover can recognise the SAME model at another provider — the closest
    // possible replacement, and invisible if only the display label survived.
    model: t.model || '',
    reach,
    classUsed: reach === 'device' ? 'L' : (k === 'bridge' ? 'A' : 'C'),
    capabilities: capabilitiesOf({ ...t, kind: k }),
    costPer1k: costOf(t, reach),
    latencyMs: latencyOf(reach, qualityOf({ ...t, kind: k })),
    quality: qualityOf({ ...t, kind: k }),
    providerRank: providerRankOf(t, k),
    available: t.enabled !== false,
  };
  const configured = applyOverride(inferred, override || {});
  // AN EXPLICIT DISABLE OUTRANKS A TUNING OVERRIDE. `enabled: false` is the user saying,
  // right now, "don't use this"; a routing override is a hint saved earlier.
  if (t.enabled === false) configured.available = false;
  // A CORRECTED QUALITY CORRECTS THE SPEED DERIVED FROM IT — unless the user set the speed.
  if (numericOverride(override?.latencyMs) === null) configured.latencyMs = latencyOf(reach, configured.quality);
  return defineModel({
    ...configured,
    available: configured.available && (health ? health.available !== false : true),
    rateLimited: !!health?.rateLimited,
  });
}
