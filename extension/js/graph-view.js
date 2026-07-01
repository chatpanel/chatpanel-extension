// Live, interactive force-directed graph (animated settle + drag + hover +
// zoom/pan). SVG, no deps.
// Shared by the Meetings and Chat-history dashboards.
//
// nodes: [{ id, type: 'meeting'|'topic'|'participant'|'person', label, focus? }]
// `person` is kept for the older chat-history graph, where topic-like nodes
// were historically emitted with that type.
// links: [{ s: id, t: id }]
// onNode(node):     called on a SINGLE tap (not a drag) — use to drill/focus the graph.
// onNodeOpen(node):  optional; called on a DOUBLE tap — use to open the object (navigate
//                    to the meeting/chat). When omitted, a single tap fires immediately
//                    (legacy callers keep working).
const SVGNS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const GOLDEN_ANGLE = 2.399963229728653;
const MAX_REPULSION_NEIGHBORS = 28;

function isConnectorNode(node) {
  return node?.type !== 'meeting';
}

function splitLargeCluster(cluster, neighbors) {
  if (cluster.nodes.length < 36) return [cluster];
  const nodeSet = new Set(cluster.nodes.map((n) => n.id));
  const degree = new Map(cluster.nodes.map((node) => [
    node.id,
    (neighbors.get(node.id) || []).filter((next) => nodeSet.has(next.id)).length,
  ]));
  const seeds = cluster.nodes
    .filter((node) => isConnectorNode(node) && (degree.get(node.id) || 0) >= 2)
    .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || String(a.label || '').localeCompare(String(b.label || '')))
    .slice(0, Math.min(8, Math.max(2, Math.ceil(cluster.nodes.length / 32))));
  if (seeds.length < 2) return [cluster];

  const groups = seeds.map((seed) => ({ id: 0, seed, nodes: [seed], hasFocus: !!seed.focus }));
  const seedGroup = new Map(seeds.map((seed, i) => [seed.id, i]));
  const assignment = new Map(seeds.map((seed, i) => [seed.id, i]));
  const seedForNode = (node) => {
    const linkedSeeds = (neighbors.get(node.id) || []).filter((next) => seedGroup.has(next.id));
    if (!linkedSeeds.length) return -1;
    linkedSeeds.sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
    return seedGroup.get(linkedSeeds[0].id);
  };

  cluster.nodes
    .filter((node) => !isConnectorNode(node) && !assignment.has(node.id))
    .forEach((node, i) => {
      const groupIndex = seedForNode(node);
      const fallback = i % groups.length;
      const group = groups[groupIndex >= 0 ? groupIndex : fallback];
      group.nodes.push(node);
      group.hasFocus = group.hasFocus || !!node.focus;
      assignment.set(node.id, groupIndex >= 0 ? groupIndex : fallback);
    });

  cluster.nodes
    .filter((node) => !assignment.has(node.id))
    .forEach((node, i) => {
      const counts = groups.map(() => 0);
      (neighbors.get(node.id) || []).forEach((next) => {
        const groupIndex = assignment.get(next.id);
        if (groupIndex != null) counts[groupIndex] += 1;
      });
      let best = 0;
      counts.forEach((count, groupIndex) => { if (count > counts[best]) best = groupIndex; });
      if (!counts[best]) best = i % groups.length;
      groups[best].nodes.push(node);
      groups[best].hasFocus = groups[best].hasFocus || !!node.focus;
      assignment.set(node.id, best);
    });

  return groups.filter((group) => group.nodes.length);
}

function clusterGraphNodes(nodes, links) {
  const neighbors = new Map(nodes.map((n) => [n.id, []]));
  links.forEach((l) => {
    neighbors.get(l.s.id)?.push(l.t);
    neighbors.get(l.t.id)?.push(l.s);
  });

  const seen = new Set();
  const components = [];
  nodes.forEach((start) => {
    if (seen.has(start.id)) return;
    const stack = [start];
    const items = [];
    seen.add(start.id);
    while (stack.length) {
      const node = stack.pop();
      items.push(node);
      (neighbors.get(node.id) || []).forEach((next) => {
        if (seen.has(next.id)) return;
        seen.add(next.id);
        stack.push(next);
      });
    }
    components.push({ id: components.length, nodes: items, hasFocus: items.some((n) => n.focus) });
  });

  const clusters = components.flatMap((component) => splitLargeCluster(component, neighbors));
  clusters.sort((a, b) => Number(b.hasFocus) - Number(a.hasFocus) || b.nodes.length - a.nodes.length);
  clusters.forEach((cluster, i) => {
    cluster.id = i;
    cluster.nodes.forEach((node, j) => {
      node.clusterId = i;
      node.clusterIndex = j;
      node.clusterSize = cluster.nodes.length;
      node.cluster = cluster;
    });
  });
  return clusters;
}

function placeClusters(clusters, W, H) {
  const count = clusters.length || 1;
  const rx = Math.max(70, W / 2 - 110);
  const ry = Math.max(60, H / 2 - 90);
  clusters.forEach((cluster, i) => {
    if (i === 0 && (cluster.hasFocus || count === 1)) {
      cluster.cx = W / 2;
      cluster.cy = H / 2;
    } else {
      const a = i * GOLDEN_ANGLE;
      const r = Math.sqrt((i + 0.5) / count);
      cluster.cx = clamp(W / 2 + Math.cos(a) * rx * r, 72, W - 72);
      cluster.cy = clamp(H / 2 + Math.sin(a) * ry * r, 58, H - 58);
    }
    cluster.radius = Math.max(42, Math.min(170, 28 + Math.sqrt(cluster.nodes.length) * 24));
  });
}

function buildSpatialGrid(nodes, cellSize) {
  const grid = new Map();
  nodes.forEach((node) => {
    const gx = Math.floor(node.x / cellSize);
    const gy = Math.floor(node.y / cellSize);
    const key = `${gx}:${gy}`;
    const bucket = grid.get(key) || [];
    bucket.push(node);
    grid.set(key, bucket);
  });
  return grid;
}

function nearbyNodes(grid, node, cellSize) {
  const gx = Math.floor(node.x / cellSize);
  const gy = Math.floor(node.y / cellSize);
  const out = [];
  for (let y = gy - 1; y <= gy + 1; y += 1) {
    for (let x = gx - 1; x <= gx + 1; x += 1) {
      const bucket = grid.get(`${x}:${y}`);
      if (!bucket) continue;
      for (const candidate of bucket) {
        if (candidate === node) continue;
        out.push(candidate);
        if (out.length >= MAX_REPULSION_NEIGHBORS) return out;
      }
    }
  }
  return out;
}

function labelPriority(node, adj) {
  const degree = adj.get(node.id)?.size || 0;
  let score = degree * 8;
  if (node.focus) score += 10000;
  if (node.type === 'meeting') score += 44;
  if (node.type === 'participant') score += 28;
  if (node.type === 'topic' || node.type === 'person') score += 22;
  if (String(node.label || '').length > 36) score -= 8;
  return score;
}

export function drawGraph(host, nodes, links, onNode, onNodeOpen) {
  if (!host) return;
  if (host._stop) host._stop(); // tear down a previous sim on re-render

  // Tap routing: single tap → onNode (drill/focus); double tap → onNodeOpen (open).
  // With no onNodeOpen, fire the single tap immediately so legacy callers are unchanged.
  let tapTimer = null; let lastTapId = null; let lastTapAt = 0;
  const handleTap = (node) => {
    if (!onNodeOpen) { onNode?.(node); return; }
    const now = Date.now();
    if (lastTapId === node.id && now - lastTapAt < 320) {
      lastTapId = null; lastTapAt = 0;
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
      onNodeOpen(node);
    } else {
      lastTapId = node.id; lastTapAt = now;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapTimer = null; onNode?.(node); }, 300);
    }
  };
  const W = Math.max(host.clientWidth || 600, 320);
  const N = nodes.length;
  const baseH = host.classList.contains('big') ? 520 : 300;
  const extraH = host.classList.contains('big')
    ? Math.min(300, Math.max(0, N - 70) * 2.1)
    : Math.min(140, Math.max(0, N - 38) * 1.5);
  const H = Math.max(host.clientHeight || 0, Math.round(baseH + extraH));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const L = links.map((l) => ({ s: byId.get(l.s), t: byId.get(l.t) })).filter((l) => l.s && l.t);
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  L.forEach((l) => { adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id); });

  const clusters = clusterGraphNodes(nodes, L);
  placeClusters(clusters, W, H);

  // Seed positions within component clusters. This is deterministic and avoids
  // starting every disconnected group in the same dense center.
  nodes.forEach((nd, i) => {
    const cluster = nd.cluster || clusters[0] || { cx: W / 2, cy: H / 2, radius: Math.min(W, H) * 0.3 };
    const localN = Math.max(1, nd.clusterSize || 1);
    const localI = nd.clusterIndex || 0;
    const a = (localI + 1) * GOLDEN_ANGLE;
    const r = 6 + Math.sqrt((localI + 1) / (localN + 1)) * cluster.radius;
    nd.graphIndex = i;
    nd.x = cluster.cx + Math.cos(a) * r;
    nd.y = cluster.cy + Math.sin(a) * r;
    nd.vx = 0;
    nd.vy = 0;
  });
  const focus = nodes.find((x) => x.focus); if (focus) { focus.x = W / 2; focus.y = H / 2; }

  const k = Math.sqrt((W * H) / (N + 1)) * 0.82;
  const repK = k * k * 0.72;
  const linkLen = clamp(k * 1.08, 64, host.classList.contains('big') ? 118 : 98);
  const repulsionRadius = Math.max(96, linkLen * 2.3);
  const linkK = 0.036;
  const clusterK = clusters.length > 1 ? 0.014 : 0.008;
  const centerK = 0.006;
  const radius = (nd) => (nd.type === 'meeting' ? (nd.focus ? 9 : 7) : 5);
  const labelBudget = N <= 28
    ? N
    : Math.min(N, host.classList.contains('big') ? Math.max(24, Math.min(54, Math.floor(W / 34))) : 22);
  const visibleLabels = new Set([...nodes]
    .sort((a, b) => labelPriority(b, adj) - labelPriority(a, adj))
    .slice(0, labelBudget)
    .map((n) => n.id));

  host.innerHTML = '';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const view = document.createElementNS(SVGNS, 'g');
  svg.appendChild(view); host.appendChild(svg);

  L.forEach((l) => {
    const ln = document.createElementNS(SVGNS, 'line'); ln.setAttribute('class', 'gedge');
    view.appendChild(ln); l.el = ln;
  });
  nodes.forEach((nd, i) => {
    const g = document.createElementNS(SVGNS, 'g');
    const labelClass = visibleLabels.has(nd.id) ? ' label-visible' : ' label-hidden';
    g.setAttribute('class', `gnode ${nd.type}${nd.focus ? ' focus' : ''}${labelClass}`);
    g.dataset.i = String(i);
    g.dataset.cluster = String(nd.clusterId ?? 0);
    const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('r', String(radius(nd)));
    const tx = document.createElementNS(SVGNS, 'text'); tx.setAttribute('x', String(radius(nd) + 4)); tx.setAttribute('y', '3.5');
    tx.textContent = (nd.label || '').length > 24 ? (nd.label || '').slice(0, 23) + '…' : (nd.label || '');
    g.appendChild(c); g.appendChild(tx); view.appendChild(g); nd.el = g;
  });

  // zoom / pan
  const tf = { k: 1, x: 0, y: 0 };
  const applyView = () => view.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
  const toSvg = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left) * (W / r.width), y: (cy - r.top) * (H / r.height) }; };
  const toGraph = (cx, cy) => { const s = toSvg(cx, cy); return { x: (s.x - tf.x) / tf.k, y: (s.y - tf.y) / tf.k }; };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const s = toSvg(e.clientX, e.clientY);
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12; const k2 = clamp(tf.k * f, 0.3, 3.2);
    tf.x = s.x - (s.x - tf.x) * (k2 / tf.k); tf.y = s.y - (s.y - tf.y) * (k2 / tf.k); tf.k = k2; applyView();
  }, { passive: false });

  const paint = () => {
    for (const l of L) { l.el.setAttribute('x1', l.s.x.toFixed(1)); l.el.setAttribute('y1', l.s.y.toFixed(1)); l.el.setAttribute('x2', l.t.x.toFixed(1)); l.el.setAttribute('y2', l.t.y.toFixed(1)); }
    for (const nd of nodes) nd.el.setAttribute('transform', `translate(${nd.x.toFixed(1)},${nd.y.toFixed(1)})`);
  };

  let alpha = 1; let raf = 0; const cx = W / 2; const cy = H / 2;
  let drag = null; let panning = null; let moved = 0;
  const tick = () => {
    raf = 0;
    const grid = buildSpatialGrid(nodes, repulsionRadius);
    for (const a of nodes) {
      for (const b of nearbyNodes(grid, a, repulsionRadius)) {
        let dx = a.x - b.x; let dy = a.y - b.y; let d2 = dx * dx + dy * dy || 0.01; let d = Math.sqrt(d2);
        const rep = (repK / d2) * alpha * 0.62; const ux = dx / d; const uy = dy / d;
        a.vx += ux * rep; a.vy += uy * rep;
      }
    }
    for (const l of L) {
      let dx = l.s.x - l.t.x; let dy = l.s.y - l.t.y; let d = Math.hypot(dx, dy) || 0.01;
      const s = (d - linkLen) * linkK * alpha; const ux = dx / d; const uy = dy / d;
      l.s.vx -= ux * s; l.s.vy -= uy * s; l.t.vx += ux * s; l.t.vy += uy * s;
    }
    for (const nd of nodes) {
      if (nd === drag) { nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0; continue; }
      if (nd.focus) { nd.x = cx; nd.y = cy; continue; }
      const cluster = nd.cluster || { cx, cy };
      nd.vx += (cluster.cx - nd.x) * clusterK * alpha;
      nd.vy += (cluster.cy - nd.y) * clusterK * alpha;
      nd.vx += (cx - nd.x) * centerK * alpha; nd.vy += (cy - nd.y) * centerK * alpha;
      nd.x += nd.vx; nd.y += nd.vy; nd.vx *= 0.6; nd.vy *= 0.6;
      nd.x = clamp(nd.x, 24, W - 24); nd.y = clamp(nd.y, 18, H - 18);
    }
    paint();
    alpha *= 0.986;
    if (alpha > 0.02 || drag) raf = requestAnimationFrame(tick);
  };
  const reheat = (a = 0.5) => { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(tick); };

  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.gnode'); moved = 0;
    if (g) {
      drag = nodes[Number(g.dataset.i)];
      const p = toGraph(e.clientX, e.clientY); drag.fx = p.x; drag.fy = p.y;
      svg.classList.add('grabbing'); reheat(0.6);
    } else { panning = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y }; svg.classList.add('grabbing'); }
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag) { const p = toGraph(e.clientX, e.clientY); drag.fx = p.x; drag.fy = p.y; moved += 1; reheat(0.3); }
    else if (panning) { tf.x = panning.tx + (e.clientX - panning.x); tf.y = panning.ty + (e.clientY - panning.y); moved += 1; applyView(); }
  });
  const endPointer = (e) => {
    if (drag && moved < 3) handleTap(drag);
    if (drag) { drag.fx = undefined; drag.fy = undefined; drag = null; reheat(0.2); }
    panning = null; svg.classList.remove('grabbing');
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ok */ }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  nodes.forEach((nd) => {
    nd.el.addEventListener('pointerenter', () => {
      const keep = new Set([nd.id, ...adj.get(nd.id)]);
      nodes.forEach((m) => {
        const show = keep.has(m.id);
        m.el.classList.toggle('faded', !show);
        m.el.classList.toggle('label-near', show);
      });
      L.forEach((l) => l.el.classList.toggle('faded', l.s.id !== nd.id && l.t.id !== nd.id));
    });
    nd.el.addEventListener('pointerleave', () => {
      nodes.forEach((m) => {
        m.el.classList.remove('faded');
        m.el.classList.remove('label-near');
      });
      L.forEach((l) => l.el.classList.remove('faded'));
    });
  });

  host._stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; } host._stop = null; };
  paint(); reheat(1);
}
