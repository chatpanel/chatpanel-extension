// Live, interactive force-directed graph (animated settle + drag + hover +
// zoom/pan), like the "famous" graph views (D3 / Obsidian). SVG, no deps.
// Shared by the Meetings and Chat-history dashboards.
//
// nodes: [{ id, type: 'meeting'|'person', label, focus? }]   (type drives color)
// links: [{ s: id, t: id }]
// onNode(node): called on a tap (not a drag).
const SVGNS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function drawGraph(host, nodes, links, onNode) {
  if (!host) return;
  if (host._stop) host._stop(); // tear down a previous sim on re-render
  const W = Math.max(host.clientWidth || 600, 320);
  const H = Math.max(host.clientHeight || 0, host.classList.contains('big') ? 520 : 300);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const L = links.map((l) => ({ s: byId.get(l.s), t: byId.get(l.t) })).filter((l) => l.s && l.t);
  const N = nodes.length;
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  L.forEach((l) => { adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id); });

  // Seed positions on a phyllotaxis spiral (deterministic).
  nodes.forEach((nd, i) => {
    const a = i * 2.39996; const r = 10 + Math.sqrt(i / N) * Math.min(W, H) * 0.42;
    nd.x = W / 2 + Math.cos(a) * r; nd.y = H / 2 + Math.sin(a) * r; nd.vx = 0; nd.vy = 0;
  });
  const focus = nodes.find((x) => x.focus); if (focus) { focus.x = W / 2; focus.y = H / 2; }

  const k = Math.sqrt((W * H) / (N + 1)) * 0.62;
  const repK = k * k * 0.85;
  const linkLen = Math.max(54, k * 0.85);
  const linkK = 0.045;
  const centerK = 0.022;
  const radius = (nd) => (nd.type === 'meeting' ? (nd.focus ? 9 : 7) : 5);

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
    g.setAttribute('class', `gnode ${nd.type}${nd.focus ? ' focus' : ''}`);
    g.dataset.i = String(i);
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
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const a = nodes[i]; const b = nodes[j];
      let dx = a.x - b.x; let dy = a.y - b.y; let d2 = dx * dx + dy * dy || 0.01; let d = Math.sqrt(d2);
      const rep = (repK / d2) * alpha; const ux = dx / d; const uy = dy / d;
      a.vx += ux * rep; a.vy += uy * rep; b.vx -= ux * rep; b.vy -= uy * rep;
    }
    for (const l of L) {
      let dx = l.s.x - l.t.x; let dy = l.s.y - l.t.y; let d = Math.hypot(dx, dy) || 0.01;
      const s = (d - linkLen) * linkK * alpha; const ux = dx / d; const uy = dy / d;
      l.s.vx -= ux * s; l.s.vy -= uy * s; l.t.vx += ux * s; l.t.vy += uy * s;
    }
    for (const nd of nodes) {
      if (nd === drag) { nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0; continue; }
      if (nd.focus) { nd.x = cx; nd.y = cy; continue; }
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
    if (drag && moved < 3) onNode(drag);
    if (drag) { drag.fx = undefined; drag.fy = undefined; drag = null; reheat(0.2); }
    panning = null; svg.classList.remove('grabbing');
    try { svg.releasePointerCapture(e.pointerId); } catch { /* ok */ }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);

  nodes.forEach((nd) => {
    nd.el.addEventListener('pointerenter', () => {
      const keep = new Set([nd.id, ...adj.get(nd.id)]);
      nodes.forEach((m) => m.el.classList.toggle('faded', !keep.has(m.id)));
      L.forEach((l) => l.el.classList.toggle('faded', l.s.id !== nd.id && l.t.id !== nd.id));
    });
    nd.el.addEventListener('pointerleave', () => {
      nodes.forEach((m) => m.el.classList.remove('faded'));
      L.forEach((l) => l.el.classList.remove('faded'));
    });
  });

  host._stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; host._stop = null; };
  paint(); reheat(1);
}
