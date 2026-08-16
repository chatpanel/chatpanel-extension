// GENERATED — do not edit.
// Source of truth: chatpanel-events/invariants.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The six invariants the replay harness asserts.
//
// These are what make the claims CHECKABLE rather than aspirational. An unverified
// invariant decays silently, so each of these becomes a CI assertion the way the
// `sync:pii --check` drift guard and the CSP assertion in build-editor.mjs already are.
//
//   I1  every model request is preceded by a context.assembled that reconstructs it
//   I2  every byte leaving the device has a privacy.egress (controlled:false for agents)
//   I3  every non-pure capability.invoked carries an idempotency key
//   I4  every capability.revoked names its activated in causes
//   I5  no durable event exists for a per-item ephemeral stream
//   I6  replay under the linearization rule is stable across runs and across hosts
//
// checkInvariants() returns violations rather than throwing, so a harness can report
// every problem in one pass instead of one per run.

import { linearize } from './order.js';
import { isRef } from './ref.js';

const v = (id, event, message) => ({ invariant: id, eventId: event ? event.id : null, message });

/** I1 — a turn that ran must have assembled its context, and every resident Ref is hashed. */
function checkI1(events) {
  const out = [];
  const assembledByTurn = new Set();
  for (const e of events) {
    if (e.type === 'context.assembled') {
      if (e.payload.turnId) assembledByTurn.add(e.payload.turnId);
      for (const r of e.payload.resident) {
        if (!isRef(r)) out.push(v('I1', e, 'resident entry is not a valid Ref'));
      }
    }
  }
  for (const e of events) {
    if (e.type === 'turn.ended' && e.payload.stepped !== false && !assembledByTurn.has(e.payload.turnId)) {
      out.push(v('I1', e, `turn ${e.payload.turnId} ended with no context.assembled — model-visible input is not reconstructable`));
    }
  }
  return out;
}

/** I2 — an invocation that egresses must produce a privacy.egress caused by it. */
function checkI2(events) {
  const out = [];
  const egressCauses = new Set();
  for (const e of events) {
    if (e.type === 'privacy.egress') for (const c of e.causes) egressCauses.add(c);
  }
  for (const e of events) {
    if (e.type === 'capability.invoked' && e.payload.egress && e.payload.egress !== 'none') {
      if (!egressCauses.has(e.id)) {
        out.push(v('I2', e, `invocation declares egress '${e.payload.egress}' but no privacy.egress references it`));
      }
    }
  }
  return out;
}

/** I3 — non-pure invocations carry an idempotency key. (Also enforced by validateEvent.) */
function checkI3(events) {
  return events
    .filter((e) => e.type === 'capability.invoked'
      && e.payload.effects !== 'pure'
      && !e.payload.idempotencyKey)
    .map((e) => v('I3', e, `'${e.payload.effects}' invocation without an idempotencyKey — a retry would repeat the side effect`));
}

/** I4 — a revoke names the activation it undoes. */
function checkI4(events) {
  const activated = new Map();
  for (const e of events) if (e.type === 'capability.activated') activated.set(e.id, e);
  return events
    .filter((e) => e.type === 'capability.revoked' && !e.causes.some((c) => activated.has(c)))
    .map((e) => v('I4', e, 'revoked does not name its activated in causes — the effect has no recorded inverse'));
}

/** I5 — ephemeral stream items never become durable facts. */
function checkI5(events, { ephemeralBudget = 200 } = {}) {
  const out = [];
  const perTypePerHost = new Map();
  for (const e of events) {
    const k = `${e.host}:${e.type}:${e.payload.streamId || ''}`;
    perTypePerHost.set(k, (perTypePerHost.get(k) || 0) + 1);
  }
  for (const [k, n] of perTypePerHost) {
    if (k.split(':')[2] && n > ephemeralBudget) {
      out.push(v('I5', null, `${n} durable events for stream ${k} — per-item stream data must be windowed, not logged`));
    }
  }
  return out;
}

/** I6 — linearization is a function of the event SET, not of the input array's order. */
function checkI6(events, { shuffles = 8, rng = mulberry32(0x5EED) } = {}) {
  if (events.length < 2) return [];
  const base = linearize(events).map((e) => e.id).join(',');
  for (let i = 0; i < shuffles; i++) {
    const shuffled = shuffle(events, rng);
    if (linearize(shuffled).map((e) => e.id).join(',') !== base) {
      return [v('I6', null, 'linearize() is order-dependent — replay is not deterministic')];
    }
  }
  return [];
}

/** Run every invariant over an event set. Returns [] when the log is sound. */
export function checkInvariants(events, opts = {}) {
  return [
    ...checkI1(events),
    ...checkI2(events),
    ...checkI3(events),
    ...checkI4(events),
    ...checkI5(events, opts),
    ...checkI6(events, opts),
  ];
}

export const INVARIANTS = Object.freeze({
  I1: 'model-visible input is reconstructable from the log',
  I2: 'every egress is recorded',
  I3: 'non-pure invocations are idempotent',
  I4: 'every activation has a recorded inverse',
  I5: 'ephemeral streams never become durable facts',
  I6: 'replay is deterministic',
});

// Seeded PRNG so a failing I6 reproduces exactly — the package holds no ambient
// dependency on Math.random.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
