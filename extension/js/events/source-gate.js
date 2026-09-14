// GENERATED — do not edit.
// Source of truth: chatpanel-events/source-gate.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The source ceiling — would this turn send internal material to a model that is too far
// away? — as a GATE, not a ranking.
//
// Routing is not enough. A router returns null in every uncertain case and null means
// "leave the choice alone", which is right for a preference and catastrophic for a privacy
// rule: an internal page with no local model available would have gone to the third party
// the user had selected. And routing only runs under Auto, so a manually chosen cloud model
// bypassed it entirely. So this runs on every turn, after routing has had its chance to
// pick something local, and it REFUSES rather than substituting: silently answering from a
// different model is the substitution this codebase keeps removing, and silently sending
// anyway is the leak it exists to stop.
//
// Was the extension's `sourceGate` + `sourcePolicySettings` + `sourceUrlsOf`; the desktop
// had none of it and sent internal pages wherever the picker pointed. The policy (which
// hosts are internal, how far their content may travel) is the user's and travels in the
// shared `internalSites` preference section, so both clients enforce the same rule.
//
// Class R: no I/O. The target's reach comes from `reachOf` (a bridge agent is 'trusted', a
// localhost endpoint 'device', the rest 'any') unless the caller already knows it.

import { sourcePolicyFor, sourceUrlsOf, DEFAULT_INTERNAL_PATTERNS } from './sources.js';
import { reachOf } from './model-candidates.js';
import { REACH, reachRank } from './reach.js';

// `sourceUrlsOf` lives in sources.js (no router on its graph) so a client's first paint can
// list a turn's addresses without pulling the router in; it is re-exported here for callers
// that have the gate anyway.
export { sourceUrlsOf };

/**
 * The internal-source policy, read from the `privacy` settings object in ONE place.
 *
 * NEVER CONFIGURED and CONFIGURED TO NOTHING are different answers. Undefined means the
 * user has not been here yet, so the built-ins apply; an array — even an empty one — is a
 * list they edited, and prepending our own to it would make a default impossible to
 * remove. Someone testing against localhost has a real reason to delete that line.
 */
export function sourcePolicySettings(privacy = {}) {
  const cfg = privacy || {};
  const saved = cfg.internalPatterns;
  const list = Array.isArray(saved)
    ? saved
    : (saved == null ? DEFAULT_INTERNAL_PATTERNS : String(saved).split(/[\s,]+/));
  return {
    enabled: cfg.internalGuard !== false,
    patterns: list.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean),
    ceiling: cfg.internalCeiling === 'trusted' ? 'trusted' : 'device',
  };
}

/** What the sources of a turn allow. Null when the guard is off or nothing matched. */
export function sourceGuardFor(policy, sources = []) {
  if (!policy || !policy.enabled || !sources?.length) return null;
  const p = sourcePolicyFor(sources, { patterns: policy.patterns, ceiling: policy.ceiling });
  return p.internal ? p : null;
}

/**
 * The gate. `{ blocked, why, reach, message }` when the target is out of reach for these
 * sources; null when the turn may go.
 *
 * @param policy    `sourcePolicySettings(privacy)`
 * @param messages  the conversation as it will be sent
 * @param sources   anything else the caller knows was attached
 * @param target    `{ kind, baseUrl }` (reach computed) or `{ reach }` (reach known)
 * @param label     how to name the target in the message
 */
export function sourceGate({ policy, messages = [], sources = [], target = {}, label = '' } = {}) {
  const guard = sourceGuardFor(policy, sourceUrlsOf(messages, sources));
  if (!guard) return null;
  const actual = REACH.includes(target?.reach) ? target.reach : reachOf(target || {});
  if (reachRank(actual) <= reachRank(guard.reach)) return null;
  const where = guard.reach === 'device' ? 'stay on this device' : 'stay inside your workspace';
  return {
    blocked: true,
    why: guard.why,
    reach: guard.reach,
    // Name the source, the model and the way out. A refusal a person cannot act on gets
    // switched off wholesale, which would leave them worse protected than before.
    message: `Not sent: ${guard.why}. "${label || 'this model'}" is outside that, and content from an internal source must ${where}. `
      + 'Pick a local model (or run one), or remove this site under Settings → Privacy → Internal sites.',
  };
}

/** Is this error the gate's refusal? A runner reads it as "this model, not this task". */
export const isSourceGateError = (err) => /^Not sent: /.test(String(err?.message || err || ''));

/** The candidates a turn under `guard` may be handed at all — for a roster, before appointment. */
export function withinReach(candidates = [], guard = null) {
  if (!guard) return candidates;
  return (candidates || []).filter((c) => reachRank(REACH.includes(c?.reach) ? c.reach : reachOf(c || {})) <= reachRank(guard.reach));
}
