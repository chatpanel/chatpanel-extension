// collapse-cards.js — collapsible entity cards for the Settings lists.
//
// One implementation shared by every long configuration list (API endpoints,
// bridge agents, …) instead of a per-list copy. An endpoint or agent card is a
// tall form; a page of them is a wall of identical fields, so cards start
// COLLAPSED and show a one-line summary — you expand only the one you're editing.
//
// Contract — the card must be:
//   <div class="entity">
//     <div class="entity-head">
//       <button class="card-toggle">…</button>   ← chevron
//       …<span class="card-summary"></span>…     ← one-line "what is this" text
//     </div>
//     …body…                                     ← hidden by CSS when collapsed
//   </div>
// Collapsing is pure CSS (`.entity.collapsed`), never a DOM removal, so unsaved
// edits in a collapsed card survive untouched.
//
// Expanded state is keyed (`endpoint:<id>`) in a module-level set so a re-render
// — after a save, a delete, or a plan change — doesn't slam shut the card the
// user was working in.

const expandedKeys = new Set();

const isInteractive = (el) => !!el?.closest('input, select, textarea, button, label, a, summary');

export function isExpanded(key) {
  return expandedKeys.has(key);
}

export function setExpanded(key, on) {
  if (on) expandedKeys.add(key);
  else expandedKeys.delete(key);
}

// Forget a card's state entirely (e.g. it was deleted), so a recycled id can't
// inherit a stale open/closed state.
export function forgetCard(key) {
  expandedKeys.delete(key);
}

// Wire one card. `defaultOpen` opens it the FIRST time it is seen (used for a
// just-added card the user is about to configure) without overriding a state they
// have since chosen. Returns helpers the caller keeps for live updates.
export function wireCollapsible(node, key, { defaultOpen = false, summary = '' } = {}) {
  const head = node?.querySelector('.entity-head');
  const btn = node?.querySelector('.card-toggle');
  const sum = node?.querySelector('.card-summary');
  const setSummary = (text) => { if (sum) sum.textContent = text || ''; };
  setSummary(summary);
  // A stale template (older settings.html) has no toggle — leave the card fully
  // expanded rather than making its fields unreachable.
  if (!head || !btn) return { setSummary, toggle: () => {}, isOpen: () => true };

  if (defaultOpen && !expandedKeys.has(key)) expandedKeys.add(key);

  const apply = () => {
    const open = expandedKeys.has(key);
    node.classList.toggle('collapsed', !open);
    btn.setAttribute('aria-expanded', String(open));
    btn.title = open ? 'Collapse' : 'Expand';
    btn.setAttribute('aria-label', open ? 'Collapse this card' : 'Expand this card');
  };

  const toggle = (on) => {
    setExpanded(key, on === undefined ? !expandedKeys.has(key) : !!on);
    apply();
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  // The whole header row is a hit target — but never steal a click meant for the
  // name field, the Enabled checkbox, Delete, or the "Use on Free" button.
  head.addEventListener('click', (e) => { if (!isInteractive(e.target)) toggle(); });
  apply();

  return { setSummary, toggle, isOpen: () => expandedKeys.has(key) };
}

// Expand/collapse a whole list at once. Caller passes the keys it rendered.
export function setAllExpanded(keys, on) {
  for (const k of keys) setExpanded(k, on);
}

// Are any of these cards currently open? Drives the "Expand all"/"Collapse all"
// label so one button can do both.
export function anyExpanded(keys) {
  return keys.some((k) => expandedKeys.has(k));
}
