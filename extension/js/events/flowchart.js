// GENERATED — do not edit.
// Source of truth: chatpanel-events/flowchart.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// flowchart.js — Mermaid `flowchart` text → a self-contained SVG string.
//
// Why this exists: models answer "draw me a diagram" with a ```mermaid block, and showing
// the source instead of the picture is a dead end for the reader. Mermaid itself is a ~3 MB
// dependency that needs a live DOM to measure text, which rules it out for a side panel that
// treats first-paint weight as a release gate — and for a renderer we want to unit-test.
//
// So this is a focused renderer for the shape models actually emit: `flowchart TB/LR` with
// labelled nodes, edges, subgraphs and classDef styling. It is PURE (string in, string out),
// so it is testable without a browser and runs identically in the extension, a desktop app or
// a mobile client — which is why it lives in the shared package rather than in one client.
//
// SAFETY: the output is only ever shown through an <img src="data:image/svg+xml,…">, which
// loads SVG in restricted mode (no scripts, no external fetches). Every piece of model text
// is XML-escaped here as well, so a label can't break out of its element either way.
//
// Anything it can't parse returns null, and the caller keeps showing the code block.

// Node shapes, LONGEST OPENER FIRST — `[(` has to be tried before `[`, or a database node
// keeps its own bracket in the label and renders as `"etcd…")`. The value is the closer and
// the shape name; shape drives the corner radius, not a different silhouette (a hexagon that
// is really a rounded rect still reads correctly; a label with a stray `)` does not).
const NODE_SHAPES = [
  ['[[', ']]', 'rect'],     // subroutine
  ['[(', ')]', 'round'],    // database / cylinder
  ['((', '))', 'pill'],     // circle
  ['([', '])', 'pill'],     // stadium
  ['{{', '}}', 'rect'],     // hexagon
  ['[/', '/]', 'rect'],     // parallelogram
  ['[\\', '\\]', 'rect'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'rect'],       // diamond → a rounded rect with a tint; shape fidelity isn't the point
  ['>', ']', 'rect'],       // asymmetric
];

const DEFAULT_PALETTE = {
  fill: '#f8fafc', stroke: '#cbd5e1', color: '#1e293b',
};
// Ranks get progressively lighter accents when the diagram declares no classes of its own,
// so an unstyled chart still reads as designed rather than as a grey wireframe.
const RANK_TINTS = [
  { fill: '#1e293b', stroke: '#1e293b', color: '#ffffff' },
  { fill: '#e0e7ff', stroke: '#a5b4fc', color: '#312e81' },
  { fill: '#f1f5f9', stroke: '#cbd5e1', color: '#0f172a' },
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Labels carry inline HTML — models write `Name<br/><i>what it does</i>` constantly, and a
// renderer that only knows <br/> prints the tags themselves, which a reader reads as a bug.
// A whole line wrapped in one emphasis tag becomes a styled line; a formatting tag anywhere
// else is dropped, because half-styled runs would need per-run text layout for very little.
//
// ONLY the formatting tags below are dropped. Anything else a label contains is left exactly
// as the model wrote it and escaped at render time, so `<script>` still shows up as the text
// `<script>` rather than quietly vanishing — a renderer that eats unknown markup hides content
// as readily as it hides an attack.
const FORMAT_TAGS = /<\/?(?:i|em|b|strong|u|code|span|small|sup|sub)\s*\/?>/gi;
const EMPH = [
  [/^<(i|em)>([\s\S]*)<\/\1>$/i, 'italic'],
  [/^<(b|strong)>([\s\S]*)<\/\1>$/i, 'bold'],
];
function styleOfPart(raw) {
  let text = String(raw || '').trim();
  let italic = false;
  let bold = false;
  // Peel repeatedly so `<b><i>x</i></b>` picks up both.
  for (let n = 0; n < 3; n++) {
    let hit = false;
    for (const [re, kind] of EMPH) {
      const m = re.exec(text);
      if (!m) continue;
      text = m[2].trim();
      if (kind === 'italic') italic = true; else bold = true;
      hit = true;
    }
    if (!hit) break;
  }
  return { text: text.replace(FORMAT_TAGS, ' ').trim(), italic, bold };
}

// Split a label into display lines: explicit <br/> first, then greedy wrap on words. Each line
// carries its own emphasis so the renderer can set font-style/weight per <text> element.
export function wrapLabel(raw, maxChars = 22) {
  const parts = String(raw || '').split(/<br\s*\/?>/i);
  const lines = [];
  for (const part of parts) {
    const { text, italic, bold } = styleOfPart(part);
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = '';
    for (const w of words) {
      if (!line) line = w;
      else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
      else { lines.push({ text: line, italic, bold }); line = w; }
    }
    if (line) lines.push({ text: line, italic, bold });
  }
  return lines.length ? lines : [{ text: '', italic: false, bold: false }];
}

// Strip mermaid's quoting around a label.
function cleanLabel(s) {
  let t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t.trim();
}

// ONE connector, matched at the current scan position:
//   an optional opening head `<`, a run of -/=/. , an optional mid-label (`A -- yes --> B`),
//   and an optional closing head `>` / `o` / `x`.
// The head characters are excluded from the body and from the mid-label, so `-->` can never be
// read as a body and `A --> B` can never swallow `B` as a label.
const CONNECTOR = /^(<?)([-=.]{2,})(?:[ \t]*([^-=<>|\n]{1,80}?)[ \t]*([-=.]{2,}))?([>ox]?)/;

/**
 * Split one line into node tokens + the edge labels between them, honouring brackets and
 * quotes so an arrow inside a label can't be read as a connector. Returns null when the line
 * holds no top-level edge operator. Handles chains (`A --> B -->|yes| C`), bidirectional
 * links (`A <--> B`) and mid-line labels (`A -- yes --> B`).
 */
export function splitEdgeChain(line) {
  const s = String(line || '');
  const parts = [];
  const labels = [];
  const bidir = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === ')' || ch === '}') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0 && (ch === '-' || ch === '=' || ch === '<')) {
      const m = CONNECTOR.exec(s.slice(i));
      // A `<` only opens a connector when a real arrow body follows it.
      if (m && (ch !== '<' || m[1])) {
        i += m[0].length - 1;
        let label = (m[3] || '').trim();
        // An explicit |label| directly after the arrow wins over a mid-line one.
        const rest = s.slice(i + 1);
        const lm = rest.match(/^\s*\|([^|]*)\|/);
        if (lm) { label = lm[1]; i += lm[0].length; }
        parts.push(buf); labels.push(label); bidir.push(m[1] === '<'); buf = '';
        continue;
      }
    }
    buf += ch;
  }
  parts.push(buf);
  if (parts.length < 2) return null;
  return { parts: parts.map((p) => p.trim().replace(/;$/, '')).filter(Boolean), labels, bidir };
}

/**
 * Parse a mermaid flowchart into { dir, nodes, edges, classDefs, nodeClass, groups }.
 * Returns null when the text isn't a flowchart we handle.
 */
export function parseFlowchart(text) {
  const src = String(text || '');
  const header = src.match(/^\s*(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/im);
  if (!header) return null;
  const dir = header[1].toUpperCase();

  const nodes = new Map(); // id -> { id, label, shape }
  const edges = [];        // { from, to, label, both }
  const classDefs = new Map();
  const nodeClass = new Map();
  const groups = [];       // [{ id, title, members: [] }] — subgraphs, in source order
  const stack = [];        // open subgraphs; the innermost one owns a node
  const memberOf = new Map();

  const claim = (id) => {
    const g = stack[stack.length - 1];
    if (!g || memberOf.has(id)) return;
    memberOf.set(id, g);
    g.members.push(id);
  };
  const ensure = (id, label, shape) => {
    const key = String(id).trim();
    if (!key) return null;
    if (!nodes.has(key)) nodes.set(key, { id: key, label: label != null ? label : key, shape: shape || 'rect' });
    else {
      const n = nodes.get(key);
      if (label != null) n.label = label;
      if (shape) n.shape = shape;
    }
    claim(key);
    return nodes.get(key);
  };

  // `ID["label"]` / `ID(label)` / `ID[("label")]` / `ID{label}` → id + label + shape, else a
  // bare id. The label runs to the LAST closer, so brackets inside a label survive.
  function readNodeToken(token) {
    const t = token.trim();
    if (!t) return null;
    const m = t.match(/^([A-Za-z0-9_.-]+)\s*([[({>])([\s\S]*)$/);
    if (!m) return ensure(t.replace(/^[[(]|[\])]$/g, ''), null);
    const id = m[1];
    const after = t.slice(id.length).trim();
    for (const [open, close, shape] of NODE_SHAPES) {
      if (!after.startsWith(open)) continue;
      const rest = after.slice(open.length);
      const end = rest.lastIndexOf(close);
      return ensure(id, cleanLabel(end >= 0 ? rest.slice(0, end) : rest), shape);
    }
    return ensure(id, null);
  }

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || /^%%/.test(line)) continue;                 // comment
    if (/^(?:flowchart|graph)\b/i.test(line)) continue;      // header
    if (/^direction\b/i.test(line)) continue;                // per-subgraph direction: not modelled

    // subgraph CP["Control Plane"] / subgraph CP [Control Plane] / subgraph Control Plane
    const sg = line.match(/^subgraph\b\s*(.*)$/i);
    if (sg) {
      const rest = sg[1].trim();
      const withLabel = rest.match(/^([A-Za-z0-9_.-]+)\s*([[("])([\s\S]*)$/);
      let id = rest || `sub${groups.length + 1}`;
      let title = rest;
      if (withLabel) {
        id = withLabel[1];
        const open = withLabel[2];
        const close = open === '[' ? ']' : open === '(' ? ')' : '"';
        const body = withLabel[3];
        const end = body.lastIndexOf(close);
        title = cleanLabel(end >= 0 ? body.slice(0, end) : body);
      }
      const g = { id, title: cleanLabel(title), members: [] };
      groups.push(g);
      stack.push(g);
      continue;
    }
    if (/^end\b/i.test(line)) { stack.pop(); continue; }

    // classDef name fill:#fff,color:#000,stroke:#ccc
    const cd = line.match(/^classDef\s+([A-Za-z0-9_-]+)\s+(.+?);?$/i);
    if (cd) {
      const style = {};
      for (const pair of cd[2].split(',')) {
        const [k, v] = pair.split(':').map((x) => (x || '').trim());
        if (k && v) style[k.toLowerCase()] = v;
      }
      classDefs.set(cd[1], style);
      continue;
    }
    // class A,B,C name
    const cl = line.match(/^class\s+([A-Za-z0-9_,.\s-]+?)\s+([A-Za-z0-9_-]+)\s*;?$/i);
    if (cl) {
      for (const id of cl[1].split(',').map((x) => x.trim()).filter(Boolean)) nodeClass.set(id, cl[2]);
      continue;
    }
    if (/^(?:style|linkStyle|click)\b/i.test(line)) continue; // not modelled

    // Edges, including CHAINS: `A --> B --> C` is two edges, and mermaid emits them often.
    // Split on edge operators that are at bracket/quote depth 0, so an arrow inside a label
    // ("a --> b") is never mistaken for a connector.
    const seg = splitEdgeChain(line);
    if (seg && seg.parts.length > 1) {
      let prev = readNodeToken(seg.parts[0]);
      for (let k = 1; k < seg.parts.length; k++) {
        const next = readNodeToken(seg.parts[k]);
        if (prev && next) {
          edges.push({
            from: prev.id, to: next.id,
            label: cleanLabel(seg.labels[k - 1] || ''),
            both: !!seg.bidir[k - 1],
          });
        }
        prev = next;
      }
      continue;
    }
    // A standalone node definition, or a bare id inside a subgraph — which is how mermaid
    // says "this existing node belongs to this group".
    if (/^[A-Za-z0-9_.-]+\s*[[({>]/.test(line)) { readNodeToken(line); continue; }
    if (stack.length && /^[A-Za-z0-9_.-]+;?$/.test(line)) { ensure(line.replace(/;$/, ''), null); continue; }
  }

  if (!nodes.size) return null;
  return { dir, nodes, edges, classDefs, nodeClass, groups: groups.filter((g) => g.members.length) };
}

// Longest-path ranking over a SUBSET of the graph: a node sits one level below its deepest
// parent. Cycles are broken by the visited guard, so a malformed graph still lays out instead
// of hanging. Taking ids rather than the whole node map is what lets one subgraph be laid out
// on its own, by the same code that lays out the chart as a whole.
function rankNodes(ids, edges) {
  const set = new Set(ids);
  const parents = new Map();
  const children = new Map();
  for (const id of set) { parents.set(id, []); children.set(id, []); }
  for (const e of edges) {
    if (!set.has(e.from) || !set.has(e.to)) continue;
    parents.get(e.to).push(e.from);
    children.get(e.from).push(e.to);
  }
  const rank = new Map();
  const roots = [...set].filter((id) => parents.get(id).length === 0);
  const queue = roots.length ? [...roots] : [set.values().next().value];
  for (const r of queue) rank.set(r, 0);
  let guard = set.size * 4;
  while (queue.length && guard-- > 0) {
    const id = queue.shift();
    const r = rank.get(id) || 0;
    for (const c of children.get(id) || []) {
      const want = r + 1;
      if ((rank.get(c) ?? -1) < want) { rank.set(c, want); queue.push(c); }
    }
  }
  for (const id of set) if (!rank.has(id)) rank.set(id, 0);
  return { rank, parents, children };
}

const CHAR_W = 7.1;   // ~13px system-ui average advance; good enough for box sizing
const LINE_H = 18;
const PAD_X = 14;
const PAD_Y = 12;
const GROUP_PAD = 16;     // breathing room between a subgraph's frame and its nodes
const GROUP_TITLE_H = 28; // the band the subgraph's own name sits in

function measure(labelLines) {
  const w = Math.max(...labelLines.map((l) => l.text.length * (l.bold ? 1.07 : 1))) * CHAR_W + PAD_X * 2;
  const h = labelLines.length * LINE_H + PAD_Y * 2;
  return { w: Math.max(72, Math.round(w)), h: Math.round(h) };
}

/**
 * Place a set of ids on a grid: rank → row (TB) or column (LR). PURE geometry over sizes, so
 * it serves both levels of a clustered chart — the nodes inside one subgraph, and the
 * subgraphs themselves as blocks.
 */
function placeGrid(ids, edges, sizeOf, { horizontal, gapMain = 56, gapCross = 22 } = {}) {
  const { rank, parents } = rankNodes(ids, edges);
  const byRank = new Map();
  for (const id of ids) {
    const r = rank.get(id) || 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(id);
  }
  // Order each rank by the average position of its parents (one barycenter sweep) so edges
  // cross as little as possible without a full layout engine.
  const order = new Map();
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    const list = byRank.get(r);
    if (r === ranks[0]) { list.forEach((id, i) => order.set(id, i)); continue; }
    list.sort((a, b) => {
      const pa = parents.get(a).map((p) => order.get(p) ?? 0);
      const pb = parents.get(b).map((p) => order.get(p) ?? 0);
      const ma = pa.length ? pa.reduce((x, y) => x + y, 0) / pa.length : 0;
      const mb = pb.length ? pb.reduce((x, y) => x + y, 0) / pb.length : 0;
      return ma - mb;
    });
    list.forEach((id, i) => order.set(id, i));
  }

  // Cross-axis extent of each rank, then centre every rank in the widest one.
  const rankExtent = new Map();
  for (const r of ranks) {
    const list = byRank.get(r);
    const total = list.reduce((sum, id) => sum + (horizontal ? sizeOf(id).h : sizeOf(id).w), 0)
      + gapCross * Math.max(0, list.length - 1);
    rankExtent.set(r, total);
  }
  const maxExtent = Math.max(...rankExtent.values(), 1);

  // Main-axis offset per rank = the tallest/widest box in each preceding rank.
  const mainOffset = new Map();
  let main = 0;
  for (const r of ranks) {
    mainOffset.set(r, main);
    const size = Math.max(...byRank.get(r).map((id) => (horizontal ? sizeOf(id).w : sizeOf(id).h)));
    main += size + gapMain;
  }
  const mainTotal = Math.max(0, main - gapMain);

  const pos = new Map();
  for (const r of ranks) {
    let cross = (maxExtent - rankExtent.get(r)) / 2;
    for (const id of byRank.get(r)) {
      const s = sizeOf(id);
      if (horizontal) { pos.set(id, { x: mainOffset.get(r), y: cross }); cross += s.h + gapCross; }
      else { pos.set(id, { x: cross, y: mainOffset.get(r) }); cross += s.w + gapCross; }
    }
  }
  return {
    pos,
    rank,
    width: horizontal ? mainTotal : maxExtent,
    height: horizontal ? maxExtent : mainTotal,
  };
}

function boxesFor(graph, ids) {
  const boxes = new Map();
  for (const id of ids) {
    const n = graph.nodes.get(id);
    const lines = wrapLabel(n.label);
    const { w, h } = measure(lines);
    boxes.set(id, { id, lines, w, h, shape: n.shape || 'rect', rank: 0 });
  }
  return boxes;
}

/** One grid, no clusters: rank → row (TB) or column (LR). Pure geometry. */
function layoutFlat(graph, { dir = graph.dir, gapMain = 56, gapCross = 22 } = {}) {
  const horizontal = dir === 'LR' || dir === 'RL';
  const ids = [...graph.nodes.keys()];
  const boxes = boxesFor(graph, ids);
  const placed = placeGrid(ids, graph.edges, (id) => boxes.get(id), { horizontal, gapMain, gapCross });
  for (const [id, b] of boxes) {
    const p = placed.pos.get(id);
    b.x = p.x; b.y = p.y; b.rank = placed.rank.get(id) || 0;
  }
  return {
    boxes, edges: graph.edges, dir, horizontal, clusters: [],
    width: placed.width, height: placed.height,
  };
}

/**
 * Lay a chart out CLUSTER-FIRST: every subgraph is laid out on its own, then placed as a
 * single block in the chart around it.
 *
 * Flattening subgraphs (what this used to do) does not just lose the frame, it loses the
 * meaning. A "control plane / worker node" diagram flattened is nine boxes whose grouping was
 * the entire point — and a member with no edges of its own, like a kube-proxy, drifts up to
 * rank 0 among strangers. Two levels of the SAME grid fix both: members only rank against
 * each other, so a group holds together, and groups rank against each other by the edges that
 * cross between them. A chart with no subgraphs never reaches this function.
 */
function layoutClustered(graph, { dir = graph.dir, gapMain = 56, gapCross = 22 } = {}) {
  const horizontal = dir === 'LR' || dir === 'RL';
  const boxes = boxesFor(graph, [...graph.nodes.keys()]);

  // Every node belongs to exactly one cluster: its subgraph, or a cluster of its own.
  const clusterOf = new Map();
  const clusters = new Map();
  graph.groups.forEach((g, i) => {
    const key = `g${i}`;
    clusters.set(key, { key, title: g.title || g.id, group: true, ids: [] });
    for (const m of g.members) if (graph.nodes.has(m) && !clusterOf.has(m)) clusterOf.set(m, key);
  });
  for (const id of graph.nodes.keys()) {
    const key = clusterOf.get(id) || `n:${id}`;
    if (!clusters.has(key)) clusters.set(key, { key, title: '', group: false, ids: [] });
    clusterOf.set(id, key);
    clusters.get(key).ids.push(id);
  }

  // Inner layout, one cluster at a time, using only the edges that stay inside it.
  for (const c of clusters.values()) {
    const inner = placeGrid(c.ids, graph.edges, (id) => boxes.get(id), { horizontal, gapMain, gapCross });
    c.inner = inner;
    c.padL = c.group ? GROUP_PAD : 0;
    c.padT = c.group ? GROUP_TITLE_H : 0;
    c.w = inner.width + c.padL * 2;
    c.h = inner.height + c.padT + (c.group ? GROUP_PAD : 0);
  }

  // Cluster-level edges: one per crossing PAIR, so the ranking sees structure, not volume.
  const seen = new Set();
  const clusterEdges = [];
  for (const e of graph.edges) {
    const a = clusterOf.get(e.from);
    const b = clusterOf.get(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clusterEdges.push({ from: a, to: b });
  }

  const keys = [...clusters.keys()];
  const outer = placeGrid(keys, clusterEdges, (k) => clusters.get(k), {
    horizontal, gapMain: gapMain + 14, gapCross: gapCross + 16,
  });
  for (const k of keys) {
    const c = clusters.get(k);
    const p = outer.pos.get(k);
    c.x = p.x; c.y = p.y;
    const clusterRank = outer.rank.get(k) || 0;
    for (const id of c.ids) {
      const b = boxes.get(id);
      const ip = c.inner.pos.get(id);
      b.x = c.x + c.padL + ip.x;
      b.y = c.y + c.padT + ip.y;
      b.rank = clusterRank + (c.inner.rank.get(id) || 0);
    }
  }

  return {
    boxes, edges: graph.edges, dir, horizontal,
    clusters: [...clusters.values()].filter((c) => c.group),
    width: outer.width, height: outer.height,
  };
}

/**
 * Lay a parsed chart out. A chart with subgraphs is laid out cluster-first; one without takes
 * the single grid, byte for byte as before. Callers never choose — the chart does.
 */
export function layoutFlowchart(graph, opts = {}) {
  return graph.groups?.length ? layoutClustered(graph, opts) : layoutFlat(graph, opts);
}

function styleFor(id, graph, rankIdx) {
  const cls = graph.nodeClass.get(id);
  const def = cls ? graph.classDefs.get(cls) : null;
  if (def) {
    return {
      fill: def.fill || DEFAULT_PALETTE.fill,
      stroke: def.stroke || def['stroke-width'] ? (def.stroke || DEFAULT_PALETTE.stroke) : DEFAULT_PALETTE.stroke,
      color: def.color || DEFAULT_PALETTE.color,
    };
  }
  if (graph.classDefs.size) return DEFAULT_PALETTE; // the author styled some nodes; stay neutral
  return RANK_TINTS[Math.min(rankIdx, RANK_TINTS.length - 1)];
}

function radiusFor(b) {
  if (b.shape === 'pill') return Math.round(Math.min(b.h, b.w) / 2);
  if (b.shape === 'round') return 16;
  return 9;
}

/**
 * Mermaid flowchart text → a complete SVG document string, or null if it isn't a flowchart
 * this renderer handles (the caller then keeps the code block).
 */
export function renderFlowchartSvg(text, { padding = 18, maxWidth = 1400, autoFlip = true } = {}) {
  const graph = parseFlowchart(text);
  if (!graph) return null;
  const lay = (opts) => layoutFlowchart(graph, opts);
  let L = lay({});
  if (!L.boxes.size) return null;

  // A broad tree laid out top-down (one root, six categories, ~28 leaves) becomes a 3000px
  // strip that is unreadable in a side panel. When a chart comes out far wider than it is
  // tall, lay it out left-to-right instead: the same graph, but the wide rank stacks
  // vertically and every label stays legible at fit-width. Purely a presentation choice —
  // the Code view always shows what the model actually wrote.
  if (autoFlip) {
    const aspect = L.width / Math.max(1, L.height);
    if (aspect > 2.2 && !L.horizontal) L = lay({ dir: 'LR' });
    else if (aspect < 0.25 && L.horizontal) L = lay({ dir: 'TB' });
  }

  const W = Math.min(maxWidth, Math.ceil(L.width + padding * 2));
  const H = Math.ceil(L.height + padding * 2);
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(L.width + padding * 2)} ${H}" width="${W}" height="${H}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">`,
  );
  out.push(
    '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
    + '<path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs>',
  );
  out.push(`<rect width="100%" height="100%" fill="#ffffff" rx="10"/>`);

  const px = (v) => Math.round(v * 10) / 10;

  // Subgraph frames first — they sit UNDER everything, as the surface a group is drawn on.
  for (const c of L.clusters) {
    out.push(
      `<rect x="${px(c.x + padding)}" y="${px(c.y + padding)}" width="${px(c.w)}" height="${px(c.h)}" rx="14" `
      + `fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="5 4"/>`,
    );
    if (c.title) {
      out.push(
        `<text x="${px(c.x + padding + 14)}" y="${px(c.y + padding + 19)}" font-size="12" font-weight="700" `
        + `fill="#475569">${esc(c.title.slice(0, 48))}</text>`,
      );
    }
  }

  // Edges next, so boxes paint over the joins.
  for (const e of L.edges) {
    const a = L.boxes.get(e.from);
    const b = L.boxes.get(e.to);
    if (!a || !b) continue;
    let x1, y1, x2, y2, d;
    if (L.horizontal) {
      // Leave from whichever face actually points at the target: with subgraphs an edge can
      // run backwards, and a curve out of the wrong face reads as a different connection.
      const back = b.x + b.w < a.x;
      x1 = back ? a.x + padding : a.x + a.w + padding;
      y1 = a.y + a.h / 2 + padding;
      x2 = back ? b.x + b.w + padding : b.x + padding;
      y2 = b.y + b.h / 2 + padding;
      const mx = (x1 + x2) / 2;
      d = `M${px(x1)},${px(y1)} C${px(mx)},${px(y1)} ${px(mx)},${px(y2)} ${px(x2)},${px(y2)}`;
    } else {
      const back = b.y + b.h < a.y;
      x1 = a.x + a.w / 2 + padding;
      y1 = back ? a.y + padding : a.y + a.h + padding;
      x2 = b.x + b.w / 2 + padding;
      y2 = back ? b.y + b.h + padding : b.y + padding;
      const my = (y1 + y2) / 2;
      d = `M${px(x1)},${px(y1)} C${px(x1)},${px(my)} ${px(x2)},${px(my)} ${px(x2)},${px(y2)}`;
    }
    // A bidirectional link (`A <--> B`) gets a head at BOTH ends — the marker is declared
    // orient="auto-start-reverse", so the same one points the right way at the start.
    const startHead = e.both ? ' marker-start="url(#a)"' : '';
    out.push(`<path d="${d}" fill="none" stroke="#94a3b8" stroke-width="1.5"${startHead} marker-end="url(#a)"/>`);
    if (e.label) {
      const lx = (x1 + x2) / 2;
      const ly = (y1 + y2) / 2;
      out.push(
        `<rect x="${px(lx - e.label.length * 3.4 - 5)}" y="${px(ly - 9)}" width="${px(e.label.length * 6.8 + 10)}" height="18" rx="5" fill="#ffffff" stroke="#e2e8f0"/>`
        + `<text x="${px(lx)}" y="${px(ly + 4)}" font-size="11" fill="#475569" text-anchor="middle">${esc(e.label)}</text>`,
      );
    }
  }

  for (const [id, b] of L.boxes) {
    const s = styleFor(id, graph, b.rank);
    out.push(
      `<rect x="${px(b.x + padding)}" y="${px(b.y + padding)}" width="${px(b.w)}" height="${px(b.h)}" rx="${radiusFor(b)}" `
      + `fill="${esc(s.fill)}" stroke="${esc(s.stroke)}" stroke-width="1.5"/>`,
    );
    const startY = b.y + padding + PAD_Y + LINE_H - 5;
    b.lines.forEach((line, i) => {
      const style = (line.italic ? ' font-style="italic"' : '') + (line.bold ? ' font-weight="700"' : '');
      out.push(
        `<text x="${px(b.x + b.w / 2 + padding)}" y="${px(startY + i * LINE_H)}" font-size="13" `
        + `fill="${esc(s.color)}" text-anchor="middle"${style}>${esc(line.text)}</text>`,
      );
    });
  }

  out.push('</svg>');
  return out.join('');
}
