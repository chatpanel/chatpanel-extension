// GENERATED — do not edit.
// Source of truth: chatpanel-events/note-graph.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The shape of a corpus: what links to what, and what it is all about.
//
// A note graph drawn from `[[wikilinks]]` alone is mostly dust — people link deliberately and
// rarely, so the picture is a handful of pairs and a hundred lonely dots, which tells you
// nothing you did not already know. The connective tissue is what notes are ABOUT: a topic
// shared by two or more notes becomes a node of its own, and the notes hang off it.
//
// That is the whole idea, and it is pure: an index of `{ id, title, topics, tags, links }` in,
// nodes and links out. No DOM, no layout, no physics — a client draws it with SVG, canvas, or
// a native view, and all of them get the same graph. The extension's `graph-view.js` keeps the
// drawing; this is the model underneath it.
//
// TOPICS ON A SINGLE NOTE ARE DROPPED. A topic that touches one note connects nothing, and
// drawing it adds a labelled node with exactly one edge — clutter that makes the real clusters
// harder to see. The threshold is the difference between a graph and a hairball.

/** How many nodes are worth drawing before a view should start trimming. */
export const MAX_GRAPH_NODES = 140;

const lc = (s) => String(s || '').trim().toLowerCase();

/**
 * Build the note graph.
 *
 * @param {Array} index  `{ id, title, topics?, tags?, links? }` — the lightweight list, not
 *                       the bodies. `links` are wikilink TITLES, resolved here against the
 *                       index's own titles, so a link to a page that does not exist yet draws
 *                       nothing rather than a dangling node.
 * @param {object} [opts]
 * @param {boolean} [opts.topics=true]   include topic hubs
 * @param {number}  [opts.minShared=2]   how many notes a topic needs before it earns a node
 * @returns {{nodes: Array, links: Array}}
 */
export function buildNoteGraph(index, { topics = true, minShared = 2 } = {}) {
  const list = Array.isArray(index) ? index.filter(Boolean) : [];
  const nodes = list.map((n) => ({ id: n.id, label: n.title || 'Untitled note', type: 'note' }));
  const links = [];
  const seen = new Set();
  const addEdge = (s, t, kind) => {
    if (!s || !t || s === t) return;
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ s, t, kind });
  };

  // Explicit wikilinks first — a deliberate connection outranks an inferred one, and adding
  // them first means the dedupe above can never drop one in favour of a topic edge.
  const byTitle = new Map(list.map((n) => [lc(n.title), n.id]));
  for (const n of list) {
    for (const name of n.links || []) {
      const target = byTitle.get(lc(name));
      if (target) addEdge(n.id, target, 'link');
    }
  }

  if (topics) {
    const hubs = new Map(); // lowercased topic → { label, ids[] }
    for (const n of list) {
      // Tags are the user's own topics and count the same: a corpus where somebody tags by
      // hand should not draw a sparser graph than one where a model extracted the topics.
      for (const raw of [...(n.topics || []), ...(n.tags || [])]) {
        const label = String(raw || '').trim();
        if (!label) continue;
        const key = lc(label);
        const e = hubs.get(key) || { label, ids: [] };
        if (!e.ids.includes(n.id)) e.ids.push(n.id);
        hubs.set(key, e);
      }
    }
    for (const [key, { label, ids }] of hubs) {
      if (ids.length < minShared) continue;
      const tid = `topic:${key}`;
      nodes.push({ id: tid, label, type: 'topic' });
      for (const id of ids) addEdge(id, tid, 'topic');
    }
  }

  return { nodes, links };
}

/**
 * The neighbourhood around one node — BFS out `hops`, keeping only links whose endpoints both
 * survive.
 *
 * A whole-corpus graph answers "what does my thinking look like"; this answers "what is near
 * THIS note", which is the question someone reading a note actually has. Topic hubs count as
 * a hop, so `hops: 2` reaches the sibling notes that share a topic with this one — which is
 * the entire point of having hubs at all.
 */
export function egoGraph(full, id, hops = 2) {
  const nodes = full?.nodes || [];
  const links = full?.links || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(id)) return { nodes: [], links: [] };
  const adj = new Map();
  for (const l of links) {
    if (!adj.has(l.s)) adj.set(l.s, new Set());
    if (!adj.has(l.t)) adj.set(l.t, new Set());
    adj.get(l.s).add(l.t);
    adj.get(l.t).add(l.s);
  }
  const inSet = new Set([id]);
  let frontier = new Set([id]);
  for (let h = 0; h < hops; h++) {
    const next = new Set();
    for (const cur of frontier) {
      for (const nb of adj.get(cur) || []) if (!inSet.has(nb)) { inSet.add(nb); next.add(nb); }
    }
    frontier = next;
  }
  return {
    nodes: [...inSet].map((nid) => {
      const m = byId.get(nid);
      return { id: nid, label: m?.label || 'Untitled note', type: m?.type || 'note', focus: nid === id };
    }),
    links: links.filter((l) => inSet.has(l.s) && inSet.has(l.t)),
  };
}

/**
 * Trim a graph to the most connected `max` nodes, keeping `keep` whatever its degree.
 *
 * A corpus of two thousand notes draws as a grey disc: every renderer slows to a crawl and
 * nothing is legible anyway. Degree is the right thing to cut on — a node nothing connects to
 * carries no information in a picture whose entire subject is connection — and the focused
 * node is exempt, because a view of "around this note" that dropped the note would be absurd.
 */
export function trimGraph(graph, max = MAX_GRAPH_NODES, keep = '') {
  const nodes = graph?.nodes || [];
  const links = graph?.links || [];
  if (nodes.length <= max) return { nodes, links };
  const degree = new Map();
  for (const l of links) {
    degree.set(l.s, (degree.get(l.s) || 0) + 1);
    degree.set(l.t, (degree.get(l.t) || 0) + 1);
  }
  const ranked = [...nodes].sort((a, b) => {
    if (a.id === keep) return -1;
    if (b.id === keep) return 1;
    return (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
  }).slice(0, max);
  const inSet = new Set(ranked.map((n) => n.id));
  return { nodes: ranked, links: links.filter((l) => inSet.has(l.s) && inSet.has(l.t)) };
}

/**
 * How many notes, links and topic hubs — the one-line summary a pane shows above the picture,
 * so a graph that looks empty says whether it IS empty or merely unconnected.
 */
export function graphStats(graph) {
  const nodes = graph?.nodes || [];
  return {
    notes: nodes.filter((n) => n.type !== 'topic').length,
    topics: nodes.filter((n) => n.type === 'topic').length,
    links: (graph?.links || []).length,
  };
}
