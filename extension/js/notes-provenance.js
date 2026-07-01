// Provenance engine — the PURE core of the notes authorship ledger: who (human /
// which agent) wrote each run of the body, tracked as a run-list `[{ len, author,
// at }]` that sums to body.length and shifts naturally as text is inserted/deleted
// (no absolute offsets to fix up). Every committed edit attributes only its CHANGED
// span (found by a prefix/suffix diff) to its author; untouched text keeps its prior
// authorship.
//
// Zero DOM / zero shared state — the notes editor owns the runs and calls these; the
// same primitive could attribute any collaboratively-edited text (gateway/bridge).

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
