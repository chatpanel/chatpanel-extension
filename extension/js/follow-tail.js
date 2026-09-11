// Following a stream without taking the scroll away from the reader.
//
// An agent writing into a note wants the tail kept in view; a person reading what it wrote
// thirty lines up wants the scroll left exactly where they put it. Those are the same
// gesture asked from two sides, and the way to serve both is to follow ONLY while the place
// being written is still on screen. Scroll away and the chasing stops; scroll back to the
// tail and it resumes — no flag to get stuck, no listener to wire, nothing to reset when a
// second write starts.
//
// The extension answers this with a scroll listener and a `_followStream` boolean over its
// `.editor-scroll`. This is the same rule, stated as a question about the document instead
// of about a container, which is what lets CodeMirror's own scroller and an outer scrolling
// column share one implementation.

/**
 * The element that actually scrolls this editor.
 *
 * CodeMirror's own `.cm-scroller` when it has a height of its own; otherwise the nearest
 * scrollable ancestor — here the note's `.editor-scroll` column, because the editor is
 * deliberately unbounded so the title, tags, body and backlinks scroll as one page.
 */
export function scrollerFor(view) {
  const own = view.scrollDOM;
  if (own && own.scrollHeight > own.clientHeight + 1) return own;
  for (let el = own?.parentElement; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

/**
 * Is document position `pos` inside the visible band right now?
 *
 * `false` when the position is outside CodeMirror's rendered viewport (coordsAtPos returns
 * null), which is the answer we want: something that far off screen is not being watched.
 * `margin` allows the tail to sit slightly below the fold and still count as followed —
 * one appended line must not be what ends the follow.
 */
export function posInView(view, pos, margin = 120) {
  let c = null;
  try { c = view.coordsAtPos(Math.max(0, Math.min(pos, view.state.doc.length))); } catch { c = null; }
  if (!c) return false;
  const sc = scrollerFor(view);
  const box = sc ? sc.getBoundingClientRect() : { top: 0, bottom: view.dom.ownerDocument.defaultView.innerHeight };
  return c.bottom > box.top - margin && c.top < box.bottom + margin;
}
