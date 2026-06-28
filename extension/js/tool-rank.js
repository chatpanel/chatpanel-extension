// Deterministic, model-free tool ranking — shared by the extension's side panel
// and the gateway, so "auto mode" narrows the same way everywhere (single source
// of truth, per the no-duplication rule).
//
// Ranks tool specs by lexical relevance to a query, weighting each query word by
// INVERSE DOCUMENT FREQUENCY across the toolset: a distinctive word like "wiki"
// (in 1–2 tools) counts far more than a common one like "search" (in many) — so
// "use wiki search" ranks the Wikipedia tool above generic search tools instead
// of tying them. Latency-sensitive: pure string ops, runs on every turn, no model
// call. Generic over the spec shape via name/description accessors (the extension
// uses { name, description }; the gateway uses OpenAI's { function: { name, … } }).

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'use', 'can', 'you', 'your', 'please',
  'about', 'from', 'what', 'who', 'how', 'are', 'was', 'will', 'just', 'tell', 'find',
  'get', 'into', 'them', 'they', 'their', 'name', 'one', 'but', 'not', 'all',
]);

const defName = (s) => (s && s.name) || '';
const defDesc = (s) => (s && s.description) || '';

// Returns specs scored + sorted most-relevant first, as [{ s, i, n }] (i = original
// index, n = score). Stable for ties (preserves original order).
export function scoreToolSpecs(specs, query, { name = defName, description = defDesc } = {}) {
  const q = String(query || '').toLowerCase();
  const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
  const list = [...(specs || [])];
  const names = list.map((s) => String(name(s) || '').toLowerCase());
  const hays = list.map((s, i) => `${names[i]} ${String(description(s) || '').toLowerCase()}`);
  const N = list.length || 1;
  const df = {}; // how many tools mention each query word
  for (const w of words) df[w] = hays.reduce((n, h) => n + (h.includes(w) ? 1 : 0), 0);
  const idf = (w) => Math.log(1 + N / (1 + (df[w] || 0))); // rarer → higher weight
  const score = (i) => {
    let n = 0;
    for (const w of words) if (hays[i].includes(w)) n += idf(w);
    for (const part of names[i].split(/[^a-z0-9]+/)) {
      if (part.length > 2 && q.includes(part)) n += 2 + idf(part); // tool explicitly named
    }
    return n;
  };
  return list.map((s, i) => ({ s, i, n: score(i) })).sort((a, b) => (b.n - a.n) || (a.i - b.i));
}

// Rank tool specs most-relevant first (stable for ties).
export function rankToolSpecs(specs, query, accessors) {
  return scoreToolSpecs(specs, query, accessors).map((x) => x.s);
}

// Narrow a flat spec list to at most `cap` entries that DON'T match `keep`, always
// retaining everything that does (e.g. local page/history tools). `cap` therefore
// bounds the NARROWABLE (MCP) tools; kept tools ride along free. Returns the list
// unchanged when there's no cap or the narrowable set already fits.
export function narrowSpecs(specs, query, { cap = 0, keep, name = defName, description = defDesc } = {}) {
  const list = specs || [];
  if (!cap || cap < 1) return list;
  const kept = keep ? list.filter(keep) : [];
  const rest = keep ? list.filter((s) => !kept.includes(s)) : list;
  if (rest.length <= cap) return list;
  const top = new Set(rankToolSpecs(rest, query, { name, description }).slice(0, cap));
  return list.filter((s) => kept.includes(s) || top.has(s)); // preserve original order
}
