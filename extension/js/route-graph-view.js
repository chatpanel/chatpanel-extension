// The routing decision, drawn.
//
// A route row showed its decision as a JSON blob, which is the record rather than an
// explanation: it says which model won and leaves "what nearly won", "what was eliminated
// and why" and "where does this go if it declines" to be worked out by reading it. Those are
// the only questions anybody opens that row to ask.
//
// RENDERING ONLY. The graph itself is derived in @chatpanel/events (routeGraph) — every
// client draws the same decision its own way, and none of them re-derives it. This file owns
// DOM and nothing else, which is why it can be loaded on demand by whichever surface wants it.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const money = (c) => (c === 0 ? 'free' : c == null ? '—' : `${c}/1k`);
const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);

/**
 * @param graph the object from routeGraph().
 * @returns an element, or null when there is nothing to draw.
 */
export function renderRouteGraph(graph) {
  if (!graph || !graph.nodes?.length) return null;
  const box = el('div', 'rg');

  // WHY, FIRST. The chosen model is already in the row title; what is missing from it is the
  // lever that decided — the user's pinned default, an axis the request asked for, a strategy.
  if (graph.strategy) {
    const head = el('div', 'rg-why');
    head.append(el('span', 'rg-strategy', graph.strategy));
    for (const r of graph.reasons || []) head.append(el('span', 'rg-reason', r));
    box.append(head);
  }

  // THE CHAIN: where this turn goes if the model declines, and after that. Drawn as a walk
  // because that is what it is — each hop is chosen relative to the one before it, not read
  // off a ranking.
  if (graph.chain?.length > 1) {
    const chain = el('div', 'rg-chain');
    chain.append(el('span', 'rg-chain-label', 'if it declines'));
    graph.chain.forEach((hop, i) => {
      if (i) chain.append(el('span', 'rg-arrow', '→'));
      const node = el('span', `rg-hop${i === 0 ? ' rg-hop-chosen' : ''}`, hop.label);
      node.title = i === 0 ? 'Answering this turn.' : hop.reason || '';
      chain.append(node);
    });
    box.append(chain);
  }

  // EVERY CANDIDATE, including the ones that lost — a decision you cannot see the losers of
  // is an assertion. Eligible ones in the router's own order, so position on screen is
  // position in the decision.
  const table = el('div', 'rg-nodes');
  for (const n of graph.nodes) {
    const row = el('div', `rg-node${n.chosen ? ' rg-chosen' : ''}${n.eligible ? '' : ' rg-out'}`);
    row.append(el('span', 'rg-name', n.label));
    const facts = el('span', 'rg-facts');
    facts.append(el('i', 'rg-fact', `q ${n.quality ?? '—'}`));
    facts.append(el('i', 'rg-fact', money(n.costPer1k)));
    facts.append(el('i', 'rg-fact', secs(n.latencyMs)));
    facts.append(el('i', `rg-fact rg-reach-${n.reach}`, n.reach));
    // An order the user PINNED is an instruction; one we inferred is a guess. Showing them
    // identically hides the single most common reason a model won.
    if (n.orderPinned) facts.append(el('i', 'rg-fact rg-pinned', `Order ${n.order}`));
    row.append(facts);
    if (!n.eligible) row.append(el('span', 'rg-out-why', n.why));
    table.append(row);
  }
  box.append(table);

  if (graph.eliminated) {
    box.append(el('p', 'rg-note', `${graph.eliminated} of ${graph.nodes.length} ruled out before ranking.`));
  }
  return box;
}
