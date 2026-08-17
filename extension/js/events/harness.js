// GENERATED — do not edit.
// Source of truth: chatpanel-events/harness.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// THE REPLAY HARNESS — what turns the determinism claim into a checked one.
//
// An unverified invariant decays silently. The claim we actually sell is replay
// determinism ("same log, same reconstructed inputs"), so it needs a job that re-runs
// recorded logs and fails the build when reconstruction drifts — the same discipline as
// the `sync:pii --check` drift guard and the CSP assertion in build-editor.mjs.
//
// What it verifies, and what it deliberately does not:
//   • ORDER is reproduced exactly, from (host, seq) and causes, never from a clock.
//   • MODEL-VISIBLE INPUT is reconstructable: every resident Ref resolves by hash.
//   • A Ref whose blob is gone reports VERIFIED-BUT-UNAVAILABLE. That is a PASS, not a
//     failure — crypto-shredding is a feature, and the log still proves what was sent.
//   • A Ref whose source CHANGED reports DRIFTED, and that IS a failure, because the
//     alternative is replay quietly substituting today's note for the one actually sent.

import { upcastAll } from './upcast.js';
import { linearize } from './order.js';
import { checkInvariants } from './invariants.js';
import { resolveRef, RESOLUTION } from './ref.js';

/**
 * @param stored  events as persisted (any schema version)
 * @param blobs   { lookup(ref) } — omit to skip content reconstruction
 * @returns a report; `ok` is the CI signal.
 */
export function replay(stored, { blobs = null, invariantOptions = {} } = {}) {
  const events = upcastAll(stored);
  const ordered = linearize(events);

  // Determinism: linearize is a function of the SET. Feed it back reversed; if the order
  // changes, replay depends on how the log happened to be read off disk.
  const stable = linearize([...events].reverse()).map((e) => e.id).join(',')
    === ordered.map((e) => e.id).join(',');

  const violations = checkInvariants(ordered, invariantOptions);

  const refs = { exact: 0, unavailable: 0, drifted: [] };
  const turns = [];
  if (blobs) {
    for (const e of ordered) {
      // What the model was SHOWN and what it SAID are refs too, and they are the half a
      // reader most wants replayed. Checking only `resident` verified the toolset while
      // leaving the conversation unverified — the part that actually reconstructs a turn.
      if (String(e.type).startsWith('assistant.')) {
        const r = resolveRef(e.payload.ref, (x) => blobs.lookup(x));
        if (r.resolution === RESOLUTION.EXACT) refs.exact++;
        else if (r.resolution === RESOLUTION.UNAVAILABLE) refs.unavailable++;
        else refs.drifted.push({ eventId: e.id, ref: r.ref, actualHash: r.actualHash });
        continue;
      }
      if (e.type !== 'context.assembled') continue;
      const resolved = e.payload.resident.map((ref) => resolveRef(ref, (r) => blobs.lookup(r)));
      for (const r of resolved) {
        if (r.resolution === RESOLUTION.EXACT) refs.exact++;
        else if (r.resolution === RESOLUTION.UNAVAILABLE) refs.unavailable++;
        else refs.drifted.push({ eventId: e.id, ref: r.ref, actualHash: r.actualHash });
      }
      turns.push({
        turnId: e.payload.turnId,
        budget: e.payload.budget,
        used: e.payload.used,
        parts: e.payload.parts,
        reconstructable: resolved.every((r) => r.resolution !== RESOLUTION.DRIFTED),
      });
    }
  }

  return {
    ok: stable && violations.length === 0 && refs.drifted.length === 0,
    events: ordered.length,
    stable,
    violations,
    refs,
    turns,
    order: ordered.map((e) => e.id),
  };
}

/** One-line CI summary. */
export function formatReport(report) {
  const lines = [
    `${report.ok ? 'PASS' : 'FAIL'} — ${report.events} events`,
    `  order stable        ${report.stable ? 'yes' : 'NO — replay is order-dependent'}`,
    `  invariants          ${report.violations.length === 0 ? 'I1-I6 hold' : `${report.violations.length} violation(s)`}`,
  ];
  for (const v of report.violations) lines.push(`    ${v.invariant} ${v.eventId || ''} ${v.message}`);
  if (report.refs.exact || report.refs.unavailable || report.refs.drifted.length) {
    lines.push(`  refs                ${report.refs.exact} exact · ${report.refs.unavailable} shredded/evicted · ${report.refs.drifted.length} DRIFTED`);
  }
  for (const d of report.refs.drifted) lines.push(`    drifted ${d.ref.kind}:${d.ref.id} — the source changed since capture`);
  return lines.join('\n');
}

/** Parse a JSONL log. Blank lines ignored so a truncated export still loads. */
export function parseJsonl(text) {
  return String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

export function toJsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}
