// Reusable corpus-overview dashboard, shared by the Chats & Meetings pages and
// mirroring the Notes page. Renders a tabbed overview — Stats / Topic graph /
// Related — over a WHOLE collection, shown when no single item is open.
//
// Separation of concerns: this module owns tab state + show/hide + two generic
// renderers (metric cards, related cards). The page owns its data and supplies
// per-tab rendering via `render(tab, host)`. The heavy bits (graph-view, BM25)
// stay in their own shared modules and are called by the page — nothing heavy is
// imported here, so first paint stays cheap.

const $ = (id) => document.getElementById(id);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

// Controller. cfg = {
//   prefix,                     // element id prefix → #<p>-dash, #<p>-dash-<tab>, #<p>-graph-toggle
//   tabs = ['stats','graph','related'],
//   onOpen(), onClose(),        // page hides/shows its other views
//   render(tab, host),          // page renders the active pane into `host`
// }
export function createDashboard(cfg) {
  const p = cfg.prefix;
  const tabs = cfg.tabs || ['stats', 'graph', 'related'];
  let on = false;
  let tab = tabs.includes('graph') ? 'graph' : tabs[0];
  const root = () => $(`${p}-dash`);

  function setTab(t) {
    tab = tabs.includes(t) ? t : tabs[0];
    for (const b of root().querySelectorAll('.dash-tabs button')) b.classList.toggle('active', b.dataset.dash === tab);
    for (const name of tabs) $(`${p}-dash-${name}`)?.classList.toggle('hidden', name !== tab);
    cfg.render?.(tab, $(`${p}-dash-${tab}`));
  }
  function open() {
    on = true;
    root().classList.remove('hidden');
    $(`${p}-graph-toggle`)?.classList.add('active');
    cfg.onOpen?.();
    setTab(tab);
  }
  function close() {
    on = false;
    root().classList.add('hidden');
    $(`${p}-graph-toggle`)?.classList.remove('active');
    cfg.onClose?.();
  }
  function wire() {
    for (const b of root().querySelectorAll('.dash-tabs button')) b.onclick = () => setTab(b.dataset.dash);
  }
  return {
    open, close, wire, setTab,
    toggle() { if (on) close(); else open(); },
    rerender() { if (on) cfg.render?.(tab, $(`${p}-dash-${tab}`)); },
    get isOpen() { return on; },
    get tab() { return tab; },
  };
}

// Stats pane: metric cards + optional chip clouds.
// spec = { metrics:[{n,l}], empty?, clouds?:[{ head, entries:[[term,count]], empty, onChip(term), chipTitle(term) }] }
export function renderStats(host, spec) {
  if (spec.empty) { host.innerHTML = `<div class="dash-empty">${esc(spec.empty)}</div>`; return; }
  const card = (n, l) => `<div class="metric"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  const clouds = spec.clouds || [];
  host.innerHTML =
    `<div class="metrics">${spec.metrics.map((m) => card(m.n, m.l)).join('')}</div>` +
    (clouds.length ? `<div class="stat-cols">${clouds.map((c, i) => `<div class="stat-col"><div class="stat-col-head">${esc(c.head)}</div><div id="${host.id}-cloud-${i}" class="chip-cloud"></div></div>`).join('')}</div>` : '');
  clouds.forEach((c, i) => {
    const el = $(`${host.id}-cloud-${i}`);
    if (!el) return;
    if (!c.entries.length) { el.innerHTML = `<span class="stat-empty">${esc(c.empty || '')}</span>`; return; }
    for (const [term, count] of c.entries) {
      const b = document.createElement('button');
      b.className = 'topic-chip';
      b.innerHTML = `${esc(term)} <span class="chip-count">${count}</span>`;
      if (c.chipTitle) b.title = c.chipTitle(term);
      b.onclick = () => c.onChip?.(term);
      el.appendChild(b);
    }
  });
}

// Related pane: a list of clickable cards. cards = [{ title, meta, onClick }]
export function renderRelated(host, cards, empty) {
  if (!cards.length) { host.innerHTML = `<div class="dash-empty">${esc(empty || 'Nothing related yet.')}</div>`; return; }
  host.innerHTML = '';
  for (const c of cards) {
    const el = document.createElement('div');
    el.className = 'related-card';
    el.innerHTML = `<div class="related-card-title">${esc(c.title)}</div><div class="related-card-meta">${esc(c.meta)}</div>`;
    el.onclick = c.onClick;
    host.appendChild(el);
  }
}
