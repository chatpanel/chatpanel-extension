// GENERATED — do not edit.
// Source of truth: chatpanel-events/citations.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Turn the citations a model wrote into the citations a reader can click.
//
// Models are told to cite as markdown links and finish with a Sources section. Large ones
// mostly comply; small ones write bare `[1]` and stop — and a user then sees numbers that
// reference nothing, with the URLs sitting unused in a tool result they never see. That is
// exactly what happened on a real answer about SpaceX: five sources fetched, five bracket
// numbers rendered, no links anywhere.
//
// The instinct is to write a firmer instruction. But the mapping from [1] to a URL is
// already known EXACTLY — the tool result numbered them — so this is a substitution, not a
// judgement, and a deterministic pass cannot fail to follow it. Prompting is the wrong tool
// for something a rule can guarantee.
//
// Shared rather than client-side: any client that shows model output with sources needs
// this, and the numbering convention belongs with the tool contract that produced it.

/** `[1] [Title](https://url)` — the citation index every search result opens with. */
const INDEX_RE = /^\[(\d+)\]\s*\[([^\]]*)\]\(([^)\s]+)\)/gm;

/**
 * Recover the numbered sources from a tool result.
 *
 * Parsed from the SAME text the model was shown, so the numbers can never disagree with
 * what it read — deriving them from anywhere else would reintroduce the mismatch this
 * exists to remove.
 */
export function sourcesFromToolText(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(INDEX_RE)) {
    const rank = Number(m[1]);
    if (!out.has(rank)) out.set(rank, { rank, title: m[2].trim(), url: m[3] });
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank);
}

// A bare citation: [1] or [1, 3] or [1,3] — but NOT a markdown link `[x](url)`, NOT a
// footnote definition at line start, and not `[]`.
const BARE_RE = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g;

/**
 * Rewrite bare `[n]` citations as markdown links, and append a Sources section listing
 * exactly what was cited.
 *
 * Only ever ADDS links; text the model already wrote as a link is untouched, and a number
 * with no matching source is left exactly as it is — inventing a link for `[7]` when seven
 * sources were never returned would be fabricating a citation, which is worse than an
 * unlinked number.
 */
export function linkifyCitations(answer, sources, { heading = 'Sources' } = {}) {
  const text = String(answer ?? '');
  const byRank = new Map((sources || []).filter((s) => s?.url).map((s) => [Number(s.rank), s]));
  if (!text.trim() || !byRank.size) return text;

  const cited = new Set();
  // Skip fenced code: a `[1]` inside a code block is code, not a citation.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const linked = parts.map((part, i) => {
    if (i % 2 === 1) return part;                       // the captured code spans
    return part.replace(BARE_RE, (whole, group) => {
      const ranks = group.split(',').map((n) => Number(n.trim()));
      if (!ranks.every((n) => byRank.has(n))) return whole;   // unknown number → leave alone
      ranks.forEach((n) => cited.add(n));
      return ranks.map((n) => `([${n}](${byRank.get(n).url}))`).join(' ');
    });
  }).join('');

  if (!cited.size) return linked;

  // A Sources section the model already wrote is left alone — appending a second one is a
  // worse outcome than a slightly differently-formatted first.
  // Match the heading however it was written — `## Sources`, `**Sources**`, or bare. The
  // first version only matched the bare form, so a model that bolded it got a second one.
  if (new RegExp(`(^|\\n)\\s*(?:#{1,6}\\s*|\\*\\*)?${heading}\\b`, 'i').test(linked)) return linked;

  const list = [...cited].sort((a, b) => a - b)
    .map((n) => { const s = byRank.get(n); return `${n}. [${s.title || s.url}](${s.url})`; })
    .join('\n');
  return `${linked.trimEnd()}\n\n**${heading}**\n${list}\n`;
}
