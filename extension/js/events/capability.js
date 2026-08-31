// GENERATED — do not edit.
// Source of truth: chatpanel-events/capability.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The capability signature — one call shape a rule, a schedule, the user or a model all
// invoke identically, through one policy path.
//
// `actor` is the field that makes capabilities turn-independent; it is the whole of the
// "capabilities are not turn-shaped" principle expressed as data rather than as a
// subsystem.
//
// `requirements` is what the router dispatches on: not "which model" but "what must be
// true". {maxLatencyMs:100, deterministic:true, egress:'none'} selects class R or M on a
// host that can realize it — or REFUSES. Silently exceeding a declared budget is the
// failure mode this exists to prevent.

import { CLASSES, EFFECTS, EGRESS, ACTOR_KINDS, SCOPE_KINDS, EventError } from './event.js';
import { DATA_SCOPES } from './scopes.js';
import { validateView } from './view.js';

export { DATA_SCOPES } from './scopes.js';

const str = (v) => typeof v === 'string' && v.length > 0;
const strs = (v, allowed = null) => Array.isArray(v) && v.every((x) => str(x) && (!allowed || allowed.includes(x)));

/**
 * Validate a capability DECLARATION — the static surface a reviewer, a user or an admin
 * approves BEFORE the capability runs. Everything here is readable without executing
 * anything, which is what makes load-time approval possible.
 */
export function validateCapability(c) {
  if (!c || typeof c !== 'object') throw new EventError('SHAPE', 'capability must be an object');
  if (!str(c.id)) throw new EventError('SHAPE', 'capability.id required');
  if (!str(c.version)) throw new EventError('SHAPE', 'capability.version required');
  if (!CLASSES.includes(c.class)) throw new EventError('SHAPE', `capability.class must be one of ${CLASSES}`);
  if (!strs(c.requires)) throw new EventError('SHAPE', 'capability.requires must be string[]');
  if (!strs(c.provides)) throw new EventError('SHAPE', 'capability.provides must be string[]');
  if (!strs(c.reads, DATA_SCOPES)) throw new EventError('SHAPE', `capability.reads must be within ${DATA_SCOPES}`);
  if (!strs(c.writes, DATA_SCOPES)) throw new EventError('SHAPE', `capability.writes must be within ${DATA_SCOPES}`);
  if (!EGRESS.includes(c.egress)) throw new EventError('SHAPE', `capability.egress must be one of ${EGRESS}`);
  if (!EFFECTS.includes(c.effects)) throw new EventError('SHAPE', `capability.effects must be one of ${EFFECTS}`);
  if (typeof c.invoke !== 'function') throw new EventError('SHAPE', 'capability.invoke required');
  if (typeof c.disclose !== 'function') throw new EventError('SHAPE', 'capability.disclose required');
  if (!c.output || typeof c.output.render !== 'function') {
    throw new EventError('SHAPE', 'capability.output.render required — canonical value and rendering are separate');
  }
  // A capability MAY ship its own UI. Optional, and validated against this capability so a
  // view can never name a capability its owner isn't already allowed to call.
  if (c.view != null) validateView(c.view, c);
  // A class-R capability that declares egress is a contradiction: R is a determinism
  // guarantee, and a network round-trip is not deterministic.
  if (c.class === 'R' && c.egress !== 'none') {
    throw new EventError('CONTRADICTION', 'class R must declare egress:none');
  }
  return c;
}

/**
 * Validate an INVOCATION. Enforces the one rule that is easiest to forget and worst to
 * miss: a capability that is not `pure` cannot be invoked without an idempotency key,
 * because a retried delegated call would otherwise perform the side effect twice.
 */
export function validateInvocation(inv, capability) {
  if (!inv || typeof inv !== 'object') throw new EventError('SHAPE', 'invocation must be an object');
  if (!str(inv.capability)) throw new EventError('SHAPE', 'invocation.capability required');
  if (!inv.actor || !ACTOR_KINDS.includes(inv.actor.kind) || !str(inv.actor.id)) {
    throw new EventError('SHAPE', `invocation.actor.kind must be one of ${ACTOR_KINDS}`);
  }
  if (!inv.scope || !SCOPE_KINDS.includes(inv.scope.kind) || !str(inv.scope.id)) {
    throw new EventError('SHAPE', `invocation.scope.kind must be one of ${SCOPE_KINDS}`);
  }
  if (!Array.isArray(inv.causes)) throw new EventError('SHAPE', 'invocation.causes must be string[]');
  const effects = capability ? capability.effects : inv.effects;
  if (effects && effects !== 'pure' && !str(inv.idempotencyKey)) {
    throw new EventError('IDEMPOTENCY', `invocation of a '${effects}' capability requires an idempotencyKey`);
  }
  return inv;
}

/**
 * Can this capability satisfy these requirements on this host?
 * Returns { ok, reasons[] } — REFUSING is a valid, expected outcome.
 *
 * `host` supplies what it can actually realize: { realizes: {R:{maxMs},M:{maxMs},...} }.
 * Class is intrinsic (a guarantee); latency is host-bound. Never fuse the two.
 */
export function canSatisfy(capability, requirements = {}, host = null) {
  const reasons = [];
  const { maxLatencyMs, deterministic, egress, maxCostUsd } = requirements;

  if (deterministic === true && !['R', 'M'].includes(capability.class)) {
    reasons.push(`class ${capability.class} is not deterministic`);
  }
  if (egress === 'none' && capability.egress !== 'none') {
    reasons.push(`capability egresses '${capability.egress}', requirement is 'none'`);
  }
  if (egress === 'redacted' && capability.egress === 'delegated') {
    reasons.push('delegated egress is not controlled, requirement is redacted');
  }
  if (maxLatencyMs != null && host) {
    const realized = host.realizes && host.realizes[capability.class];
    if (!realized) reasons.push(`host cannot realize class ${capability.class}`);
    else if (realized.maxMs > maxLatencyMs) {
      reasons.push(`host realizes class ${capability.class} at ~${realized.maxMs}ms, requirement is ${maxLatencyMs}ms`);
    }
  }
  if (maxCostUsd != null && capability.class === 'C' && maxCostUsd <= 0) {
    reasons.push('cloud class requires a positive cost ceiling');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The model-facing projection — an ALLOWLIST built from exactly three fields.
 *
 * Never an omit-list. An omit-list leaks the next field someone adds; this cannot,
 * because `invoke`, `effects`, `cost`, `writes` and `egress` are never copied.
 */
export function toModelSchema(capability) {
  return {
    name: capability.id,
    description: capability.disclose().gist,
    parameters: capability.input || { type: 'object', properties: {} },
  };
}

/** The same allowlist over a toolset — the only supported way to build a model request. */
export function toModelSchemas(capabilities) {
  return capabilities.map(toModelSchema);
}
