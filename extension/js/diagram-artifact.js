// diagram-artifact.js — a ```mermaid placeholder becomes a picture, wherever it appears.
//
// markdown.js emits `<div class="md-artifact md-artifact-mermaid">` carrying only the ESCAPED
// source. This module upgrades that placeholder into a Diagram | Code card with zoom, copy and
// open-full-size. The renderer (events/flowchart.js, from @chatpanel/events) is pure text → SVG
// and the result is shown through `<img src="data:image/svg+xml,…">` — restricted mode, so no
// scripts and no external fetches. Diagram types the renderer does not cover return null and the
// code block simply stays, which is the fail-safe for every path below.
//
// It used to live inside artifacts.js, which only the side panel ever called — so a flowchart
// written into a NOTE stayed a wall of `flowchart TB` source in both the reading view and the
// live editor. The logic is one module now because it has three call sites (chat bubbles, the
// notes preview, and the CodeMirror block widget) and a fourth is obvious: any client that
// renders our markdown wants the same card.
//
// COST: nothing until a diagram exists. Every caller checks hasDiagrams() first, this module is
// only ever `await import()`ed, it imports the renderer the same way, and it injects its own
// stylesheet on first mount — so a page with no diagram loads neither the code nor the CSS.

const CSS_FILE = 'artifacts.css';
// source text → rendered SVG (or null when the renderer declined it). The CodeMirror widget is
// rebuilt on cursor moves and re-created when it scrolls back into view, so without this a
// diagram would be laid out again on every one of those. Bounded: notes are long.
const SVG_CACHE = new Map();
const CACHE_MAX = 48;

let renderFlowchartSvg = null; // set once events/flowchart.js has loaded

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/** The diagram source from the placeholder (already-escaped HTML → real text). */
function sourceOf(node) {
  const code = node.querySelector('.artifact-src code');
  return code ? code.textContent || '' : '';
}

function svgFor(source) {
  if (SVG_CACHE.has(source)) return SVG_CACHE.get(source);
  let svg = null;
  try { svg = renderFlowchartSvg(source); } catch { svg = null; }
  if (SVG_CACHE.size >= CACHE_MAX) SVG_CACHE.delete(SVG_CACHE.keys().next().value);
  SVG_CACHE.set(source, svg);
  return svg;
}

// The card's CSS. The side panel links it statically; every other host page gets it here, once,
// the first time it actually shows a diagram. An external stylesheet from our own package —
// never an inline <style> — so it needs no CSP concession.
function ensureStyles(doc) {
  try {
    if (doc.querySelector(`link[href$="${CSS_FILE}"]`)) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(CSS_FILE);
    (doc.head || doc.documentElement).appendChild(link);
  } catch { /* unstyled beats not-rendered */ }
}

/** Is there anything here to upgrade? Cheap enough to call on every render. */
export function hasDiagrams(root) {
  return !!root?.querySelector?.('.md-artifact-mermaid:not([data-artifact-ready])');
}

/**
 * Upgrade every un-mounted `.md-artifact-mermaid` under `root`. SYNCHRONOUS, and returns false
 * without touching anything when the renderer hasn't been loaded yet — that lets a caller that
 * has already mounted one diagram (the live editor, re-creating its block widget) paint the next
 * one in the same frame instead of after a microtask, which is the difference between a diagram
 * that is simply there and one that flashes its source first.
 *
 * `onEdit` adds an Edit button and is how a host that OWNS the source (the live editor) offers a
 * way back to the text; without it the card is read-only, which is right for a chat bubble.
 */
export function mountDiagramsSync(root, { onEdit } = {}) {
  if (!renderFlowchartSvg) return false;
  const nodes = root?.querySelectorAll?.('.md-artifact-mermaid:not([data-artifact-ready])');
  if (!nodes || !nodes.length) return true; // renderer ready, nothing to do
  ensureStyles(root.ownerDocument || document);
  for (const node of nodes) {
    try {
      node.setAttribute('data-artifact-ready', '1');
      const source = sourceOf(node);
      const svg = svgFor(source);
      if (!svg) continue; // not a flowchart we draw — leave the source visible

      const bar = el('div', 'artifact-bar');
      const btnDiagram = el('button', 'artifact-btn is-on', 'Diagram');
      const btnCode = el('button', 'artifact-btn', 'Code');
      const btnOut = el('button', 'artifact-btn artifact-zoom', '−');
      const btnFit = el('button', 'artifact-btn artifact-zoom', 'Fit');
      const btnIn = el('button', 'artifact-btn artifact-zoom', '+');
      const btnCopy = el('button', 'artifact-btn', 'Copy');
      const btnEdit = onEdit ? el('button', 'artifact-btn', 'Edit') : null;
      const btnOpen = el('button', 'artifact-btn artifact-open', 'Open ↗');
      for (const b of [btnDiagram, btnCode, btnOut, btnFit, btnIn, btnCopy, btnEdit, btnOpen]) if (b) b.type = 'button';
      const zoomLabel = el('span', 'artifact-status', 'Fit');
      bar.append(btnDiagram, btnCode, btnOut, btnFit, btnIn, zoomLabel, btnCopy);
      if (btnEdit) bar.append(btnEdit);
      bar.append(btnOpen);

      const figure = el('div', 'artifact-diagram');
      const img = document.createElement('img');
      img.alt = 'diagram';
      img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
      figure.appendChild(img);

      // Zoom: a big chart is unreadable squeezed to panel width, so "Fit" is the default and
      // +/− step the true pixel size while the figure scrolls. The SVG carries its intrinsic
      // size, which is what the steps are relative to.
      const baseW = Number((svg.match(/width="(\d+)"/) || [])[1]) || 800;
      let zoom = 0; // 0 = fit-to-width
      const applyZoom = () => {
        if (!zoom) { img.style.width = '100%'; img.style.maxWidth = '100%'; zoomLabel.textContent = 'Fit'; }
        else { img.style.width = `${Math.round(baseW * zoom)}px`; img.style.maxWidth = 'none'; zoomLabel.textContent = `${Math.round(zoom * 100)}%`; }
      };
      const step = (dir) => {
        // Stepping from Fit starts at 100%, which is what a reader expects the first + to do.
        zoom = zoom ? Math.min(4, Math.max(0.25, zoom + dir * 0.25)) : (dir > 0 ? 1.25 : 0.75);
        applyZoom();
      };

      const src = node.querySelector('.artifact-src');
      node.insertBefore(bar, node.firstChild);
      node.appendChild(figure);

      const show = (diagram) => {
        btnDiagram.classList.toggle('is-on', diagram);
        btnCode.classList.toggle('is-on', !diagram);
        figure.style.display = diagram ? 'block' : 'none';
        if (src) src.style.display = diagram ? 'none' : 'block';
        for (const b of [btnOut, btnFit, btnIn]) b.style.display = diagram ? '' : 'none';
        zoomLabel.style.display = diagram ? '' : 'none';
      };
      btnDiagram.addEventListener('click', () => show(true));
      btnCode.addEventListener('click', () => show(false));
      btnIn.addEventListener('click', () => step(1));
      btnOut.addEventListener('click', () => step(-1));
      btnFit.addEventListener('click', () => { zoom = 0; applyZoom(); });
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(source).then(() => {
          btnCopy.textContent = 'Copied';
          setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1200);
        }).catch(() => {});
      });
      if (btnEdit) btnEdit.addEventListener('click', () => { try { onEdit(node); } catch { /* ignore */ } });
      // Open the diagram full-size in a tab: a blob: SVG opens as an image document, so the
      // browser's own zoom/pan applies and it prints/saves cleanly. No scripts involved.
      btnOpen.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
      applyZoom();
      show(true); // the picture is the point — show it first
    } catch { /* leave the code block untouched */ }
  }
  return true;
}

/** Load the renderer if needed, then mount. Never throws — the source stays visible. */
export async function mountDiagrams(root, opts = {}) {
  if (!hasDiagrams(root)) return; // nothing to draw — don't pull the renderer in for nothing
  if (!renderFlowchartSvg) {
    try { ({ renderFlowchartSvg } = await import('./events/flowchart.js')); } catch { return; }
  }
  mountDiagramsSync(root, opts);
}
