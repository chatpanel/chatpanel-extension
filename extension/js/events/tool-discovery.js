// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-discovery.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// `find` — the way back to a tool the menu left out.
//
// Narrowing keeps a turn's tool list short by ranking the connected tools against the
// message and showing the top few. It keeps the EXECUTE map whole on purpose — a tool the
// model knows the name of still runs — but nothing told the model the names it was not
// shown. So a tool that ranked low was, for that turn, gone: the model could not ask for
// it because it did not know to.
//
// This is the missing half. A `find` action searches the FULL set — every tool the group
// owns, narrowed or not — and answers with names and one-liners, cheap enough to sit on
// every dispatcher and cheap enough to call on a hunch. The model discovers, then calls;
// the menu stays short; the capability decision the cap used to make silently is now a
// call away. `describe` already gives the full schema for one action, so the two together
// are the pay-as-you-go ladder: names → one line → full schema, each on demand.
//
// Ranking is injected. The lexical, IDF-weighted ranker the extension and gateway share
// lives in @chatpanel/pii; this package must stay dependency-free, so it takes `rank` and
// falls back to a plain token overlap when a host has none.

export const FIND_ACTION = 'find';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'use', 'can', 'you', 'your', 'from', 'what', 'how', 'are', 'get', 'find', 'tool', 'tools']);

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Token overlap — a fallback, not a ranker anyone should prefer. */
export function overlapRank(specs, query) {
  const q = new Set(tokens(query));
  if (!q.size) return [...specs];
  return specs
    .map((s, i) => {
      const hay = `${s.name} ${s.description || ''}`.toLowerCase();
      let n = 0;
      for (const w of q) if (hay.includes(w)) n += 1;
      return { s, i, n };
    })
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map((x) => x.s);
}

/** First sentence, whitespace collapsed, capped — the "one line" of the ladder. */
export function oneLiner(description, max = 110) {
  const s = String(description || '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/[.!?]\s|\n/);
  const first = cut > 20 ? s.slice(0, cut + 1) : s;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

const requiredOf = (spec) => {
  const p = spec?.parameters || spec?.inputSchema;
  return Array.isArray(p?.required) ? p.required.map(String) : [];
};

/**
 * @param specs  the FULL set — not the narrowed menu
 * @param rank   `(specs, query) => specs` most-relevant first
 * @returns `[{ name, summary, required }]`
 */
export function findTools(specs, query, { limit = 8, rank = overlapRank } = {}) {
  const list = (specs || []).filter((s) => s && s.name);
  const q = String(query || '').trim();
  const ranked = q ? rank(list, q) : list;
  const cap = Math.max(1, Math.min(50, Number(limit) || 8));
  return ranked.slice(0, cap).map((s) => ({ name: s.name, summary: oneLiner(s.description), required: requiredOf(s) }));
}

/** The JSON text a `find` action returns, with the next step spelled out. */
export function findToolsResult(specs, query, { limit, rank, describeAction = 'describe', menu = [] } = {}) {
  const found = findTools(specs, query, { limit, rank });
  const total = (specs || []).length;
  const hidden = new Set(menu.map((m) => (typeof m === 'string' ? m : m?.name)));
  return JSON.stringify({
    query: String(query || ''),
    matches: found.map((f) => ({ ...f, listed: hidden.size ? hidden.has(f.name) : undefined })),
    total,
    hint: found.length
      ? `Call one as {"action":"<name>","args":{…}}. Unsure of its arguments? {"action":"${describeAction}","args":{"tool":"<name>"}}.`
      : `No tool matched "${query}" among ${total}. Try other words, or describe the task differently.`,
  });
}

/** The parameter schema fragment a dispatcher advertises for `find`. */
export function findActionArgs() {
  return {
    query: { type: 'string', description: `With action="${FIND_ACTION}": words describing the task; returns matching tool names.` },
  };
}
