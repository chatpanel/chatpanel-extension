// Deterministic tool selection — rank tool specs by lexical relevance to a query and
// narrow a toolset to a manageable subset, so a single turn doesn't flood the model
// with dozens of MCP tools (which bloats the prompt and slows / confuses the model).
//
// No model call: pure keyword overlap on each tool's name + description, plus a boost
// when a tool's name is mentioned in the prompt ("use the wiki search tool"). This is
// the latency-sensitive path — it runs on every turn, so it must stay cheap.

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'use', 'can', 'you', 'your', 'please',
  'about', 'from', 'what', 'who', 'how', 'are', 'was', 'will', 'just', 'tell', 'find',
  'get', 'into', 'them', 'they', 'their', 'name', 'one', 'and', 'but', 'not', 'all',
]);

// Rank tool specs most-relevant first (stable for ties — preserves original order).
export function rankToolSpecs(specs, query) {
  const q = String(query || '').toLowerCase();
  const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
  const score = (s) => {
    const hay = `${(s && s.name) || ''} ${(s && s.description) || ''}`.toLowerCase();
    let n = 0;
    for (const w of words) if (hay.includes(w)) n += 1;
    for (const part of String((s && s.name) || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (part.length > 2 && q.includes(part)) n += 2; // tool name explicitly named
    }
    return n;
  };
  return [...(specs || [])]
    .map((s, i) => ({ s, i, n: score(s) }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map((x) => x.s);
}

// Keep LOCAL tools (page / history — not remote MCP) always; only mcp_* get narrowed.
export const isLocalToolSpec = (s) => !String((s && s.name) || '').startsWith('mcp_');

// Narrow toolset.specs to at most `cap`, always keeping specs matched by `keep`.
// Returns the toolset unchanged when there's no cap (0/falsy) or it's already small.
// The `execute`/route map is preserved — only the specs ADVERTISED to the model are
// trimmed, so this can't break a tool the model legitimately knows about.
export function narrowToolset(toolset, query, { cap = 0, keep } = {}) {
  const specs = toolset && toolset.specs;
  if (!specs || !cap || cap < 1 || specs.length <= cap) return toolset;
  const keptSet = new Set(keep ? specs.filter(keep) : []);
  const rest = specs.filter((s) => !keptSet.has(s));
  const room = Math.max(0, cap - keptSet.size);
  const top = new Set(rankToolSpecs(rest, query).slice(0, room));
  const chosen = specs.filter((s) => keptSet.has(s) || top.has(s)); // preserve order
  return { ...toolset, specs: chosen };
}
