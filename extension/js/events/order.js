// GENERATED — do not edit.
// Source of truth: chatpanel-events/order.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// THE LINEARIZATION RULE — stated once, never varied.
//
//   Replay orders events by topological sort over `causes`, breaking ties by
//   (host, seq) with hosts in lexicographic id order. Wall time is never consulted.
//
// This is what makes replay deterministic when two hosts append concurrently. A
// timestamp is not an order: clocks skew, and two hosts can stamp the same millisecond.
// `causes` gives a partial order; the tie-break makes it total; neither depends on a
// clock, so the same set of events linearizes identically on every host, forever.
//
// Dangling causes (an id we do not hold, e.g. a partial export) are IGNORED rather than
// fatal, so a sanitized or truncated trace still replays. A cycle is fatal, because it
// means the log is corrupt.

import { EventError } from './event.js';

/** (host, seq) with hosts lexicographic — the deterministic tie-break. */
export function compareEvents(a, b) {
  if (a.host !== b.host) return a.host < b.host ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // total, for identical (host,seq)
}

/**
 * Deterministic topological linearization. Pure; input array is not mutated.
 * @throws EventError('CYCLE') if `causes` contains a cycle.
 */
export function linearize(events) {
  const byId = new Map();
  for (const e of events) byId.set(e.id, e);

  const indegree = new Map();
  const dependents = new Map();
  for (const e of events) {
    const deps = e.causes.filter((c) => byId.has(c)); // dangling causes ignored
    indegree.set(e.id, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(e.id);
    }
  }

  // Kahn's algorithm with a ready-set kept in (host, seq) order, so the output is a
  // function of the event set alone and not of the input array's order.
  const ready = events.filter((e) => indegree.get(e.id) === 0).sort(compareEvents);
  const out = [];
  while (ready.length > 0) {
    const next = ready.shift();
    out.push(next);
    const kids = dependents.get(next.id);
    if (!kids) continue;
    let unlocked = false;
    for (const kid of kids) {
      const left = indegree.get(kid) - 1;
      indegree.set(kid, left);
      if (left === 0) { ready.push(byId.get(kid)); unlocked = true; }
    }
    if (unlocked) ready.sort(compareEvents);
  }

  if (out.length !== events.length) {
    const stuck = events.filter((e) => !out.includes(e)).map((e) => e.id);
    throw new EventError('CYCLE', 'causes contains a cycle', stuck);
  }
  return out;
}

/** True when `causes` never points forward within one host's own sequence. */
export function causesAreWellFormed(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const e of events) {
    for (const c of e.causes) {
      const cause = byId.get(c);
      if (cause && cause.host === e.host && cause.seq >= e.seq) return false;
    }
  }
  return true;
}
