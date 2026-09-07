// A sub-tab bar for a settings panel that has grown too tall to scan.
//
// The Privacy & Gateway panel is eight collapsible sections, some nested two deep inside a
// container that is itself shown only when the gateway is connected. Collapsing them keeps
// the page short, which is right, but it also means the only way to find a feature is to open
// sections one at a time and read their summaries — the page tells you how much there is
// without telling you where anything is.
//
// So: one bar, one section at a time, and the sections keep their markup exactly as it is.
//
// WHY IT WALKS A PATH rather than just hiding siblings. The targets are not all siblings —
// `#gw-sec-routing` lives inside `#gw-config` inside `#pv-gateway` — so showing one means
// hiding everything that is not ON the path from the panel down to it, at every level. Doing
// that generically is what keeps this reusable: the caller names targets, not a shape.
//
// Two escape hatches the panel actually needs:
//   • [data-subtab-keep] — never hidden. The panel's intro card, the bar itself, and the
//     sticky Save button that must stay in reach from every section it can edit.
//   • `requires` — a tab whose content lives inside a container that is itself conditionally
//     hidden (the gateway config before the gateway connects) is DISABLED rather than
//     offered, because selecting it would show an empty panel and read as a broken tab.
//
// No state of its own beyond the current selection, no knowledge of what any section does.

const KEEP = '[data-subtab-keep]';

/** Is this element hidden by a class/attribute someone else owns? */
function ownerHidden(el) {
  return !!el && (el.classList.contains('hidden') || el.hasAttribute('hidden'));
}

/**
 * @param root       the panel element the bar governs
 * @param bar        an empty container the buttons are rendered into
 * @param groups     [{ id, label, target, requires? }] — `target`/`requires` are element ids
 * @param storageKey localStorage key for the last-selected tab ('' = don't remember)
 * @returns { select, refresh, current } — `refresh` re-evaluates `requires` after the
 *          condition it depends on may have changed (e.g. the gateway connected).
 */
export function wireSubtabs({ root, bar, groups = [], storageKey = '' } = {}) {
  if (!root || !bar) return { select: () => {}, refresh: () => {}, current: () => '' };
  const live = groups
    .map((g) => ({ ...g, el: document.getElementById(g.target) }))
    .filter((g) => g.el);
  if (!live.length) return { select: () => {}, refresh: () => {}, current: () => '' };

  let currentId = '';
  const buttons = new Map();

  // Everything this module hid, so a re-select can put it all back rather than leaving
  // whatever the previous selection hid still hidden.
  const hidden = new Set();
  const reset = () => {
    for (const el of hidden) el.hidden = false;
    hidden.clear();
  };
  const hide = (el) => { el.hidden = true; hidden.add(el); };

  function showOnly(target) {
    reset();
    const path = new Set();
    for (let n = target; n && n !== root; n = n.parentElement) path.add(n);
    // Only ever called on a STRICT ANCESTOR of the target — the target's own subtree is left
    // exactly as it is. That is what makes the <summary> rule below unambiguous.
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(KEEP)) continue;
        if (child.tagName === 'SUMMARY') {
          // The heading of the section being VIEWED is the tab's title and stays (it is in
          // the target's own subtree, which is never walked). This one belongs to a container
          // we are merely passing THROUGH, so it would render as a second, redundant title
          // above every one of its sub-tabs — and it has a tab of its own already.
          hide(child);
          continue;
        }
        if (path.has(child)) {
          // On the path: make sure it is actually open, then keep descending until the
          // target itself — below that, everything belongs to the tab and stays as it is.
          if (child.tagName === 'DETAILS') child.open = true;
          if (child !== target) walk(child);
        } else if (!ownerHidden(child)) {
          // Only hide what is currently visible: a container someone else has hidden for
          // its own reasons must stay hidden when we put things back.
          hide(child);
        }
      }
    };
    walk(root);
    if (target.tagName === 'DETAILS') target.open = true;
  }

  function available(g) {
    return !g.requires || !ownerHidden(document.getElementById(g.requires));
  }

  function select(id, { remember = true } = {}) {
    const g = live.find((x) => x.id === id && available(x)) || live.find(available);
    if (!g) return;
    currentId = g.id;
    for (const [bid, btn] of buttons) {
      const on = bid === g.id;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    }
    showOnly(g.el);
    if (remember && storageKey) {
      try { localStorage.setItem(storageKey, g.id); } catch { /* private window — just don't remember */ }
    }
  }

  bar.replaceChildren();
  bar.setAttribute('role', 'tablist');
  for (const g of live) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'subtab';
    btn.textContent = g.label;
    btn.setAttribute('role', 'tab');
    btn.onclick = () => select(g.id);
    buttons.set(g.id, btn);
    bar.appendChild(btn);
  }
  // Left/Right move between tabs, as a tablist is expected to.
  bar.onkeydown = (e) => {
    const order = live.filter(available).map((g) => g.id);
    const i = order.indexOf(currentId);
    if (i < 0) return;
    if (e.key === 'ArrowRight') select(order[(i + 1) % order.length]);
    else if (e.key === 'ArrowLeft') select(order[(i - 1 + order.length) % order.length]);
    else return;
    e.preventDefault();
    buttons.get(currentId)?.focus();
  };

  // A tab whose container is hidden is shown as unavailable rather than removed: the feature
  // exists, it just needs the gateway running, and a tab that vanishes teaches nothing.
  function refresh() {
    for (const g of live) {
      const btn = buttons.get(g.id);
      const ok = available(g);
      btn.disabled = !ok;
      btn.title = ok ? '' : 'Connect the gateway to use this';
    }
    if (currentId && !available(live.find((g) => g.id === currentId) || {})) select('', { remember: false });
  }
  refresh();

  let initial = '';
  try { initial = storageKey ? localStorage.getItem(storageKey) || '' : ''; } catch { /* no store */ }
  select(initial, { remember: false });

  return {
    select,
    refresh,
    current: () => currentId,
    /** Reveal whichever tab contains this element — for deep links into a section. */
    revealFor(el) {
      const g = live.find((x) => x.el === el || x.el.contains(el));
      if (g) select(g.id);
      return !!g;
    },
  };
}
