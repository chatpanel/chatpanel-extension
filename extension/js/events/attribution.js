// GENERATED — do not edit.
// Source of truth: chatpanel-events/attribution.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// AUTHORSHIP — who wrote which run of a document, and the versions you can go back to.
//
// Moved here from the extension's `notes-provenance.js` unchanged in behaviour. It was
// always platform-free: a run-list `[{ len, author, at }]` that sums to the body length and
// shifts naturally as text is inserted or deleted, with no absolute offsets to fix up. The
// desktop needed exactly the same answers, and a second implementation of "who wrote this"
// would have disagreed with the first on precisely the edits that matter.
//
// WHY RUNS AND NOT OFFSETS. An offset-based ledger has to be repaired after every edit, and
// the repair is where the bugs live. A run-list is repaired BY the edit: replacing [s,e)
// with n characters is a splice, and everything after it moves without being touched.
//
// The versioning half is new here and belongs beside it, because a version snapshot carries
// its ledger — restoring a body without its attribution would silently reattribute an
// agent's paragraphs to the person who pressed Restore.

export const HUMAN = 'You';

export function blankAttribution(len, author = HUMAN, at = 0) {
  return len > 0 ? [{ len, author, at }] : [];
}

// The minimal replaced range: [start,end) of `prev` became `insLen` new chars in `next`.
export function diffRange(prev, next) {
  const max = Math.min(prev.length, next.length);
  let s = 0; while (s < max && prev[s] === next[s]) s++;
  let e = 0; while (e < max - s && prev[prev.length - 1 - e] === next[next.length - 1 - e]) e++;
  return { start: s, end: prev.length - e, insLen: next.length - s - e };
}

export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.len) continue;
    const last = out[out.length - 1];
    if (last && last.author === r.author && last.at === r.at) last.len += r.len;
    else out.push({ len: r.len, author: r.author, at: r.at });
  }
  return out;
}

export function spliceAttribution(runs, start, end, insLen, author, at) {
  const before = [], after = [];
  let pos = 0;
  for (const r of runs) {
    const rStart = pos, rEnd = pos + r.len;
    if (rEnd <= start) before.push(r);
    else if (rStart >= end) after.push(r);
    else {
      if (rStart < start) before.push({ len: start - rStart, author: r.author, at: r.at });
      if (rEnd > end) after.push({ len: rEnd - end, author: r.author, at: r.at });
    }
    pos = rEnd;
  }
  return mergeRuns([...before, ...(insLen ? [{ len: insLen, author, at }] : []), ...after]);
}

// Attribute the diff prev→next to `author`. Returns the updated run-list (unchanged
// reference-wise only when there was no change).
export function applyAttribution(runs, prev, next, author, at) {
  const cur = Array.isArray(runs) && runs.length ? runs : blankAttribution(prev.length);
  const { start, end, insLen } = diffRange(prev, next);
  if (start === end && !insLen) return cur; // no change
  return spliceAttribution(cur, start, end, insLen, author, at);
}

export function attributionSummary(runs) {
  const by = new Map();
  let total = 0;
  for (const r of runs || []) { by.set(r.author, (by.get(r.author) || 0) + r.len); total += r.len; }
  return {
    by: [...by.entries()].map(([author, chars]) => ({ author, chars })).sort((a, b) => b.chars - a.chars),
    total,
  };
}

// Adopt a stored ledger only if it still matches the body length (a note edited by an
// older build, or imported, won't have one) — otherwise seed the whole body as You.
export function normalizeAttribution(runs, bodyLen, at) {
  if (Array.isArray(runs) && runs.length && runs.reduce((n, r) => n + (r.len || 0), 0) === bodyLen) return mergeRuns(runs);
  return blankAttribution(bodyLen, HUMAN, at);
}

// ---------------------------------------------------------------------------
// Versions — the snapshots you can go back to
// ---------------------------------------------------------------------------

/** Forty is what the extension keeps. Enough to undo an afternoon, bounded enough to store. */
export const MAX_VERSIONS = 40;

/**
 * Append a snapshot of `body` and its ledger, and return the new list.
 *
 * Two rules, both about not filling the list with noise:
 *   · a body identical to the newest snapshot is not a new version;
 *   · a ledger that does not sum to this body's length is not this body's ledger, so it is
 *     seeded blank rather than carried across — a mismatched ledger would make a later
 *     restore attribute the wrong spans to the wrong authors.
 */
export function pushVersion(versions, { body, attribution = null, by = HUMAN, label = '', at = Date.now() } = {}) {
  const list = Array.isArray(versions) ? versions : [];
  const text = String(body ?? '');
  const last = list[list.length - 1];
  if (last && last.body === text) return list;
  const ledger = (Array.isArray(attribution) && attribution.reduce((n, r) => n + (r.len || 0), 0) === text.length)
    ? attribution
    : blankAttribution(text.length, by, at);
  return [...list, { body: text, attribution: ledger, at, by, label: label || by }].slice(-MAX_VERSIONS);
}

/**
 * Restore version `index`, keeping the current draft as a snapshot first so the restore is
 * itself undoable.
 *
 * The guard against re-snapshotting matters more than it looks: flipping between two
 * versions (A→B→A→B) would otherwise push an identical "Before restore" row every time and
 * push the version you were trying to reach off the end of a bounded list.
 */
export function restoreVersion(versions, index, { currentBody, currentAttribution = null, at = Date.now(), label = 'Before restore' } = {}) {
  const list = Array.isArray(versions) ? versions : [];
  const target = list[index];
  if (!target) return null;
  const draft = String(currentBody ?? '');
  const next = list.some((v) => v.body === draft)
    ? list
    : pushVersion(list, { body: draft, attribution: currentAttribution, by: HUMAN, label, at });
  return {
    body: target.body,
    attribution: normalizeAttribution(target.attribution, target.body.length, target.at || at),
    versions: next,
  };
}
