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
// labelled nodes, edges and classDef styling. It is PURE (string in, string out), so it is
// testable without a browser and runs identically in the extension, a desktop app or a
// mobile client — which is why it lives in the shared package rather than in one client.
//
// SAFETY: the output is only ever shown through an <img src="data:image/svg+xml,…">, which
// loads SVG in restricted mode (no scripts, no external fetches). Every piece of model text
// is XML-escaped here as well, so a label can't break out of its element either way.
//
// Anything it can't parse returns null, and the caller keeps showing the code block.

const NODE_SHAPES = {
  '[': ']',   // rect
  '(': ')',   // rounded
  '{': '}',   // diamond → drawn as a rounded rect with a tint; shape fidelity is not the point
  '>': ']',   // asymmetric
};

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

// Split a label into display lines: explicit <br/> first, then greedy wrap on words.
function wrapLabel(raw, maxChars = 22) {
  const parts = String(raw || '').split(/<br\s*\/?>/i);
  const lines = [];
  for (const part of parts) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = '';
    for (const w of words) {
      if (!line) line = w;
      else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

// Strip mermaid's quoting around a label.
function cleanLabel(s) {
  let t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t.trim();
}

// Split one line into node tokens + the edge labels between them, honouring brackets and
// quotes so an arrow inside a label can't be read as a connector. Returns null when the line
// holds no top-level edge operator. Handles chains: A --> B -->|yes| C.
const EDGE_OPS = ['-.->', '==>', '===>', '-->', '--->', '---', '-.-'];
export function splitEdgeChain(line) {
  const s = String(line || '');
  const parts = [];
  const labels = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === ')' || ch === '}') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0 && (ch === '-' || ch === '=')) {
      const op = EDGE_OPS.find((o) => s.startsWith(o, i));
      if (op) {
        i += op.length - 1;
        // An optional |label| directly after the arrow.
        let label = '';
        const rest = s.slice(i + 1);
        const lm = rest.match(/^\s*\|([^|]*)\|/);
        if (lm) { label = lm[1]; i += lm[0].length; }
        parts.push(buf); labels.push(label); buf = '';
        continue;
      }
    }
    buf += ch;
  }
  parts.push(buf);
  if (parts.length < 2) return null;
  return { parts: parts.map((p) => p.trim().replace(/;$/, '')).filter(Boolean), labels };
}

/**
 * Parse a mermaid flowchart into { dir, nodes: Map, edges: [] , classes }.
 * Returns null when the text isn't a flowchart we handle.
 */
export function parseFlowchart(text) {
  const src = String(text || '');
  const header = src.match(/^\s*(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/im);
  if (!header) return null;
  const dir = header[1].toUpperCase();

  const nodes = new Map(); // id -> { id, label }
  const edges = [];        // { from, to, label }
  const classDefs = new Map();
  const nodeClass = new Map();

  const ensure = (id, label) => {
    const key = String(id).trim();
    if (!key) return null;
    if (!nodes.has(key)) nodes.set(key, { id: key, label: label != null ? label : key });
    else if (label != null) nodes.get(key).label = label;
    return nodes.get(key);
  };

  // `ID["label"]` / `ID(label)` / `ID{label}` → id + label, else a bare id.
  function readNodeToken(token) {
    const t = token.trim();
    if (!t) return null;
    const m = t.match(/^([A-Za-z0-9_.-]+)\s*([[({>])([\s\S]*)$/);
    if (!m) return ensure(t.replace(/^[[(]|[\])]$/g, ''), null);
    const [, id, open, rest] = m;
    const close = NODE_SHAPES[open] || ']';
    // Take everything up to the LAST closing bracket, so labels may contain brackets.
    const end = rest.lastIndexOf(close);
    const label = end >= 0 ? rest.slice(0, end) : rest;
    return ensure(id, cleanLabel(label.replace(/^[([{>]+/, '')));
  }

  for (let raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || /^%%/.test(line)) continue;                 // comment
    if (/^(?:flowchart|graph)\b/i.test(line)) continue;      // header
    if (/^(?:subgraph|end)\b/i.test(line)) continue;         // subgraphs: flattened, not drawn

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
        if (prev && next) edges.push({ from: prev.id, to: next.id, label: cleanLabel(seg.labels[k - 1] || '') });
        prev = next;
      }
      continue;
    }
    // A standalone node definition.
    if (/^[A-Za-z0-9_.-]+\s*[[({>]/.test(line)) { readNodeToken(line); continue; }
  }

  if (!nodes.size) return null;
  return { dir, nodes, edges, classDefs, nodeClass };
}

// Longest-path ranking: a node sits one level below its deepest parent. Cycles are broken by
// the visited guard, so a malformed graph still lays out instead of hanging.
function rankNodes(nodes, edges) {
  const parents = new Map();
  const children = new Map();
  for (const id of nodes.keys()) { parents.set(id, []); children.set(id, []); }
  for (const e of edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    parents.get(e.to).push(e.from);
    children.get(e.from).push(e.to);
  }
  const rank = new Map();
  const roots = [...nodes.keys()].filter((id) => parents.get(id).length === 0);
  const queue = roots.length ? [...roots] : [nodes.keys().next().value];
  for (const r of queue) rank.set(r, 0);
  let guard = nodes.size * 4;
  while (queue.length && guard-- > 0) {
    const id = queue.shift();
    const r = rank.get(id) || 0;
    for (const c of children.get(id) || []) {
      const want = r + 1;
      if ((rank.get(c) ?? -1) < want) { rank.set(c, want); queue.push(c); }
    }
  }
  for (const id of nodes.keys()) if (!rank.has(id)) rank.set(id, 0);
  return { rank, parents, children };
}

const CHAR_W = 7.1;   // ~13px system-ui average advance; good enough for box sizing
const LINE_H = 18;
const PAD_X = 14;
const PAD_Y = 12;

function measure(labelLines) {
  const w = Math.max(...labelLines.map((l) => l.length)) * CHAR_W + PAD_X * 2;
  const h = labelLines.length * LINE_H + PAD_Y * 2;
  return { w: Math.max(72, Math.round(w)), h: Math.round(h) };
}

/** Lay the graph out on a grid: rank → row (TB) or column (LR). Pure geometry. */
export function layoutFlowchart(graph, { dir = graph.dir, gapMain = 56, gapCross = 22 } = {}) {
  const { nodes, edges } = graph;
  const { rank, parents, children } = rankNodes(nodes, edges);

  const byRank = new Map();
  for (const [id, r] of rank) {
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(id);
  }
  // Order each rank by the average position of its parents (one barycenter sweep) so edges
  // cross as little as possible without a full layout engine.
  const order = new Map();
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    const ids = byRank.get(r);
    if (r === ranks[0]) { ids.forEach((id, i) => order.set(id, i)); continue; }
    ids.sort((a, b) => {
      const pa = parents.get(a).map((p) => order.get(p) ?? 0);
      const pb = parents.get(b).map((p) => order.get(p) ?? 0);
      const ma = pa.length ? pa.reduce((x, y) => x + y, 0) / pa.length : 0;
      const mb = pb.length ? pb.reduce((x, y) => x + y, 0) / pb.length : 0;
      return ma - mb;
    });
    ids.forEach((id, i) => order.set(id, i));
  }

  const horizontal = dir === 'LR' || dir === 'RL';
  const box = new Map();
  for (const [id, n] of nodes) {
    const lines = wrapLabel(n.label);
    const { w, h } = measure(lines);
    box.set(id, { id, lines, w, h, rank: rank.get(id) || 0 });
  }

  // Cross-axis extent of each rank, then centre every rank in the widest one.
  const rankExtent = new Map();
  for (const r of ranks) {
    const ids = byRank.get(r);
    const total = ids.reduce((sum, id) => sum + (horizontal ? box.get(id).h : box.get(id).w), 0)
      + gapCross * Math.max(0, ids.length - 1);
    rankExtent.set(r, total);
  }
  const maxExtent = Math.max(...rankExtent.values(), 1);

  // Main-axis offset per rank = the tallest/widest box in each preceding rank.
  const mainOffset = new Map();
  let main = 0;
  for (const r of ranks) {
    mainOffset.set(r, main);
    const size = Math.max(...byRank.get(r).map((id) => (horizontal ? box.get(id).w : box.get(id).h)));
    main += size + gapMain;
  }
  const mainTotal = Math.max(0, main - gapMain);

  for (const r of ranks) {
    const ids = byRank.get(r);
    let cross = (maxExtent - rankExtent.get(r)) / 2;
    for (const id of ids) {
      const b = box.get(id);
      if (horizontal) { b.x = mainOffset.get(r); b.y = cross; cross += b.h + gapCross; }
      else { b.x = cross; b.y = mainOffset.get(r); cross += b.w + gapCross; }
    }
  }

  const width = horizontal ? mainTotal : maxExtent;
  const height = horizontal ? maxExtent : mainTotal;
  return { boxes: box, edges, dir, width, height, horizontal, children };
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

/**
 * Mermaid flowchart text → a complete SVG document string, or null if it isn't a flowchart
 * this renderer handles (the caller then keeps the code block).
 */
export function renderFlowchartSvg(text, { padding = 18, maxWidth = 1400 } = {}) {
  const graph = parseFlowchart(text);
  if (!graph) return null;
  const L = layoutFlowchart(graph);
  if (!L.boxes.size) return null;

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

  // Edges first, so boxes paint over the joins.
  for (const e of L.edges) {
    const a = L.boxes.get(e.from);
    const b = L.boxes.get(e.to);
    if (!a || !b) continue;
    let x1, y1, x2, y2, d;
    if (L.horizontal) {
      x1 = a.x + a.w + padding; y1 = a.y + a.h / 2 + padding;
      x2 = b.x + padding;       y2 = b.y + b.h / 2 + padding;
      const mx = (x1 + x2) / 2;
      d = `M${px(x1)},${px(y1)} C${px(mx)},${px(y1)} ${px(mx)},${px(y2)} ${px(x2)},${px(y2)}`;
    } else {
      x1 = a.x + a.w / 2 + padding; y1 = a.y + a.h + padding;
      x2 = b.x + b.w / 2 + padding; y2 = b.y + padding;
      const my = (y1 + y2) / 2;
      d = `M${px(x1)},${px(y1)} C${px(x1)},${px(my)} ${px(x2)},${px(my)} ${px(x2)},${px(y2)}`;
    }
    out.push(`<path d="${d}" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a)"/>`);
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
      `<rect x="${px(b.x + padding)}" y="${px(b.y + padding)}" width="${px(b.w)}" height="${px(b.h)}" rx="9" `
      + `fill="${esc(s.fill)}" stroke="${esc(s.stroke)}" stroke-width="1.5"/>`,
    );
    const startY = b.y + padding + PAD_Y + LINE_H - 5;
    b.lines.forEach((line, i) => {
      out.push(
        `<text x="${px(b.x + b.w / 2 + padding)}" y="${px(startY + i * LINE_H)}" font-size="13" `
        + `fill="${esc(s.color)}" text-anchor="middle">${esc(line)}</text>`,
      );
    });
  }

  out.push('</svg>');
  return out.join('');
}
