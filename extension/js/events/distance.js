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

/**
 * A ceiling on pairwise work, and the reason it exists.
 *
 * Comparing every pair is the N×N scan the knowledge design forbids, and it behaves exactly
 * as that rule predicts. Two passes learned it the hard way: near-duplicate titles ran 40s
 * over 12,000 records, and merge suggestions did not finish 12,000 SUBJECTS in two minutes.
 * Both on the UI thread, which is an unresponsive tab rather than a slow report.
 */
export const MAX_PAIR_COMPARISONS = 200_000;

const BLOCK_KEY_CHARS = 4;
// Every block gets at least this many comparisons before the budget can starve it.
const MIN_BLOCK_BUDGET = 2_000;

/**
 * The keys a string is filed under for candidate generation.
 *
 * Three, and each earns its place: two strings within a couple of edits still agree on their
 * first few characters unless the typo is at the front — in which case they agree on their
 * last few — and two forms of one person's name ("alex rivera", "a rivera") agree on the
 * LAST TOKEN even when neither end matches. Drop the third and abbreviated first names stop
 * being found at all.
 */
export function blockKeys(norm) {
  const s = String(norm || '');
  if (!s) return [];
  const keys = new Set([`p:${s.slice(0, BLOCK_KEY_CHARS)}`, `s:${s.slice(-BLOCK_KEY_CHARS)}`]);
  const last = s.split(' ').filter(Boolean).pop();
  if (last && last.length >= 2) keys.add(`t:${last}`);
  return [...keys];
}

/**
 * BLOCKING — the standard record-linkage answer to "which pairs are worth comparing".
 *
 * Files every string under `blockKeys` and yields only pairs that share one, so the work is
 * proportional to the corpus rather than to its square. Each unordered pair is yielded at
 * most once even when two strings share several keys.
 *
 * `budget` is the backstop for the pathological case — ten thousand titles that all start the
 * same way land in one block, and a block is compared pairwise. A weird corpus then costs a
 * truncated report instead of a hung page.
 */
export function* blockedPairs(values, { budget = MAX_PAIR_COMPARISONS } = {}) {
  const blocks = new Map();
  for (const v of values) {
    for (const key of blockKeys(v)) {
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(v);
    }
  }
  let spent = 0;
  const seen = new Set();
  // SMALLEST BLOCKS FIRST, and a per-block share of the budget. Both are about RECALL, not
  // speed, and the first version got this wrong: nine thousand subjects all beginning
  // "Unrelated Person" land in one bucket under the prefix key, and that single
  // non-discriminating block spent the entire budget before the buckets holding the real
  // findings were ever reached — so a big corpus returned five hundred suggestions and not
  // one of the ones that mattered.
  //
  // A small block is a discriminating one: "rivera" as a last token says far more than
  // "unre" as a prefix. Working through them in size order means the specific evidence is
  // spent first and the vague evidence gets whatever is left.
  const buckets = [...blocks.values()].filter((b) => b.length > 1).sort((a, b) => a.length - b.length);
  for (const bucket of buckets) {
    if (spent >= budget) return;
    // No single block may consume the whole budget, however it is ordered.
    const blockBudget = Math.min(budget - spent, Math.max(MIN_BLOCK_BUDGET, Math.floor(budget / 8)));
    let blockSpent = 0;
    for (let i = 0; i < bucket.length && blockSpent < blockBudget; i += 1) {
      for (let j = i + 1; j < bucket.length && blockSpent < blockBudget; j += 1) {
        const a = bucket[i]; const b = bucket[j];
        const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blockSpent += 1;
        spent += 1;
        yield [a, b];
      }
    }
  }
}
