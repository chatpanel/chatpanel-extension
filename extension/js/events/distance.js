// GENERATED — do not edit.
// Source of truth: chatpanel-events/distance.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// How far apart are two strings — one answer, and nothing else in the module.
//
// It exists as its own file for a load-time reason, and the reason is worth recording
// because it is the second time this rule has been learned here. `voice-intents.js` needed
// a bounded Levenshtein for wake-word matching and grew one. When the maintenance pass
// needed the same question answered for near-duplicate titles, importing it from there was
// the correct instinct — reuse, don't reinvent — and it pulled `voice-intents.js` (79 KB)
// and its `structured.js` dependency (41 KB) onto the MV3 service worker's cold start, for
// forty lines of arithmetic.
//
// So: a primitive two unrelated features need belongs in a module of its own, not in
// whichever feature happened to need it first. Reuse is right; reuse through a large module
// is a 120 KB import of one function.

/**
 * Bounded Levenshtein. Returns early once the distance cannot come in under `max`, so a
 * wake scan over a long transcript — or a pairwise title sweep over a corpus — stays linear
 * in practice rather than paying for an exact answer nobody reads.
 *
 * Past `max` the return is `max + 1`: "far", not a number. Callers compare against `max`.
 */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
