// Rename in place.
//
// Chats have had an inline rename in the side panel for a long time; meetings had none,
// which is why a call captured as "Zoom Meeting" stayed that way forever. Rather than
// copy that handler twice more, it is one module: swap the element for an input, commit
// on Enter or blur, cancel on Escape, never write an empty title.
//
// window.prompt() is not an option — it is unreliable in a side panel and ugly
// everywhere else.

const MAX = 120;

/**
 * Edit one element's text in place.
 *
 * el        the element showing the title (its content is restored on cancel)
 * value     the text to seed the input with
 * onCommit(next) called only when the value actually CHANGED and isn't empty
 * onDone()  always called after commit or cancel, so the caller can re-render
 *
 * Returns the input, focused and selected.
 */
export function editTitleInline(el, { value = '', onCommit, onDone, placeholder = 'Name this…', className = 'cp-title-input' } = {}) {
  if (!el) return null;
  const original = value;
  const input = el.ownerDocument.createElement('input');
  input.className = className;
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = MAX;
  input.setAttribute('aria-label', 'Rename');
  // Inherit the heading's own typography, so the field IS the title rather than a form
  // control that appeared next to it.
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  input.style.cssText = `font: inherit; font-size: ${cs.fontSize}; font-weight: ${cs.fontWeight};
    letter-spacing: ${cs.letterSpacing}; width: 100%; max-width: 100%; box-sizing: border-box;
    padding: 2px 6px; margin: -3px 0; border-radius: 7px; color: var(--text, #181b20);
    background: var(--card, var(--bg-elev, #fff)); border: 1px solid var(--accent, #5b5bf0); outline: none;`;

  const snapshot = [...el.childNodes];
  el.textContent = '';
  el.appendChild(input);

  let done = false;
  const restore = () => {
    el.textContent = '';
    snapshot.forEach((n) => el.appendChild(n));
  };
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim().slice(0, MAX);
    restore();
    if (commit && next && next !== original) onCommit?.(next);
    onDone?.();
  };

  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation(); // page shortcuts must not fire while renaming
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);

  input.focus();
  input.select();
  return input;
}

/**
 * Make a heading renamable: double-click (or a caller-supplied button) starts the edit.
 * Returns { start() } so a "Rename" button can trigger the same path a double-click does.
 */
export function mountEditableTitle(el, { getValue, onCommit, onDone, hint = 'Double-click to rename' } = {}) {
  if (!el) return { start() {} };
  const start = () => editTitleInline(el, { value: getValue?.() ?? el.textContent ?? '', onCommit, onDone });
  el.title = hint;
  el.style.cursor = 'text';
  el.ondblclick = (e) => { e.preventDefault(); start(); };
  return { start };
}
